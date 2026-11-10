//! CDP screencast of the tab NOVA works in, into a latest-frame slot. Runs on its own DevTools connection, so it
//! never waits for the browser lock. Chrome sends the next frame only after an ack; the ack is held back until the
//! frame interval has passed, which is the backpressure: Chrome coalesces instead of queueing.
use crate::{
    browser::{LiveHandle, LiveTarget},
    live::{LatestFrame, Stop, StreamOptions},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    io::Read,
    net::TcpStream,
    sync::Arc,
    time::{Duration, Instant},
};
use tungstenite::{Message, WebSocket};
use url::Url;

const MESSAGE_LIMIT: usize = 12 * 1024 * 1024;

fn tabs(port: u16) -> Result<Vec<Value>, String> {
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(format!("http://127.0.0.1:{port}/json/list"))
        .send()
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    response
        .take(2 * 1024 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let list: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    Ok(list
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| t["type"] == "page")
        .cloned()
        .collect())
}

/// What the viewer may show above the picture: address, title and the page's CSS viewport.
pub fn frame_meta(tab: &Value, metadata: &Value) -> String {
    let clip = |value: &Value, max: usize| value.as_str().unwrap_or("").chars().take(max).collect::<String>();
    json!({
        "kind": "browser",
        "tab": clip(&tab["id"], 64),
        "url": clip(&tab["url"], 600),
        "title": clip(&tab["title"], 200),
        "vw": metadata["deviceWidth"],
        "vh": metadata["deviceHeight"],
        "scrollY": metadata["scrollOffsetY"],
    })
    .to_string()
}

/// JPEG width and height from its header, without decoding the picture.
pub fn jpeg_size(bytes: &[u8]) -> Option<(u32, u32)> {
    image::ImageReader::with_format(std::io::Cursor::new(bytes), image::ImageFormat::Jpeg)
        .into_dimensions()
        .ok()
}

fn validate_debugger(raw: &str, port: u16) -> Result<(), String> {
    let url = Url::parse(raw).map_err(|e| e.to_string())?;
    if url.scheme() != "ws" || url.host_str() != Some("127.0.0.1") || url.port() != Some(port) {
        return Err("Unexpected browser debugger address".into());
    }
    Ok(())
}

pub fn spawn_screencast(
    target: LiveHandle,
    slot: Arc<LatestFrame>,
    stop: Stop,
    options: StreamOptions,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let current = || target.lock().unwrap_or_else(|e| e.into_inner()).clone();
        while !stop.stopped() {
            let Some(live) = current() else {
                std::thread::sleep(Duration::from_millis(250));
                continue;
            };
            let wanted = options.tab.clone().unwrap_or_else(|| live.id.clone());
            let follow = options.tab.is_none();
            let still = || {
                !stop.stopped()
                    && (!follow
                        || current()
                            .as_ref()
                            .is_some_and(|t: &LiveTarget| t.id == wanted && t.port == live.port))
            };
            if cast(live.port, &wanted, &slot, &options, &still).is_err() {
                std::thread::sleep(Duration::from_millis(500));
            }
        }
        slot.close();
    })
}

fn cast(
    port: u16,
    id: &str,
    slot: &LatestFrame,
    options: &StreamOptions,
    still: &dyn Fn() -> bool,
) -> Result<(), String> {
    let mut tab = tabs(port)?
        .into_iter()
        .find(|t| t["id"].as_str() == Some(id))
        .ok_or("Unknown tab")?;
    let raw = tab["webSocketDebuggerUrl"]
        .as_str()
        .ok_or("Missing debugger")?
        .to_string();
    validate_debugger(&raw, port)?;
    let stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().map_err(|_| "Bad address")?,
        Duration::from_secs(3),
    )
    .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;
    let config = tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(MESSAGE_LIMIT))
        .max_frame_size(Some(MESSAGE_LIMIT));
    let (mut socket, _): (WebSocket<TcpStream>, _) =
        tungstenite::client::client_with_config(raw.as_str(), stream, Some(config)).map_err(|e| e.to_string())?;
    socket
        .get_mut()
        .set_read_timeout(Some(Duration::from_millis(300)))
        .map_err(|e| e.to_string())?;
    let height = options.max_width * 10 / 16;
    let start = json!({"id":1,"method":"Page.startScreencast","params":{
        "format":"jpeg","quality":options.quality,"maxWidth":options.max_width,"maxHeight":height.max(240),"everyNthFrame":1}});
    socket
        .send(Message::Text(start.to_string().into()))
        .map_err(|e| e.to_string())?;
    let interval = Duration::from_secs_f64(1.0 / options.fps.max(1) as f64);
    let mut last = Instant::now() - interval;
    let mut refreshed = Instant::now();
    let mut next = 2u64;
    let result = loop {
        if !still() {
            break Ok(());
        }
        // Address and title change on navigation; the frame metadata has neither.
        if refreshed.elapsed() > Duration::from_secs(1) {
            refreshed = Instant::now();
            if let Some(fresh) = tabs(port)
                .ok()
                .and_then(|list| list.into_iter().find(|t| t["id"] == tab["id"]))
            {
                tab = fresh;
            }
        }
        let message = match socket.read() {
            Ok(message) => message,
            Err(tungstenite::Error::Io(e))
                if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) =>
            {
                continue
            }
            Err(e) => break Err(e.to_string()),
        };
        let Message::Text(text) = message else { continue };
        let Ok(event) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if event["method"] != "Page.screencastFrame" {
            continue;
        }
        let params = &event["params"];
        let session = params["sessionId"].clone();
        if let Some(jpeg) = params["data"].as_str().and_then(|data| STANDARD.decode(data).ok()) {
            // Hold the ack until the frame slot has passed: Chrome waits and coalesces.
            let wait = interval.saturating_sub(last.elapsed());
            if !wait.is_zero() {
                std::thread::sleep(wait);
            }
            last = Instant::now();
            let (width, height) = jpeg_size(&jpeg).unwrap_or((0, 0));
            slot.publish(jpeg, width, height, frame_meta(&tab, &params["metadata"]));
        }
        let ack = json!({"id":next,"method":"Page.screencastFrameAck","params":{"sessionId":session}});
        next += 1;
        if let Err(e) = socket.send(Message::Text(ack.to_string().into())) {
            break Err(e.to_string());
        }
    };
    let stop = json!({"id":next,"method":"Page.stopScreencast","params":{}});
    let _ = socket.send(Message::Text(stop.to_string().into()));
    let _ = socket.close(None);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debugger_must_be_this_browser_on_loopback() {
        assert!(validate_debugger("ws://127.0.0.1:9222/devtools/page/A", 9222).is_ok());
        assert!(validate_debugger("ws://127.0.0.1:9333/devtools/page/A", 9222).is_err());
        assert!(validate_debugger("ws://10.0.0.2:9222/devtools/page/A", 9222).is_err());
        assert!(validate_debugger("wss://127.0.0.1:9222/devtools/page/A", 9222).is_err());
    }

    #[test]
    fn frame_meta_is_one_bounded_json_line() {
        let tab =
            json!({"id":"T1","url":format!("https://example.org/{}", "a".repeat(2000)),"title":"Hi\r\nX-Evil: 1"});
        let meta = frame_meta(&tab, &json!({"deviceWidth":1280,"deviceHeight":720,"scrollOffsetY":12}));
        assert!(!meta.contains('\n') && !meta.contains('\r'));
        let parsed: Value = serde_json::from_str(&meta).unwrap();
        assert_eq!(parsed["vw"], 1280);
        assert_eq!(parsed["url"].as_str().unwrap().chars().count(), 600);
    }

    #[test]
    fn jpeg_size_reads_the_header_only() {
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 50)
            .encode(&[0u8; 8 * 4 * 3], 8, 4, image::ExtendedColorType::Rgb8)
            .unwrap();
        assert_eq!(jpeg_size(&jpeg), Some((8, 4)));
        assert_eq!(jpeg_size(b"not a jpeg"), None);
    }
}
