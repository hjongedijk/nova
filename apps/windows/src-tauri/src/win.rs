//! The Windows-only glue: finding the desktop layout, putting a window behind the icons, keeping it there, and the
//! "start with Windows" entry. The decisions are made by `nova-win-core`; this file only asks Windows and acts.
//! On other systems everything here says "not supported", so the rest of the app still compiles.

use nova_win_core::desktop::{DesktopSnapshot, InsertAfter};
#[cfg(not(windows))]
use nova_win_core::forward::PointerKind;
use nova_win_core::geometry::Rect;

#[cfg(windows)]
mod imp {
    use super::*;
    use nova_win_core::autostart::{run_value, RUN_KEY, RUN_VALUE_NAME};
    use nova_win_core::desktop::{
        needs_reorder, IconWorker, CHILD_STYLE, REORDER_FLAGS, SHOW_FLAGS, SPAWN_WORKER_MESSAGE,
    };
    use nova_win_core::forward::PointerKind;
    use std::sync::{Mutex, OnceLock};
    use windows::core::{w, BOOL, PCWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, EnumWindows, FindWindowExW, FindWindowW, GetAncestor, GetClassNameW, GetMessageW, GetParent,
        GetWindow, IsWindow, SendMessageTimeoutW, SetParent, SetWindowLongW, SetWindowPos, SetWindowsHookExW,
        WindowFromPoint, GA_ROOT, GWL_STYLE, GW_CHILD, GW_HWNDNEXT, HWND_BOTTOM, MSG, MSLLHOOKSTRUCT,
        SET_WINDOW_POS_FLAGS, SMTO_NORMAL, WH_MOUSE_LL, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE,
    };

    fn hwnd(value: u64) -> HWND {
        HWND(value as usize as *mut core::ffi::c_void)
    }

    fn id(h: HWND) -> u64 {
        h.0 as usize as u64
    }

    unsafe extern "system" fn collect(h: HWND, l: LPARAM) -> BOOL {
        let list = &mut *(l.0 as *mut Vec<HWND>);
        list.push(h);
        BOOL(1)
    }

    fn class_of(h: HWND) -> String {
        let mut buffer = [0u16; 256];
        let n = unsafe { GetClassNameW(h, &mut buffer) };
        String::from_utf16_lossy(&buffer[..n.max(0) as usize])
    }

    /// What the desktop looks like now (after asking Progman to create the WorkerW).
    pub fn snapshot() -> DesktopSnapshot {
        unsafe {
            let Ok(progman) = FindWindowW(w!("Progman"), PCWSTR::null()) else {
                return DesktopSnapshot::default();
            };
            let mut ignored = 0usize;
            SendMessageTimeoutW(
                progman,
                SPAWN_WORKER_MESSAGE,
                WPARAM(0xD),
                LPARAM(1),
                SMTO_NORMAL,
                1000,
                Some(&mut ignored),
            );
            let worker_child = FindWindowExW(Some(progman), None, w!("WorkerW"), PCWSTR::null()).is_ok();
            let icons = FindWindowExW(Some(progman), None, w!("SHELLDLL_DefView"), PCWSTR::null()).ok();
            let mut top: Vec<HWND> = Vec::new();
            let _ = EnumWindows(Some(collect), LPARAM(&mut top as *mut Vec<HWND> as isize));
            let mut icon_workers = Vec::new();
            for h in top {
                if class_of(h) == "WorkerW"
                    && FindWindowExW(Some(h), None, w!("SHELLDLL_DefView"), PCWSTR::null()).is_ok()
                {
                    let next = FindWindowExW(None, Some(h), w!("WorkerW"), PCWSTR::null()).ok().map(id);
                    icon_workers.push(IconWorker { next_worker: next });
                }
            }
            DesktopSnapshot {
                progman: Some(id(progman)),
                progman_has_worker_child: worker_child,
                progman_icons: icons.map(id),
                icon_workers,
            }
        }
    }

    /// Makes `window` a child of the chosen desktop window, at `rect`, and shows it.
    pub fn place(window: isize, parent: u64, after: InsertAfter, rect: Rect) -> Result<(), String> {
        let h = HWND(window as *mut core::ffi::c_void);
        let parent_handle = hwnd(parent);
        let insert_after = match after {
            InsertAfter::Window(w) => hwnd(w),
            InsertAfter::Bottom => HWND_BOTTOM,
        };
        unsafe {
            SetWindowLongW(h, GWL_STYLE, CHILD_STYLE as i32);
            SetParent(h, Some(parent_handle)).map_err(|e| format!("SetParent: {e}"))?;
            SetWindowPos(
                h,
                Some(insert_after),
                rect.x,
                rect.y,
                rect.w,
                rect.h,
                SET_WINDOW_POS_FLAGS(SHOW_FLAGS),
            )
            .map_err(|e| format!("SetWindowPos: {e}"))?;
            match GetParent(h) {
                Ok(now) if now == parent_handle => Ok(()),
                _ => Err("Windows did not accept the wallpaper window behind the desktop".into()),
            }
        }
    }

    pub fn helper_parent() -> Result<isize, String> {
        unsafe {
            let mut candidates = Vec::new();
            if let Ok(progman) = FindWindowW(w!("Progman"), PCWSTR::null()) {
                candidates.push(progman);
            }
            let _ = EnumWindows(Some(collect), LPARAM(&mut candidates as *mut Vec<HWND> as isize));
            let parent = candidates
                .into_iter()
                .find(|parent| {
                    matches!(class_of(*parent).as_str(), "Progman" | "WorkerW")
                        && FindWindowExW(Some(*parent), None, w!("SHELLDLL_DefView"), PCWSTR::null()).is_ok()
                })
                .ok_or_else(|| "Windows desktop host for the helper is unavailable".to_string())?;
            Ok(parent.0 as isize)
        }
    }

    /// Place the helper above desktop icons but inside the desktop host.
    pub fn place_helper(window: isize, rect: Rect) -> Result<(), String> {
        use windows::Win32::Graphics::Gdi::ScreenToClient;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongW, HWND_TOP, SWP_FRAMECHANGED, SWP_NOACTIVATE, WS_CHILD, WS_POPUP,
        };
        let h = HWND(window as *mut core::ffi::c_void);
        let parent = HWND(helper_parent()? as *mut core::ffi::c_void);
        unsafe {
            let mut position = POINT { x: rect.x, y: rect.y };
            if !ScreenToClient(parent, &mut position).as_bool() {
                return Err("Could not translate the helper's desktop position".into());
            }
            // Retain visibility and clipping bits; a hidden helper must stay hidden.
            let style = GetWindowLongW(h, GWL_STYLE) as u32;
            SetWindowLongW(h, GWL_STYLE, ((style & !WS_POPUP.0) | WS_CHILD.0) as i32);
            if GetParent(h).ok() != Some(parent) {
                SetParent(h, Some(parent)).map_err(|e| format!("Helper SetParent: {e}"))?;
            }
            SetWindowPos(
                h,
                Some(HWND_TOP),
                position.x,
                position.y,
                rect.w,
                rect.h,
                SWP_NOACTIVATE | SWP_FRAMECHANGED,
            )
            .map_err(|e| format!("Helper SetWindowPos: {e}"))?;
            Ok(())
        }
    }

    /// The helper receives normal Windows mouse messages; never replay those
    /// same clicks into a wallpaper behind it.
    pub fn over_helper(window: isize, point: (i32, i32)) -> bool {
        use windows::Win32::UI::WindowsAndMessaging::IsChild;
        let h = HWND(window as *mut core::ffi::c_void);
        unsafe {
            let target = WindowFromPoint(POINT { x: point.0, y: point.1 });
            target == h || IsChild(h, target).as_bool()
        }
    }

    /// A native select/dropdown popup belongs to its WebView, even though its
    /// top-level class is not Progman/WorkerW. Do not cancel its captured click.
    pub fn over_owned_popup(window: isize, point: (i32, i32)) -> bool {
        use windows::Win32::UI::WindowsAndMessaging::IsChild;
        if window == 0 {
            return false;
        }
        let root = HWND(window as *mut core::ffi::c_void);
        unsafe {
            let mut target = WindowFromPoint(POINT { x: point.0, y: point.1 });
            for _ in 0..16 {
                if target.0.is_null() {
                    return false;
                }
                if target == root || IsChild(root, target).as_bool() {
                    return true;
                }
                // GetParent follows the owner for top-level popup windows.
                let Ok(parent) = GetParent(target) else {
                    return false;
                };
                if parent == target {
                    return false;
                }
                target = parent;
            }
            false
        }
    }

    static KEPT: Mutex<Vec<isize>> = Mutex::new(Vec::new());
    static KEEPER: OnceLock<()> = OnceLock::new();

    fn tick() {
        let list: Vec<isize> = KEPT.lock().map(|l| l.clone()).unwrap_or_default();
        for raw in list {
            let h = HWND(raw as *mut core::ffi::c_void);
            unsafe {
                if !IsWindow(Some(h)).as_bool() {
                    if let Ok(mut l) = KEPT.lock() {
                        l.retain(|x| *x != raw);
                    }
                    continue;
                }
                let Ok(parent) = GetParent(h) else { continue };
                let icons = FindWindowExW(Some(parent), None, w!("SHELLDLL_DefView"), PCWSTR::null()).ok();
                let mut children = Vec::new();
                let mut next = GetWindow(parent, GW_CHILD).ok();
                while let Some(c) = next {
                    children.push(id(c));
                    next = GetWindow(c, GW_HWNDNEXT).ok();
                }
                if needs_reorder(&children, icons.map(id), id(h)) {
                    if let Some(icons) = icons {
                        let _ = SetWindowPos(h, Some(icons), 0, 0, 0, 0, SET_WINDOW_POS_FLAGS(REORDER_FLAGS));
                    }
                }
            }
        }
    }

    /// Puts the window right back behind the icon layer whenever something brings it to the front (every 1.5 s).
    pub fn keep_behind_icons(window: isize) {
        if let Ok(mut l) = KEPT.lock() {
            if !l.contains(&window) {
                l.push(window);
            }
        }
        KEEPER.get_or_init(|| {
            std::thread::spawn(|| loop {
                std::thread::sleep(std::time::Duration::from_millis(1500));
                tick();
            });
        });
    }

    type Sink = fn(PointerKind, (i32, i32));
    static SINK: OnceLock<Sink> = OnceLock::new();

    /// True when the topmost window at the point belongs to the desktop (Progman / WorkerW), not to an application.
    pub fn over_desktop(x: i32, y: i32) -> bool {
        unsafe {
            let hit = WindowFromPoint(POINT { x, y });
            if hit.0.is_null() {
                return false;
            }
            let root = GetAncestor(hit, GA_ROOT);
            let root = if root.0.is_null() { hit } else { root };
            nova_win_core::forward::is_desktop_class(&class_of(root))
        }
    }

    unsafe extern "system" fn mouse_proc(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
        if code >= 0 {
            let kind = match w.0 as u32 {
                WM_MOUSEMOVE => Some(PointerKind::Move),
                WM_LBUTTONDOWN => Some(PointerKind::Down),
                WM_LBUTTONUP => Some(PointerKind::Up),
                _ => None,
            };
            if let (Some(kind), Some(sink)) = (kind, SINK.get()) {
                let info = &*(l.0 as *const MSLLHOOKSTRUCT);
                // Never block the mouse: the sink decides quickly and hands the work to another thread.
                sink(kind, (info.pt.x, info.pt.y));
            }
        }
        CallNextHookEx(None, code, w, l)
    }

    /// Watches the mouse system-wide (a low-level hook on its own thread). The wallpaper sits behind the icon
    /// layer, so Windows never delivers clicks to it; the sink replays them. The hook never swallows an event.
    pub fn watch_mouse(sink: Sink) {
        if SINK.set(sink).is_err() {
            return;
        }
        std::thread::spawn(|| unsafe {
            if let Err(error) = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), None, 0) {
                crate::log!("mouse forwarding for the wallpaper is unavailable: {error}");
                return;
            }
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
        });
    }

    pub fn autostart_enabled() -> bool {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(RUN_KEY)
            .and_then(|k| k.get_value::<String, _>(RUN_VALUE_NAME))
            .is_ok()
    }

    pub fn set_autostart(on: bool) -> Result<(), String> {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey(RUN_KEY)
            .map_err(|e| e.to_string())?;
        if on {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let value = run_value(&exe.to_string_lossy()).ok_or("het pad van NOVA Desk is niet geschikt")?;
            key.set_value(RUN_VALUE_NAME, &value).map_err(|e| e.to_string())
        } else {
            match key.delete_value(RUN_VALUE_NAME) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e.to_string()),
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    pub fn snapshot() -> DesktopSnapshot {
        DesktopSnapshot::default()
    }
    pub fn place(_window: isize, _parent: u64, _after: InsertAfter, _rect: Rect) -> Result<(), String> {
        Err("NOVA Desk places wallpaper windows on Windows only".into())
    }
    pub fn place_helper(_window: isize, _rect: Rect) -> Result<(), String> {
        Err("De helper vastzetten op het bureaublad werkt alleen op Windows".into())
    }
    pub fn over_helper(_window: isize, _point: (i32, i32)) -> bool {
        false
    }
    pub fn over_owned_popup(_window: isize, _point: (i32, i32)) -> bool {
        false
    }
    pub fn keep_behind_icons(_window: isize) {}
    pub fn over_desktop(_x: i32, _y: i32) -> bool {
        false
    }
    pub fn watch_mouse(_sink: fn(PointerKind, (i32, i32))) {}
    pub fn autostart_enabled() -> bool {
        false
    }
    pub fn set_autostart(_on: bool) -> Result<(), String> {
        Err("Starten met Windows werkt alleen op Windows".into())
    }
}

pub use imp::*;
