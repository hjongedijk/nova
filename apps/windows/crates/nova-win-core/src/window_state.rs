//! Where the NOVA app window was, so it opens there again (`%LOCALAPPDATA%\NOVA\window.json`). A saved place that
//! is no longer on any screen (monitor unplugged, resolution changed) is ignored or pulled back into view.
use crate::geometry::{MonitorInfo, Rect};
use serde::{Deserialize, Serialize};

/// Smallest app window in physical pixels at 100 %; scaled with the monitor.
pub const MIN_WIDTH: f64 = 760.0;
pub const MIN_HEIGHT: f64 = 540.0;
/// First start: a comfortable size, centred.
pub const DEFAULT_WIDTH: f64 = 980.0;
pub const DEFAULT_HEIGHT: f64 = 700.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    #[serde(default)]
    pub maximized: bool,
}

impl WindowState {
    pub fn parse(text: &str) -> Option<WindowState> {
        let state: WindowState = serde_json::from_str(text).ok()?;
        (state.width > 0 && state.height > 0 && state.width <= 32768 && state.height <= 32768).then_some(state)
    }
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

/// The rectangle to open at, or `None` to centre a default-size window. The window keeps its saved monitor when at
/// least a grab-able part of its top edge is on a work area; it is then shrunk to fit and moved fully inside it.
pub fn restore(state: &WindowState, monitors: &[MonitorInfo]) -> Option<Rect> {
    // The title bar must stay reachable: test a strip along the top of the window.
    let probe_y = state.y + 8;
    let visible = monitors.iter().find(|m| {
        let w = &m.work;
        let left = state.x.max(w.x);
        let right = (state.x + state.width).min(w.right());
        right - left >= 120 && probe_y >= w.y && probe_y < w.bottom()
    })?;
    let work = visible.work;
    let min_w = (MIN_WIDTH * visible.scale).round() as i32;
    let min_h = (MIN_HEIGHT * visible.scale).round() as i32;
    let width = state.width.max(min_w).min(work.w);
    let height = state.height.max(min_h).min(work.h);
    let x = state.x.clamp(work.x, work.right() - width);
    let y = state.y.clamp(work.y, work.bottom() - height);
    Some(Rect::new(x, y, width, height))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn monitor(x: i32, y: i32, w: i32, h: i32, scale: f64) -> MonitorInfo {
        MonitorInfo {
            name: format!("m{x}"),
            bounds: Rect::new(x, y, w, h),
            work: Rect::new(x, y, w, h - 40),
            scale,
            primary: x == 0,
        }
    }
    #[test]
    fn parse_round_trips_and_rejects_nonsense() {
        let state = WindowState {
            x: -1200,
            y: 40,
            width: 1000,
            height: 700,
            maximized: true,
        };
        assert_eq!(WindowState::parse(&state.to_json()), Some(state));
        assert_eq!(
            WindowState::parse(r#"{"x":1,"y":2,"width":800,"height":600}"#).map(|s| s.maximized),
            Some(false)
        );
        for bad in [
            "",
            "{",
            "[]",
            r#"{"x":0,"y":0,"width":0,"height":600}"#,
            r#"{"x":0,"y":0,"width":-5,"height":5}"#,
        ] {
            assert_eq!(WindowState::parse(bad), None, "{bad}");
        }
    }
    #[test]
    fn a_window_on_a_connected_screen_opens_where_it_was() {
        let screens = [monitor(0, 0, 1920, 1080, 1.0), monitor(-2560, 0, 2560, 1440, 1.0)];
        let state = WindowState {
            x: -2000,
            y: 100,
            width: 1000,
            height: 700,
            maximized: false,
        };
        assert_eq!(restore(&state, &screens), Some(Rect::new(-2000, 100, 1000, 700)));
    }
    #[test]
    fn a_window_on_an_unplugged_screen_is_centred_again() {
        let screens = [monitor(0, 0, 1920, 1080, 1.0)];
        let state = WindowState {
            x: 2500,
            y: 100,
            width: 1000,
            height: 700,
            maximized: false,
        };
        assert_eq!(restore(&state, &screens), None);
        // Title bar above the screen: not grab-able.
        let above = WindowState {
            x: 100,
            y: -300,
            ..state
        };
        assert_eq!(restore(&above, &screens), None);
    }
    #[test]
    fn partly_visible_windows_are_pulled_in_and_sized_to_fit() {
        let screens = [monitor(0, 0, 1280, 720, 1.5)];
        let state = WindowState {
            x: 1000,
            y: 10,
            width: 4000,
            height: 300,
            maximized: false,
        };
        let rect = restore(&state, &screens).unwrap();
        assert_eq!(rect.w, 1280);
        assert_eq!(rect.h, 680.min((MIN_HEIGHT * 1.5) as i32));
        assert!(rect.x >= 0 && rect.right() <= 1280);
        assert!(rect.y >= 0 && rect.bottom() <= 680);
    }
}
