//! Monitor and window placement math, in physical pixels. DPI scaling is applied here, never in the glue.
//!
//! The helper window is its panel plus a transparent margin of `PAD_CSS` on every side (room for the shadow and a
//! small gap to the top edge), so the web page's rounded panel is `PAD_CSS` inset from the window edge.

use crate::view::View;

/// Transparent margin around the panel inside the window, in CSS pixels. The web page uses the same number.
pub const PAD_CSS: f64 = 12.0;
/// The hidden (autohide) panel is a strip this high, in CSS pixels.
pub const HIDDEN_STRIP_CSS: f64 = 3.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub fn new(x: i32, y: i32, w: i32, h: i32) -> Rect {
        Rect { x, y, w, h }
    }
    pub fn right(&self) -> i32 {
        self.x + self.w
    }
    pub fn bottom(&self) -> i32 {
        self.y + self.h
    }
    pub fn center(&self) -> (i32, i32) {
        (self.x + self.w / 2, self.y + self.h / 2)
    }
    pub fn contains(&self, px: i32, py: i32) -> bool {
        px >= self.x && px < self.right() && py >= self.y && py < self.bottom()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MonitorInfo {
    /// Windows device name, for example `\\.\DISPLAY2`. Stable across restarts, unlike the index.
    pub name: String,
    /// The whole monitor.
    pub bounds: Rect,
    /// The monitor without the taskbar.
    pub work: Rect,
    /// DPI scale factor (1.0 = 100%, 1.5 = 150%).
    pub scale: f64,
    pub primary: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Anchor {
    TopCentre,
    TopLeft,
    TopRight,
}

impl Anchor {
    pub fn parse(text: &str) -> Option<Anchor> {
        match text {
            "top-centre" => Some(Anchor::TopCentre),
            "top-left" => Some(Anchor::TopLeft),
            "top-right" => Some(Anchor::TopRight),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Anchor::TopCentre => "top-centre",
            Anchor::TopLeft => "top-left",
            Anchor::TopRight => "top-right",
        }
    }
}

/// Where the user dragged the helper, relative to its anchor and in CSS pixels, so it survives a DPI change.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Offset {
    pub dx: f64,
    pub dy: f64,
}

fn px(css: f64, scale: f64) -> i32 {
    (css * scale).round() as i32
}

fn safe_scale(scale: f64) -> f64 {
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

/// Window size in physical pixels for a view: panel + margin, never larger than the work area.
pub fn window_size(view: View, hidden: bool, scale: f64, work: &Rect) -> (i32, i32) {
    let scale = safe_scale(scale);
    let (cw, ch) = view.css_size();
    let panel_h = if hidden { HIDDEN_STRIP_CSS } else { f64::from(ch) };
    let w = px(f64::from(cw) + 2.0 * PAD_CSS, scale).min(work.w).max(1);
    let h = px(panel_h + 2.0 * PAD_CSS, scale).min(work.h).max(1);
    (w, h)
}

/// A window that covers the whole work area (the expand button).
pub fn fullscreen_rect(work: &Rect) -> Rect {
    *work
}

/// Moves a rectangle so that it lies inside `area` (as far as it fits; a larger one is aligned to the top-left).
pub fn clamp_into(rect: Rect, area: &Rect) -> Rect {
    let w = rect.w.min(area.w);
    let h = rect.h.min(area.h);
    let x = rect.x.min(area.right() - w).max(area.x);
    let y = rect.y.min(area.bottom() - h).max(area.y);
    Rect { x, y, w, h }
}

fn base_x(anchor: Anchor, w: i32, work: &Rect) -> i32 {
    match anchor {
        Anchor::TopCentre => work.x + (work.w - w) / 2,
        Anchor::TopLeft => work.x,
        Anchor::TopRight => work.right() - w,
    }
}

/// Top-left of the window for an anchor and a dragged offset, always inside the work area.
pub fn place(anchor: Anchor, offset: Offset, size: (i32, i32), work: &Rect, scale: f64) -> (i32, i32) {
    let scale = safe_scale(scale);
    let (w, h) = size;
    let x = base_x(anchor, w, work) + px(offset.dx, scale);
    let y = work.y + px(offset.dy, scale);
    let r = clamp_into(Rect::new(x, y, w, h), work);
    (r.x, r.y)
}

/// The inverse of `place`: what offset reproduces a window position (after a drag).
pub fn offset_from_position(anchor: Anchor, pos: (i32, i32), size: (i32, i32), work: &Rect, scale: f64) -> Offset {
    let scale = safe_scale(scale);
    Offset {
        dx: f64::from(pos.0 - base_x(anchor, size.0, work)) / scale,
        dy: f64::from(pos.1 - work.y) / scale,
    }
}

/// Which monitor a point lies on, if any.
pub fn monitor_at(monitors: &[MonitorInfo], point: (i32, i32)) -> Option<usize> {
    monitors.iter().position(|m| m.bounds.contains(point.0, point.1))
}

/// The monitor with the largest overlap with a rectangle (the monitor a dragged window "is on").
pub fn monitor_for_rect(monitors: &[MonitorInfo], rect: &Rect) -> Option<usize> {
    let mut best: Option<(usize, i64)> = None;
    for (i, m) in monitors.iter().enumerate() {
        let w = (rect.right().min(m.bounds.right()) - rect.x.max(m.bounds.x)).max(0) as i64;
        let h = (rect.bottom().min(m.bounds.bottom()) - rect.y.max(m.bounds.y)).max(0) as i64;
        let area = w * h;
        if area > 0 && best.is_none_or(|(_, a)| area > a) {
            best = Some((i, area));
        }
    }
    best.map(|(i, _)| i)
}

/// Chooses the monitor to use: by remembered device name, else by 1-based number (0 = none given), else the
/// primary one, else the first. `monitors` must not be empty.
pub fn resolve_display(monitors: &[MonitorInfo], name: Option<&str>, number: u32) -> usize {
    if let Some(name) = name {
        if let Some(i) = monitors.iter().position(|m| m.name == name) {
            return i;
        }
    }
    if number >= 1 && (number as usize) <= monitors.len() {
        return number as usize - 1;
    }
    monitors.iter().position(|m| m.primary).unwrap_or(0)
}

/// The top-left of the virtual screen: child windows of the desktop are positioned relative to it.
pub fn virtual_origin(monitors: &[MonitorInfo]) -> (i32, i32) {
    let x = monitors.iter().map(|m| m.bounds.x).min().unwrap_or(0);
    let y = monitors.iter().map(|m| m.bounds.y).min().unwrap_or(0);
    (x, y)
}

/// The rectangle of a wallpaper window inside its desktop parent: the monitor, relative to the virtual origin.
pub fn wallpaper_child_rect(bounds: &Rect, origin: (i32, i32)) -> Rect {
    Rect::new(bounds.x - origin.0, bounds.y - origin.1, bounds.w, bounds.h)
}

/// Height of the taskbar in pixels, as the PowerShell agent derives it; 48 when it cannot be seen (a side taskbar
/// or an auto-hidden one), so the wallpaper page still lifts its input field clear of the bottom edge.
pub fn taskbar_px(bounds: &Rect, work: &Rect) -> i32 {
    let t = (bounds.h - work.h).max(0);
    if t == 0 {
        48
    } else {
        t
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn work(x: i32, y: i32, w: i32, h: i32) -> Rect {
        Rect::new(x, y, w, h)
    }

    fn mon(name: &str, x: i32, y: i32, w: i32, h: i32, scale: f64, primary: bool) -> MonitorInfo {
        MonitorInfo {
            name: name.to_string(),
            bounds: Rect::new(x, y, w, h),
            work: Rect::new(x, y, w, h - 48),
            scale,
            primary,
        }
    }

    #[test]
    fn window_size_adds_the_margin_and_scales() {
        let w = work(0, 0, 1920, 1032);
        assert_eq!(window_size(View::Overview, false, 1.0, &w), (664, 384));
        assert_eq!(window_size(View::Overview, false, 1.5, &w), (996, 576));
        assert_eq!(window_size(View::Compact, false, 1.25, &w), (480, 85));
        assert_eq!(
            window_size(View::Chat, false, 2.0, &work(0, 0, 3840, 2100)),
            (1328, 928)
        );
    }

    #[test]
    fn hidden_is_a_thin_strip_and_never_taller_than_the_view() {
        let w = work(0, 0, 1920, 1032);
        assert_eq!(window_size(View::Overview, true, 1.0, &w), (664, 27));
        assert_eq!(window_size(View::Overview, true, 2.0, &w).1, 54);
    }

    #[test]
    fn window_never_exceeds_a_small_work_area() {
        let w = work(0, 0, 800, 200);
        assert_eq!(window_size(View::Chat, false, 1.0, &w), (664, 200));
        assert_eq!(window_size(View::Overview, false, 1.0, &w), (664, 200));
    }

    #[test]
    fn bad_scale_falls_back_to_one() {
        let w = work(0, 0, 1920, 1032);
        assert_eq!(window_size(View::Compact, false, 0.0, &w), (384, 68));
        assert_eq!(window_size(View::Compact, false, f64::NAN, &w), (384, 68));
        assert_eq!(window_size(View::Compact, false, -2.0, &w), (384, 68));
    }

    #[test]
    fn top_centre_is_centred_on_the_work_area() {
        let w = work(0, 0, 1920, 1032);
        assert_eq!(
            place(Anchor::TopCentre, Offset::default(), (984, 304), &w, 1.0),
            (468, 0)
        );
    }

    #[test]
    fn top_centre_on_a_monitor_with_negative_coordinates() {
        let w = work(-2560, -200, 2560, 1392);
        assert_eq!(
            place(Anchor::TopCentre, Offset::default(), (984, 304), &w, 1.0),
            (-2560 + 788, -200)
        );
    }

    #[test]
    fn corners_touch_the_work_area() {
        let w = work(100, 50, 1920, 1032);
        assert_eq!(
            place(Anchor::TopLeft, Offset::default(), (500, 100), &w, 1.0),
            (100, 50)
        );
        assert_eq!(
            place(Anchor::TopRight, Offset::default(), (500, 100), &w, 1.0),
            (1520, 50)
        );
    }

    #[test]
    fn offsets_move_the_window_in_css_pixels() {
        let w = work(0, 0, 1920, 1032);
        let o = Offset { dx: 100.0, dy: 40.0 };
        assert_eq!(place(Anchor::TopCentre, o, (984, 304), &w, 1.0), (568, 40));
        assert_eq!(place(Anchor::TopCentre, o, (1476, 456), &w, 1.5), (222 + 150, 60));
    }

    #[test]
    fn place_clamps_inside_the_work_area() {
        let w = work(0, 0, 1920, 1032);
        let far = Offset { dx: 5000.0, dy: 5000.0 };
        let (x, y) = place(Anchor::TopCentre, far, (984, 304), &w, 1.0);
        assert_eq!((x, y), (1920 - 984, 1032 - 304));
        let neg = Offset {
            dx: -5000.0,
            dy: -5000.0,
        };
        assert_eq!(place(Anchor::TopCentre, neg, (984, 304), &w, 1.0), (0, 0));
    }

    #[test]
    fn a_saved_offset_from_a_bigger_monitor_stays_on_a_smaller_one() {
        let small = work(0, 0, 1366, 720);
        let saved = Offset { dx: 900.0, dy: 700.0 };
        let (x, y) = place(Anchor::TopCentre, saved, (984, 304), &small, 1.0);
        assert!(x >= 0 && x + 984 <= 1366 && y >= 0 && y + 304 <= 720);
    }

    #[test]
    fn offset_is_the_inverse_of_place() {
        let w = work(-1920, 0, 1920, 1032);
        for (anchor, dx) in [
            (Anchor::TopCentre, -37.0),
            (Anchor::TopLeft, 37.0),
            (Anchor::TopRight, -37.0),
        ] {
            let o = Offset { dx, dy: 120.0 };
            let size = (1476, 456);
            let pos = place(anchor, o, size, &w, 1.5);
            let back = offset_from_position(anchor, pos, size, &w, 1.5);
            assert!((back.dx - o.dx).abs() < 1.0, "{anchor:?}: {back:?}");
            assert!((back.dy - o.dy).abs() < 1.0, "{anchor:?}: {back:?}");
        }
    }

    #[test]
    fn clamp_into_keeps_size_when_it_fits_and_shrinks_when_it_does_not() {
        let area = work(0, 0, 1000, 600);
        assert_eq!(
            clamp_into(Rect::new(-50, -10, 300, 200), &area),
            Rect::new(0, 0, 300, 200)
        );
        assert_eq!(
            clamp_into(Rect::new(900, 500, 300, 200), &area),
            Rect::new(700, 400, 300, 200)
        );
        assert_eq!(
            clamp_into(Rect::new(10, 10, 2000, 900), &area),
            Rect::new(0, 0, 1000, 600)
        );
    }

    #[test]
    fn fullscreen_covers_the_work_area() {
        let w = work(0, 0, 1920, 1032);
        assert_eq!(fullscreen_rect(&w), w);
    }

    #[test]
    fn resolve_display_prefers_name_then_number_then_primary() {
        let m = vec![
            mon("\\\\.\\DISPLAY1", 0, 0, 1920, 1080, 1.0, true),
            mon("\\\\.\\DISPLAY2", 1920, 0, 2560, 1440, 1.25, false),
        ];
        assert_eq!(resolve_display(&m, Some("\\\\.\\DISPLAY2"), 1), 1);
        assert_eq!(resolve_display(&m, Some("\\\\.\\GONE"), 2), 1);
        assert_eq!(resolve_display(&m, None, 2), 1);
        assert_eq!(resolve_display(&m, None, 0), 0);
        assert_eq!(resolve_display(&m, None, 9), 0);
        let no_primary = vec![mon("a", 0, 0, 10, 10, 1.0, false)];
        assert_eq!(resolve_display(&no_primary, None, 0), 0);
    }

    #[test]
    fn primary_is_used_even_when_it_is_not_first() {
        let m = vec![
            mon("left", -1920, 0, 1920, 1080, 1.0, false),
            mon("main", 0, 0, 2560, 1440, 1.0, true),
        ];
        assert_eq!(resolve_display(&m, None, 0), 1);
    }

    #[test]
    fn monitor_for_rect_picks_the_biggest_overlap() {
        let m = vec![
            mon("a", 0, 0, 1920, 1080, 1.0, true),
            mon("b", 1920, 0, 1920, 1080, 1.0, false),
        ];
        assert_eq!(monitor_for_rect(&m, &Rect::new(1400, 0, 984, 304)), Some(0));
        assert_eq!(monitor_for_rect(&m, &Rect::new(1700, 0, 984, 304)), Some(1));
        assert_eq!(monitor_for_rect(&m, &Rect::new(5000, 0, 10, 10)), None);
        assert_eq!(monitor_at(&m, (1921, 5)), Some(1));
        assert_eq!(monitor_at(&m, (-1, 5)), None);
    }

    #[test]
    fn wallpaper_rect_is_relative_to_the_virtual_origin() {
        let m = vec![
            mon("left", -1920, -100, 1920, 1080, 1.0, false),
            mon("main", 0, 0, 2560, 1440, 1.0, true),
        ];
        let origin = virtual_origin(&m);
        assert_eq!(origin, (-1920, -100));
        assert_eq!(wallpaper_child_rect(&m[0].bounds, origin), Rect::new(0, 0, 1920, 1080));
        assert_eq!(
            wallpaper_child_rect(&m[1].bounds, origin),
            Rect::new(1920, 100, 2560, 1440)
        );
    }

    #[test]
    fn taskbar_height_matches_the_agent() {
        let b = Rect::new(0, 0, 1920, 1080);
        assert_eq!(taskbar_px(&b, &Rect::new(0, 0, 1920, 1032)), 48);
        assert_eq!(taskbar_px(&b, &Rect::new(0, 0, 1920, 1040)), 40);
        assert_eq!(taskbar_px(&b, &Rect::new(0, 0, 1920, 1080)), 48);
        assert_eq!(taskbar_px(&b, &Rect::new(70, 0, 1850, 1080)), 48);
    }
}
