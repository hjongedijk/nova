//! Where a wallpaper window has to go so that it sits behind the desktop icons. This is the DECISION only,
//! ported from `NovaDesk.Find` and `NovaDesk.Behind` in agents/windows/nova-agent.ps1; the glue gathers the
//! snapshot with Win32 calls (FindWindow, FindWindowEx, EnumWindows) and carries the decision out.
//!
//! Handles are plain `u64` here (0 never occurs for a real window).

/// A top-level `WorkerW` window that holds the icon layer (`SHELLDLL_DefView`), as the glue saw it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IconWorker {
    /// The next top-level `WorkerW` after it in the z-order (what `FindWindowEx(NULL, this, "WorkerW")` returns),
    /// or `None` when there is none.
    pub next_worker: Option<u64>,
}

/// What the desktop looks like, after the `0x052C` message was sent to Progman.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DesktopSnapshot {
    pub progman: Option<u64>,
    /// Progman has a `WorkerW` child (the real wallpaper, on Windows 11 24H2 and later).
    pub progman_has_worker_child: bool,
    /// The icon layer (`SHELLDLL_DefView`) as a child of Progman.
    pub progman_icons: Option<u64>,
    /// Top-level `WorkerW` windows that contain the icon layer, in enumeration order.
    pub icon_workers: Vec<IconWorker>,
}

/// Which layout was recognised.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layout {
    /// Older layout: the window becomes a child of a top-level WorkerW, at the bottom.
    TopLevelWorker,
    /// Windows 11 24H2 and later: a child of Progman, right behind the icon layer.
    ProgmanChild,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InsertAfter {
    /// Right behind this window (the icon layer).
    Window(u64),
    /// `HWND_BOTTOM`.
    Bottom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    NoProgman,
    NoKnownLayout,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Place {
        layout: Layout,
        parent: u64,
        after: InsertAfter,
    },
    /// Not recognised. The caller must not guess: a wrong parent shows the window on top of everything.
    Unrecognised(Reason),
}

pub fn decide(snapshot: &DesktopSnapshot) -> Decision {
    let Some(progman) = snapshot.progman else {
        return Decision::Unrecognised(Reason::NoProgman);
    };
    // Windows 11 24H2: Progman holds the icons and a WorkerW child with the real wallpaper.
    if snapshot.progman_has_worker_child {
        if let Some(icons) = snapshot.progman_icons {
            return Decision::Place {
                layout: Layout::ProgmanChild,
                parent: progman,
                after: InsertAfter::Window(icons),
            };
        }
    }
    // Older layout. The agent's EnumWindows callback overwrites `worker` for every WorkerW that holds the icons,
    // also with "none", so the LAST such window decides. That is ported as is.
    let worker = snapshot
        .icon_workers
        .iter()
        .fold(None, |_, candidate| candidate.next_worker);
    match worker {
        Some(parent) => Decision::Place {
            layout: Layout::TopLevelWorker,
            parent,
            after: InsertAfter::Bottom,
        },
        None => Decision::Unrecognised(Reason::NoKnownLayout),
    }
}

/// `NovaDesk.Behind`: given the children of the parent from front to back, does the wallpaper window `me` sit in
/// front of the icon layer and need to go back behind it? With no icon layer in the parent (older layout) there is
/// nothing to keep in order.
pub fn needs_reorder(children_front_to_back: &[u64], icons: Option<u64>, me: u64) -> bool {
    let Some(icons) = icons else {
        return false;
    };
    for &child in children_front_to_back {
        if child == icons {
            return false;
        }
        if child == me {
            return true;
        }
    }
    false
}

/// Win32 window styles for the wallpaper child: `WS_CHILD | WS_VISIBLE`, no title bar or border.
pub const CHILD_STYLE: u32 = 0x5000_0000;
/// `SetWindowPos` flags: no activate (0x10), show (0x40), frame changed (0x20).
pub const SHOW_FLAGS: u32 = 0x0070;
/// `SetWindowPos` flags to put a window behind the icons without move, resize or activate.
pub const REORDER_FLAGS: u32 = 0x0013;
/// The message that makes Progman create the WorkerW, and its parameters.
pub const SPAWN_WORKER_MESSAGE: u32 = 0x052C;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_11_24h2_places_behind_the_icons_inside_progman() {
        let s = DesktopSnapshot {
            progman: Some(100),
            progman_has_worker_child: true,
            progman_icons: Some(101),
            icon_workers: vec![],
        };
        assert_eq!(
            decide(&s),
            Decision::Place {
                layout: Layout::ProgmanChild,
                parent: 100,
                after: InsertAfter::Window(101)
            }
        );
    }

    #[test]
    fn older_layout_uses_the_worker_behind_the_icon_window_at_the_bottom() {
        let s = DesktopSnapshot {
            progman: Some(100),
            progman_has_worker_child: false,
            progman_icons: None,
            icon_workers: vec![IconWorker { next_worker: Some(300) }],
        };
        assert_eq!(
            decide(&s),
            Decision::Place {
                layout: Layout::TopLevelWorker,
                parent: 300,
                after: InsertAfter::Bottom
            }
        );
    }

    #[test]
    fn a_worker_child_without_icons_in_progman_falls_through_to_the_old_layout() {
        let s = DesktopSnapshot {
            progman: Some(100),
            progman_has_worker_child: true,
            progman_icons: None,
            icon_workers: vec![IconWorker { next_worker: Some(7) }],
        };
        assert!(matches!(
            decide(&s),
            Decision::Place {
                layout: Layout::TopLevelWorker,
                parent: 7,
                ..
            }
        ));
    }

    #[test]
    fn icons_in_progman_without_a_worker_child_is_not_the_new_layout() {
        let s = DesktopSnapshot {
            progman: Some(100),
            progman_has_worker_child: false,
            progman_icons: Some(101),
            icon_workers: vec![],
        };
        assert_eq!(decide(&s), Decision::Unrecognised(Reason::NoKnownLayout));
    }

    #[test]
    fn no_progman_means_unrecognised() {
        assert_eq!(
            decide(&DesktopSnapshot::default()),
            Decision::Unrecognised(Reason::NoProgman)
        );
    }

    #[test]
    fn unknown_layout_is_never_guessed() {
        let s = DesktopSnapshot {
            progman: Some(1),
            ..Default::default()
        };
        assert_eq!(decide(&s), Decision::Unrecognised(Reason::NoKnownLayout));
    }

    #[test]
    fn the_last_icon_worker_decides_even_when_it_has_no_next_worker() {
        // Ported quirk: the PowerShell callback assigns for every match, so a later "none" wins.
        let s = DesktopSnapshot {
            progman: Some(1),
            icon_workers: vec![IconWorker { next_worker: Some(5) }, IconWorker { next_worker: None }],
            ..Default::default()
        };
        assert_eq!(decide(&s), Decision::Unrecognised(Reason::NoKnownLayout));
        let s = DesktopSnapshot {
            progman: Some(1),
            icon_workers: vec![IconWorker { next_worker: None }, IconWorker { next_worker: Some(9) }],
            ..Default::default()
        };
        assert!(matches!(decide(&s), Decision::Place { parent: 9, .. }));
    }

    #[test]
    fn reorder_is_needed_only_when_we_are_in_front_of_the_icons() {
        assert!(needs_reorder(&[7, 1, 2], Some(2), 1));
        assert!(!needs_reorder(&[7, 2, 1], Some(2), 1));
        assert!(!needs_reorder(&[2, 1], Some(2), 1));
    }

    #[test]
    fn reorder_does_nothing_without_an_icon_layer_or_when_we_are_not_a_child() {
        assert!(!needs_reorder(&[1, 2], None, 1));
        assert!(!needs_reorder(&[5, 6], Some(2), 1));
        assert!(!needs_reorder(&[], Some(2), 1));
    }

    #[test]
    fn win32_constants_match_the_agent() {
        assert_eq!(CHILD_STYLE, 0x50000000);
        assert_eq!(SHOW_FLAGS, 0x0070);
        assert_eq!(REORDER_FLAGS, 0x0013);
        assert_eq!(SPAWN_WORKER_MESSAGE, 0x052C);
    }
}
