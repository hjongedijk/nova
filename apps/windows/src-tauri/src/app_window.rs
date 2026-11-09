//! The NOVA application window: one normal Windows window (taskbar, Alt+Tab, snap, dark title bar) with the
//! status, display choices, pairing, start-up and updates. The tray menu only holds the few quick actions; every
//! setting lives here. It is a local page (`ui/`), never the remote NOVA site, and the only window that may pair,
//! open the firewall or install updates.
use crate::state::Shared;
use crate::windows_ops::{app_address, monitors, open_external, HELPER};
use crate::{app, log, tray, win};
use nova_win_core::args::{Args, WallpaperArg};
use nova_win_core::geometry::{resolve_display, Rect};
use nova_win_core::mode::{apply_event, Event, Mode, WallpaperStyle};
use nova_win_core::view::View;
use nova_win_core::window_state::{self, WindowState};
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;
use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

pub const LABEL: &str = "setup";
/// NOVA's navy, painted by the window before the page loads: no white flash.
const BACKGROUND: tauri::window::Color = tauri::window::Color(9, 19, 33, 255);

/// The last size and place while the window was neither maximized nor minimized.
static LAST_NORMAL: Mutex<Option<Rect>> = Mutex::new(None);

fn state_path(app: &AppHandle) -> std::path::PathBuf {
    app.state::<Shared>().lock().config_path.with_file_name("window.json")
}

fn remember(window: &WebviewWindow) {
    if window.is_maximized().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
        return;
    }
    if let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) {
        if let Ok(mut last) = LAST_NORMAL.lock() {
            *last = Some(Rect::new(pos.x, pos.y, size.width as i32, size.height as i32));
        }
    }
}

fn save_state(window: &WebviewWindow) {
    let Some(rect) = LAST_NORMAL.lock().ok().and_then(|l| *l) else {
        return;
    };
    let state = WindowState {
        x: rect.x,
        y: rect.y,
        width: rect.w,
        height: rect.h,
        maximized: window.is_maximized().unwrap_or(false),
    };
    if let Err(error) = nova_win_core::agent::atomic_save(&state_path(window.app_handle()), &state.to_json()) {
        log!("window.json could not be saved: {error}");
    }
}

/// Opens the window, or brings it to the front when it is already open.
pub fn open(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    // Its own browser profile: it must not share one with the NOVA windows, which start WebView2 with other arguments.
    let profile = app.state::<Shared>().lock().profile_dir.with_file_name("setup-profile");
    let saved = std::fs::read_to_string(state_path(app))
        .ok()
        .and_then(|text| WindowState::parse(&text));
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("NOVA")
        .inner_size(window_state::DEFAULT_WIDTH, window_state::DEFAULT_HEIGHT)
        .min_inner_size(window_state::MIN_WIDTH, window_state::MIN_HEIGHT)
        .center()
        .resizable(true)
        .visible(false)
        .theme(Some(tauri::Theme::Dark))
        .background_color(BACKGROUND)
        .zoom_hotkeys_enabled(false)
        .data_directory(profile)
        .on_navigation(|url| url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost"))
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .build();
    let window = match built {
        Ok(window) => window,
        Err(error) => {
            log!("could not open the NOVA window: {error}");
            return;
        }
    };
    crate::webview::harden(&window, crate::webview::Kind::App, None);
    if let Some(state) = saved {
        if let Some(rect) = window_state::restore(&state, &monitors(app)) {
            let _ = window.set_size(PhysicalSize::new(rect.w as u32, rect.h as u32));
            let _ = window.set_position(PhysicalPosition::new(rect.x, rect.y));
            if let Ok(mut last) = LAST_NORMAL.lock() {
                *last = Some(rect);
            }
        }
        if state.maximized {
            let _ = window.maximize();
        }
    }
    let handle = window.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => remember(&handle),
        tauri::WindowEvent::CloseRequested { .. } => save_state(&handle),
        _ => {}
    });
    // Should the page never report that it loaded, still show the window.
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(2500));
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(window) = handle.get_webview_window(LABEL) {
                if !window.is_visible().unwrap_or(true) {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });
    });
}

/// Everything the window shows. No pairing code: that is requested separately.
pub fn snapshot(app: &AppHandle) -> Value {
    let list = monitors(app);
    let helper_open = app
        .get_webview_window(HELPER)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    let autostart = win::autostart_enabled();
    let shared = app.state::<Shared>();
    let inner = shared.lock();
    let current = if list.is_empty() {
        0
    } else {
        resolve_display(&list, inner.config.helper_display.as_deref(), 0) + 1
    };
    let displays: Vec<Value> = list
        .iter()
        .enumerate()
        .map(|(i, m)| {
            json!({
                "index": i + 1,
                "width": m.bounds.w,
                "height": m.bounds.h,
                "primary": m.primary,
                "wallpaper": inner.desired.wallpapers.contains_key(&m.name),
            })
        })
        .collect();
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "url": inner.config.url,
        "listening": crate::agent_http::listening(),
        "agentError": inner.agent_error,
        "port": inner.agent.port,
        "mode": inner.desired.mode.as_str(),
        "helperWanted": inner.desired.helper_visible,
        "helperOpen": helper_open,
        "helperDisplay": current,
        "displays": displays,
        "autostart": autostart,
        "paused": inner.paused,
        "emergencyReady": inner.emergency_ready,
        "elevated": crate::platform::is_elevated(),
        "hotkeys": inner.agent.hotkeys,
        "hotkeyWarnings": inner.hotkey_warnings,
    })
}

/// Tells an open window that something changed (called whenever the tray menu is rebuilt).
pub fn publish(app: &AppHandle) {
    if app.get_webview_window(LABEL).is_some() {
        let _ = app.emit_to(LABEL, "nova-app-state", snapshot(app));
    }
}

fn only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == LABEL {
        Ok(())
    } else {
        Err("Niet toegestaan voor dit venster".into())
    }
}

fn on_main(app: &AppHandle, work: impl FnOnce(&AppHandle) + Send + 'static) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        work(&handle);
        tray::rebuild(&handle);
    })
    .map_err(|_| "NOVA sluit af".to_string())
}

#[tauri::command]
pub async fn app_state(window: WebviewWindow, app: AppHandle) -> Result<Value, String> {
    only(&window)?;
    Ok(snapshot(&app))
}

#[tauri::command]
pub async fn app_set_mode(window: WebviewWindow, app: AppHandle, mode: String) -> Result<(), String> {
    only(&window)?;
    let mode = Mode::parse(&mode).ok_or("Onbekende weergave")?;
    on_main(&app, move |app| {
        app::handle_args(
            app,
            Args {
                mode: Some(mode),
                ..Args::default()
            },
        )
    })
}

#[tauri::command]
pub async fn app_set_helper_display(window: WebviewWindow, app: AppHandle, index: u32) -> Result<(), String> {
    only(&window)?;
    if index == 0 || index as usize > monitors(&app).len() {
        return Err(format!("Scherm {index} bestaat niet"));
    }
    on_main(&app, move |app| {
        app::handle_args(
            app,
            Args {
                display: Some(index),
                ..Args::default()
            },
        )
    })
}

#[tauri::command]
pub async fn app_set_wallpaper(window: WebviewWindow, app: AppHandle, index: u32, on: bool) -> Result<(), String> {
    only(&window)?;
    if index == 0 || index as usize > monitors(&app).len() {
        return Err(format!("Scherm {index} bestaat niet"));
    }
    on_main(&app, move |app| {
        app::handle_args(
            app,
            Args {
                wallpapers: vec![WallpaperArg {
                    display: index,
                    style: on.then_some(WallpaperStyle::Full),
                }],
                ..Args::default()
            },
        )
    })
}

#[tauri::command]
pub async fn app_set_helper_visible(window: WebviewWindow, app: AppHandle, visible: bool) -> Result<(), String> {
    only(&window)?;
    if !app.state::<Shared>().lock().desired.mode.wants_helper() {
        return Err("Kies eerst een weergave met de helper".into());
    }
    on_main(&app, move |app| {
        {
            let shared = app.state::<Shared>();
            let mut inner = shared.lock();
            let event = if visible { Event::ShowHelper } else { Event::HideHelper };
            inner.desired = apply_event(inner.desired.clone(), event);
        }
        app::apply(app);
    })
}

#[tauri::command]
pub async fn app_show_login(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    only(&window)?;
    if !app.state::<Shared>().lock().config.mode.wants_helper() {
        return Err("Kies eerst een weergave met de helper".into());
    }
    on_main(&app, |app| {
        app::handle_args(
            app,
            Args {
                view: Some(View::Chat),
                show: true,
                ..Args::default()
            },
        )
    })
}

#[tauri::command]
pub async fn app_open_browser(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    only(&window)?;
    let url = app_address(&app).ok_or("Stel eerst het adres van NOVA in")?;
    open_external(&app, &url);
    Ok(())
}

#[tauri::command]
pub async fn app_set_autostart(window: WebviewWindow, app: AppHandle, on: bool) -> Result<(), String> {
    only(&window)?;
    // Registering the start-up task runs schtasks; keep it off the window thread.
    let result = tauri::async_runtime::spawn_blocking(move || win::set_autostart(on))
        .await
        .map_err(|e| e.to_string())?;
    let _ = on_main(&app, |_| {});
    result.map_err(|error| {
        log!("start with Windows: {error}");
        format!("Starten met Windows kon niet worden aangepast: {error}")
    })
}

#[tauri::command]
pub async fn app_set_paused(window: WebviewWindow, app: AppHandle, paused: bool) -> Result<(), String> {
    only(&window)?;
    on_main(&app, move |app| {
        if app.state::<Shared>().lock().paused != paused {
            if paused {
                crate::controls::stop(app);
            } else {
                crate::controls::toggle_pause(app);
            }
        }
    })
}
