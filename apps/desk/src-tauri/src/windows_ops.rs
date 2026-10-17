//! Creating, placing and closing the NOVA windows. All geometry comes from `nova-desk-core`.

use crate::state::Shared;
use crate::{log, win};
use nova_desk_core::desktop::{decide, Decision};
use nova_desk_core::geometry::{
    fullscreen_rect, monitor_for_rect, offset_from_position, place, resolve_display, taskbar_px, virtual_origin,
    wallpaper_child_rect, window_size, MonitorInfo, Rect,
};
use nova_desk_core::mode::WallpaperSpec;
use nova_desk_core::nav::{app_url, browser_args, classify, helper_url, wallpaper_url, Navigation};
use std::time::{Duration, Instant};
use tauri::ipc::CapabilityBuilder;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

pub const HELPER: &str = "helper";

/// Runs inside every NOVA page before it loads: marks it as a desk window, so the page is transparent from the first
/// paint (no flash of a rectangular background).
const DESK_SCRIPT: &str =
    "try { document.documentElement.classList.add('desk'); window.__NOVA_DESK__ = true; } catch (e) {}";

pub fn open_external(app: &AppHandle, url: &str) {
    if let Err(error) = app.opener().open_url(url, None::<&str>) {
        log!("could not open {url} in the browser: {error}");
    }
}

pub fn monitors(app: &AppHandle) -> Vec<MonitorInfo> {
    let list = app.available_monitors().unwrap_or_default();
    let primary = app.primary_monitor().ok().flatten();
    list.iter()
        .enumerate()
        .map(|(i, m)| {
            let name = m.name().cloned().unwrap_or_else(|| format!("monitor-{}", i + 1));
            let rect =
                |p: &PhysicalPosition<i32>, s: &PhysicalSize<u32>| Rect::new(p.x, p.y, s.width as i32, s.height as i32);
            let work = m.work_area();
            MonitorInfo {
                name,
                bounds: rect(m.position(), m.size()),
                work: rect(&work.position, &work.size),
                scale: m.scale_factor(),
                primary: primary
                    .as_ref()
                    .map(|p| p.position() == m.position() && p.size() == m.size())
                    .unwrap_or(i == 0),
            }
        })
        .collect()
}

pub fn fingerprint(monitors: &[MonitorInfo]) -> String {
    monitors
        .iter()
        .map(|m| {
            format!(
                "{}@{},{},{}x{}/{}",
                m.name, m.bounds.x, m.bounds.y, m.bounds.w, m.bounds.h, m.scale
            )
        })
        .collect::<Vec<_>>()
        .join(";")
}

/// Gives the helper window of this NOVA origin the few commands it needs; no other window and no other origin.
pub fn grant_origin(app: &AppHandle, origin: &str) {
    let shared = app.state::<Shared>();
    let number = {
        let mut inner = shared.lock();
        if !inner.granted.insert(origin.to_string()) {
            return;
        }
        inner.granted.len()
    };
    let capability = CapabilityBuilder::new(format!("desk-helper-{number}"))
        .remote(format!("{origin}/*"))
        .local(false)
        .window(HELPER)
        .permission("allow-desk-info")
        .permission("allow-desk-set-display")
        .permission("allow-desk-set-view")
        .permission("allow-desk-hide-helper")
        .permission("allow-desk-set-fullscreen")
        .permission("core:window:allow-start-dragging");
    if let Err(error) = app.add_capability(capability) {
        log!("could not grant the helper its commands: {error}");
    }
}

fn guard(app: &AppHandle, origin: String) -> impl Fn(&url::Url) -> bool + Send + 'static {
    let app = app.clone();
    move |target| match classify(target, &origin) {
        Navigation::Allow => true,
        Navigation::External => {
            open_external(&app, target.as_str());
            false
        }
        Navigation::Block => {
            log!("blocked navigation to a {} address", target.scheme());
            false
        }
    }
}

fn new_window_guard(
    app: &AppHandle,
    origin: String,
) -> impl Fn(url::Url, tauri::webview::NewWindowFeatures) -> NewWindowResponse<tauri::Wry> + Send + 'static {
    let app = app.clone();
    move |target, _features| {
        // Links that want their own window (target="_blank") open in the default browser, never inside NOVA Desk.
        match classify(&target, &origin) {
            Navigation::Allow | Navigation::External => open_external(&app, target.as_str()),
            Navigation::Block => log!("blocked a new window for a {} address", target.scheme()),
        }
        NewWindowResponse::Deny
    }
}

fn builder<'a>(
    app: &'a AppHandle,
    label: &str,
    url: &str,
    origin: &str,
    profile: std::path::PathBuf,
) -> Option<WebviewWindowBuilder<'a, tauri::Wry, AppHandle>> {
    let parsed: url::Url = url.parse().ok()?;
    Some(
        WebviewWindowBuilder::new(app, label, WebviewUrl::External(parsed))
            .decorations(false)
            .shadow(false)
            .resizable(false)
            .skip_taskbar(true)
            .visible(false)
            .focused(false)
            .data_directory(profile)
            .additional_browser_args(&browser_args(origin))
            .disable_drag_drop_handler()
            .initialization_script(DESK_SCRIPT)
            .on_navigation(guard(app, origin.to_string()))
            .on_new_window(new_window_guard(app, origin.to_string())),
    )
}

pub fn create_helper(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(existing) = app.get_webview_window(HELPER) {
        return Some(existing);
    }
    let shared = app.state::<Shared>();
    let (origin, view, profile) = {
        let inner = shared.lock();
        (
            inner.config.url.clone()?,
            inner.config.helper_view,
            inner.profile_dir.clone(),
        )
    };
    grant_origin(app, &origin);
    let url = helper_url(&origin, view);
    let built = builder(app, HELPER, &url, &origin, profile)?
        .title("NOVA helper")
        .transparent(true)
        .always_on_top(true)
        .build();
    match built {
        Ok(window) => {
            let handle = app.clone();
            window.on_window_event(move |event| match event {
                tauri::WindowEvent::Moved(_) => on_moved(&handle),
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // Closing the helper hides it; the tray brings it back.
                    api.prevent_close();
                    crate::app::helper_hidden_by_user(&handle);
                }
                _ => {}
            });
            Some(window)
        }
        Err(error) => {
            log!("could not open the helper window: {error}");
            None
        }
    }
}

/// Size and position of the helper for the current display, view, and the user's dragged offset.
pub fn apply_layout(app: &AppHandle) {
    let Some(window) = app.get_webview_window(HELPER) else {
        return;
    };
    let list = monitors(app);
    if list.is_empty() {
        return;
    }
    let shared = app.state::<Shared>();
    let (target, size, pos) = {
        let inner = shared.lock();
        let index = resolve_display(&list, inner.config.helper_display.as_deref(), 0);
        let monitor = &list[index];
        if inner.fullscreen {
            let r = fullscreen_rect(&monitor.work);
            (index, (r.w, r.h), (r.x, r.y))
        } else {
            let size = window_size(inner.view, inner.hidden, monitor.scale, &monitor.work);
            let offset = inner.config.positions.get(&monitor.name).copied().unwrap_or_default();
            (
                index,
                size,
                place(inner.config.helper_anchor, offset, size, &monitor.work, monitor.scale),
            )
        }
    };
    let _ = target;
    {
        let mut inner = shared.lock();
        inner.ignore_moves_until = Instant::now() + Duration::from_millis(800);
    }
    // Resize first and move second: the other way round, a bigger window could briefly stick out of the screen.
    let _ = window.set_size(PhysicalSize::new(size.0.max(1) as u32, size.1.max(1) as u32));
    let _ = window.set_position(PhysicalPosition::new(pos.0, pos.1));
}

/// The user stopped dragging: remember where, per display, and which display it is on now.
fn on_moved(app: &AppHandle) {
    let shared = app.state::<Shared>();
    let spawn = {
        // try_lock: a move that Windows reports while the app itself holds the lock is never a user drag.
        let Ok(mut inner) = shared.inner.try_lock() else { return };
        if Instant::now() < inner.ignore_moves_until || inner.fullscreen {
            return;
        }
        inner.last_move = Instant::now();
        let spawn = !inner.commit_pending;
        inner.commit_pending = true;
        spawn
    };
    if !spawn {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(300));
            let quiet = {
                let shared = app.state::<Shared>();
                let inner = shared.lock();
                inner.last_move.elapsed() >= Duration::from_millis(300)
            };
            if quiet {
                break;
            }
        }
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || commit_position(&handle));
    });
}

fn commit_position(app: &AppHandle) {
    let shared = app.state::<Shared>();
    let Some(window) = app.get_webview_window(HELPER) else {
        shared.lock().commit_pending = false;
        return;
    };
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        shared.lock().commit_pending = false;
        return;
    };
    let list = monitors(app);
    let rect = Rect::new(pos.x, pos.y, size.width as i32, size.height as i32);
    let changed_display = {
        let mut inner = shared.lock();
        inner.commit_pending = false;
        let Some(index) = monitor_for_rect(&list, &rect) else {
            return;
        };
        let monitor = &list[index];
        let before = inner.config.helper_display.clone();
        let offset = offset_from_position(
            inner.config.helper_anchor,
            (rect.x, rect.y),
            (rect.w, rect.h),
            &monitor.work,
            monitor.scale,
        );
        inner.config.positions.insert(monitor.name.clone(), offset);
        inner.config.helper_display = Some(monitor.name.clone());
        inner.save();
        before.as_deref() != Some(monitor.name.as_str())
    };
    if changed_display {
        // Another display may have another scale: make the window the right size there.
        apply_layout(app);
        crate::tray::rebuild(app);
    }
}

fn label_for(monitor: &str) -> String {
    let clean: String = monitor.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    format!("wallpaper-{clean}")
}

pub fn close_wallpaper(app: &AppHandle, monitor: &str) {
    if let Some(window) = app.get_webview_window(&label_for(monitor)) {
        let _ = window.destroy();
    }
    app.state::<Shared>().lock().wallpapers.remove(monitor);
}

pub fn create_wallpaper(app: &AppHandle, monitor: &str, spec: WallpaperSpec) {
    let list = monitors(app);
    let Some(info) = list.iter().find(|m| m.name == monitor).cloned() else {
        return;
    };
    let shared = app.state::<Shared>();
    let (origin, profile) = {
        let inner = shared.lock();
        match inner.config.url.clone() {
            Some(url) => (url, inner.profile_dir.clone()),
            None => return,
        }
    };
    let label = label_for(monitor);
    if app.get_webview_window(&label).is_some() {
        return;
    }
    let url = wallpaper_url(&origin, spec.style, spec.quiet, taskbar_px(&info.bounds, &info.work));
    let Some(prepared) = builder(app, &label, &url, &origin, profile) else {
        return;
    };
    let window = match prepared.title("NOVA wallpaper").build() {
        Ok(window) => window,
        Err(error) => {
            log!("could not open the wallpaper window: {error}");
            return;
        }
    };
    shared.lock().wallpapers.insert(monitor.to_string(), spec);
    window.on_window_event(|event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
        }
    });
    let Ok(raw) = window.hwnd() else {
        log!("no window handle for the wallpaper window; closing it");
        let _ = window.destroy();
        shared.lock().wallpapers.remove(monitor);
        return;
    };
    let handle = raw.0 as isize;
    let origin_point = virtual_origin(&list);
    let rect = wallpaper_child_rect(&info.bounds, origin_point);
    let app = app.clone();
    let monitor = monitor.to_string();
    // The desktop may still be building its layers right after login: try for up to 30 seconds, like the agent.
    std::thread::spawn(move || {
        let mut last = None;
        for _ in 0..30 {
            let snapshot = win::snapshot();
            match decide(&snapshot) {
                Decision::Place { parent, after, .. } => match win::place(handle, parent, after, rect) {
                    Ok(()) => {
                        win::keep_behind_icons(handle);
                        log!("wallpaper on {monitor} placed behind the icons");
                        return;
                    }
                    Err(error) => {
                        log!("placing the wallpaper window failed: {error}");
                        last = Some(error);
                        break;
                    }
                },
                Decision::Unrecognised(reason) => {
                    last = Some(format!("{reason:?}: {snapshot:?}"));
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
        }
        // Never guess: a window that is not behind the icons would cover the screen, so it is closed again.
        log!(
            "the desktop layout of this Windows was not recognised ({}); the wallpaper window is closed",
            last.unwrap_or_default()
        );
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || close_wallpaper(&app2, &monitor));
    });
}

pub fn app_address(app: &AppHandle) -> Option<String> {
    app.state::<Shared>().lock().config.url.as_deref().map(app_url)
}
