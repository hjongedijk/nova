//! Native desktop contract: screenshots, windows and input. Images are never written to disk.
use crate::transport::Outcome;
use serde::Serialize;
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};
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

/// Stateless router. There is no permission, lease or rate limit: the only thing that stops NOVA is the owner's
/// pause / emergency stop (`paused`, or a cancelled epoch), which NOVA itself cannot lift.
#[derive(Default)]
pub struct Desktop;
impl Desktop {
    pub fn route(&mut self, path: &str, body: &Value, paused: bool) -> Outcome {
        self.route_guarded(path, body, paused, &|| false)
    }
    pub fn route_guarded(&mut self, path: &str, body: &Value, paused: bool, cancelled: &dyn Fn() -> bool) -> Outcome {
        if path == "/v1/desktop/status" {
            return Ok(json!({"ok":true,"view":!paused,"control":!paused,
                "armed":!paused,"armedUntil":null,"paused":paused,
                "killHotkey":"Ctrl+Alt+Shift+K","displays":displays()?}));
        }
        if cancelled() {
            return Err((409, "Pc-bediening is gestopt".into()));
        }
        if paused {
            return Err((
                409,
                "Agent is gepauzeerd door de eigenaar (systeemvak of Ctrl+Alt+Shift+K)".into(),
            ));
        }
        match path {
            "/v1/desktop/windows" => native_windows(),
            "/v1/desktop/screenshot" => {
                let display = integer(body, "display", 0, 0, 32)? as u32;
                let width = integer(body, "maxWidth", 1280, 320, 1920)? as u32;
                capture(display, width)
            }
            // Kept for NOVA's API contract. Input needs no arming: this only acknowledges the request.
            "/v1/desktop/control" => {
                let armed = body["armed"]
                    .as_bool()
                    .ok_or_else(|| (400, "armed moet true of false zijn".to_string()))?;
                if armed {
                    let ttl = integer(body, "ttlSeconds", 900, 0, i64::MAX / 2000)? as u64;
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map_err(|_| (500, "Ongeldige systeemklok".into()))?
                        .as_millis() as u64;
                    Ok(json!({"ok":true,"armed":true,"armedUntil":now + ttl * 1000}))
                } else {
                    Ok(json!({"ok":true,"armed":false}))
                }
            }
            "/v1/desktop/input" => {
                let action = Input::parse(body)?;
                native_input(&action, body, cancelled)?;
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
                    .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 4000 && !s.contains('\0'))
                    .ok_or_else(|| (400, "Tekst moet 1 tot 4000 tekens bevatten".into()))?
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
        "media_play_pause" | "mediaplaypause" => 0xb3,
        "media_stop" | "mediastop" => 0xb2,
        "media_next" | "medianext" => 0xb0,
        "media_previous" | "mediaprevious" => 0xb1,
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
use windows::{capture, displays, native_input, native_windows};
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
    fn input_rejects_malformed_chords_and_text() {
        for key in ["Ctrl+Ctrl+A", "F13", "", "Alt+"] {
            assert!(parse_key(key).is_err(), "{key}");
        }
        assert_eq!(parse_key("media_play_pause").unwrap(), vec![0xb3]);
        assert_eq!(parse_key("media_stop").unwrap(), vec![0xb2]);
        assert_eq!(parse_key("media_next").unwrap(), vec![0xb0]);
        assert_eq!(parse_key("media_previous").unwrap(), vec![0xb1]);
        assert_eq!(parse_key("Win+R").unwrap(), vec![0x5b, 0x52]);
        assert_eq!(parse_key("Ctrl+Shift+Tab").unwrap(), vec![0x11, 0x10, 9]);
        assert_eq!(parse_key("Ctrl+Alt+Delete").unwrap(), vec![0x11, 0x12, 0x2e]);
        assert!(Input::parse(&json!({"action":"type","text":"a".repeat(4001)})).is_err());
        assert!(Input::parse(&json!({"action":"type","text":"a".repeat(2000)})).is_ok());
        assert!(Input::parse(&json!({"action":"click","x":-1,"y":0})).is_err());
        assert!(Input::parse(&json!({"action":"scroll","dy":51})).is_err());
    }
    #[test]
    fn nothing_needs_arming_or_permissions() {
        let mut d = Desktop;
        // Reach the native layer without arming or a lease, then cancel before
        // sending input. This tests both hosts without typing into the CI desktop.
        for _ in 0..50 {
            let checks = std::cell::Cell::new(0);
            let err = d
                .route_guarded("/v1/desktop/input", &json!({"action":"key","key":"A"}), false, &|| {
                    checks.set(checks.get() + 1);
                    checks.get() > 1
                })
                .unwrap_err();
            assert_eq!(checks.get(), 2, "input must reach the native cancellation check");
            assert_eq!(err.0, 409, "{err:?}");
        }
        assert_eq!(
            d.route("/v1/desktop/input", &json!({"action":"nope"}), false)
                .unwrap_err()
                .0,
            400
        );
        // The arming route stays valid for NOVA's contract, with any ttl, and is only an acknowledgement.
        let armed = d
            .route("/v1/desktop/control", &json!({"armed":true,"ttlSeconds":100000}), false)
            .unwrap();
        assert_eq!(armed["armed"], true);
        assert!(armed["armedUntil"].as_u64().is_some());
        assert_eq!(
            d.route("/v1/desktop/control", &json!({"armed":false}), false).unwrap()["armed"],
            false
        );
        assert_eq!(d.route("/v1/desktop/control", &json!({}), false).unwrap_err().0, 400);
        let status = d.route("/v1/desktop/status", &json!({}), false).unwrap();
        assert_eq!(status["view"], true);
        assert_eq!(status["control"], true);
        assert_eq!(status["armed"], true);
        assert_eq!(status["killHotkey"], "Ctrl+Alt+Shift+K");
    }
    #[test]
    fn only_the_owner_pause_or_emergency_stop_refuses() {
        let mut d = Desktop;
        assert_eq!(d.route("/v1/desktop/windows", &json!({}), true).unwrap_err().0, 409);
        assert_eq!(
            d.route("/v1/desktop/input", &json!({"action":"key","key":"A"}), true)
                .unwrap_err()
                .0,
            409
        );
        let paused = d.route("/v1/desktop/status", &json!({}), true).unwrap();
        assert_eq!(paused["paused"], true);
        assert_eq!(paused["control"], false);
        let cancelled = d.route_guarded("/v1/desktop/input", &json!({"action":"key","key":"A"}), false, &|| true);
        assert_eq!(cancelled.unwrap_err().0, 409);
        assert_eq!(d.route("/v1/desktop/other", &json!({}), false).unwrap_err().0, 404);
    }
}
