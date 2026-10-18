//! The mode state machine: which windows should exist for a mode, and what to do to get there.
//! Same semantics as the PowerShell agent: wallpaper choices stay remembered when the mode hides them.

use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Mode {
    #[default]
    Wallpaper,
    Helper,
    Both,
}

impl Mode {
    pub fn parse(text: &str) -> Option<Mode> {
        match text {
            "wallpaper" => Some(Mode::Wallpaper),
            "helper" => Some(Mode::Helper),
            "both" => Some(Mode::Both),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Wallpaper => "wallpaper",
            Mode::Helper => "helper",
            Mode::Both => "both",
        }
    }
    pub fn wants_helper(self) -> bool {
        matches!(self, Mode::Helper | Mode::Both)
    }
    pub fn wants_wallpaper(self) -> bool {
        matches!(self, Mode::Wallpaper | Mode::Both)
    }
    /// With the helper on top the wallpaper stays quiet: the helper does the listening and typing.
    pub fn quiet_wallpaper(self) -> bool {
        self == Mode::Both
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WallpaperStyle {
    Full,
    Sphere,
}

impl WallpaperStyle {
    pub fn parse(text: &str) -> Option<WallpaperStyle> {
        match text {
            "full" => Some(WallpaperStyle::Full),
            "sphere" => Some(WallpaperStyle::Sphere),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            WallpaperStyle::Full => "full",
            WallpaperStyle::Sphere => "sphere",
        }
    }
}

/// What one wallpaper window is: its style, and whether it is quiet (no input or voice, mode `both`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WallpaperSpec {
    pub style: WallpaperStyle,
    pub quiet: bool,
}

/// What the user wants.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Desired {
    pub mode: Mode,
    /// The helper window is shown (the tray can hide it without leaving the mode).
    pub helper_visible: bool,
    /// Remembered per monitor name; absent means off.
    pub wallpapers: BTreeMap<String, WallpaperStyle>,
}

/// What exists now.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Running {
    pub helper_exists: bool,
    pub helper_shown: bool,
    pub wallpapers: BTreeMap<String, WallpaperSpec>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    ShowHelper,
    HideHelper,
    CloseHelper,
    CreateWallpaper { monitor: String, spec: WallpaperSpec },
    CloseWallpaper { monitor: String },
}

/// The actions that turn `running` into what `desired` asks, given the monitors that are connected now.
/// Wallpapers go first (they are behind everything); the helper last.
pub fn reconcile(desired: &Desired, connected: &[String], running: &Running) -> Vec<Action> {
    let mut actions = Vec::new();
    let mut wanted: BTreeMap<String, WallpaperSpec> = BTreeMap::new();
    if desired.mode.wants_wallpaper() {
        for (monitor, style) in &desired.wallpapers {
            if connected.iter().any(|c| c == monitor) {
                wanted.insert(
                    monitor.clone(),
                    WallpaperSpec {
                        style: *style,
                        quiet: desired.mode.quiet_wallpaper(),
                    },
                );
            }
        }
    }
    for monitor in running.wallpapers.keys() {
        if !wanted.contains_key(monitor) {
            actions.push(Action::CloseWallpaper {
                monitor: monitor.clone(),
            });
        }
    }
    for (monitor, spec) in &wanted {
        match running.wallpapers.get(monitor) {
            Some(current) if current == spec => {}
            Some(_) => {
                actions.push(Action::CloseWallpaper {
                    monitor: monitor.clone(),
                });
                actions.push(Action::CreateWallpaper {
                    monitor: monitor.clone(),
                    spec: *spec,
                });
            }
            None => actions.push(Action::CreateWallpaper {
                monitor: monitor.clone(),
                spec: *spec,
            }),
        }
    }
    let helper_wanted = desired.mode.wants_helper();
    if !helper_wanted {
        if running.helper_exists {
            actions.push(Action::CloseHelper);
        }
    } else if desired.helper_visible {
        if !running.helper_shown {
            actions.push(Action::ShowHelper);
        }
    } else if running.helper_shown {
        actions.push(Action::HideHelper);
    }
    actions
}

/// Events that change what the user wants.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    SetMode(Mode),
    /// `None` turns the wallpaper of that monitor off.
    SetWallpaper {
        monitor: String,
        style: Option<WallpaperStyle>,
    },
    ToggleHelper,
    ShowHelper,
    HideHelper,
}

pub fn apply_event(mut state: Desired, event: Event) -> Desired {
    match event {
        Event::SetMode(mode) => {
            state.mode = mode;
            // A mode that wants the helper brings it back; the tray's "hide" only lasts within a mode.
            if mode.wants_helper() {
                state.helper_visible = true;
            }
        }
        Event::SetWallpaper { monitor, style } => match style {
            Some(style) => {
                state.wallpapers.insert(monitor, style);
            }
            None => {
                state.wallpapers.remove(&monitor);
            }
        },
        Event::ToggleHelper => state.helper_visible = !state.helper_visible,
        Event::ShowHelper => state.helper_visible = true,
        Event::HideHelper => state.helper_visible = false,
    }
    state
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn desired(mode: Mode, helper_visible: bool, walls: &[(&str, WallpaperStyle)]) -> Desired {
        Desired {
            mode,
            helper_visible,
            wallpapers: walls.iter().map(|(m, s)| (m.to_string(), *s)).collect(),
        }
    }

    fn spec(style: WallpaperStyle, quiet: bool) -> WallpaperSpec {
        WallpaperSpec { style, quiet }
    }

    #[test]
    fn mode_parse_and_flags() {
        assert_eq!(Mode::parse("both"), Some(Mode::Both));
        assert_eq!(Mode::parse("Both"), None);
        assert!(Mode::Both.wants_helper() && Mode::Both.wants_wallpaper() && Mode::Both.quiet_wallpaper());
        assert!(!Mode::Helper.wants_wallpaper());
        assert!(!Mode::Wallpaper.wants_helper() && !Mode::Wallpaper.quiet_wallpaper());
        assert_eq!(Mode::default(), Mode::Wallpaper);
    }

    #[test]
    fn wallpaper_mode_creates_only_the_chosen_monitors() {
        let d = desired(Mode::Wallpaper, true, &[("A", WallpaperStyle::Full)]);
        let actions = reconcile(&d, &names(&["A", "B"]), &Running::default());
        assert_eq!(
            actions,
            vec![Action::CreateWallpaper {
                monitor: "A".into(),
                spec: spec(WallpaperStyle::Full, false)
            }]
        );
    }

    #[test]
    fn helper_mode_keeps_choices_but_shows_no_wallpaper() {
        let d = desired(Mode::Helper, true, &[("A", WallpaperStyle::Full)]);
        let mut running = Running::default();
        running.wallpapers.insert("A".into(), spec(WallpaperStyle::Full, false));
        let actions = reconcile(&d, &names(&["A"]), &running);
        assert_eq!(
            actions,
            vec![Action::CloseWallpaper { monitor: "A".into() }, Action::ShowHelper]
        );
        // the choice is still in `d`
        assert_eq!(d.wallpapers.len(), 1);
    }

    #[test]
    fn both_makes_the_wallpaper_quiet_and_recreates_a_loud_one() {
        let d = desired(Mode::Both, true, &[("A", WallpaperStyle::Sphere)]);
        let mut running = Running::default();
        running
            .wallpapers
            .insert("A".into(), spec(WallpaperStyle::Sphere, false));
        let actions = reconcile(&d, &names(&["A"]), &running);
        assert_eq!(
            actions,
            vec![
                Action::CloseWallpaper { monitor: "A".into() },
                Action::CreateWallpaper {
                    monitor: "A".into(),
                    spec: spec(WallpaperStyle::Sphere, true)
                },
                Action::ShowHelper
            ]
        );
    }

    #[test]
    fn nothing_to_do_when_everything_matches() {
        let d = desired(Mode::Both, true, &[("A", WallpaperStyle::Full)]);
        let running = Running {
            helper_exists: true,
            helper_shown: true,
            wallpapers: [("A".to_string(), spec(WallpaperStyle::Full, true))]
                .into_iter()
                .collect(),
        };
        assert!(reconcile(&d, &names(&["A"]), &running).is_empty());
    }

    #[test]
    fn a_disconnected_monitor_loses_its_window_and_a_returning_one_gets_it_back() {
        let d = desired(
            Mode::Wallpaper,
            true,
            &[("A", WallpaperStyle::Full), ("B", WallpaperStyle::Full)],
        );
        let mut running = Running::default();
        running.wallpapers.insert("A".into(), spec(WallpaperStyle::Full, false));
        running.wallpapers.insert("B".into(), spec(WallpaperStyle::Full, false));
        assert_eq!(
            reconcile(&d, &names(&["A"]), &running),
            vec![Action::CloseWallpaper { monitor: "B".into() }]
        );
        running.wallpapers.remove("B");
        assert_eq!(
            reconcile(&d, &names(&["A", "B"]), &running),
            vec![Action::CreateWallpaper {
                monitor: "B".into(),
                spec: spec(WallpaperStyle::Full, false)
            }]
        );
    }

    #[test]
    fn hiding_the_helper_does_not_close_it() {
        let d = desired(Mode::Helper, false, &[]);
        let running = Running {
            helper_exists: true,
            helper_shown: true,
            wallpapers: Default::default(),
        };
        assert_eq!(reconcile(&d, &[], &running), vec![Action::HideHelper]);
        let hidden = Running {
            helper_exists: true,
            helper_shown: false,
            wallpapers: Default::default(),
        };
        assert!(reconcile(&d, &[], &hidden).is_empty());
    }

    #[test]
    fn leaving_helper_mode_closes_the_helper() {
        let d = desired(Mode::Wallpaper, true, &[]);
        let running = Running {
            helper_exists: true,
            helper_shown: true,
            wallpapers: Default::default(),
        };
        assert_eq!(reconcile(&d, &[], &running), vec![Action::CloseHelper]);
        let never = Running::default();
        assert!(reconcile(&d, &[], &never).is_empty());
    }

    #[test]
    fn events_change_the_state() {
        let s = apply_event(Desired::default(), Event::SetMode(Mode::Helper));
        assert_eq!(s.mode, Mode::Helper);
        assert!(s.helper_visible);
        let s = apply_event(s, Event::HideHelper);
        assert!(!s.helper_visible);
        let s = apply_event(s, Event::ToggleHelper);
        assert!(s.helper_visible);
        let s = apply_event(
            s,
            Event::SetWallpaper {
                monitor: "A".into(),
                style: Some(WallpaperStyle::Sphere),
            },
        );
        assert_eq!(s.wallpapers.get("A"), Some(&WallpaperStyle::Sphere));
        let s = apply_event(
            s,
            Event::SetWallpaper {
                monitor: "A".into(),
                style: None,
            },
        );
        assert!(s.wallpapers.is_empty());
    }

    #[test]
    fn a_new_mode_that_wants_the_helper_brings_it_back() {
        let hidden = Desired {
            mode: Mode::Wallpaper,
            helper_visible: false,
            wallpapers: Default::default(),
        };
        let s = apply_event(hidden, Event::SetMode(Mode::Both));
        assert!(s.helper_visible);
    }
}
