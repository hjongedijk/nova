//! Creating, placing and closing the NOVA windows. All geometry comes from `nova-win-core`.

use crate::state::Shared;
use crate::{log, win};
use nova_win_core::desktop::{decide, Decision};
use nova_win_core::forward::{parse_zones, PointerForwarder, PointerInput, PointerKind, Target, Zone};
use nova_win_core::geometry::{
    fullscreen_rect, monitor_for_rect, offset_from_position, place, resolve_display, taskbar_px, window_size, Anchor,
    MonitorInfo, Offset, Rect,
};
use nova_win_core::keys::{plan, Call, KeyPlan};
use nova_win_core::mode::WallpaperSpec;
use nova_win_core::nav::{app_url, browser_args, classify, helper_url, wallpaper_url, Navigation};
use std::time::{Duration, Instant};
use tauri::ipc::CapabilityBuilder;
use tauri::webview::{NewWindowResponse, PermissionKind, PermissionResponse};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

pub const HELPER: &str = "helper";

/// Wallpaper windows that want the mouse, and the thread that replays it into their pages. The wallpaper sits behind
/// the icon layer, so Windows delivers no clicks to it (see `nova_win_core::forward`).
static FORWARD_TARGETS: std::sync::Mutex<Vec<Target>> = std::sync::Mutex::new(Vec::new());
static FORWARD_TX: std::sync::OnceLock<std::sync::mpsc::Sender<Job>> = std::sync::OnceLock::new();
static POINTER_FORWARDER: std::sync::Mutex<PointerForwarder> = std::sync::Mutex::new(PointerForwarder::new());
static HELPER_HWND: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);
static LAST_MOVE: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);
/// The interactive rectangles each wallpaper page reported last: label, when, zones in physical screen pixels.
type ReportedZones = Vec<(String, Instant, Option<Vec<Zone>>)>;
static ZONES: std::sync::Mutex<ReportedZones> = std::sync::Mutex::new(Vec::new());
/// How often the pages are asked for their interactive rectangles, and how long an answer stays valid.
const ZONE_POLL: Duration = Duration::from_millis(250);
const ZONE_FRESH: Duration = Duration::from_secs(3);

/// Work for the browser thread, in the order the hooks produced it.
enum Job {
    Pointer(PointerInput),
    Keys { label: String, calls: Vec<Call> },
}

fn forward_targets() -> std::sync::MutexGuard<'static, Vec<Target>> {
    FORWARD_TARGETS.lock().unwrap_or_else(|p| p.into_inner())
}

fn zones() -> std::sync::MutexGuard<'static, ReportedZones> {
    ZONES.lock().unwrap_or_else(|p| p.into_inner())
}

/// Starts forwarding once. The worker preserves event order and WebView2 dispatches browser input on its UI thread.
pub fn start_forwarding(app: &AppHandle) {
    let (tx, rx) = std::sync::mpsc::channel::<Job>();
    if FORWARD_TX.set(tx).is_err() {
        return;
    }
    let worker = app.clone();
    std::thread::spawn(move || {
        for job in rx {
            match job {
                Job::Pointer(input) => {
                    if let Some(window) = worker.get_webview_window(&input.hit.label) {
                        dispatch_pointer(&window, input);
                    }
                }
                Job::Keys { label, calls } => {
                    if let Some(window) = worker.get_webview_window(&label) {
                        dispatch_calls(&window, calls);
                    }
                }
            }
        }
    });
    // The page tells where its controls are; only presses there are taken from the desktop.
    let poller = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(ZONE_POLL);
        let labels: Vec<String> = forward_targets().iter().map(|t| t.label.clone()).collect();
        zones().retain(|(label, ..)| labels.contains(label));
        for label in labels {
            if let Some(window) = poller.get_webview_window(&label) {
                poll_zones(&window, label);
            }
        }
    });
    win::watch_input(on_mouse, on_key);
}

/// The WebView's current viewport in physical screen pixels, its rasterization scale and zoom, read on the UI thread.
#[cfg(windows)]
unsafe fn live_viewport(
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
) -> Option<(Rect, f64, f64)> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller3;
    use windows_webview::core::Interface;
    let controller3 = controller.cast::<ICoreWebView2Controller3>().ok()?;
    let mut scale = 0.0;
    let mut zoom = 0.0;
    let mut parent = windows_webview::Win32::Foundation::HWND::default();
    let mut bounds = windows_webview::Win32::Foundation::RECT::default();
    controller3.RasterizationScale(&mut scale).ok()?;
    controller.ZoomFactor(&mut zoom).ok()?;
    controller.ParentWindow(&mut parent).ok()?;
    controller.Bounds(&mut bounds).ok()?;
    let origin = win::client_bounds(parent.0 as isize)?;
    Some((
        Rect::new(
            origin.x + bounds.left,
            origin.y + bounds.top,
            bounds.right - bounds.left,
            bounds.bottom - bounds.top,
        ),
        scale,
        zoom,
    ))
}

/// Asks the page for `window.__novaZones()` and stores the answer in physical screen pixels. A page without it
/// (an older NOVA, the offline screen) leaves the zones unknown, which keeps the earlier forward-everything input.
#[cfg(windows)]
fn poll_zones(window: &WebviewWindow, label: String) {
    use webview2_com::ExecuteScriptCompletedHandler;
    let result = window.with_webview(move |platform| unsafe {
        let controller = platform.controller();
        let Some((viewport, scale, zoom)) = live_viewport(&controller) else {
            return;
        };
        let Ok(webview) = controller.CoreWebView2() else { return };
        let script = windows_webview::core::HSTRING::from(
            "(() => { try { return window.__novaZones ? window.__novaZones() : null } catch (e) { return null } })()",
        );
        let handler = ExecuteScriptCompletedHandler::create(Box::new(move |result, json| {
            if result.is_err() {
                return Ok(());
            }
            let parsed = serde_json::from_str::<Option<String>>(&json)
                .ok()
                .flatten()
                .and_then(|text| parse_zones(&text, viewport, scale * zoom));
            let mut all = zones();
            all.retain(|(l, ..)| *l != label);
            all.push((label, Instant::now(), parsed));
            Ok(())
        }));
        let _ = webview.ExecuteScript(&script, &handler);
    });
    if let Err(error) = result {
        log!("could not ask the wallpaper where its controls are: {error}");
    }
}

#[cfg(not(windows))]
fn poll_zones(_window: &WebviewWindow, _label: String) {}

#[cfg(windows)]
fn dispatch_pointer(window: &WebviewWindow, input: PointerInput) {
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC;

    let result = window.with_webview(move |platform| unsafe {
        let controller = platform.controller();
        // The Tao child window can retain the primary monitor's cached DPI.
        // CDP expects CSS pixels of this actual WebView, so query its own scale
        // and client origin on the UI thread immediately before dispatch.
        let input = if input.hit.screen_point.is_some() {
            match live_viewport(&controller) {
                Some((bounds, scale, zoom)) => {
                    let Some(input) = input.for_viewport(bounds, scale, zoom) else {
                        return;
                    };
                    input
                }
                // A resize or shutdown must never strand a pressed browser button.
                None if input.kind == PointerKind::Up => input.cancelled_release(),
                None => return,
            }
        } else {
            input
        };
        // Cancellation over another application must release the old press without stealing that app's focus.
        if input.focus {
            let _ = controller.MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
        }
        call_devtools(&controller, "Input.dispatchMouseEvent", &input.params());
    });
    if let Err(error) = result {
        log!("could not queue wallpaper browser input: {error}");
    }
}

#[cfg(windows)]
fn dispatch_calls(window: &WebviewWindow, calls: Vec<Call>) {
    let result = window.with_webview(move |platform| unsafe {
        let controller = platform.controller();
        for call in &calls {
            call_devtools(&controller, call.method, &call.params);
        }
    });
    if let Err(error) = result {
        log!("could not queue wallpaper keyboard input: {error}");
    }
}

/// Logs a failing DevTools method once, so a broken input channel is visible in the log without flooding it.
#[cfg(windows)]
fn report_devtools_failure(method: &'static str, error: impl std::fmt::Display) {
    static REPORTED: std::sync::Mutex<Vec<&'static str>> = std::sync::Mutex::new(Vec::new());
    let mut reported = REPORTED.lock().unwrap_or_else(|p| p.into_inner());
    if !reported.contains(&method) {
        reported.push(method);
        log!("wallpaper browser input ({method}) failed: {error}");
    }
}

#[cfg(windows)]
unsafe fn call_devtools(
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
    method: &'static str,
    params: &str,
) {
    use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, CoTaskMemPWSTR};
    let Ok(webview) = controller.CoreWebView2() else { return };
    let name = CoTaskMemPWSTR::from(method);
    let params = CoTaskMemPWSTR::from(params);
    let completed = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, _| {
        if let Err(error) = result {
            report_devtools_failure(method, error);
        }
        Ok(())
    }));
    if let Err(error) =
        webview.CallDevToolsProtocolMethod(*name.as_ref().as_pcwstr(), *params.as_ref().as_pcwstr(), &completed)
    {
        report_devtools_failure(method, error);
    }
}

#[cfg(not(windows))]
fn dispatch_pointer(_window: &WebviewWindow, _input: PointerInput) {}

#[cfg(not(windows))]
fn dispatch_calls(_window: &WebviewWindow, _calls: Vec<Call>) {}

/// Called from the mouse hook: must stay fast and never block. Returns true when Windows must drop the event
/// (a press on one of the page's controls). Helper events are already delivered natively.
fn on_mouse(kind: PointerKind, point: (i32, i32)) -> bool {
    let mut targets = forward_targets().clone();
    {
        let reported = zones();
        targets.retain_mut(|target| {
            let Some(bounds) = win::client_bounds(target.native_handle) else {
                return false;
            };
            target.bounds = bounds;
            target.zones = reported
                .iter()
                .find(|(label, at, _)| *label == target.label && at.elapsed() < ZONE_FRESH)
                .and_then(|(_, _, zones)| zones.clone());
            true
        });
    }
    let helper = HELPER_HWND.load(std::sync::atomic::Ordering::Relaxed);
    let target = targets.iter().find(|target| target.bounds.contains(point.0, point.1));
    let desktop = target.is_some_and(|target| {
        !win::over_helper(helper, point)
            && (win::over_desktop(point.0, point.1) || win::over_owned_popup(target.native_handle, point))
    });
    let Ok(mut forwarder) = POINTER_FORWARDER.try_lock() else {
        return false;
    };
    let routed = forwarder.event(kind, point, desktop, &targets);
    drop(forwarder);
    if routed.inputs.is_empty() {
        return routed.swallow;
    }
    // Hover moves are throttled; presses, releases, wheel turns and ending hover never are.
    let hover_only = routed
        .inputs
        .iter()
        .all(|input| input.kind == PointerKind::Move && input.hit.screen_point.is_some());
    if hover_only {
        if let Ok(mut last) = LAST_MOVE.try_lock() {
            let now = Instant::now();
            if last.is_some_and(|t| now.duration_since(t) < Duration::from_millis(16)) {
                return routed.swallow;
            }
            *last = Some(now);
        }
    }
    if let Some(tx) = FORWARD_TX.get() {
        for input in routed.inputs {
            let _ = tx.send(Job::Pointer(input));
        }
    }
    routed.swallow
}

/// Called from the keyboard hook. Returns true when the key went to the wallpaper page instead of Windows: only
/// after a click in one of its text fields and only while the desktop itself is the active window.
fn on_key(key: win::Key) -> bool {
    let label = {
        let Ok(forwarder) = POINTER_FORWARDER.try_lock() else {
            return false;
        };
        match forwarder.typing_target() {
            Some(label) => label.to_string(),
            None => return false,
        }
    };
    if !win::desktop_is_active() || !forward_targets().iter().any(|t| t.label == label) {
        return false;
    }
    let mods = win::modifiers();
    let text = if key.down { win::key_text(&key, mods) } else { None };
    match plan(key.vk, key.down, mods, text.as_deref()) {
        KeyPlan::Pass => false,
        KeyPlan::Stop => {
            if let Ok(mut forwarder) = POINTER_FORWARDER.try_lock() {
                forwarder.stop_typing();
            }
            false
        }
        KeyPlan::Page(calls) => {
            if !calls.is_empty() {
                if let Some(tx) = FORWARD_TX.get() {
                    let _ = tx.send(Job::Keys { label, calls });
                }
            }
            true
        }
    }
}

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

/// Wires the helper window of this NOVA origin to the few window commands it needs (drag, view, display).
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
        .permission("allow-desk-set-fullscreen");
    if let Err(error) = app.add_capability(capability) {
        log!("could not grant the helper its commands: {error}");
    }
}

fn guard(app: &AppHandle, label: String, origin: String) -> impl Fn(&url::Url) -> bool + Send + 'static {
    let app = app.clone();
    move |target| match classify(target, &origin) {
        // NOVA's own "not reachable" screen (webview::harden), exactly once per failed load.
        Navigation::Block if target.scheme() == "data" && crate::webview::take_offline_permit(&label) => true,
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
    let microphone_origin = origin.to_owned();
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
            .on_permission_request(move |webview, kind| {
                if kind == PermissionKind::Microphone
                    && webview
                        .url()
                        .is_ok_and(|url| url.origin().ascii_serialization() == microphone_origin)
                {
                    PermissionResponse::Allow
                } else {
                    PermissionResponse::Default
                }
            })
            .zoom_hotkeys_enabled(false)
            .on_navigation(guard(app, label.to_string(), origin.to_string()))
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
    shared.lock().helper_ready = false;
    let prepared = builder(app, HELPER, &url, &origin, profile)?;
    #[cfg(windows)]
    let prepared = {
        let parent = match win::helper_parent() {
            Ok(parent) => parent,
            Err(error) => {
                log!("could not attach helper to desktop: {error}");
                return None;
            }
        };
        // Register the child relationship with Tao too, so later show/hide and
        // resize operations retain WS_CHILD rather than restoring popup styles.
        prepared.parent_raw(windows_webview::Win32::Foundation::HWND(
            parent as *mut core::ffi::c_void,
        ))
    };
    let built = prepared
        .on_page_load(|window, payload| {
            let shared = window.state::<Shared>();
            let (ready, notifications, paused) = {
                let mut inner = shared.lock();
                let origin = inner.config.url.as_deref().unwrap_or("");
                let ready = payload.event() == tauri::webview::PageLoadEvent::Finished
                    && payload.url().origin().ascii_serialization() == origin
                    && payload.url().path() == "/helper";
                inner.helper_ready = ready;
                (ready, inner.notifications.clone(), inner.paused)
            };
            if ready {
                for text in notifications {
                    if let Ok(script) = nova_win_core::script::notification_script(&text) {
                        let _ = window.eval(script);
                    }
                }
                if paused {
                    if let Ok(script) = nova_win_core::script::action_script("pause", Some(true)) {
                        let _ = window.eval(script);
                    }
                }
            }
        })
        .title("NOVA helper")
        .transparent(true)
        .always_on_top(false)
        .build();
    match built {
        Ok(window) => {
            crate::webview::harden(
                &window,
                crate::webview::Kind::Helper,
                Some((origin.clone(), url.clone())),
            );
            if let Ok(raw) = window.hwnd() {
                HELPER_HWND.store(raw.0 as isize, std::sync::atomic::Ordering::Relaxed);
            }
            let handle = app.clone();
            window.on_window_event(move |event| match event {
                tauri::WindowEvent::Moved(_) => on_moved(&handle),
                tauri::WindowEvent::Destroyed => {
                    HELPER_HWND.store(0, std::sync::atomic::Ordering::Relaxed);
                    crate::webview::forget(HELPER);
                }
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
            (
                index,
                size,
                place(Anchor::TopCentre, Offset::default(), size, &monitor.work, monitor.scale),
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
    if let Ok(raw) = window.hwnd() {
        if let Err(error) = win::place_helper(raw.0 as isize, Rect::new(pos.0, pos.1, size.0.max(1), size.1.max(1))) {
            log!("could not place the helper on the desktop: {error}");
        }
    }
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
    forward_targets().retain(|t| t.label != label_for(monitor));
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
    if app.get_webview_window(&label).is_some() || shared.lock().wallpapers.contains_key(monitor) {
        return;
    }
    // Reserve this monitor while Explorer creates its host. Closing or changing
    // modes removes the reservation and cancels the queued creation below.
    shared.lock().wallpapers.insert(monitor.to_string(), spec);
    pending().insert(monitor.to_string());
    let app = app.clone();
    let monitor = monitor.to_string();
    std::thread::spawn(move || {
        let done = Pending(monitor.clone());
        for _ in 0..30 {
            if app.state::<Shared>().lock().wallpapers.get(&monitor) != Some(&spec) {
                return;
            }
            if let Decision::Place { parent, after, .. } = decide(&win::snapshot()) {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    // Stays pending until the window exists, so heal() never races the creation.
                    let _done = done;
                    if handle.get_webview_window(&label).is_some() {
                        return;
                    }
                    let shared = handle.state::<Shared>();
                    let current = shared.lock();
                    if current.wallpapers.get(&monitor) != Some(&spec) || current.config.url.as_deref() != Some(&origin)
                    {
                        return;
                    }
                    drop(current);
                    let url = wallpaper_url(&origin, spec.style, spec.quiet, taskbar_px(&info.bounds, &info.work));
                    let Some(prepared) = builder(&handle, &label, &url, &origin, profile) else {
                        close_wallpaper(&handle, &monitor);
                        return;
                    };
                    #[cfg(windows)]
                    let prepared = prepared.parent_raw(windows_webview::Win32::Foundation::HWND(
                        parent as usize as *mut core::ffi::c_void,
                    ));
                    // Tao must know this is a child before construction, just as
                    // for the helper. Late SetParent alone leaves stale popup/DPI state.
                    let window = match prepared.title("NOVA wallpaper").build() {
                        Ok(window) => window,
                        Err(error) => {
                            log!("could not open the wallpaper window: {error}");
                            close_wallpaper(&handle, &monitor);
                            return;
                        }
                    };
                    crate::webview::harden(
                        &window,
                        crate::webview::Kind::Wallpaper,
                        Some((origin.clone(), url.clone())),
                    );
                    let forget = label.clone();
                    window.on_window_event(move |event| match event {
                        tauri::WindowEvent::CloseRequested { api, .. } => api.prevent_close(),
                        tauri::WindowEvent::Destroyed => crate::webview::forget(&forget),
                        _ => {}
                    });
                    let placed = window.hwnd().map_err(|error| error.to_string()).and_then(|raw| {
                        let native = raw.0 as isize;
                        win::place(native, parent, after, info.bounds)?;
                        window
                            .set_size(PhysicalSize::new(info.bounds.w as u32, info.bounds.h as u32))
                            .map_err(|error| error.to_string())?;
                        window.set_zoom(1.0).map_err(|error| error.to_string())?;
                        let position = window.inner_position().map_err(|error| error.to_string())?;
                        let size = window.inner_size().map_err(|error| error.to_string())?;
                        let scale = window.scale_factor().map_err(|error| error.to_string())?;
                        win::keep_behind_icons(native);
                        forward_targets().retain(|target| target.label != label);
                        forward_targets().push(Target {
                            label: label.clone(),
                            native_handle: native,
                            bounds: Rect::new(position.x, position.y, size.width as i32, size.height as i32),
                            scale,
                            zones: None,
                        });
                        start_forwarding(&handle);
                        Ok(())
                    });
                    if let Err(error) = placed {
                        log!("placing the wallpaper window failed: {error}");
                        close_wallpaper(&handle, &monitor);
                    } else {
                        log!("wallpaper on {monitor} placed behind the icons");
                    }
                });
                return;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
        log!("the desktop layout was not recognised; no wallpaper window was opened");
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if handle.get_webview_window(&label_for(&monitor)).is_none() {
                close_wallpaper(&handle, &monitor);
            }
        });
    });
}

/// Wallpaper monitors whose window is still being created (Explorer may need a few seconds).
static PENDING: std::sync::Mutex<Option<std::collections::HashSet<String>>> = std::sync::Mutex::new(None);

struct PendingSet(std::sync::MutexGuard<'static, Option<std::collections::HashSet<String>>>);
impl PendingSet {
    fn insert(mut self, monitor: String) {
        self.0.get_or_insert_with(Default::default).insert(monitor);
    }
    fn contains(&self, monitor: &str) -> bool {
        self.0.as_ref().is_some_and(|set| set.contains(monitor))
    }
}
fn pending() -> PendingSet {
    PendingSet(PENDING.lock().unwrap_or_else(|p| p.into_inner()))
}
/// Clears the pending mark when the creation thread ends, however it ends.
struct Pending(String);
impl Drop for Pending {
    fn drop(&mut self) {
        if let Some(set) = pending().0.as_mut() {
            set.remove(&self.0);
        }
    }
}

/// NOVA windows that Windows took away: Explorer restarted (the desktop host and every child window are gone),
/// or the helper could not be attached yet right after sign-in. Returns true when something must be rebuilt;
/// the dead windows are already cleaned up then.
pub fn heal(app: &AppHandle) -> bool {
    let (wallpapers, wants_helper) = {
        let shared = app.state::<Shared>();
        let inner = shared.lock();
        (
            inner.wallpapers.keys().cloned().collect::<Vec<_>>(),
            inner.config.url.is_some() && inner.desired.mode.wants_helper() && inner.desired.helper_visible,
        )
    };
    let mut rebuild = false;
    for monitor in wallpapers {
        if pending().contains(&monitor) {
            continue;
        }
        let alive = app
            .get_webview_window(&label_for(&monitor))
            .and_then(|w| w.hwnd().ok())
            .is_some_and(|h| win::alive(h.0 as isize));
        if !alive {
            log!("the wallpaper window on {monitor} disappeared (Explorer restarted?); rebuilding it");
            close_wallpaper(app, &monitor);
            rebuild = true;
        }
    }
    match app.get_webview_window(HELPER) {
        Some(window) => {
            if !window.hwnd().is_ok_and(|h| win::alive(h.0 as isize)) {
                log!("the helper window lost its desktop host; rebuilding it");
                let _ = window.destroy();
                rebuild = true;
            }
        }
        None if wants_helper => rebuild = true,
        None => {}
    }
    rebuild
}

pub fn app_address(app: &AppHandle) -> Option<String> {
    app.state::<Shared>().lock().config.url.as_deref().map(app_url)
}
