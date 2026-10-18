//! A tiny log file (`desk.log` next to `desk.json`) for troubleshooting on a real PC. It never holds addresses with
//! credentials, tokens or page content; it is cut to its last part when it grows past 256 KB.

use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

static PATH: OnceLock<PathBuf> = OnceLock::new();
const MAX_BYTES: u64 = 256 * 1024;

pub fn init(path: PathBuf) {
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > MAX_BYTES {
            let _ = std::fs::remove_file(&path);
        }
    }
    let _ = PATH.set(path);
}

pub fn line(message: &str) {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let text = format!("[{secs}] {message}\n");
    eprint!("{text}");
    if let Some(path) = PATH.get() {
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = file.write_all(text.as_bytes());
        }
    }
}

#[macro_export]
macro_rules! log {
    ($($arg:tt)*) => { $crate::log::line(&format!($($arg)*)) };
}
