//! Shared state. Rule: never call a window function while holding the lock. Moving or resizing a window makes
//! Windows call back into the event handlers on the same thread, and they lock too.

use nova_win_core::config::DeskConfig;
use nova_win_core::mode::{Desired, WallpaperSpec};
use nova_win_core::view::View;
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

pub struct Shared {
    pub inner: Mutex<Inner>,
}

pub struct Inner {
    pub config: DeskConfig,
    pub agent: nova_win_core::agent::AgentConfig,
    pub agent_error: Option<String>,
    pub paused: bool,
    pub hotkey_warnings: Vec<String>,
    pub notifications: std::collections::VecDeque<String>,
    pub helper_ready: bool,
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
    pub fn try_save(&self) -> Result<(), String> {
        let text = nova_win_core::agent::encode(&self.config, &self.agent);
        nova_win_core::agent::atomic_save(&self.config_path, &text)
    }

    pub fn save(&self) {
        if let Err(error) = self.try_save() {
            crate::log!("config.json could not be saved: {error}");
        }
    }
}
