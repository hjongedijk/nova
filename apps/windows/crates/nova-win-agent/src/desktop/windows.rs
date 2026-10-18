use super::{scale_point, Display, Input};
use crate::transport::Outcome;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use windows::{
    core::BOOL,
    Win32::{
        Foundation::{HWND, LPARAM, RECT},
        Graphics::Gdi::*,
        UI::{HiDpi::*, Input::KeyboardAndMouse::*, WindowsAndMessaging::*},
    },
};
fn error(message: &str) -> (u16, String) {
    (503, message.into())
}
struct Dpi(DPI_AWARENESS_CONTEXT);
impl Dpi {
    fn enter() -> Self {
        Self(unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) })
    }
}
impl Drop for Dpi {
    fn drop(&mut self) {
        unsafe {
            SetThreadDpiAwarenessContext(self.0);
        }
    }
}

pub(super) fn displays() -> Result<Vec<Display>, (u16, String)> {
    unsafe extern "system" fn visit(monitor: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
        let output = &mut *(data.0 as *mut Vec<Display>);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut info).as_bool() {
            let b = info.rcMonitor;
            output.push(Display {
                index: 0,
                x: b.left,
                y: b.top,
                width: b.right - b.left,
                height: b.bottom - b.top,
                primary: info.dwFlags & MONITORINFOF_PRIMARY != 0,
            });
        }
        BOOL(1)
    }
    let _dpi = Dpi::enter();
    let mut output = Vec::<Display>::new();
    if !unsafe { EnumDisplayMonitors(None, None, Some(visit), LPARAM(&mut output as *mut _ as isize)) }.as_bool() {
        return Err(error("Beeldschermen konden niet worden gelezen"));
    }
    output.sort_by_key(|d| (!d.primary, d.x, d.y));
    for (i, d) in output.iter_mut().enumerate() {
        d.index = i as u32 + 1;
    }
    if output.is_empty() {
        return Err(error("Geen interactief beeldscherm beschikbaar"));
    }
    Ok(output)
}
fn screen(index: u32) -> Result<Display, (u16, String)> {
    displays()?
        .into_iter()
        .find(|d| if index == 0 { d.primary } else { d.index == index })
        .ok_or_else(|| (400, "Beeldscherm bestaat niet".into()))
}
pub(super) fn native_windows() -> Outcome {
    struct List {
        active: HWND,
        items: Vec<Value>,
        processes: sysinfo::System,
    }
    unsafe extern "system" fn visit(hwnd: HWND, data: LPARAM) -> BOOL {
        let list = &mut *(data.0 as *mut List);
        if !IsWindowVisible(hwnd).as_bool() {
            return BOOL(1);
        }
        let mut title = [0u16; 512];
        let length = GetWindowTextW(hwnd, &mut title);
        if length <= 0 {
            return BOOL(1);
        }
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let process = list
            .processes
            .process(sysinfo::Pid::from_u32(pid))
            .map(|p| p.name().to_string_lossy().into_owned())
            .unwrap_or_default();
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return BOOL(1);
        }
        list.items.push(json!({"id":(hwnd.0 as isize).to_string(),"title":String::from_utf16_lossy(&title[..length as usize]),
            "process":process,"foreground":hwnd==list.active,"minimized":IsIconic(hwnd).as_bool(),"x":rect.left,"y":rect.top,"width":rect.right-rect.left,"height":rect.bottom-rect.top}));
        BOOL(1)
    }
    let _dpi = Dpi::enter();
    let mut list = List {
        active: unsafe { GetForegroundWindow() },
        items: vec![],
        processes: sysinfo::System::new_all(),
    };
    unsafe { EnumWindows(Some(visit), LPARAM(&mut list as *mut _ as isize)) }
        .map_err(|_| error("Vensters konden niet worden gelezen"))?;
    Ok(json!({"ok":true,"windows":list.items}))
}
fn denied(window: &Value) -> bool {
    let text = format!(
        "{} {}",
        window["title"].as_str().unwrap_or(""),
        window["process"].as_str().unwrap_or("")
    )
    .to_lowercase();
    [
        "keepass",
        "bitwarden",
        "1password",
        "lastpass",
        "dashlane",
        "enpass",
        "proton pass",
        "nordpass",
        "wachtwoord",
        "password",
        "passkey",
        "credential",
        "windows security",
        "windows-beveiliging",
        "user account control",
        "consent",
        "logonui",
        "aanmelden bij windows",
        "bank",
        "rabobank",
        "abn amro",
        "bunq",
        "inloggen",
        "sign in",
    ]
    .iter()
    .any(|term| text.contains(term))
}
pub(super) fn protected_foreground() -> Result<(), (u16, String)> {
    let windows = native_windows()?;
    if windows["windows"]
        .as_array()
        .is_some_and(|list| list.iter().any(|w| w["foreground"] == true && denied(w)))
    {
        return Err((403, "Het actieve venster is beschermd".into()));
    }
    Ok(())
}
// RAII always restores the selected GDI object before releasing its bitmap/DC.
struct Capture {
    source: HDC,
    target: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
}
impl Drop for Capture {
    fn drop(&mut self) {
        unsafe {
            if !self.previous.is_invalid() {
                SelectObject(self.target, self.previous);
            }
            if !self.bitmap.is_invalid() {
                let _ = DeleteObject(self.bitmap.into());
            }
            if !self.target.is_invalid() {
                let _ = DeleteDC(self.target);
            }
            if !self.source.is_invalid() {
                ReleaseDC(None, self.source);
            }
        }
    }
}
pub(super) fn capture(index: u32, max_width: u32) -> Outcome {
    let _dpi = Dpi::enter();
    let d = screen(index)?;
    let list = native_windows()?;
    if list["windows"].as_array().is_some_and(|windows| {
        windows.iter().any(|window| {
            if window["minimized"] == true || !denied(window) {
                return false;
            }
            let x = window["x"].as_i64().unwrap_or(0);
            let y = window["y"].as_i64().unwrap_or(0);
            let w = window["width"].as_i64().unwrap_or(0);
            let h = window["height"].as_i64().unwrap_or(0);
            x < i64::from(d.x) + i64::from(d.width)
                && y < i64::from(d.y) + i64::from(d.height)
                && x + w > i64::from(d.x)
                && y + h > i64::from(d.y)
        })
    }) {
        return Err((403, "Een beschermd venster is zichtbaar op dit beeldscherm".into()));
    }
    if d.width <= 0 || d.height <= 0 {
        return Err(error("Ongeldig beeldscherm"));
    }
    let width = d.width.min(max_width as i32);
    let height = ((d.height as f64 * width as f64 / d.width as f64).round() as i32).max(1);
    if (width as i64) * (height as i64) > 8_000_000 {
        return Err(error("Beeldschermverhouding is te groot"));
    }
    unsafe {
        let mut g = Capture {
            source: GetDC(None),
            target: HDC::default(),
            bitmap: HBITMAP::default(),
            previous: HGDIOBJ::default(),
        };
        if g.source.is_invalid() {
            return Err(error("Geen toegang tot het bureaublad"));
        }
        g.target = CreateCompatibleDC(Some(g.source));
        if g.target.is_invalid() {
            return Err(error("Schermbuffer kon niet worden aangemaakt"));
        }
        g.bitmap = CreateCompatibleBitmap(g.source, width, height);
        if g.bitmap.is_invalid() {
            return Err(error("Schermbuffer kon niet worden aangemaakt"));
        }
        g.previous = SelectObject(g.target, g.bitmap.into());
        if g.previous.is_invalid() {
            return Err(error("Schermbuffer kon niet worden geselecteerd"));
        }
        SetStretchBltMode(g.target, HALFTONE);
        if !StretchBlt(
            g.target,
            0,
            0,
            width,
            height,
            Some(g.source),
            d.x,
            d.y,
            d.width,
            d.height,
            SRCCOPY | CAPTUREBLT,
        )
        .as_bool()
        {
            return Err(error("Scherm vastleggen mislukt; controleer of Windows is ontgrendeld"));
        }
        let mut cursor = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        if GetCursorInfo(&mut cursor).is_ok() && cursor.flags == CURSOR_SHOWING {
            let p = cursor.ptScreenPos;
            if p.x >= d.x && p.y >= d.y && p.x < d.x + d.width && p.y < d.y + d.height {
                let mut icon = ICONINFO::default();
                let handle = HICON(cursor.hCursor.0);
                if GetIconInfo(handle, &mut icon).is_ok() {
                    let scale = width as f64 / d.width as f64;
                    let x = ((p.x - d.x - icon.xHotspot as i32) as f64 * scale).round() as i32;
                    let y = ((p.y - d.y - icon.yHotspot as i32) as f64 * scale).round() as i32;
                    let _ = DrawIconEx(
                        g.target,
                        x,
                        y,
                        handle,
                        (GetSystemMetrics(SM_CXCURSOR) as f64 * scale).round().max(1.0) as i32,
                        (GetSystemMetrics(SM_CYCURSOR) as f64 * scale).round().max(1.0) as i32,
                        0,
                        None,
                        DI_NORMAL,
                    );
                    if !icon.hbmMask.is_invalid() {
                        let _ = DeleteObject(icon.hbmMask.into());
                    }
                    if !icon.hbmColor.is_invalid() {
                        let _ = DeleteObject(icon.hbmColor.into());
                    }
                }
            }
        }
        // GetDIBits requires the bitmap to be deselected from its DC.
        SelectObject(g.target, g.previous);
        g.previous = HGDIOBJ::default();
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bgra = vec![0u8; width as usize * height as usize * 4];
        if GetDIBits(
            g.source,
            g.bitmap,
            0,
            height as u32,
            Some(bgra.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        ) != height
        {
            return Err(error("Schermpixels konden niet worden gelezen"));
        }
        let mut rgb = Vec::with_capacity(width as usize * height as usize * 3);
        for pixel in bgra.as_chunks::<4>().0 {
            rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
        }
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 75)
            .encode(&rgb, width as u32, height as u32, image::ExtendedColorType::Rgb8)
            .map_err(|_| error("Schermbeeld coderen mislukt"))?;
        if jpeg.len() > 6_000_000 {
            return Err(error("Schermbeeld is te groot"));
        }
        Ok(
            json!({"ok":true,"image":STANDARD.encode(jpeg),"mimeType":"image/jpeg","width":width,"height":height,"display":d.index}),
        )
    }
}
fn send(inputs: &[INPUT]) -> Result<(), (u16, String)> {
    if unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) } != inputs.len() as u32 {
        return Err(error(
            "Windows blokkeert invoer. Controleer beheerrechten en het actieve venster",
        ));
    }
    Ok(())
}
fn mouse(flags: MOUSE_EVENT_FLAGS, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dwFlags: flags,
                mouseData: data as u32,
                ..Default::default()
            },
        },
    }
}
fn key(code: u16, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(code),
                dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                ..Default::default()
            },
        },
    }
}
fn move_to(point: (i32, i32)) -> Result<(), (u16, String)> {
    unsafe { SetCursorPos(point.0, point.1) }.map_err(|_| error("Muis kon niet worden verplaatst"))
}
pub(super) fn native_input(input: &Input, body: &Value, cancelled: &dyn Fn() -> bool) -> Result<(), (u16, String)> {
    let _dpi = Dpi::enter();
    let index = super::integer(body, "display", 0, 0, 32)? as u32;
    let screen = screen(index)?;
    let point = |x, y| scale_point(&screen, body, x, y);
    let check = || {
        if cancelled() {
            Err((409, "Pc-bediening is gestopt".into()))
        } else {
            Ok(())
        }
    };
    let guarded_send = |inputs: &[INPUT]| {
        check()?;
        send(inputs)
    };
    let guarded_move = |point: (i32, i32)| {
        check()?;
        move_to(point)
    };
    check()?;
    match input {
        Input::Pointer { kind, x, y } => {
            guarded_move(point(*x, *y)?)?;
            if kind != "move" {
                let (down, up) = if kind == "rightclick" {
                    (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP)
                } else {
                    (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
                };
                guarded_send(&[mouse(down, 0), mouse(up, 0)])?;
                if kind == "doubleclick" {
                    guarded_send(&[mouse(down, 0), mouse(up, 0)])?;
                }
            }
        }
        Input::Drag { x, y, to_x, to_y } => {
            let start = point(*x, *y)?;
            let end = point(*to_x, *to_y)?;
            guarded_move(start)?;
            guarded_send(&[mouse(MOUSEEVENTF_LEFTDOWN, 0)])?;
            // Release the button even when a later move fails.
            let moved = (|| {
                for step in 1..=12 {
                    guarded_move((
                        start.0 + (end.0 - start.0) * step / 12,
                        start.1 + (end.1 - start.1) * step / 12,
                    ))?;
                    std::thread::sleep(std::time::Duration::from_millis(8));
                }
                Ok(())
            })();
            let released = send(&[mouse(MOUSEEVENTF_LEFTUP, 0)]);
            moved?;
            released?;
        }
        Input::Scroll { point: at, dx, dy } => {
            if let Some((x, y)) = at {
                guarded_move(point(*x, *y)?)?;
            }
            if *dy != 0 {
                guarded_send(&[mouse(MOUSEEVENTF_WHEEL, -dy * 120)])?;
            }
            if *dx != 0 {
                guarded_send(&[mouse(MOUSEEVENTF_HWHEEL, dx * 120)])?;
            }
        }
        Input::Type(text) => {
            let mut inputs = Vec::new();
            for unit in text.encode_utf16() {
                for up in [false, true] {
                    inputs.push(INPUT {
                        r#type: INPUT_KEYBOARD,
                        Anonymous: INPUT_0 {
                            ki: KEYBDINPUT {
                                wScan: unit,
                                dwFlags: KEYEVENTF_UNICODE | if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
                                ..Default::default()
                            },
                        },
                    });
                }
            }
            guarded_send(&inputs)?;
        }
        Input::Key(keys) => {
            let inputs: Vec<_> = keys
                .iter()
                .map(|k| key(*k, false))
                .chain(keys.iter().rev().map(|k| key(*k, true)))
                .collect();
            if let Err(err) = guarded_send(&inputs) {
                let release: Vec<_> = keys.iter().rev().map(|k| key(*k, true)).collect();
                let _ = send(&release);
                return Err(err);
            }
        }
        Input::Focus(id) => {
            let list = native_windows()?;
            let target = list["windows"]
                .as_array()
                .and_then(|list| {
                    list.iter()
                        .find(|w| w["id"].as_str().and_then(|s| s.parse::<isize>().ok()) == Some(*id))
                })
                .ok_or_else(|| (404, "Venster bestaat niet meer".into()))?;
            if denied(target) {
                return Err((403, "Dit venster is beschermd".into()));
            }
            let hwnd = HWND(*id as *mut _);
            check()?;
            unsafe {
                let _ = ShowWindow(hwnd, SW_RESTORE);
                if !SetForegroundWindow(hwnd).as_bool() {
                    return Err(error("Windows kon dit venster niet activeren"));
                }
            }
        }
    }
    Ok(())
}
