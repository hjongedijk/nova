//! Mouse forwarding for the wallpaper windows.
//!
//! Root cause of "clicking does nothing in wallpaper mode": the wallpaper window is a child of Progman/WorkerW placed
//! BEHIND the icon layer (`SHELLDLL_DefView`), which covers the whole desktop. Windows hit-tests the icon layer first,
//! so the page never receives a mouse message. The glue therefore watches the mouse globally and, when the cursor is
//! over the bare desktop (not over an application window), hands the event to WebView2 browser input.
//!
//! Which clicks belong to the page is decided with the page's own interactive rectangles (`window.__novaZones()`,
//! polled by the glue and converted to physical screen pixels by [`parse_zones`]):
//! - a press on a control is forwarded and SWALLOWED, so Explorer does not also start a rubber-band selection, take
//!   the focus or deselect icons while the page handles the click;
//! - a press on a text field is forwarded and also left to Explorer: that activates the desktop, which is the
//!   condition for typing (see `keys`);
//! - a press anywhere else is Explorer's alone (icons, selecting, the desktop menu); it never reaches the page.
//!
//! Movement is never swallowed (the cursor must move) and is forwarded over the whole bare desktop, so hover,
//! `pointerenter`/`pointerleave` and the "move to the bottom" reveal work; leaving the desktop sends one move outside
//! the page so hover ends. This module owns routing, drag capture and the DevTools mouse parameters; it never
//! injects DOM events.

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

/// An interactive rectangle of a wallpaper page, in physical screen pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Zone {
    pub rect: Rect,
    /// Typing goes here (a text field, or an open window with fields).
    pub typing: bool,
}

/// Converts the page's `__novaZones()` answer — `"x,y,w,h,t;..."` in CSS pixels relative to the viewport — into
/// physical screen rectangles, rounded outward so the edge of a control is never left to the desktop and clipped to
/// the page. `None` when the scale is unusable; malformed entries are skipped.
pub fn parse_zones(text: &str, viewport: Rect, scale: f64) -> Option<Vec<Zone>> {
    if !scale.is_finite() || scale <= 0.0 {
        return None;
    }
    let mut zones = Vec::new();
    for entry in text.split(';') {
        let fields: Vec<f64> = entry
            .split(',')
            .map(|field| field.trim().parse::<f64>().unwrap_or(f64::NAN))
            .collect();
        let [x, y, w, h, t] = fields[..] else { continue };
        if ![x, y, w, h, t].iter().all(|v| v.is_finite()) || w <= 0.0 || h <= 0.0 {
            continue;
        }
        let left = (f64::from(viewport.x) + x * scale).floor().max(f64::from(viewport.x));
        let top = (f64::from(viewport.y) + y * scale).floor().max(f64::from(viewport.y));
        let right = (f64::from(viewport.x) + (x + w) * scale)
            .ceil()
            .min(f64::from(viewport.right()));
        let bottom = (f64::from(viewport.y) + (y + h) * scale)
            .ceil()
            .min(f64::from(viewport.bottom()));
        if right <= left || bottom <= top {
            continue;
        }
        zones.push(Zone {
            rect: Rect::new(left as i32, top as i32, (right - left) as i32, (bottom - top) as i32),
            typing: t == 1.0,
        });
    }
    Some(zones)
}

/// Where a point falls relative to a page's interactive rectangles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZoneHit {
    /// The page has not reported its rectangles (yet, or an old page): forward, but leave the desktop its click too.
    Unknown,
    /// Bare desktop: Explorer's alone.
    Outside,
    Inside {
        typing: bool,
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
    /// The page's interactive rectangles in physical screen pixels; `None` while unknown or stale.
    pub zones: Option<Vec<Zone>>,
}

impl Target {
    pub fn zone_at(&self, point: (i32, i32)) -> ZoneHit {
        let Some(zones) = &self.zones else {
            return ZoneHit::Unknown;
        };
        let mut hit: Option<bool> = None;
        for zone in zones.iter().filter(|zone| zone.rect.contains(point.0, point.1)) {
            hit = Some(hit.unwrap_or(false) || zone.typing);
        }
        match hit {
            Some(typing) => ZoneHit::Inside { typing },
            None => ZoneHit::Outside,
        }
    }

    /// The same window in the same place; its zones may change while a button is held.
    fn same_window(&self, other: &Target) -> bool {
        self.label == other.label && self.native_handle == other.native_handle && self.bounds == other.bounds
    }
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

impl Hit {
    /// A point outside the page: ends hover or a press without touching a control.
    fn outside(label: String) -> Self {
        Hit {
            label,
            screen_point: None,
            x: -1.0,
            y: -1.0,
        }
    }
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
            // A cancelled drag or an ended hover must stay outside the page, regardless of monitor changes.
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

/// What to do with one real mouse event: browser input to send (in order) and whether Windows must drop it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Routed {
    pub inputs: Vec<PointerInput>,
    /// Return non-zero from the low-level hook: the desktop (and every other window) never sees this event.
    /// Only presses, releases and wheel turns are ever swallowed, never movement.
    pub swallow: bool,
}

/// A press belongs to its original wallpaper until release. Leaving it cancels that browser press once;
/// subsequent real application movements/releases are not replayed into any wallpaper.
#[derive(Default)]
pub struct PointerForwarder {
    pressed: Option<Target>,
    /// The real button-down was swallowed, so its button-up must be too (wherever it happens).
    swallowed_down: bool,
    /// The wallpaper that last got a hover move; it gets one move outside when the cursor leaves it.
    hovering: Option<String>,
    /// The wallpaper whose text field was clicked last; keyboard input may go there while the desktop is active.
    typing: Option<String>,
}

impl PointerForwarder {
    pub const fn new() -> Self {
        Self {
            pressed: None,
            swallowed_down: false,
            hovering: None,
            typing: None,
        }
    }

    /// The wallpaper that should receive typing: a text field of it was clicked and nothing else since.
    pub fn typing_target(&self) -> Option<&str> {
        self.typing.as_deref()
    }

    /// Typing ends (Esc, Alt+Tab, the wallpaper went away).
    pub fn stop_typing(&mut self) {
        self.typing = None;
    }

    pub fn event(&mut self, kind: PointerKind, point: (i32, i32), over_desktop: bool, targets: &[Target]) -> Routed {
        let swallow_release = kind == PointerKind::Up && std::mem::take(&mut self.swallowed_down);
        if let Some(pressed) = self.pressed.take() {
            let active = targets.iter().any(|target| target.same_window(&pressed));
            if !active || !over_desktop || !pressed.bounds.contains(point.0, point.1) {
                self.hovering = None;
                let cancel = PointerInput {
                    hit: Hit::outside(pressed.label),
                    kind: PointerKind::Up,
                    buttons: 0,
                    focus: false,
                };
                return Routed {
                    inputs: vec![cancel],
                    swallow: swallow_release,
                };
            }
            let hit = route(point, true, std::slice::from_ref(&pressed)).expect("point lies in the pressed window");
            if kind != PointerKind::Up {
                self.pressed = Some(pressed);
            }
            let swallow = match kind {
                PointerKind::Move => false,
                PointerKind::Up => swallow_release,
                // Another press or a wheel turn while the button is held follows the press.
                PointerKind::Down | PointerKind::Wheel { .. } => self.swallowed_down,
            };
            let input = PointerInput {
                hit,
                kind,
                buttons: u8::from(kind != PointerKind::Up),
                focus: false,
            };
            return Routed {
                inputs: vec![input],
                swallow,
            };
        }
        // A button released after a press in an application or on the bare desktop is not the page's.
        if kind == PointerKind::Up {
            return Routed {
                inputs: Vec::new(),
                swallow: swallow_release,
            };
        }
        let Some(hit) = route(point, over_desktop, targets) else {
            if kind == PointerKind::Down {
                self.typing = None;
            }
            return Routed {
                inputs: self.leave(None).into_iter().collect(),
                swallow: false,
            };
        };
        let mut inputs: Vec<PointerInput> = self.leave(Some(&hit.label)).into_iter().collect();
        let Some(target) = targets.iter().find(|target| target.label == hit.label) else {
            return Routed::default();
        };
        let zone = target.zone_at(point);
        let hover = |hit: Hit| PointerInput {
            hit,
            kind: PointerKind::Move,
            buttons: 0,
            focus: false,
        };
        self.hovering = Some(hit.label.clone());
        match kind {
            PointerKind::Move => {
                inputs.push(hover(hit));
                Routed { inputs, swallow: false }
            }
            PointerKind::Wheel { .. } => {
                if zone != ZoneHit::Outside {
                    inputs.push(PointerInput {
                        hit,
                        kind,
                        buttons: 0,
                        focus: false,
                    });
                }
                Routed {
                    inputs,
                    swallow: matches!(zone, ZoneHit::Inside { .. }),
                }
            }
            PointerKind::Down => {
                // (swallow the real press, focus the page, keyboard goes to the page)
                let (swallow, focus, typing) = match zone {
                    // Icons, selecting and the desktop menu stay Explorer's.
                    ZoneHit::Outside => {
                        self.typing = None;
                        return Routed { inputs, swallow: false };
                    }
                    // An older page without zones: the earlier behaviour, both get the press.
                    ZoneHit::Unknown => (false, true, false),
                    ZoneHit::Inside { typing } => (!typing, typing, typing),
                };
                self.pressed = Some(target.clone());
                self.swallowed_down = swallow;
                self.typing = typing.then(|| hit.label.clone());
                // Chromium has not seen the pointer arrive when moves were coalesced: a move to the press point
                // first makes the press hit the element under the cursor every time.
                inputs.push(hover(hit.clone()));
                inputs.push(PointerInput {
                    hit,
                    kind,
                    buttons: 1,
                    focus,
                });
                Routed { inputs, swallow }
            }
            PointerKind::Up => Routed::default(),
        }
    }

    /// One move outside the page that was hovered, unless the pointer is still on that page.
    fn leave(&mut self, now: Option<&str>) -> Option<PointerInput> {
        if self.hovering.as_deref() == now {
            return None;
        }
        let label = self.hovering.take()?;
        Some(PointerInput {
            hit: Hit::outside(label),
            kind: PointerKind::Move,
            buttons: 0,
            focus: false,
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

    fn target(label: &str, bounds: Rect, scale: f64, zones: Option<Vec<Zone>>) -> Target {
        Target {
            label: label.into(),
            native_handle: 0,
            bounds,
            scale,
            zones,
        }
    }

    /// Two monitors without page zones (an older page): the earlier forward-everything behaviour.
    fn targets() -> Vec<Target> {
        vec![
            target("wallpaper-a", Rect::new(0, 0, 1920, 1080), 1.0, None),
            target("wallpaper-b", Rect::new(1920, -200, 2560, 1440), 2.0, None),
        ]
    }

    /// One monitor whose page reported a button at 100..200 x 40..60 and a text field at 600..1000 x 900..940.
    fn zoned() -> Vec<Target> {
        vec![target(
            "wallpaper-a",
            Rect::new(0, 0, 1920, 1080),
            1.0,
            Some(vec![
                Zone {
                    rect: Rect::new(100, 40, 100, 20),
                    typing: false,
                },
                Zone {
                    rect: Rect::new(600, 900, 400, 40),
                    typing: true,
                },
            ]),
        )]
    }

    fn kinds(routed: &Routed) -> Vec<PointerKind> {
        routed.inputs.iter().map(|input| input.kind).collect()
    }

    fn last(routed: Routed) -> PointerInput {
        routed.inputs.last().cloned().expect("an input")
    }

    #[test]
    fn zones_are_parsed_into_physical_screen_pixels_on_a_scaled_negative_monitor() {
        let viewport = Rect::new(-2560, -200, 2560, 1440);
        let zones = parse_zones("10,20,30,40,0;100.4,0,10.2,10,1", viewport, 1.5).unwrap();
        assert_eq!(
            zones,
            vec![
                Zone {
                    rect: Rect::new(-2545, -170, 45, 60),
                    typing: false
                },
                Zone {
                    rect: Rect::new(-2410, -200, 16, 15),
                    typing: true
                },
            ]
        );
    }

    #[test]
    fn malformed_empty_and_offscreen_zones_are_skipped_and_partial_ones_clipped() {
        let viewport = Rect::new(0, 0, 1000, 500);
        assert_eq!(parse_zones("", viewport, 1.0), Some(vec![]));
        assert_eq!(
            parse_zones(
                "1,2,3;a,b,c,d,e;1,1,0,5,0;1,1,5,-5,0;NaN,1,1,1,0;5000,5,10,10,0",
                viewport,
                1.0
            ),
            Some(vec![])
        );
        assert_eq!(
            parse_zones("-20,490,40,40,0", viewport, 1.0).unwrap(),
            vec![Zone {
                rect: Rect::new(0, 490, 20, 10),
                typing: false
            }]
        );
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(parse_zones("1,1,1,1,0", viewport, scale), None);
        }
    }

    #[test]
    fn zone_hit_test_distinguishes_unknown_outside_control_and_field() {
        let t = &zoned()[0];
        assert_eq!(t.zone_at((150, 50)), ZoneHit::Inside { typing: false });
        assert_eq!(t.zone_at((700, 920)), ZoneHit::Inside { typing: true });
        assert_eq!(t.zone_at((200, 50)), ZoneHit::Outside, "right edge is exclusive");
        assert_eq!(t.zone_at((5, 5)), ZoneHit::Outside);
        assert_eq!(targets()[0].zone_at((5, 5)), ZoneHit::Unknown);
        let mut overlap = zoned()[0].clone();
        overlap.zones.as_mut().unwrap().push(Zone {
            rect: Rect::new(0, 0, 1920, 1080),
            typing: true,
        });
        assert_eq!(overlap.zone_at((150, 50)), ZoneHit::Inside { typing: true });
    }

    #[test]
    fn a_click_on_a_page_control_is_forwarded_and_hidden_from_the_desktop() {
        let mut forwarder = PointerForwarder::new();
        let down = forwarder.event(PointerKind::Down, (150, 50), true, &zoned());
        assert!(down.swallow);
        assert_eq!(kinds(&down), vec![PointerKind::Move, PointerKind::Down]);
        assert!(!down.inputs[1].focus);
        // The drag leaves the control: still the page's press, movement is never swallowed.
        let drag = forwarder.event(PointerKind::Move, (400, 300), true, &zoned());
        assert!(!drag.swallow);
        assert_eq!(params(&drag.inputs[0])["buttons"], 1);
        let up = forwarder.event(PointerKind::Up, (400, 300), true, &zoned());
        assert!(up.swallow, "the release of a swallowed press is swallowed too");
        assert_eq!(kinds(&up), vec![PointerKind::Up]);
        assert_eq!(forwarder.typing_target(), None);
    }

    #[test]
    fn the_bare_desktop_and_its_icons_stay_explorers() {
        let mut forwarder = PointerForwarder::new();
        let down = forwarder.event(PointerKind::Down, (5, 5), true, &zoned());
        assert!(!down.swallow);
        assert!(down.inputs.iter().all(|i| i.kind != PointerKind::Down));
        // Dragging an icon (or a selection rectangle) across a control does not become a page press.
        let over_control = forwarder.event(PointerKind::Move, (150, 50), true, &zoned());
        assert_eq!(params(&over_control.inputs[0])["buttons"], 0);
        let up = forwarder.event(PointerKind::Up, (150, 50), true, &zoned());
        assert_eq!(up, Routed::default());
        let wheel = PointerKind::Wheel {
            delta_x: 0,
            delta_y: 120,
        };
        assert!(!forwarder.event(wheel, (5, 5), true, &zoned()).swallow);
        assert!(forwarder
            .event(wheel, (5, 5), true, &zoned())
            .inputs
            .iter()
            .all(|i| i.kind == PointerKind::Move));
        let scroll = forwarder.event(wheel, (150, 50), true, &zoned());
        assert!(scroll.swallow);
        assert_eq!(kinds(&scroll), vec![wheel]);
    }

    #[test]
    fn a_click_on_a_text_field_reaches_both_and_arms_typing_until_a_click_elsewhere() {
        let mut forwarder = PointerForwarder::new();
        let down = forwarder.event(PointerKind::Down, (700, 920), true, &zoned());
        assert!(!down.swallow, "Explorer must activate the desktop so keys can be taken");
        assert!(down.inputs[1].focus);
        assert_eq!(forwarder.typing_target(), Some("wallpaper-a"));
        let up = forwarder.event(PointerKind::Up, (700, 920), true, &zoned());
        assert!(!up.swallow);
        assert_eq!(forwarder.typing_target(), Some("wallpaper-a"));
        forwarder.event(PointerKind::Down, (150, 50), true, &zoned());
        assert_eq!(forwarder.typing_target(), None);
        forwarder.event(PointerKind::Up, (150, 50), true, &zoned());
        forwarder.event(PointerKind::Down, (700, 920), true, &zoned());
        forwarder.event(PointerKind::Up, (700, 920), true, &zoned());
        forwarder.event(PointerKind::Down, (5, 5), true, &zoned());
        assert_eq!(forwarder.typing_target(), None);
        forwarder.event(PointerKind::Up, (5, 5), true, &zoned());
        forwarder.event(PointerKind::Down, (700, 920), true, &zoned());
        forwarder.event(PointerKind::Up, (700, 920), true, &zoned());
        forwarder.event(PointerKind::Down, (700, 920), false, &zoned());
        assert_eq!(forwarder.typing_target(), None, "a click in an application ends typing");
        forwarder.event(PointerKind::Up, (700, 920), false, &zoned());
        forwarder.event(PointerKind::Down, (700, 920), true, &zoned());
        forwarder.stop_typing();
        assert_eq!(forwarder.typing_target(), None);
    }

    #[test]
    fn hover_ends_with_one_move_outside_when_the_pointer_leaves_for_an_application() {
        let mut forwarder = PointerForwarder::new();
        let hover = forwarder.event(PointerKind::Move, (150, 50), true, &zoned());
        assert_eq!(kinds(&hover), vec![PointerKind::Move]);
        let leave = forwarder.event(PointerKind::Move, (150, 50), false, &zoned());
        assert_eq!(leave.inputs.len(), 1);
        assert_eq!(leave.inputs[0].hit.screen_point, None);
        assert_eq!((leave.inputs[0].hit.x, leave.inputs[0].hit.y), (-1.0, -1.0));
        assert!(forwarder
            .event(PointerKind::Move, (160, 50), false, &zoned())
            .inputs
            .is_empty());
        // Monitor to monitor: the old page loses hover, the new one gets it.
        forwarder.event(PointerKind::Move, (10, 10), true, &targets());
        let cross = forwarder.event(PointerKind::Move, (2000, 0), true, &targets());
        assert_eq!(cross.inputs[0].hit.label, "wallpaper-a");
        assert_eq!(cross.inputs[0].hit.x, -1.0);
        assert_eq!(cross.inputs[1].hit.label, "wallpaper-b");
    }

    #[test]
    fn zones_refreshing_during_a_drag_do_not_cancel_it() {
        let mut forwarder = PointerForwarder::new();
        forwarder.event(PointerKind::Down, (150, 50), true, &zoned());
        let mut moved = zoned();
        moved[0].zones = Some(vec![]);
        let drag = forwarder.event(PointerKind::Move, (160, 60), true, &moved);
        assert_eq!(drag.inputs[0].kind, PointerKind::Move);
        assert_eq!(drag.inputs[0].buttons, 1);
    }

    #[test]
    fn a_swallowed_press_cancelled_over_an_application_still_swallows_its_release_once() {
        let mut forwarder = PointerForwarder::new();
        forwarder.event(PointerKind::Down, (150, 50), true, &zoned());
        let cancel = forwarder.event(PointerKind::Move, (150, 50), false, &zoned());
        assert_eq!(kinds(&cancel), vec![PointerKind::Up]);
        assert!(!cancel.swallow);
        let up = forwarder.event(PointerKind::Up, (150, 50), false, &zoned());
        assert!(up.inputs.is_empty());
        assert!(up.swallow);
        let next = forwarder.event(PointerKind::Up, (150, 50), false, &zoned());
        assert!(!next.swallow);
    }

    #[test]
    fn second_4k_monitor_uses_current_browser_scale_instead_of_primary_creation_scale() {
        let target = target("4k", Rect::new(1920, 0, 3840, 2160), 1.0, None);
        let mut forwarder = PointerForwarder::new();
        for kind in [
            PointerKind::Down,
            PointerKind::Up,
            PointerKind::Wheel {
                delta_x: 0,
                delta_y: 120,
            },
        ] {
            let input = last(forwarder.event(kind, (3420, 900), true, std::slice::from_ref(&target)));
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
            forwarder.event(PointerKind::Down, (2020, 0), true, &targets());
            let up = last(forwarder.event(PointerKind::Up, (2020, 0), true, &targets()));
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
        let down = last(forwarder.event(PointerKind::Down, (2020, 0), true, &targets()));
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
        let cancelled = last(forwarder.event(PointerKind::Move, (1, 1), false, &targets()));
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
        let routed = forwarder.event(kind, (2020, 0), true, &targets());
        assert!(!routed.swallow, "without zones the desktop keeps its events");
        let input = last(routed);
        assert!(!input.focus);
        let params: serde_json::Value = serde_json::from_str(&input.params()).unwrap();
        assert_eq!(params["type"], "mouseWheel");
        assert_eq!(params["button"], "none");
        assert_eq!(params["x"], 50.0);
        assert_eq!(params["y"], 100.0);
        assert_eq!(params["deltaX"], 40);
        assert_eq!(params["deltaY"], -120);
        let away = forwarder.event(kind, (100, 50), false, &targets());
        assert!(away.inputs.iter().all(|i| i.kind != kind));
        assert_eq!(
            forwarder.event(PointerKind::Up, (100, 50), true, &targets()),
            Routed::default()
        );
    }

    #[test]
    fn a_click_on_the_bare_desktop_reaches_the_wallpaper() {
        let hit = route((100, 50), true, &targets()).unwrap();
        assert_eq!((hit.label.as_str(), hit.x, hit.y), ("wallpaper-a", 100.0, 50.0));
    }

    #[test]
    fn a_click_on_an_application_window_is_left_alone() {
        assert_eq!(route((100, 50), false, &targets()), None);
        let mut forwarder = PointerForwarder::new();
        assert_eq!(
            forwarder.event(PointerKind::Down, (150, 50), false, &zoned()),
            Routed::default()
        );
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
        let t = [target("w", Rect::new(10, 10, 100, 100), 0.0, None)];
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
    fn browser_click_is_a_move_press_and_release_not_a_dom_click() {
        let mut forwarder = PointerForwarder::new();
        let down = forwarder.event(PointerKind::Down, (100, 50), true, &targets());
        assert_eq!(params(&down.inputs[0])["type"], "mouseMoved");
        assert_eq!(params(&down.inputs[0])["buttons"], 0);
        let up = last(forwarder.event(PointerKind::Up, (100, 50), true, &targets()));
        let down = last(down);
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
        assert!(forwarder
            .event(PointerKind::Up, (100, 50), true, &targets())
            .inputs
            .is_empty());
    }

    #[test]
    fn drag_keeps_button_held_and_uses_monitor_css_coordinates() {
        let mut forwarder = PointerForwarder::new();
        forwarder.event(PointerKind::Down, (2020, 0), true, &targets());
        let drag = last(forwarder.event(PointerKind::Move, (2320, 200), true, &targets()));
        assert_eq!(
            params(&drag),
            serde_json::json!({
                "type":"mouseMoved", "x":200.0, "y":200.0, "button":"left", "buttons":1, "clickCount":0
            })
        );
        assert!(!drag.focus);
        let up = last(forwarder.event(PointerKind::Up, (2320, 200), true, &targets()));
        assert_eq!(params(&up)["buttons"], 0);
        let hover = last(forwarder.event(PointerKind::Move, (2320, 200), true, &targets()));
        assert_eq!(params(&hover)["button"], "none");
    }

    #[test]
    fn crossing_an_application_or_monitor_boundary_releases_once_without_stealing_focus() {
        for (point, desktop) in [((120, 60), false), ((2000, 0), true), ((-1, -1), true)] {
            let mut forwarder = PointerForwarder::new();
            forwarder.event(PointerKind::Down, (100, 50), true, &targets());
            let routed = forwarder.event(PointerKind::Move, point, desktop, &targets());
            assert_eq!(routed.inputs.len(), 1);
            let release = last(routed);
            assert_eq!(release.kind, PointerKind::Up);
            assert_eq!(release.hit.label, "wallpaper-a");
            assert_eq!((release.hit.x, release.hit.y), (-1.0, -1.0));
            assert!(!release.focus);
            assert_eq!(params(&release)["buttons"], 0);
            assert!(forwarder
                .event(PointerKind::Up, point, desktop, &targets())
                .inputs
                .is_empty());
        }
    }

    #[test]
    fn removed_wallpaper_releases_capture_and_nonfinite_coordinates_never_enter_json() {
        let mut forwarder = PointerForwarder::new();
        forwarder.event(PointerKind::Down, (100, 50), true, &targets());
        assert_eq!(
            last(forwarder.event(PointerKind::Up, (100, 50), true, &[])).kind,
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
