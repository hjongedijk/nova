//! Mouse forwarding for the wallpaper windows.
//!
//! Root cause of "clicking does nothing in wallpaper mode": the wallpaper window is a child of Progman/WorkerW placed
//! BEHIND the icon layer (`SHELLDLL_DefView`), which covers the whole desktop. Windows hit-tests the icon layer first,
//! so the page never receives a mouse message. The glue therefore watches the mouse globally and, when the cursor is
//! over the bare desktop (not over an application window), hands the event to WebView2 browser input.
//! This module owns routing, drag capture and the DevTools mouse parameters; it never injects DOM events.

use crate::geometry::Rect;

/// What the mouse did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerKind {
    Move,
    Down,
    Up,
    /// Browser wheel deltas in CSS pixels; positive values scroll right/down.
    Wheel {
        delta_x: i32,
        delta_y: i32,
    },
}

/// A wallpaper window as the forwarder knows it: its label, its monitor in physical screen pixels, and the scale.
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub label: String,
    /// Native host handle for identifying its owned browser popups; zero in pure tests.
    pub native_handle: isize,
    pub bounds: Rect,
    pub scale: f64,
}

/// Where in a page the event lands, in CSS pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub label: String,
    /// Keep the hook's physical point until WebView2 supplies its current viewport and scale.
    pub screen_point: Option<(i32, i32)>,
    pub x: f64,
    pub y: f64,
}

/// Window classes of the desktop itself. A mouse over any other top-level window belongs to that window.
pub fn is_desktop_class(root_class: &str) -> bool {
    matches!(root_class, "Progman" | "WorkerW")
}

/// The wallpaper that should get a pointer event at physical screen point `point`, or `None` when the cursor is over
/// an application window (`over_desktop == false`) or outside every wallpaper.
pub fn route(point: (i32, i32), over_desktop: bool, targets: &[Target]) -> Option<Hit> {
    if !over_desktop {
        return None;
    }
    let target = targets.iter().find(|t| t.bounds.contains(point.0, point.1))?;
    let scale = if target.scale.is_finite() && target.scale > 0.0 {
        target.scale
    } else {
        1.0
    };
    Some(Hit {
        label: target.label.clone(),
        screen_point: Some(point),
        x: f64::from(point.0 - target.bounds.x) / scale,
        y: f64::from(point.1 - target.bounds.y) / scale,
    })
}

/// One browser input event, directed to a single wallpaper. Cancellation releases its mouse button without
/// focusing the wallpaper or clicking a control when the real pointer has moved onto another application.
#[derive(Debug, Clone, PartialEq)]
pub struct PointerInput {
    pub hit: Hit,
    pub kind: PointerKind,
    pub buttons: u8,
    pub focus: bool,
}

impl PointerInput {
    /// Release a browser press outside every control, without moving focus.
    pub fn cancelled_release(mut self) -> Self {
        self.kind = PointerKind::Up;
        self.buttons = 0;
        self.focus = false;
        self.hit.screen_point = None;
        self.hit.x = -1.0;
        self.hit.y = -1.0;
        self
    }

    /// Reproject at dispatch time: a desktop child can retain its creation monitor's
    /// cached scale while WebView2 already renders at the second monitor's DPI.
    pub fn for_viewport(mut self, viewport: Rect, rasterization_scale: f64, zoom: f64) -> Option<Self> {
        let Some(point) = self.hit.screen_point else {
            // A cancelled drag must stay outside the page, regardless of monitor changes.
            return Some(self);
        };
        let scale = rasterization_scale * zoom;
        if !rasterization_scale.is_finite()
            || rasterization_scale <= 0.0
            || !zoom.is_finite()
            || zoom <= 0.0
            || !scale.is_finite()
            || !viewport.contains(point.0, point.1)
        {
            return (self.kind == PointerKind::Up).then(|| self.cancelled_release());
        }
        self.hit.x = (f64::from(point.0) - f64::from(viewport.x)) / scale;
        self.hit.y = (f64::from(point.1) - f64::from(viewport.y)) / scale;
        Some(self)
    }

    /// CSS pixel coordinates for WebView2's Input.dispatchMouseEvent; no JavaScript execution is involved.
    pub fn params(&self) -> String {
        let event_type = match self.kind {
            PointerKind::Move => "mouseMoved",
            PointerKind::Down => "mousePressed",
            PointerKind::Up => "mouseReleased",
            PointerKind::Wheel { .. } => "mouseWheel",
        };
        let wheel = matches!(self.kind, PointerKind::Wheel { .. });
        let mut params = serde_json::json!({
            "type": event_type,
            "x": finite(self.hit.x),
            "y": finite(self.hit.y),
            "button": if wheel || self.kind == PointerKind::Move && self.buttons == 0 { "none" } else { "left" },
            "buttons": self.buttons,
            "clickCount": if wheel || self.kind == PointerKind::Move { 0 } else { 1 },
        });
        if let PointerKind::Wheel { delta_x, delta_y } = self.kind {
            params["deltaX"] = delta_x.into();
            params["deltaY"] = delta_y.into();
        }
        params.to_string()
    }
}

/// A press belongs to its original wallpaper until release. Leaving it cancels that browser press once;
/// subsequent real application movements/releases are not replayed into any wallpaper.
#[derive(Default)]
pub struct PointerForwarder {
    pressed: Option<Target>,
}

impl PointerForwarder {
    pub const fn new() -> Self {
        Self { pressed: None }
    }

    pub fn event(
        &mut self,
        kind: PointerKind,
        point: (i32, i32),
        over_desktop: bool,
        targets: &[Target],
    ) -> Option<PointerInput> {
        if let Some(pressed) = &self.pressed {
            let active = targets.iter().any(|target| target == pressed);
            if !active || !over_desktop || !pressed.bounds.contains(point.0, point.1) {
                let target = self.pressed.take()?;
                return Some(PointerInput {
                    hit: Hit {
                        label: target.label,
                        screen_point: None,
                        x: -1.0,
                        y: -1.0,
                    },
                    kind: PointerKind::Up,
                    buttons: 0,
                    focus: false,
                });
            }
            let hit = route(point, true, std::slice::from_ref(pressed))?;
            if kind == PointerKind::Up {
                self.pressed = None;
            }
            return Some(PointerInput {
                hit,
                kind,
                buttons: u8::from(kind != PointerKind::Up),
                focus: kind == PointerKind::Down,
            });
        }
        // A button released after a press in an application is that application's input only.
        if kind == PointerKind::Up {
            return None;
        }
        let hit = route(point, over_desktop, targets)?;
        if kind == PointerKind::Down {
            self.pressed = targets.iter().find(|target| target.label == hit.label).cloned();
        }
        Some(PointerInput {
            hit,
            kind,
            buttons: u8::from(kind == PointerKind::Down),
            focus: kind == PointerKind::Down,
        })
    }
}

fn finite(v: f64) -> f64 {
    if v.is_finite() {
        v
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn targets() -> Vec<Target> {
        vec![
            Target {
                label: "wallpaper-a".into(),
                native_handle: 0,
                bounds: Rect::new(0, 0, 1920, 1080),
                scale: 1.0,
            },
            Target {
                label: "wallpaper-b".into(),
                native_handle: 0,
                bounds: Rect::new(1920, -200, 2560, 1440),
                scale: 2.0,
            },
        ]
    }

    #[test]
    fn second_4k_monitor_uses_current_browser_scale_instead_of_primary_creation_scale() {
        let target = Target {
            label: "4k".into(),
            native_handle: 0,
            bounds: Rect::new(1920, 0, 3840, 2160),
            scale: 1.0,
        };
        let mut forwarder = PointerForwarder::new();
        for kind in [
            PointerKind::Down,
            PointerKind::Up,
            PointerKind::Wheel {
                delta_x: 0,
                delta_y: 120,
            },
        ] {
            let input = forwarder
                .event(kind, (3420, 900), true, std::slice::from_ref(&target))
                .unwrap();
            assert_eq!((input.hit.x, input.hit.y), (1500.0, 900.0));
            let input = input.for_viewport(target.bounds, 1.5, 1.0).unwrap();
            assert_eq!((input.hit.x, input.hit.y), (1000.0, 600.0));
        }
    }

    #[test]
    fn a_release_is_cancelled_when_the_browser_moves_or_scale_is_unavailable() {
        for (viewport, scale) in [
            (Rect::new(0, 0, 1920, 1080), 1.0),
            (Rect::new(1920, -200, 2560, 1440), 0.0),
        ] {
            let mut forwarder = PointerForwarder::new();
            forwarder.event(PointerKind::Down, (2020, 0), true, &targets()).unwrap();
            let up = forwarder.event(PointerKind::Up, (2020, 0), true, &targets()).unwrap();
            let release = up.for_viewport(viewport, scale, 1.0).unwrap();
            assert_eq!(release.kind, PointerKind::Up);
            assert_eq!((release.hit.x, release.hit.y), (-1.0, -1.0));
            assert_eq!(release.hit.screen_point, None);
            assert_eq!(release.buttons, 0);
            assert!(!release.focus);
        }
    }

    #[test]
    fn browser_origin_and_zoom_are_current_and_cancelled_drags_stay_cancelled() {
        let mut forwarder = PointerForwarder::new();
        let down = forwarder.event(PointerKind::Down, (2020, 0), true, &targets()).unwrap();
        let input = down.for_viewport(Rect::new(1870, -300, 3840, 2160), 1.5, 1.25).unwrap();
        assert_eq!((input.hit.x, input.hit.y), (80.0, 160.0));
        assert!(input
            .clone()
            .for_viewport(Rect::new(0, 0, 1920, 1080), 1.0, 1.0)
            .is_none());
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(input
                .clone()
                .for_viewport(Rect::new(1920, -200, 3840, 2160), scale, 1.0)
                .is_none());
        }
        let cancelled = forwarder.event(PointerKind::Move, (1, 1), false, &targets()).unwrap();
        let input = cancelled
            .for_viewport(Rect::new(1920, 0, 3840, 2160), 1.5, 1.0)
            .unwrap();
        assert_eq!((input.hit.x, input.hit.y), (-1.0, -1.0));
        assert!(!input.focus);
    }

    #[test]
    fn wheel_routes_without_focusing_and_preserves_horizontal_and_vertical_delta() {
        let mut forwarder = PointerForwarder::new();
        let kind = PointerKind::Wheel {
            delta_x: 40,
            delta_y: -120,
        };
        let input = forwarder.event(kind, (2020, 0), true, &targets()).unwrap();
        assert!(!input.focus);
        let params: serde_json::Value = serde_json::from_str(&input.params()).unwrap();
        assert_eq!(params["type"], "mouseWheel");
        assert_eq!(params["button"], "none");
        assert_eq!(params["x"], 50.0);
        assert_eq!(params["y"], 100.0);
        assert_eq!(params["deltaX"], 40);
        assert_eq!(params["deltaY"], -120);
        assert!(forwarder.event(kind, (100, 50), false, &targets()).is_none());
        assert!(forwarder.event(PointerKind::Up, (100, 50), true, &targets()).is_none());
    }

    #[test]
    fn a_click_on_the_bare_desktop_reaches_the_wallpaper() {
        let hit = route((100, 50), true, &targets()).unwrap();
        assert_eq!((hit.label.as_str(), hit.x, hit.y), ("wallpaper-a", 100.0, 50.0));
    }

    #[test]
    fn a_click_on_an_application_window_is_left_alone() {
        assert_eq!(route((100, 50), false, &targets()), None);
    }

    #[test]
    fn coordinates_are_per_monitor_and_in_css_pixels() {
        let hit = route((1920 + 400, -200 + 200), true, &targets()).unwrap();
        assert_eq!((hit.label.as_str(), hit.x, hit.y), ("wallpaper-b", 200.0, 100.0));
    }

    #[test]
    fn outside_every_wallpaper_nothing_happens() {
        assert_eq!(route((-5, -5), true, &targets()), None);
        assert_eq!(route((0, 0), true, &[]), None);
    }

    #[test]
    fn a_bad_scale_falls_back_to_one() {
        let t = [Target {
            label: "w".into(),
            native_handle: 0,
            bounds: Rect::new(10, 10, 100, 100),
            scale: 0.0,
        }];
        assert_eq!(route((20, 30), true, &t).unwrap().x, 10.0);
    }

    #[test]
    fn only_progman_and_workerw_are_the_desktop() {
        assert!(is_desktop_class("Progman"));
        assert!(is_desktop_class("WorkerW"));
        assert!(!is_desktop_class("Shell_TrayWnd"));
        assert!(!is_desktop_class("Chrome_WidgetWin_1"));
    }

    fn params(input: &PointerInput) -> serde_json::Value {
        serde_json::from_str(&input.params()).unwrap()
    }

    #[test]
    fn browser_click_is_a_press_and_release_not_a_dom_click() {
        let mut forwarder = PointerForwarder::new();
        let down = forwarder.event(PointerKind::Down, (100, 50), true, &targets()).unwrap();
        let up = forwarder.event(PointerKind::Up, (100, 50), true, &targets()).unwrap();
        assert_eq!(
            params(&down),
            serde_json::json!({
                "type": "mousePressed", "x":100.0, "y":50.0, "button":"left", "buttons":1, "clickCount":1
            })
        );
        assert_eq!(params(&up)["type"], "mouseReleased");
        assert_eq!(params(&up)["buttons"], 0);
        assert!(down.focus);
        // Do not move focus away from a native select popup opened on press.
        assert!(!up.focus);
        assert!(forwarder.event(PointerKind::Up, (100, 50), true, &targets()).is_none());
    }

    #[test]
    fn drag_keeps_button_held_and_uses_monitor_css_coordinates() {
        let mut forwarder = PointerForwarder::new();
        forwarder.event(PointerKind::Down, (2020, 0), true, &targets()).unwrap();
        let drag = forwarder
            .event(PointerKind::Move, (2320, 200), true, &targets())
            .unwrap();
        assert_eq!(
            params(&drag),
            serde_json::json!({
                "type":"mouseMoved", "x":200.0, "y":200.0, "button":"left", "buttons":1, "clickCount":0
            })
        );
        assert!(!drag.focus);
        let up = forwarder.event(PointerKind::Up, (2320, 200), true, &targets()).unwrap();
        assert_eq!(params(&up)["buttons"], 0);
        let hover = forwarder
            .event(PointerKind::Move, (2320, 200), true, &targets())
            .unwrap();
        assert_eq!(params(&hover)["button"], "none");
    }

    #[test]
    fn crossing_an_application_or_monitor_boundary_releases_once_without_stealing_focus() {
        for (point, desktop) in [((120, 60), false), ((2000, 0), true), ((-1, -1), true)] {
            let mut forwarder = PointerForwarder::new();
            forwarder.event(PointerKind::Down, (100, 50), true, &targets()).unwrap();
            let release = forwarder.event(PointerKind::Move, point, desktop, &targets()).unwrap();
            assert_eq!(release.kind, PointerKind::Up);
            assert_eq!(release.hit.label, "wallpaper-a");
            assert_eq!((release.hit.x, release.hit.y), (-1.0, -1.0));
            assert!(!release.focus);
            assert_eq!(params(&release)["buttons"], 0);
            assert!(forwarder.event(PointerKind::Up, point, desktop, &targets()).is_none());
        }
    }

    #[test]
    fn removed_wallpaper_releases_capture_and_nonfinite_coordinates_never_enter_json() {
        let mut forwarder = PointerForwarder::new();
        forwarder.event(PointerKind::Down, (100, 50), true, &targets()).unwrap();
        assert_eq!(
            forwarder.event(PointerKind::Up, (100, 50), true, &[]).unwrap().kind,
            PointerKind::Up
        );
        let invalid = PointerInput {
            hit: Hit {
                label: "w".into(),
                screen_point: None,
                x: f64::NAN,
                y: f64::INFINITY,
            },
            kind: PointerKind::Move,
            buttons: 0,
            focus: false,
        };
        assert_eq!(params(&invalid)["x"], 0.0);
        assert_eq!(params(&invalid)["y"], 0.0);
    }
}
