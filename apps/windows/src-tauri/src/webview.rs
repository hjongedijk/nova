//! Makes NOVA's WebView2 windows behave like an application instead of a browser tab: no browser shortcuts
//! (F5, Ctrl+P, Ctrl+F, F12), no zoom or pinch, no status bar, no developer tools in release builds, and for the
//! NOVA pages a Dutch "not reachable" screen that retries by itself instead of Edge's error page.
use crate::log;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::WebviewWindow;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// The local app window (settings, pairing, updates).
    App,
    /// The helper: keeps the page's own context menu for copy/paste in the chat field.
    Helper,
    Wallpaper,
}

/// Labels that may show the built-in offline page once (a `data:` navigation), set right before it is shown.
static OFFLINE_PENDING: Mutex<Option<HashSet<String>>> = Mutex::new(None);
/// Failed loads in a row per window, for the retry delay.
static FAILURES: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);

/// Whether the navigation guard lets this `data:` load through: only NOVA's own offline page, once.
pub fn take_offline_permit(label: &str) -> bool {
    OFFLINE_PENDING
        .lock()
        .ok()
        .and_then(|mut set| set.as_mut().map(|set| set.remove(label)))
        .unwrap_or(false)
}

fn failures(label: &str, reset: bool) -> u32 {
    let Ok(mut map) = FAILURES.lock() else { return 0 };
    let map = map.get_or_insert_with(HashMap::new);
    if reset {
        map.remove(label);
        return 0;
    }
    let count = map.entry(label.to_string()).or_insert(0);
    let current = *count;
    *count = count.saturating_add(1);
    current
}

#[cfg(windows)]
pub fn harden(window: &WebviewWindow, kind: Kind, retry: Option<(String, String)>) {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{CoTaskMemPWSTR, NavigationCompletedEventHandler};
    use windows_webview::core::Interface;
    let label = window.label().to_string();
    let result = window.with_webview(move |platform| unsafe {
        let Ok(webview) = platform.controller().CoreWebView2() else {
            return;
        };
        if let Ok(settings) = webview.Settings() {
            let _ = settings.SetIsStatusBarEnabled(false);
            let _ = settings.SetIsZoomControlEnabled(false);
            let _ = settings.SetAreDevToolsEnabled(cfg!(debug_assertions));
            // The app window and the wallpaper have no use for "Back / Reload / Save as / Print / Inspect".
            if kind != Kind::Helper {
                let _ = settings.SetAreDefaultContextMenusEnabled(false);
            }
            if retry.is_some() {
                let _ = settings.SetIsBuiltInErrorPageEnabled(false);
            }
            if let Ok(settings) = settings.cast::<ICoreWebView2Settings3>() {
                // Editing keys (copy, paste, undo, select all) keep working; browser features do not.
                let _ = settings.SetAreBrowserAcceleratorKeysEnabled(false);
            }
            if let Ok(settings) = settings.cast::<ICoreWebView2Settings5>() {
                let _ = settings.SetIsPinchZoomEnabled(false);
            }
            if let Ok(settings) = settings.cast::<ICoreWebView2Settings6>() {
                let _ = settings.SetIsSwipeNavigationEnabled(false);
            }
        }
        let Some((origin, target)) = retry else { return };
        let handler = NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
            let (Some(sender), Some(args)) = (sender, args) else {
                return Ok(());
            };
            let mut success = windows_webview::core::BOOL(0);
            args.IsSuccess(&mut success)?;
            if success.as_bool() {
                let mut source = windows_webview::core::PWSTR::null();
                if sender.Source(&mut source).is_ok() {
                    let url = webview2_com::take_pwstr(source);
                    if url.starts_with(&origin) {
                        failures(&label, true);
                    }
                }
                return Ok(());
            }
            let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
            args.WebErrorStatus(&mut status)?;
            // A link that opened in the default browser cancels this navigation: that is not an outage.
            if status == COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED
                || status == COREWEBVIEW2_WEB_ERROR_STATUS_VALID_AUTHENTICATION_CREDENTIALS_REQUIRED
            {
                return Ok(());
            }
            let attempt = failures(&label, false);
            let wait = nova_win_core::backoff::page_reload(attempt).as_secs();
            if attempt == 0 {
                log!(
                    "{label}: NOVA is not reachable (WebView2 status {}); retrying",
                    status.0
                );
            }
            if let Ok(mut set) = OFFLINE_PENDING.lock() {
                set.get_or_insert_with(HashSet::new).insert(label.clone());
            }
            let page = CoTaskMemPWSTR::from(nova_win_core::nav::offline_page(&target, wait).as_str());
            if sender.NavigateToString(*page.as_ref().as_pcwstr()).is_err() {
                take_offline_permit(&label);
            }
            Ok(())
        }));
        let mut token = 0i64;
        if let Err(error) = webview.add_NavigationCompleted(&handler, &mut token) {
            log!("could not watch page loads: {error}");
        }
    });
    if let Err(error) = result {
        log!("could not configure the window's browser: {error}");
    }
}

#[cfg(not(windows))]
pub fn harden(_window: &WebviewWindow, _kind: Kind, _retry: Option<(String, String)>) {}

/// Forget retry state of a window that is closed.
pub fn forget(label: &str) {
    failures(label, true);
    take_offline_permit(label);
}
