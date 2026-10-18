//! `desk.json` in `%LOCALAPPDATA%\NOVA\`: the address of NOVA, the mode, the helper's display and position, and the
//! wallpaper choice per display. Parsing is lenient (one bad field is replaced by its default and reported, so a
//! hand-edited file never locks the user out) but never panics.

use crate::args::Args;
use crate::geometry::{Anchor, Offset};
use crate::mode::{Mode, WallpaperStyle};
use crate::nav::normalize_origin;
use crate::view::View;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq)]
pub struct DeskConfig {
    pub url: Option<String>,
    pub mode: Mode,
    /// Device name of the display the helper was last on.
    pub helper_display: Option<String>,
    pub helper_view: View,
    pub helper_anchor: Anchor,
    /// Dragged position per display (device name).
    pub positions: BTreeMap<String, Offset>,
    /// Wallpaper style per display (device name); absent = off.
    pub wallpapers: BTreeMap<String, WallpaperStyle>,
}

impl Default for DeskConfig {
    fn default() -> Self {
        DeskConfig {
            url: None,
            mode: Mode::default(),
            helper_display: None,
            helper_view: View::Compact,
            helper_anchor: Anchor::TopCentre,
            positions: BTreeMap::new(),
            wallpapers: BTreeMap::new(),
        }
    }
}

const MAX_OFFSET: f64 = 20000.0;

fn finite_offset(v: &Value) -> Option<Offset> {
    let dx = v.get("dx")?.as_f64()?;
    let dy = v.get("dy")?.as_f64()?;
    if dx.is_finite() && dy.is_finite() && dx.abs() <= MAX_OFFSET && dy.abs() <= MAX_OFFSET {
        Some(Offset { dx, dy })
    } else {
        None
    }
}

/// Parses `desk.json`. Fails only when the text is not a JSON object at all.
pub fn parse(text: &str) -> Result<(DeskConfig, Vec<String>), String> {
    let value: Value = serde_json::from_str(text).map_err(|e| format!("desk.json is geen geldige JSON: {e}"))?;
    let root = value
        .as_object()
        .ok_or_else(|| "desk.json moet een object zijn".to_string())?;
    let mut config = DeskConfig::default();
    let mut warnings = Vec::new();

    match root.get("url") {
        None | Some(Value::Null) => {}
        Some(Value::String(s)) if s.is_empty() => {}
        Some(Value::String(s)) => match normalize_origin(s) {
            Ok(origin) => config.url = Some(origin),
            Err(e) => warnings.push(format!("url genegeerd: {e}")),
        },
        Some(_) => warnings.push("url genegeerd: geen tekst".into()),
    }
    match root.get("mode") {
        None => {}
        Some(Value::String(s)) => match Mode::parse(s) {
            Some(m) => config.mode = m,
            None => warnings.push(format!("mode '{s}' genegeerd")),
        },
        Some(_) => warnings.push("mode genegeerd".into()),
    }
    if let Some(helper) = root.get("helper").and_then(Value::as_object) {
        if let Some(Value::String(s)) = helper.get("display") {
            if !s.is_empty() && s.len() <= 128 {
                config.helper_display = Some(s.clone());
            }
        }
        if let Some(Value::String(s)) = helper.get("view") {
            match View::parse(s) {
                Some(v) if v.is_persistent() || v == View::Compact => config.helper_view = v,
                _ => warnings.push(format!("helper.view '{s}' genegeerd")),
            }
        }
        if let Some(Value::String(s)) = helper.get("anchor") {
            match Anchor::parse(s) {
                Some(a) => config.helper_anchor = a,
                None => warnings.push(format!("helper.anchor '{s}' genegeerd")),
            }
        }
        if let Some(positions) = helper.get("positions").and_then(Value::as_object) {
            for (name, v) in positions {
                match finite_offset(v) {
                    Some(o) => {
                        config.positions.insert(name.clone(), o);
                    }
                    None => warnings.push(format!("positie van {name} genegeerd")),
                }
            }
        }
    }
    if let Some(walls) = root.get("wallpaper").and_then(Value::as_object) {
        for (name, v) in walls {
            match v.as_str().and_then(WallpaperStyle::parse) {
                Some(style) => {
                    config.wallpapers.insert(name.clone(), style);
                }
                None => warnings.push(format!("wallpaper van {name} genegeerd")),
            }
        }
    }
    Ok((config, warnings))
}

impl DeskConfig {
    pub fn to_json(&self) -> String {
        let mut helper = Map::new();
        if let Some(d) = &self.helper_display {
            helper.insert("display".into(), json!(d));
        }
        helper.insert("view".into(), json!(self.helper_view.as_str()));
        helper.insert("anchor".into(), json!(self.helper_anchor.as_str()));
        let positions: Map<String, Value> = self
            .positions
            .iter()
            .map(|(k, o)| (k.clone(), json!({ "dx": o.dx, "dy": o.dy })))
            .collect();
        helper.insert("positions".into(), Value::Object(positions));
        let walls: Map<String, Value> = self
            .wallpapers
            .iter()
            .map(|(k, s)| (k.clone(), json!(s.as_str())))
            .collect();
        let mut root = Map::new();
        if let Some(url) = &self.url {
            root.insert("url".into(), json!(url));
        }
        root.insert("mode".into(), json!(self.mode.as_str()));
        root.insert("helper".into(), Value::Object(helper));
        root.insert("wallpaper".into(), Value::Object(walls));
        let mut text = serde_json::to_string_pretty(&Value::Object(root)).expect("config serializes");
        text.push('\n');
        text
    }

    /// Applies command-line arguments. `monitors` are the device names in display order (display 1 = first).
    /// Returns warnings for choices that cannot be applied (an unknown display number).
    pub fn apply_args(&mut self, args: &Args, monitors: &[String]) -> Vec<String> {
        let mut warnings = Vec::new();
        if let Some(url) = &args.url {
            self.url = Some(url.clone());
        }
        if let Some(mode) = args.mode {
            self.mode = mode;
        }
        match args.display {
            Some(0) | None => {}
            Some(n) => match monitors.get(n as usize - 1) {
                Some(name) => self.helper_display = Some(name.clone()),
                None => warnings.push(format!("scherm {n} bestaat niet (deze pc heeft er {})", monitors.len())),
            },
        }
        if let Some(view) = args.view {
            if view.is_persistent() || view == View::Compact {
                self.helper_view = view;
            }
        }
        for choice in &args.wallpapers {
            let targets: Vec<String> = if choice.display == 0 {
                monitors.to_vec()
            } else {
                match monitors.get(choice.display as usize - 1) {
                    Some(name) => vec![name.clone()],
                    None => {
                        warnings.push(format!(
                            "scherm {} bestaat niet (deze pc heeft er {})",
                            choice.display,
                            monitors.len()
                        ));
                        continue;
                    }
                }
            };
            for name in targets {
                match choice.style {
                    Some(style) => {
                        self.wallpapers.insert(name, style);
                    }
                    None => {
                        self.wallpapers.remove(&name);
                    }
                }
            }
        }
        warnings
    }
}

#[cfg(test)]
#[allow(clippy::field_reassign_with_default)]
mod tests {
    use super::*;
    use crate::args::parse as parse_args;

    fn args(list: &[&str]) -> Args {
        parse_args(list.iter().map(|s| s.to_string())).unwrap()
    }

    fn names() -> Vec<String> {
        vec!["\\\\.\\DISPLAY1".into(), "\\\\.\\DISPLAY2".into()]
    }

    #[test]
    fn an_empty_object_gives_the_defaults() {
        let (c, w) = parse("{}").unwrap();
        assert_eq!(c, DeskConfig::default());
        assert!(w.is_empty());
        assert_eq!(c.mode, Mode::Wallpaper);
        assert_eq!(c.helper_view, View::Compact);
        assert_eq!(c.helper_anchor, Anchor::TopCentre);
    }

    #[test]
    fn a_full_file_parses() {
        let text = r#"{
          "url": "https://nova.example.nl/",
          "mode": "both",
          "helper": { "display": "\\\\.\\DISPLAY2", "view": "chat", "anchor": "top-right",
                      "positions": { "\\\\.\\DISPLAY2": { "dx": 12.5, "dy": 30 } } },
          "wallpaper": { "\\\\.\\DISPLAY1": "full", "\\\\.\\DISPLAY2": "sphere" }
        }"#;
        let (c, w) = parse(text).unwrap();
        assert!(w.is_empty(), "{w:?}");
        assert_eq!(c.url.as_deref(), Some("https://nova.example.nl"));
        assert_eq!(c.mode, Mode::Both);
        assert_eq!(c.helper_display.as_deref(), Some("\\\\.\\DISPLAY2"));
        assert_eq!(c.helper_view, View::Chat);
        assert_eq!(c.helper_anchor, Anchor::TopRight);
        assert_eq!(c.positions["\\\\.\\DISPLAY2"], Offset { dx: 12.5, dy: 30.0 });
        assert_eq!(c.wallpapers.len(), 2);
    }

    #[test]
    fn bad_fields_fall_back_and_are_reported() {
        let text = r#"{ "url": "javascript:alert(1)", "mode": "party", "helper": { "view": "confirmation", "anchor": "middle",
          "positions": { "A": { "dx": "x" }, "B": "x", "C": {"dx": 99999, "dy": 0} } }, "wallpaper": { "A": "neon" } }"#;
        let (c, w) = parse(text).unwrap();
        assert_eq!(c, DeskConfig::default());
        assert_eq!(w.len(), 8, "{w:?}");
    }

    #[test]
    fn the_old_allowed_origins_key_is_ignored_and_not_written_back() {
        let (c, w) = parse(r#"{ "allowedOrigins": ["https://auth.example.nl"] }"#).unwrap();
        assert!(w.is_empty());
        assert_eq!(c, DeskConfig::default());
        assert!(!c.to_json().contains("allowedOrigins"));
    }

    #[test]
    fn broken_files_are_errors_not_panics() {
        assert!(parse("").is_err());
        assert!(parse("{").is_err());
        assert!(parse("[]").is_err());
        assert!(parse("\"x\"").is_err());
        assert!(parse("null").is_err());
    }

    #[test]
    fn wrongly_typed_fields_do_not_panic() {
        let (c, w) = parse(r#"{"url": 5, "mode": 3, "helper": "x", "wallpaper": []}"#).unwrap();
        assert_eq!(c, DeskConfig::default());
        assert_eq!(w.len(), 2);
    }

    #[test]
    fn write_then_read_round_trips() {
        let mut c = DeskConfig::default();
        c.url = Some("http://192.168.1.10:8080".into());
        c.mode = Mode::Helper;
        c.helper_display = Some("\\\\.\\DISPLAY2".into());
        c.helper_view = View::Overview;
        c.positions
            .insert("\\\\.\\DISPLAY2".into(), Offset { dx: -40.25, dy: 8.0 });
        c.wallpapers.insert("\\\\.\\DISPLAY1".into(), WallpaperStyle::Sphere);
        let (back, w) = parse(&c.to_json()).unwrap();
        assert!(w.is_empty());
        assert_eq!(back, c);
    }

    #[test]
    fn arguments_override_and_choose_displays_by_number() {
        let mut c = DeskConfig::default();
        let w = c.apply_args(
            &args(&["--url", "http://nova:8080", "--mode", "helper", "--display", "2"]),
            &names(),
        );
        assert!(w.is_empty());
        assert_eq!(c.url.as_deref(), Some("http://nova:8080"));
        assert_eq!(c.mode, Mode::Helper);
        assert_eq!(c.helper_display.as_deref(), Some("\\\\.\\DISPLAY2"));
    }

    #[test]
    fn display_zero_keeps_the_remembered_display() {
        let mut c = DeskConfig::default();
        c.helper_display = Some("\\\\.\\DISPLAY2".into());
        c.apply_args(&args(&["--display", "0"]), &names());
        assert_eq!(c.helper_display.as_deref(), Some("\\\\.\\DISPLAY2"));
    }

    #[test]
    fn an_unknown_display_number_warns_and_changes_nothing() {
        let mut c = DeskConfig::default();
        let w = c.apply_args(&args(&["--display", "5", "--wallpaper", "7:full"]), &names());
        assert_eq!(w.len(), 2);
        assert_eq!(c, DeskConfig::default());
    }

    #[test]
    fn wallpaper_arguments_set_and_clear_per_display() {
        let mut c = DeskConfig::default();
        c.apply_args(&args(&["--wallpaper", "all:full"]), &names());
        assert_eq!(c.wallpapers.len(), 2);
        c.apply_args(&args(&["--wallpaper", "2:off", "--wallpaper", "1:sphere"]), &names());
        assert_eq!(c.wallpapers.len(), 1);
        assert_eq!(c.wallpapers["\\\\.\\DISPLAY1"], WallpaperStyle::Sphere);
    }

    #[test]
    fn transient_views_are_not_remembered() {
        let mut c = DeskConfig::default();
        c.apply_args(&args(&["--view", "chat"]), &names());
        assert_eq!(c.helper_view, View::Chat);
        c.apply_args(&args(&["--view", "confirmation"]), &names());
        assert_eq!(c.helper_view, View::Chat);
    }
}
