//! Shared state. Rule: never call a window function while holding the lock. Moving or resizing a window makes
//! Windows call back into the event handlers on the same thread, and they lock too.

use nova_desk_core::config::DeskConfig;
use nova_desk_core::mode::{Desired, WallpaperSpec};
use nova_desk_core::view::View;
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

pub struct Shared {
    pub inner: Mutex<Inner>,
}

pub struct Inner {
    pub config: DeskConfig,
    pub config_path: PathBuf,
    pub profile_dir: PathBuf,
    pub desired: Desired,
    /// The view the page asked for last, and whether it is the thin autohide strip.
    pub view: View,
    pub hidden: bool,
    pub fullscreen: bool,
    /// Wallpaper windows that exist (by monitor name).
    pub wallpapers: BTreeMap<String, WallpaperSpec>,
    /// Origins that were given the helper's page commands.
    pub granted: HashSet<String>,
    /// Moves caused by the app itself are not the user dragging.
    pub ignore_moves_until: Instant,
    pub last_move: Instant,
    pub commit_pending: bool,
    pub monitor_fingerprint: String,
}

impl Shared {
    pub fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Inner {
    pub fn save(&self) {
        if let Some(parent) = self.config_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let temp = self.config_path.with_extension("json.tmp");
        let text = self.config.to_json();
        if std::fs::write(&temp, text).is_ok() && std::fs::rename(&temp, &self.config_path).is_err() {
            let _ = std::fs::remove_file(&self.config_path);
            let _ = std::fs::rename(&temp, &self.config_path);
        }
    }
}
