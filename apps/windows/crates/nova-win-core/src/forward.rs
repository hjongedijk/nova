//! Mouse forwarding for the wallpaper windows.
//!
//! Root cause of "clicking does nothing in wallpaper mode": the wallpaper window is a child of Progman/WorkerW placed
//! BEHIND the icon layer (`SHELLDLL_DefView`), which covers the whole desktop. Windows hit-tests the icon layer first,
//! so the page never receives a mouse message. The glue therefore watches the mouse globally and, when the cursor is
//! over the bare desktop (not over an application window), hands the event to the wallpaper page as synthetic DOM
//! events. This module is the pure part: which wallpaper (if any) gets the event, where in it, and the script.

use crate::geometry::Rect;

/// What the mouse did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerKind {
    Move,
    Down,
    Up,
}

/// A wallpaper window as the forwarder knows it: its label, its monitor in physical screen pixels, and the scale.
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub label: String,
    pub bounds: Rect,
    pub scale: f64,
}

/// Where in a page the event lands, in CSS pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub label: String,
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
        x: f64::from(point.0 - target.bounds.x) / scale,
        y: f64::from(point.1 - target.bounds.y) / scale,
    })
}

/// The script that replays one pointer event inside the wallpaper page. Only numbers and a fixed kind are spliced
/// in. A click is synthesised on button-up when the press and release land on the same element.
pub fn pointer_script(kind: PointerKind, x: f64, y: f64) -> String {
    let (x, y) = (finite(x), finite(y));
    let kind = match kind {
        PointerKind::Move => "move",
        PointerKind::Down => "down",
        PointerKind::Up => "up",
    };
    format!(
        "(() => {{ const k = '{kind}', x = {x:.1}, y = {y:.1}; const s = (window.__novaPointer ||= {{}});
const el = document.elementFromPoint(x, y); if (!el) return;
const o = (type, extra) => new MouseEvent(type, Object.assign({{ bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y }}, extra));
const p = (type, extra) => {{ try {{ return new PointerEvent(type, Object.assign({{ bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true }}, extra)); }} catch (e) {{ return o(type, extra); }} }};
if (k === 'move') {{ if (s.over !== el) {{ if (s.over) {{ s.over.dispatchEvent(o('mouseout')); s.over.dispatchEvent(p('pointerout')); }} el.dispatchEvent(p('pointerover')); el.dispatchEvent(o('mouseover')); s.over = el; }} el.dispatchEvent(p('pointermove')); el.dispatchEvent(o('mousemove')); return; }}
if (k === 'down') {{ s.down = el; el.dispatchEvent(p('pointerdown', {{ button: 0, buttons: 1 }})); el.dispatchEvent(o('mousedown', {{ button: 0, buttons: 1 }})); if (el.focus) try {{ el.focus({{ preventScroll: true }}); }} catch (e) {{}} return; }}
el.dispatchEvent(p('pointerup', {{ button: 0 }})); el.dispatchEvent(o('mouseup', {{ button: 0 }}));
const d = s.down; s.down = null; if (d && (d === el || d.contains(el) || el.contains(d))) {{ (d === el ? el : d).dispatchEvent(o('click', {{ button: 0 }})); }} }})()"
    )
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
                bounds: Rect::new(0, 0, 1920, 1080),
                scale: 1.0,
            },
            Target {
                label: "wallpaper-b".into(),
                bounds: Rect::new(1920, -200, 2560, 1440),
                scale: 2.0,
            },
        ]
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

    #[test]
    fn the_script_only_contains_numbers_and_a_fixed_kind() {
        let s = pointer_script(PointerKind::Down, f64::NAN, 12.34);
        assert!(s.contains("k = 'down', x = 0.0, y = 12.3"), "{s}");
        assert!(pointer_script(PointerKind::Up, 1.0, 2.0).contains("k = 'up'"));
        assert!(pointer_script(PointerKind::Move, 1.0, 2.0).contains("'click'"));
    }
}
