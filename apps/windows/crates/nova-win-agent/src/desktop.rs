//! Native desktop contract and in-memory control lease. Images are never written to disk.
use crate::transport::Outcome;
use serde::Serialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
#[cfg(windows)]
mod windows;

#[derive(Clone, Debug, Serialize)]
pub struct Display {
    pub index: u32,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub primary: bool,
}

#[derive(Default)]
pub struct Desktop {
    lease: Option<(Instant, u64)>,
    actions: Vec<Instant>,
}
impl Desktop {
    pub fn disarm(&mut self) {
        self.lease = None;
    }
    pub fn armed(&self) -> bool {
        self.lease.is_some_and(|(until, _)| Instant::now() < until)
    }
    pub fn until(&self) -> Option<u64> {
        self.lease
            .filter(|(until, _)| Instant::now() < *until)
            .map(|(_, ms)| ms)
    }
    pub fn route(&mut self, path: &str, body: &Value, view: bool, control: bool, paused: bool) -> Outcome {
        self.route_guarded(path, body, view, control, paused, &|| false)
    }
    pub fn route_guarded(
        &mut self,
        path: &str,
        body: &Value,
        view: bool,
        control: bool,
        paused: bool,
        cancelled: &dyn Fn() -> bool,
    ) -> Outcome {
        if cancelled() && !(path == "/v1/desktop/control" && body["armed"] == false) {
            self.disarm();
            return Err((409, "Pc-bediening is gestopt".into()));
        }
        if !view || !control || paused {
            self.disarm();
        }
        if path == "/v1/desktop/status" {
            return Ok(
                json!({"ok":true,"view":view && !paused,"control":view && control && !paused,
                "armed":self.armed(),"armedUntil":self.until(),"paused":paused,
                "killHotkey":"Ctrl+Alt+Shift+K","displays":displays()?}),
            );
        }
        // Disarming remains possible even after permissions are disabled.
        if path == "/v1/desktop/control" && body["armed"] == false {
            self.disarm();
            return Ok(json!({"ok":true,"armed":false}));
        }
        if !view {
            return Err((403, "Meekijken staat uit in NOVA op deze pc".into()));
        }
        if paused {
            return Err((409, "Agent is gepauzeerd".into()));
        }
        match path {
            "/v1/desktop/windows" => native_windows(),
            "/v1/desktop/screenshot" => {
                protected_foreground()?;
                let display = integer(body, "display", 0, 0, 32)? as u32;
                let width = integer(body, "maxWidth", 1280, 320, 1920)? as u32;
                capture(display, width)
            }
            "/v1/desktop/control" => {
                if !control {
                    return Err((403, "Bedienen staat uit in NOVA op deze pc".into()));
                }
                if body["armed"] != true {
                    return Err((400, "armed moet true of false zijn".into()));
                }
                let ttl = integer(body, "ttlSeconds", 0, 1, 900)? as u64;
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|_| (500, "Ongeldige systeemklok".into()))?
                    .as_millis() as u64;
                self.lease = Some((Instant::now() + Duration::from_secs(ttl), now + ttl * 1000));
                self.actions.clear();
                Ok(json!({"ok":true,"armed":true,"armedUntil":self.until()}))
            }
            "/v1/desktop/input" => {
                if !control || !self.armed() {
                    return Err((409, "Pc-bediening is niet actief".into()));
                }
                let action = Input::parse(body)?;
                protected_foreground()?;
                let now = Instant::now();
                self.actions
                    .retain(|at| now.duration_since(*at) < Duration::from_secs(1));
                if self.actions.len() >= 10 {
                    return Err((429, "Te veel invoeracties".into()));
                }
                self.actions.push(now);
                if cancelled() || !self.armed() {
                    return Err((409, "Pc-bediening is gestopt".into()));
                }
                let deadline = self.lease.map(|(until, _)| until).unwrap();
                native_input(&action, body, &|| cancelled() || Instant::now() >= deadline)?;
                Ok(json!({"ok":true,"action":body["action"]}))
            }
            _ => Err((404, "Onbekende bureaubladroute".into())),
        }
    }
}
fn integer(body: &Value, key: &str, default: i64, min: i64, max: i64) -> Result<i64, (u16, String)> {
    let value = match body.get(key) {
        Some(v) => v.as_i64().ok_or_else(|| (400, format!("Ongeldige {key}")))?,
        None => default,
    };
    if !(min..=max).contains(&value) {
        return Err((400, format!("Ongeldige {key}")));
    }
    Ok(value)
}
#[derive(Debug)]
enum Input {
    Pointer {
        kind: String,
        x: f64,
        y: f64,
    },
    Drag {
        x: f64,
        y: f64,
        to_x: f64,
        to_y: f64,
    },
    Scroll {
        point: Option<(f64, f64)>,
        dx: i32,
        dy: i32,
    },
    Type(String),
    Key(Vec<u16>),
    Focus(isize),
}
fn coordinate(body: &Value, key: &str) -> Result<f64, (u16, String)> {
    body[key]
        .as_f64()
        .filter(|v| v.is_finite() && *v >= 0.0 && *v <= 65536.0)
        .ok_or_else(|| (400, format!("Ongeldige {key}")))
}
impl Input {
    fn parse(body: &Value) -> Result<Self, (u16, String)> {
        let action = body["action"].as_str().unwrap_or("");
        Ok(match action {
            "move" | "click" | "doubleclick" | "rightclick" => Self::Pointer {
                kind: action.into(),
                x: coordinate(body, "x")?,
                y: coordinate(body, "y")?,
            },
            "drag" => Self::Drag {
                x: coordinate(body, "x")?,
                y: coordinate(body, "y")?,
                to_x: coordinate(body, "toX")?,
                to_y: coordinate(body, "toY")?,
            },
            "scroll" => Self::Scroll {
                point: if body.get("x").is_some() || body.get("y").is_some() {
                    Some((coordinate(body, "x")?, coordinate(body, "y")?))
                } else {
                    None
                },
                dx: integer(body, "dx", 0, -50, 50)? as i32,
                dy: integer(body, "dy", 0, -50, 50)? as i32,
            },
            "type" => Self::Type(
                body["text"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 500 && !s.contains('\0'))
                    .ok_or_else(|| (400, "Tekst moet 1 tot 500 tekens bevatten".into()))?
                    .into(),
            ),
            "key" => Self::Key(parse_key(body["key"].as_str().unwrap_or(""))?),
            "focus_window" => Self::Focus(
                body["windowId"]
                    .as_str()
                    .and_then(|s| s.parse::<isize>().ok())
                    .filter(|id| *id > 0)
                    .ok_or_else(|| (400, "Ongeldig venster".into()))?,
            ),
            _ => return Err((400, "Onbekende invoeractie".into())),
        })
    }
}
fn parse_key(raw: &str) -> Result<Vec<u16>, (u16, String)> {
    let fail = || (400, "Ongeldige toetscombinatie".into());
    let parts: Vec<_> = raw.split('+').map(|s| s.trim().to_ascii_lowercase()).collect();
    if parts.is_empty() || parts.len() > 4 {
        return Err(fail());
    }
    let mut keys = Vec::new();
    for modifier in &parts[..parts.len() - 1] {
        let code = match modifier.as_str() {
            "ctrl" | "control" => 0x11,
            "alt" => 0x12,
            "shift" => 0x10,
            "win" | "meta" => 0x5b,
            _ => return Err(fail()),
        };
        if keys.contains(&code) {
            return Err(fail());
        }
        keys.push(code);
    }
    let key = parts.last().unwrap().as_str();
    let code = match key {
        "enter" | "return" => 0x0d,
        "escape" | "esc" => 0x1b,
        "tab" => 9,
        "space" => 0x20,
        "backspace" => 8,
        "win" | "meta" => 0x5b,
        "delete" | "del" => 0x2e,
        "insert" => 0x2d,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" => 0x21,
        "pagedown" => 0x22,
        "left" | "arrowleft" => 0x25,
        "up" | "arrowup" => 0x26,
        "right" | "arrowright" => 0x27,
        "down" | "arrowdown" => 0x28,
        _ if key.len() == 1 && key.as_bytes()[0].is_ascii_alphanumeric() => {
            key.as_bytes()[0].to_ascii_uppercase() as u16
        }
        _ if key.starts_with('f') => key[1..]
            .parse::<u16>()
            .ok()
            .filter(|n| (1..=12).contains(n))
            .map(|n| 0x6f + n)
            .ok_or_else(fail)?,
        _ => return Err(fail()),
    };
    if code == 0x2e && keys.contains(&0x11) && keys.contains(&0x12) {
        return Err(fail());
    }
    keys.push(code);
    Ok(keys)
}
fn scale_point(screen: &Display, body: &Value, x: f64, y: f64) -> Result<(i32, i32), (u16, String)> {
    let (rw, rh) = if let Some(relative) = body.get("relativeTo") {
        (coordinate(relative, "width")?, coordinate(relative, "height")?)
    } else {
        (screen.width as f64, screen.height as f64)
    };
    if rw < 1.0 || rh < 1.0 || x >= rw || y >= rh {
        return Err((400, "Punt ligt buiten de schermafbeelding".into()));
    }
    Ok((
        screen.x + ((x / rw * screen.width as f64).floor() as i32).clamp(0, screen.width - 1),
        screen.y + ((y / rh * screen.height as f64).floor() as i32).clamp(0, screen.height - 1),
    ))
}
#[cfg(windows)]
use windows::{capture, displays, native_input, native_windows, protected_foreground};
#[cfg(not(windows))]
fn unsupported<T>() -> Result<T, (u16, String)> {
    Err((503, "Alleen beschikbaar op Windows".into()))
}
#[cfg(not(windows))]
fn displays() -> Result<Vec<Display>, (u16, String)> {
    Ok(vec![])
}
#[cfg(not(windows))]
fn native_windows() -> Outcome {
    unsupported()
}
#[cfg(not(windows))]
fn protected_foreground() -> Result<(), (u16, String)> {
    Ok(())
}
#[cfg(not(windows))]
fn capture(_: u32, _: u32) -> Outcome {
    unsupported()
}
#[cfg(not(windows))]
fn native_input(input: &Input, body: &Value, cancelled: &dyn Fn() -> bool) -> Result<(), (u16, String)> {
    if cancelled() {
        return Err((409, "Pc-bediening is gestopt".into()));
    }
    // Keep validation compiled and exercised on the host without invoking an OS action.
    let screen = Display {
        index: 1,
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
        primary: true,
    };
    match input {
        Input::Pointer { kind, x, y } => {
            let _ = kind;
            scale_point(&screen, body, *x, *y)?;
        }
        Input::Drag { x, y, to_x, to_y } => {
            scale_point(&screen, body, *x, *y)?;
            scale_point(&screen, body, *to_x, *to_y)?;
        }
        Input::Scroll { point, dx, dy } => {
            let _ = (point, dx, dy);
        }
        Input::Type(text) => {
            let _ = text;
        }
        Input::Key(keys) => {
            let _ = keys;
        }
        Input::Focus(id) => {
            let _ = id;
        }
    }
    unsupported()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scaling_respects_negative_origins_and_rejects_outside() {
        let d = Display {
            index: 2,
            x: -2560,
            y: -100,
            width: 2560,
            height: 1440,
            primary: false,
        };
        let body = json!({"relativeTo":{"width":1280,"height":720}});
        assert_eq!(scale_point(&d, &body, 640.0, 360.0).unwrap(), (-1280, 620));
        assert!(scale_point(&d, &body, 1280.0, 0.0).is_err());
        assert!(scale_point(&d, &json!({"relativeTo":{"width":0,"height":1}}), 0.0, 0.0).is_err());
    }
    #[test]
    fn input_rejects_invalid_chords_and_unbounded_text() {
        for key in ["Ctrl+Alt+Delete", "Ctrl+Ctrl+A", "F13", "", "Alt+"] {
            assert!(parse_key(key).is_err(), "{key}");
        }
        assert_eq!(parse_key("Win+R").unwrap(), vec![0x5b, 0x52]);
        assert_eq!(parse_key("Ctrl+Shift+Tab").unwrap(), vec![0x11, 0x10, 9]);
        assert!(Input::parse(&json!({"action":"type","text":"a".repeat(501)})).is_err());
        assert!(Input::parse(&json!({"action":"click","x":-1,"y":0})).is_err());
        assert!(Input::parse(&json!({"action":"scroll","dy":51})).is_err());
    }
    #[test]
    fn lease_is_volatile_bounded_and_disarm_always_works() {
        let mut d = Desktop::default();
        assert!(!d.armed());
        assert!(d
            .route(
                "/v1/desktop/input",
                &json!({"action":"key","key":"A"}),
                true,
                true,
                false
            )
            .is_err());
        assert!(d
            .route(
                "/v1/desktop/control",
                &json!({"armed":true,"ttlSeconds":901}),
                true,
                true,
                false
            )
            .is_err());
        d.route(
            "/v1/desktop/control",
            &json!({"armed":true,"ttlSeconds":30}),
            true,
            true,
            false,
        )
        .unwrap();
        assert!(d.armed());
        assert!(d.until().is_some());
        let cancelled = d.route_guarded(
            "/v1/desktop/input",
            &json!({"action":"key","key":"A"}),
            true,
            true,
            false,
            &|| true,
        );
        assert_eq!(cancelled.unwrap_err().0, 409);
        assert_eq!(
            d.route("/v1/desktop/windows", &json!({}), true, true, true)
                .unwrap_err()
                .0,
            409
        );
        assert!(!d.armed());
        d.route("/v1/desktop/control", &json!({"armed":false}), false, false, true)
            .unwrap();
        assert!(!Desktop::default().armed());
    }
}
