//! The helper's views and their size in CSS pixels (the same table as docs/windows-agent.md and the agent).

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum View {
    Compact,
    Overview,
    Notifications,
    Weather,
    Lists,
    Chat,
    Confirmation,
}

impl View {
    pub const ALL: [View; 7] = [
        View::Compact,
        View::Overview,
        View::Notifications,
        View::Weather,
        View::Lists,
        View::Chat,
        View::Confirmation,
    ];

    pub fn parse(text: &str) -> Option<View> {
        View::ALL.into_iter().find(|v| v.as_str() == text)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            View::Compact => "compact",
            View::Overview => "overview",
            View::Notifications => "notifications",
            View::Weather => "weather",
            View::Lists => "lists",
            View::Chat => "chat",
            View::Confirmation => "confirmation",
        }
    }

    /// Panel size in CSS pixels (width, height).
    pub fn css_size(self) -> (u32, u32) {
        match self {
            View::Compact => (360, 44),
            View::Chat => (640, 440),
            View::Confirmation => (640, 220),
            View::Overview | View::Notifications | View::Weather | View::Lists => (640, 360),
        }
    }

    /// Transient views never replace the view the user last chose (same rule as the agent).
    pub fn is_persistent(self) -> bool {
        !matches!(self, View::Compact | View::Confirmation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_match_the_documented_table() {
        assert_eq!(View::Overview.css_size(), (640, 360));
        assert_eq!(View::Chat.css_size(), (640, 440));
        assert_eq!(View::Confirmation.css_size(), (640, 220));
        assert_eq!(View::Compact.css_size(), (360, 44));
        assert_eq!(View::Weather.css_size(), (640, 360));
    }

    #[test]
    fn parse_round_trips_and_rejects_unknown() {
        for v in View::ALL {
            assert_eq!(View::parse(v.as_str()), Some(v));
        }
        assert_eq!(View::parse("fullscreen"), None);
        assert_eq!(View::parse(""), None);
    }

    #[test]
    fn only_meaningful_views_persist() {
        assert!(View::Chat.is_persistent());
        assert!(!View::Compact.is_persistent());
        assert!(!View::Confirmation.is_persistent());
    }
}
