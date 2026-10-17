//! The commands a page can call. Each one is its own permission (see build.rs and the capabilities), the helper
//! commands check that they come from the helper window, and none of them takes a path, a command line or a script.

use crate::state::Shared;
use crate::windows_ops::{apply_layout, monitors, HELPER};
use crate::{app, log, tray};
use nova_desk_core::geometry::resolve_display;
use nova_desk_core::nav::normalize_origin;
use nova_desk_core::view::View;
use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayDto {
    index: u32,
    name: String,
    primary: bool,
    width: i32,
    height: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InfoDto {
    version: &'static str,
    /// 1-based number of the display the helper is on.
    display: u32,
    displays: Vec<DisplayDto>,
    fullscreen: bool,
}

fn only(window: &WebviewWindow, label: &str) -> Result<(), String> {
    if window.label() == label {
        Ok(())
    } else {
        Err("niet toegestaan voor dit venster".into())
    }
}

#[tauri::command]
pub async fn desk_info(window: WebviewWindow, app: AppHandle) -> Result<InfoDto, String> {
    only(&window, HELPER)?;
    let list = monitors(&app);
    let shared = app.state::<Shared>();
    let (current, fullscreen) = {
        let inner = shared.lock();
        (
            resolve_display(&list, inner.config.helper_display.as_deref(), 0),
            inner.fullscreen,
        )
    };
    Ok(InfoDto {
        version: env!("CARGO_PKG_VERSION"),
        display: current as u32 + 1,
        displays: list
            .iter()
            .enumerate()
            .map(|(i, m)| DisplayDto {
                index: i as u32 + 1,
                name: m.name.clone(),
                primary: m.primary,
                width: m.bounds.w,
                height: m.bounds.h,
            })
            .collect(),
        fullscreen,
    })
}

/// Moves the helper to another display (1-based) and remembers it.
#[tauri::command]
pub async fn desk_set_display(window: WebviewWindow, app: AppHandle, index: u32) -> Result<(), String> {
    only(&window, HELPER)?;
    let list = monitors(&app);
    let name = index
        .checked_sub(1)
        .and_then(|i| list.get(i as usize))
        .map(|m| m.name.clone())
        .ok_or_else(|| format!("scherm {index} bestaat niet"))?;
    {
        let shared = app.state::<Shared>();
        let mut inner = shared.lock();
        inner.config.helper_display = Some(name);
        inner.fullscreen = false;
        inner.save();
    }
    let handle = app.clone();
    app.run_on_main_thread(move || {
        apply_layout(&handle);
        tray::rebuild(&handle);
    })
    .map_err(|e| e.to_string())
}

/// The panel changes view (and may be the thin autohide strip): the window follows.
#[tauri::command]
pub async fn desk_set_view(window: WebviewWindow, app: AppHandle, view: String, hidden: bool) -> Result<(), String> {
    only(&window, HELPER)?;
    let view = View::parse(&view).ok_or("onbekende weergave")?;
    {
        let shared = app.state::<Shared>();
        let mut inner = shared.lock();
        inner.view = view;
        inner.hidden = hidden;
        if !hidden && view.is_persistent() {
            inner.config.helper_view = view;
            inner.save();
        }
    }
    let handle = app.clone();
    app.run_on_main_thread(move || apply_layout(&handle))
        .map_err(|e| e.to_string())
}

/// The "hide" button: the helper goes away until the tray (or a notification) brings it back.
#[tauri::command]
pub async fn desk_hide_helper(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    only(&window, HELPER)?;
    app::helper_hidden_by_user(&app);
    Ok(())
}

/// The expand button: the helper covers the work area of its display, or goes back to its size.
#[tauri::command]
pub async fn desk_set_fullscreen(window: WebviewWindow, app: AppHandle, on: bool) -> Result<(), String> {
    only(&window, HELPER)?;
    app.state::<Shared>().lock().fullscreen = on;
    let handle = app.clone();
    app.run_on_main_thread(move || apply_layout(&handle))
        .map_err(|e| e.to_string())
}

/// First-run page only: the address of NOVA.
#[tauri::command]
pub async fn desk_set_url(window: WebviewWindow, app: AppHandle, url: String) -> Result<(), String> {
    only(&window, "setup")?;
    let origin = normalize_origin(&url).map_err(|e| e.to_string())?;
    {
        let shared = app.state::<Shared>();
        let mut inner = shared.lock();
        inner.config.url = Some(origin);
        inner.save();
    }
    log!("the NOVA address was set from the setup page");
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Some(setup) = handle.get_webview_window("setup") {
            let _ = setup.destroy();
        }
        app::start(&handle);
    })
    .map_err(|e| e.to_string())
}
