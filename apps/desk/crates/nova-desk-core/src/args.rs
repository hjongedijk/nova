//! Command-line arguments. The same parser reads the arguments of the first start and those that a second start
//! hands to the running instance (single instance), which is how the PowerShell agent steers NOVA Desk.

use crate::mode::{Mode, WallpaperStyle};
use crate::nav::normalize_origin;
use crate::script::MAX_NOTIFICATION_BYTES;
use crate::view::View;
use base64::Engine;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArgError {
    Unknown(String),
    MissingValue(String),
    BadValue { name: String, why: String },
}

impl std::fmt::Display for ArgError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ArgError::Unknown(a) => write!(f, "onbekend argument '{a}'"),
            ArgError::MissingValue(a) => write!(f, "argument {a} mist een waarde"),
            ArgError::BadValue { name, why } => write!(f, "argument {name}: {why}"),
        }
    }
}

/// One `--wallpaper` choice: display number (0 = all displays) and style (`None` = off).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WallpaperArg {
    pub display: u32,
    pub style: Option<WallpaperStyle>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Args {
    /// `--url`: the NOVA address, normalised.
    pub url: Option<String>,
    /// `--mode helper|wallpaper|both`
    pub mode: Option<Mode>,
    /// `--display N` (1-based; 0 means "no preference")
    pub display: Option<u32>,
    /// `--view compact|overview|chat|...`
    pub view: Option<View>,
    /// `--hidden`: with `--view`, show the thin autohide strip.
    pub hidden: bool,
    /// `--action open|speak|mute|settings|pause` (from the agent's tray and shortcuts)
    pub action: Option<String>,
    /// `--paused true|false`, for the pause action
    pub paused: Option<bool>,
    /// `--notify <base64url JSON>`: a helper notification from the agent, decoded.
    pub notify: Option<String>,
    /// `--wallpaper N:full|sphere|off` (repeatable)
    pub wallpapers: Vec<WallpaperArg>,
    /// `--show` / `--hide`: the helper window.
    pub show: bool,
    pub hide: bool,
    /// `--quit`: ends the running instance.
    pub quit: bool,
}

fn value_of(name: &str, inline: Option<String>, rest: &mut std::vec::IntoIter<String>) -> Result<String, ArgError> {
    if let Some(v) = inline {
        return Ok(v);
    }
    match rest.next() {
        Some(v) if !v.starts_with("--") => Ok(v),
        _ => Err(ArgError::MissingValue(name.to_string())),
    }
}

fn bad(name: &str, why: &str) -> ArgError {
    ArgError::BadValue {
        name: name.to_string(),
        why: why.to_string(),
    }
}

fn parse_bool(name: &str, text: &str) -> Result<bool, ArgError> {
    match text {
        "true" | "1" | "yes" => Ok(true),
        "false" | "0" | "no" => Ok(false),
        _ => Err(bad(name, "gebruik true of false")),
    }
}

/// Parses the arguments WITHOUT the program name.
pub fn parse<I: IntoIterator<Item = String>>(input: I) -> Result<Args, ArgError> {
    let mut args = Args::default();
    let mut rest = input.into_iter().collect::<Vec<_>>().into_iter();
    while let Some(arg) = rest.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((n, v)) if n.starts_with("--") => (n.to_string(), Some(v.to_string())),
            _ => (arg.clone(), None),
        };
        match name.as_str() {
            "--url" => {
                let v = value_of(&name, inline, &mut rest)?;
                args.url = Some(normalize_origin(&v).map_err(|e| bad(&name, &e.to_string()))?);
            }
            "--mode" => {
                let v = value_of(&name, inline, &mut rest)?;
                args.mode = Some(Mode::parse(&v).ok_or_else(|| bad(&name, "gebruik helper, wallpaper of both"))?);
            }
            "--display" => {
                let v = value_of(&name, inline, &mut rest)?;
                args.display = Some(
                    v.parse::<u32>()
                        .ok()
                        .filter(|n| *n <= 64)
                        .ok_or_else(|| bad(&name, "gebruik een schermnummer (0 = hoofdscherm)"))?,
                );
            }
            "--view" => {
                let v = value_of(&name, inline, &mut rest)?;
                args.view = Some(View::parse(&v).ok_or_else(|| bad(&name, "onbekende weergave"))?);
            }
            "--action" => {
                let v = value_of(&name, inline, &mut rest)?;
                if !crate::script::ACTIONS.contains(&v.as_str()) {
                    return Err(bad(&name, "onbekende actie"));
                }
                args.action = Some(v);
            }
            "--paused" => {
                let v = value_of(&name, inline, &mut rest)?;
                args.paused = Some(parse_bool(&name, &v)?);
            }
            "--notify" => {
                let v = value_of(&name, inline, &mut rest)?;
                if v.len() > MAX_NOTIFICATION_BYTES * 2 {
                    return Err(bad(&name, "te groot"));
                }
                let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .decode(v.trim_end_matches('='))
                    .map_err(|_| bad(&name, "geen geldige base64url"))?;
                let text = String::from_utf8(bytes).map_err(|_| bad(&name, "geen UTF-8"))?;
                if text.len() > MAX_NOTIFICATION_BYTES {
                    return Err(bad(&name, "te groot"));
                }
                args.notify = Some(text);
            }
            "--wallpaper" => {
                let v = value_of(&name, inline, &mut rest)?;
                let (display, style) = v
                    .split_once(':')
                    .ok_or_else(|| bad(&name, "gebruik N:full, N:sphere of N:off"))?;
                let display = if display == "all" {
                    0
                } else {
                    display
                        .parse::<u32>()
                        .ok()
                        .filter(|n| *n <= 64)
                        .ok_or_else(|| bad(&name, "ongeldig schermnummer"))?
                };
                let style = match style {
                    "off" => None,
                    other => {
                        Some(WallpaperStyle::parse(other).ok_or_else(|| bad(&name, "gebruik full, sphere of off"))?)
                    }
                };
                args.wallpapers.push(WallpaperArg { display, style });
            }
            "--hidden" => args.hidden = true,
            "--show" => args.show = true,
            "--hide" => args.hide = true,
            "--quit" => args.quit = true,
            _ => return Err(ArgError::Unknown(arg)),
        }
    }
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(list: &[&str]) -> Result<Args, ArgError> {
        parse(list.iter().map(|s| s.to_string()))
    }

    #[test]
    fn no_arguments_is_fine() {
        assert_eq!(p(&[]).unwrap(), Args::default());
    }

    #[test]
    fn the_documented_arguments_parse() {
        let a = p(&["--url", "http://nova:8080/", "--mode", "both", "--display", "2"]).unwrap();
        assert_eq!(a.url.as_deref(), Some("http://nova:8080"));
        assert_eq!(a.mode, Some(Mode::Both));
        assert_eq!(a.display, Some(2));
    }

    #[test]
    fn equals_form_works() {
        let a = p(&["--mode=helper", "--display=0", "--view=chat"]).unwrap();
        assert_eq!(a.mode, Some(Mode::Helper));
        assert_eq!(a.display, Some(0));
        assert_eq!(a.view, Some(View::Chat));
    }

    #[test]
    fn bad_values_are_errors() {
        assert!(matches!(p(&["--mode", "party"]), Err(ArgError::BadValue { .. })));
        assert!(matches!(p(&["--display", "-1"]), Err(ArgError::BadValue { .. })));
        assert!(matches!(p(&["--display", "x"]), Err(ArgError::BadValue { .. })));
        assert!(matches!(p(&["--display", "999"]), Err(ArgError::BadValue { .. })));
        assert!(matches!(p(&["--url", "ftp://x"]), Err(ArgError::BadValue { .. })));
        assert!(matches!(p(&["--url", "https://a/b"]), Err(ArgError::BadValue { .. })));
        assert!(matches!(p(&["--view", "huge"]), Err(ArgError::BadValue { .. })));
        assert!(matches!(
            p(&["--action", "format-disk"]),
            Err(ArgError::BadValue { .. })
        ));
    }

    #[test]
    fn missing_values_and_unknown_flags_are_errors() {
        assert_eq!(p(&["--mode"]), Err(ArgError::MissingValue("--mode".into())));
        assert_eq!(
            p(&["--mode", "--display"]),
            Err(ArgError::MissingValue("--mode".into()))
        );
        assert_eq!(p(&["--exec", "calc.exe"]), Err(ArgError::Unknown("--exec".into())));
        assert_eq!(p(&["stray"]), Err(ArgError::Unknown("stray".into())));
    }

    #[test]
    fn wallpaper_choices_repeat() {
        let a = p(&[
            "--wallpaper",
            "1:full",
            "--wallpaper",
            "2:off",
            "--wallpaper",
            "all:sphere",
        ])
        .unwrap();
        assert_eq!(
            a.wallpapers,
            vec![
                WallpaperArg {
                    display: 1,
                    style: Some(WallpaperStyle::Full)
                },
                WallpaperArg {
                    display: 2,
                    style: None
                },
                WallpaperArg {
                    display: 0,
                    style: Some(WallpaperStyle::Sphere)
                },
            ]
        );
        assert!(p(&["--wallpaper", "1"]).is_err());
        assert!(p(&["--wallpaper", "1:neon"]).is_err());
    }

    #[test]
    fn flags_and_actions() {
        let a = p(&[
            "--view", "overview", "--hidden", "--show", "--action", "pause", "--paused", "true",
        ])
        .unwrap();
        assert!(a.hidden && a.show && !a.hide && !a.quit);
        assert_eq!(a.action.as_deref(), Some("pause"));
        assert_eq!(a.paused, Some(true));
        assert!(p(&["--quit"]).unwrap().quit);
        assert!(p(&["--paused", "maybe"]).is_err());
    }

    #[test]
    fn a_notification_is_decoded_from_base64url() {
        let json = r#"{"seq":5,"title":"Hoi"}"#;
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json);
        assert_eq!(p(&["--notify", &encoded]).unwrap().notify.as_deref(), Some(json));
        let padded = format!("{encoded}==");
        assert_eq!(p(&["--notify", &padded]).unwrap().notify.as_deref(), Some(json));
        assert!(p(&["--notify", "***"]).is_err());
        let huge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode("x".repeat(5000));
        assert!(p(&["--notify", &huge]).is_err());
    }
}
