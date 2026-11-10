//! Live video for NOVA's windows: the browser (CDP screencast) and the desktop (repeated capture) as an MJPEG
//! stream over the agent's own authenticated HTTP link.
//!
//! Frames are never queued. A producer overwrites one latest-frame slot; the writer takes whatever is newest when
//! the socket is ready again, so a slow viewer drops frames instead of building latency. The writer also keeps a
//! byte budget per second and the stream ends on its own after `MAX_STREAM`, when the owner pauses the agent, or
//! when the viewer goes away.
use std::{
    io::{self, Write},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};

pub const BOUNDARY: &str = "novaframe";
/// One stream never outlives this; the API reconnects while a window still watches.
pub const MAX_STREAM: Duration = Duration::from_secs(15 * 60);
/// Live streams the agent serves at once (each holds one HTTP worker).
pub const MAX_STREAMS: usize = 4;
/// Frames larger than this are dropped instead of sent.
pub const MAX_FRAME_BYTES: usize = 1_500_000;
/// Bytes per second one stream may send.
pub const STREAM_BYTES_PER_SECOND: usize = 6_000_000;

static ACTIVE: AtomicUsize = AtomicUsize::new(0);

/// A held stream slot; released on drop.
pub struct StreamPermit(());
impl StreamPermit {
    pub fn acquire() -> Option<Self> {
        let mut current = ACTIVE.load(Ordering::SeqCst);
        while current < MAX_STREAMS {
            match ACTIVE.compare_exchange(current, current + 1, Ordering::SeqCst, Ordering::SeqCst) {
                Ok(_) => return Some(Self(())),
                Err(actual) => current = actual,
            }
        }
        None
    }
    pub fn active() -> usize {
        ACTIVE.load(Ordering::SeqCst)
    }
}
impl Drop for StreamPermit {
    fn drop(&mut self) {
        ACTIVE.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Clone, Debug)]
pub struct Frame {
    pub seq: u64,
    pub jpeg: Arc<Vec<u8>>,
    pub width: u32,
    pub height: u32,
    /// One line of JSON with what the viewer may show next to the picture (never page text).
    pub meta: String,
}

#[derive(Default)]
struct Slot {
    frame: Option<Frame>,
    seq: u64,
    taken: u64,
    dropped: u64,
    closed: bool,
}

/// The single latest frame. Publishing over an untaken frame counts it as dropped.
#[derive(Default)]
pub struct LatestFrame {
    slot: Mutex<Slot>,
    ready: Condvar,
}
impl LatestFrame {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    pub fn publish(&self, jpeg: Vec<u8>, width: u32, height: u32, meta: String) -> u64 {
        let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        if slot.frame.as_ref().is_some_and(|f| f.seq > slot.taken) {
            slot.dropped += 1;
        }
        slot.seq += 1;
        let seq = slot.seq;
        slot.frame = Some(Frame {
            seq,
            jpeg: Arc::new(jpeg),
            width,
            height,
            meta,
        });
        drop(slot);
        self.ready.notify_all();
        seq
    }
    /// The newest frame after `seq`, waiting at most `timeout`. None on timeout or when closed.
    pub fn next_after(&self, seq: u64, timeout: Duration) -> Option<Frame> {
        let deadline = Instant::now() + timeout;
        let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if let Some(frame) = slot.frame.as_ref().filter(|f| f.seq > seq) {
                let frame = frame.clone();
                slot.taken = slot.taken.max(frame.seq);
                return Some(frame);
            }
            if slot.closed {
                return None;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            slot = self.ready.wait_timeout(slot, left).unwrap_or_else(|e| e.into_inner()).0;
        }
    }
    pub fn close(&self) {
        self.slot.lock().unwrap_or_else(|e| e.into_inner()).closed = true;
        self.ready.notify_all();
    }
    pub fn closed(&self) -> bool {
        self.slot.lock().unwrap_or_else(|e| e.into_inner()).closed
    }
    pub fn dropped(&self) -> u64 {
        self.slot.lock().unwrap_or_else(|e| e.into_inner()).dropped
    }
}

/// Adapts the capture rate to how long capturing and encoding take, between `min` and `max` frames per second.
#[derive(Clone, Debug)]
pub struct Pacer {
    min: f64,
    max: f64,
    fps: f64,
}
impl Pacer {
    pub fn new(min: f64, max: f64) -> Self {
        let max = max.max(min);
        Self { min, max, fps: max }
    }
    pub fn fps(&self) -> f64 {
        self.fps
    }
    pub fn interval(&self) -> Duration {
        Duration::from_secs_f64(1.0 / self.fps)
    }
    /// Work that eats most of the frame slot slows the rate; quick work lets it climb back.
    pub fn record(&mut self, work: Duration) {
        let slot = 1.0 / self.fps;
        let used = work.as_secs_f64() / slot;
        if used > 0.7 {
            self.fps = (self.fps * 0.8).max(self.min);
        } else if used < 0.35 {
            self.fps = (self.fps * 1.1).min(self.max);
        }
    }
}

/// Token bucket in bytes per second; refuses a frame instead of waiting for it.
pub struct ByteBudget {
    rate: f64,
    tokens: f64,
    at: Instant,
}
impl ByteBudget {
    pub fn new(rate: usize) -> Self {
        Self {
            rate: rate as f64,
            tokens: rate as f64,
            at: Instant::now(),
        }
    }
    pub fn take(&mut self, bytes: usize, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.at).as_secs_f64();
        self.at = now;
        self.tokens = (self.tokens + elapsed * self.rate).min(self.rate);
        if (bytes as f64) > self.tokens {
            return false;
        }
        self.tokens -= bytes as f64;
        true
    }
}

/// Tells a producer thread to stop when the stream that feeds on it ends.
#[derive(Clone, Default)]
pub struct Stop(Arc<AtomicBool>);
impl Stop {
    pub fn stopped(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
    pub fn stop(&self) {
        self.0.store(true, Ordering::SeqCst)
    }
}

pub fn response_head() -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary={BOUNDARY}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n"
    )
}

pub fn part_head(frame: &Frame) -> String {
    let meta = frame.meta.replace(['\r', '\n'], " ");
    format!(
        "--{BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\nX-Nova-Frame: {}\r\nX-Nova-Size: {}x{}\r\nX-Nova-Meta: {meta}\r\n\r\n",
        frame.jpeg.len(),
        frame.seq,
        frame.width,
        frame.height
    )
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct PumpStats {
    pub sent: u64,
    pub skipped: u64,
}

/// Writes frames from `slot` to `out` until the viewer goes away, `alive` turns false, the slot closes or
/// `limit` passes. Every frame is flushed at once. Returns what was sent.
pub fn pump(
    out: &mut dyn Write,
    slot: &LatestFrame,
    alive: &dyn Fn() -> bool,
    limit: Duration,
    bytes_per_second: usize,
) -> io::Result<PumpStats> {
    let end = Instant::now() + limit;
    let mut budget = ByteBudget::new(bytes_per_second);
    let mut stats = PumpStats::default();
    let mut last = 0;
    out.write_all(response_head().as_bytes())?;
    out.flush()?;
    while Instant::now() < end && alive() {
        let Some(frame) = slot.next_after(last, Duration::from_millis(500)) else {
            if slot.closed() {
                break;
            }
            continue;
        };
        last = frame.seq;
        if frame.jpeg.len() > MAX_FRAME_BYTES || !budget.take(frame.jpeg.len(), Instant::now()) {
            stats.skipped += 1;
            continue;
        }
        out.write_all(part_head(&frame).as_bytes())?;
        out.write_all(&frame.jpeg)?;
        out.write_all(b"\r\n")?;
        out.flush()?;
        stats.sent += 1;
    }
    let _ = out.write_all(format!("--{BOUNDARY}--\r\n").as_bytes());
    let _ = out.flush();
    Ok(stats)
}

/// Query settings a viewer may ask for, already clamped.
#[derive(Clone, Debug, PartialEq)]
pub struct StreamOptions {
    pub display: u32,
    pub max_width: u32,
    pub fps: u32,
    pub quality: u8,
    pub tab: Option<String>,
}
impl Default for StreamOptions {
    fn default() -> Self {
        Self {
            display: 0,
            max_width: 1280,
            fps: 12,
            quality: 60,
            tab: None,
        }
    }
}
impl StreamOptions {
    pub fn parse(query: &str) -> Result<Self, (u16, String)> {
        let mut options = Self::default();
        let mut seen = Vec::new();
        for (key, raw) in url::form_urlencoded::parse(query.as_bytes()) {
            if seen.contains(&key.to_string()) {
                return Err((400, "Dubbele streamparameter".into()));
            }
            seen.push(key.to_string());
            let number = || {
                raw.parse::<u32>()
                    .map_err(|_| (400, "Ongeldige streamparameter".to_string()))
            };
            match key.as_ref() {
                "display" => options.display = number()?.min(32),
                "maxWidth" => options.max_width = number()?.clamp(320, 1920),
                "fps" => options.fps = number()?.clamp(1, 30),
                "quality" => options.quality = number()?.clamp(30, 90) as u8,
                "tab" => {
                    if raw.is_empty() || raw.len() > 64 || !raw.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
                    {
                        return Err((400, "Ongeldig tabblad".into()));
                    }
                    options.tab = Some(raw.to_string());
                }
                _ => return Err((400, "Onbekende streamparameter".into())),
            }
        }
        Ok(options)
    }
}

/// Runs `capture` on its own thread at an adaptive rate and publishes changed frames into `slot`. An unchanged
/// screen is re-sent at most every two seconds so the viewer knows the stream is alive.
pub fn spawn_capture(
    slot: Arc<LatestFrame>,
    stop: Stop,
    options: StreamOptions,
    capture: impl Fn(&StreamOptions) -> Result<(Vec<u8>, u32, u32), String> + Send + 'static,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        use std::hash::{Hash, Hasher};
        let mut pacer = Pacer::new(2.0, options.fps as f64);
        let mut previous = 0u64;
        let mut repeated_at = Instant::now();
        let mut failures = 0;
        while !stop.stopped() {
            let started = Instant::now();
            match capture(&options) {
                Ok((jpeg, width, height)) => {
                    failures = 0;
                    let mut hasher = std::collections::hash_map::DefaultHasher::new();
                    jpeg.hash(&mut hasher);
                    let hash = hasher.finish();
                    if hash != previous || repeated_at.elapsed() > Duration::from_secs(2) {
                        previous = hash;
                        repeated_at = Instant::now();
                        slot.publish(
                            jpeg,
                            width,
                            height,
                            format!(
                                r#"{{"kind":"desktop","display":{},"fps":{:.1}}}"#,
                                options.display,
                                pacer.fps()
                            ),
                        );
                    }
                }
                Err(_) => {
                    failures += 1;
                    if failures > 10 {
                        break;
                    }
                }
            }
            pacer.record(started.elapsed());
            let wait = pacer.interval().saturating_sub(started.elapsed());
            std::thread::sleep(wait.max(Duration::from_millis(5)));
        }
        slot.close();
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_slow_viewer_drops_frames_instead_of_queueing_them() {
        let slot = LatestFrame::new();
        for n in 0..5 {
            slot.publish(vec![n], 1, 1, "{}".into());
        }
        // Only the newest frame is ever handed out; four were overwritten before anyone read them.
        let frame = slot.next_after(0, Duration::from_millis(10)).unwrap();
        assert_eq!(frame.seq, 5);
        assert_eq!(*frame.jpeg, vec![4]);
        assert_eq!(slot.dropped(), 4);
        assert!(slot.next_after(5, Duration::from_millis(10)).is_none());
        slot.publish(vec![9], 1, 1, "{}".into());
        assert_eq!(slot.next_after(5, Duration::from_millis(10)).unwrap().seq, 6);
        assert_eq!(slot.dropped(), 4, "a frame that was taken is not a dropped frame");
    }

    #[test]
    fn waiting_wakes_on_publish_and_on_close() {
        let slot = LatestFrame::new();
        let producer = slot.clone();
        let worker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            producer.publish(vec![1, 2, 3], 2, 2, "{}".into());
            std::thread::sleep(Duration::from_millis(30));
            producer.close();
        });
        assert_eq!(slot.next_after(0, Duration::from_secs(2)).unwrap().jpeg.len(), 3);
        assert!(slot.next_after(1, Duration::from_secs(2)).is_none());
        assert!(slot.closed());
        worker.join().unwrap();
    }

    #[test]
    fn pacer_slows_down_under_load_and_recovers() {
        let mut pacer = Pacer::new(2.0, 20.0);
        assert_eq!(pacer.fps(), 20.0);
        for _ in 0..30 {
            pacer.record(Duration::from_millis(600));
        }
        assert_eq!(pacer.fps(), 2.0);
        for _ in 0..60 {
            pacer.record(Duration::from_millis(1));
        }
        assert_eq!(pacer.fps(), 20.0);
    }

    #[test]
    fn byte_budget_refuses_bursts_and_refills_over_time() {
        let start = Instant::now();
        let mut budget = ByteBudget::new(1000);
        assert!(budget.take(800, start));
        assert!(!budget.take(800, start));
        assert!(budget.take(800, start + Duration::from_millis(700)));
    }

    #[test]
    fn pump_writes_flushed_multipart_frames_and_skips_oversized_ones() {
        let slot = LatestFrame::new();
        let producer = slot.clone();
        let worker = std::thread::spawn(move || {
            producer.publish(vec![0xff, 0xd8, 1, 0xff, 0xd9], 4, 3, r#"{"kind":"browser"}"#.into());
            std::thread::sleep(Duration::from_millis(40));
            producer.publish(vec![0; MAX_FRAME_BYTES + 1], 4, 3, "{}".into());
            std::thread::sleep(Duration::from_millis(40));
            producer.publish(vec![0xff, 0xd8, 2, 0xff, 0xd9], 4, 3, "{}\r\nX-Evil: 1".into());
            std::thread::sleep(Duration::from_millis(40));
            producer.close();
        });
        let mut out = Vec::new();
        let stats = pump(&mut out, &slot, &|| true, Duration::from_secs(5), 10_000_000).unwrap();
        worker.join().unwrap();
        assert_eq!(stats, PumpStats { sent: 2, skipped: 1 });
        let text = String::from_utf8_lossy(&out);
        assert!(text.starts_with("HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=novaframe"));
        assert_eq!(text.matches("Content-Type: image/jpeg").count(), 2);
        assert!(text.contains("X-Nova-Size: 4x3"));
        assert!(text.contains(r#"X-Nova-Meta: {"kind":"browser"}"#));
        assert!(!text.contains("\r\nX-Evil"), "meta cannot inject headers");
        assert!(text.ends_with("--novaframe--\r\n"));
    }

    #[test]
    fn pump_stops_when_the_owner_pauses() {
        let slot = LatestFrame::new();
        let mut out = Vec::new();
        let started = Instant::now();
        pump(
            &mut out,
            &slot,
            &|| started.elapsed() < Duration::from_millis(50),
            MAX_STREAM,
            1000,
        )
        .unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn stream_options_are_clamped_and_validated() {
        let options = StreamOptions::parse("display=2&maxWidth=99999&fps=120&quality=5&tab=ABC-123").unwrap();
        assert_eq!(
            options,
            StreamOptions {
                display: 2,
                max_width: 1920,
                fps: 30,
                quality: 30,
                tab: Some("ABC-123".into())
            }
        );
        assert!(StreamOptions::parse("fps=1&fps=2").is_err());
        assert!(StreamOptions::parse("tab=../json").is_err());
        assert!(StreamOptions::parse("unknown=1").is_err());
        assert!(StreamOptions::parse("fps=-1").is_err());
        assert_eq!(StreamOptions::parse("").unwrap(), StreamOptions::default());
    }

    #[test]
    fn stream_permits_are_limited_and_released() {
        let held: Vec<_> = std::iter::from_fn(StreamPermit::acquire)
            .take(MAX_STREAMS + 2)
            .collect();
        assert_eq!(held.len(), MAX_STREAMS);
        assert!(StreamPermit::acquire().is_none());
        drop(held);
        assert!(StreamPermit::acquire().is_some());
    }

    #[test]
    fn capture_thread_skips_unchanged_frames_and_stops() {
        let slot = LatestFrame::new();
        let stop = Stop::default();
        let options = StreamOptions {
            fps: 30,
            ..StreamOptions::default()
        };
        let worker = spawn_capture(slot.clone(), stop.clone(), options, |_| Ok((vec![1, 2, 3], 2, 1)));
        std::thread::sleep(Duration::from_millis(200));
        stop.stop();
        worker.join().unwrap();
        // Identical frames are published once (plus a two-second heartbeat), not 30 times a second.
        assert_eq!(slot.next_after(0, Duration::from_millis(10)).unwrap().seq, 1);
        assert!(slot.closed());
    }
}
