//! The Windows-only glue: finding the desktop layout, putting a window behind the icons, keeping it there, and the
//! "start with Windows" entry. The decisions are made by `nova-desk-core`; this file only asks Windows and acts.
//! On other systems everything here says "not supported", so the rest of the app still compiles.

use nova_desk_core::desktop::{DesktopSnapshot, InsertAfter};
use nova_desk_core::geometry::Rect;

#[cfg(windows)]
mod imp {
    use super::*;
    use nova_desk_core::autostart::{run_value, RUN_KEY, RUN_VALUE_NAME};
    use nova_desk_core::desktop::{
        needs_reorder, IconWorker, CHILD_STYLE, REORDER_FLAGS, SHOW_FLAGS, SPAWN_WORKER_MESSAGE,
    };
    use std::sync::{Mutex, OnceLock};
    use windows::core::{w, BOOL, PCWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, FindWindowExW, FindWindowW, GetClassNameW, GetParent, GetWindow, IsWindow, SendMessageTimeoutW,
        SetParent, SetWindowLongW, SetWindowPos, GWL_STYLE, GW_CHILD, GW_HWNDNEXT, HWND_BOTTOM, SET_WINDOW_POS_FLAGS,
        SMTO_NORMAL,
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
    pub fn keep_behind_icons(_window: isize) {}
    pub fn autostart_enabled() -> bool {
        false
    }
    pub fn set_autostart(_on: bool) -> Result<(), String> {
        Err("Starten met Windows werkt alleen op Windows".into())
    }
}

pub use imp::*;
