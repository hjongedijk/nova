//! Slow capture/CDP work stays off the GUI thread. Desktop leases are never persisted.
use crate::state::Shared;
use nova_win_agent::{browser::Browser, desktop::Desktop, transport::Outcome};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Manager};
pub struct Automation {
    pub desktop: Mutex<Desktop>,
    pub browser: Mutex<Browser>,
    pub epoch: Arc<AtomicU64>,
}
pub fn init(app: &AppHandle, dir: &std::path::Path) {
    let mut browser = Browser::new(dir.join("browser-profile"));
    let preferences = app
        .state::<Shared>()
        .lock()
        .agent
        .legacy_preferences
        .get("browser")
        .cloned()
        .unwrap_or(json!({}));
    browser.configure(&preferences);
    app.manage(Automation {
        desktop: Mutex::new(Desktop::default()),
        browser: Mutex::new(browser),
        epoch: Arc::new(AtomicU64::new(0)),
    });
}
pub fn cancel(app: &AppHandle) {
    app.state::<Automation>().epoch.fetch_add(1, Ordering::SeqCst);
}
pub fn shutdown_browser(app: &AppHandle) {
    app.state::<Automation>()
        .browser
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .shutdown();
}
pub fn shutdown(app: &AppHandle) {
    if app.try_state::<Automation>().is_some() {
        cancel(app);
        disarm(app);
        shutdown_browser(app);
    }
}
pub fn disarm(app: &AppHandle) {
    app.state::<Automation>()
        .desktop
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .disarm();
}
pub fn route(app: &AppHandle, path: &str, body: Value) -> Outcome {
    if path.starts_with("/v1/desktop/") {
        let runtime = app.state::<Automation>();
        let mut desktop = runtime.desktop.lock().unwrap_or_else(|e| e.into_inner());
        let (permissions, paused, ready, expected) = {
            let shared = app.state::<Shared>();
            let inner = shared.lock();
            (
                inner.agent.automation.clone(),
                inner.paused,
                inner.emergency_ready,
                runtime.epoch.load(Ordering::SeqCst),
            )
        };
        let result = desktop.route_guarded(
            path,
            &body,
            permissions.view,
            permissions.control && ready,
            paused,
            &|| runtime.epoch.load(Ordering::SeqCst) != expected,
        );
        if path == "/v1/desktop/screenshot" && runtime.epoch.load(Ordering::SeqCst) != expected {
            return Err((409, "Schermbeeld ophalen is gestopt".into()));
        }
        return result;
    }
    let runtime = app.state::<Automation>();
    let mut browser = runtime.browser.lock().unwrap_or_else(|e| e.into_inner());
    let (enabled, paused, expected) = {
        let shared = app.state::<Shared>();
        let inner = shared.lock();
        (
            inner.agent.automation.browser,
            inner.paused,
            runtime.epoch.load(Ordering::SeqCst),
        )
    };
    if !enabled || paused {
        if path == "/v1/browser/status" {
            return Ok(json!({"ok":true,"enabled":false,"paused":paused,"running":false,"tabs":[]}));
        }
        return Err((403, "Browserbediening staat uit of is gepauzeerd".into()));
    }
    browser.route_guarded(path, &body, runtime.epoch.clone(), expected)
}
