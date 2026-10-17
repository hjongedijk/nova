//! Which addresses NOVA Desk may load. The windows only ever show the configured NOVA origin; everything else is
//! refused, and ordinary web links open in the default browser instead.

use crate::mode::WallpaperStyle;
use crate::view::View;
use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NavError {
    Empty,
    Invalid,
    Scheme,
    Credentials,
    Extra,
}

impl std::fmt::Display for NavError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            NavError::Empty => "Vul het adres van NOVA in.",
            NavError::Invalid => {
                "Dit is geen geldig adres. Gebruik bijvoorbeeld https://nova.example.nl of http://192.168.1.10:8080."
            }
            NavError::Scheme => "Het adres moet met http:// of https:// beginnen.",
            NavError::Credentials => "Zet geen gebruikersnaam of wachtwoord in het adres.",
            NavError::Extra => "Gebruik alleen het adres zelf, zonder pad, zoekopdracht of #-deel.",
        })
    }
}

/// `http(s)://host[:port]`, nothing else. Returns the normalised origin without a trailing slash.
pub fn normalize_origin(input: &str) -> Result<String, NavError> {
    let text = input.trim();
    if text.is_empty() {
        return Err(NavError::Empty);
    }
    let url = Url::parse(text).map_err(|_| NavError::Invalid)?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(NavError::Scheme);
    }
    if url.host_str().is_none() {
        return Err(NavError::Invalid);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(NavError::Credentials);
    }
    if (url.path() != "/" && !url.path().is_empty()) || url.query().is_some() || url.fragment().is_some() {
        return Err(NavError::Extra);
    }
    Ok(url.origin().ascii_serialization())
}

/// What to do with a navigation request of a NOVA window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Navigation {
    /// Same origin as NOVA: load it.
    Allow,
    /// Another web site: refuse it in the window and open it in the default browser.
    External,
    /// Anything else (file:, data:, javascript:, ...): refuse.
    Block,
}

pub fn classify(target: &Url, origin: &str) -> Navigation {
    if (target.scheme() == "http" || target.scheme() == "https") && target.origin().ascii_serialization() == origin {
        return Navigation::Allow;
    }
    // The browser itself loads about:blank for a new frame; nothing else without a network address is fine.
    if target.as_str() == "about:blank" {
        return Navigation::Allow;
    }
    if (target.scheme() == "http" || target.scheme() == "https") && target.host_str().is_some() {
        return Navigation::External;
    }
    Navigation::Block
}

/// The helper page for a view.
pub fn helper_url(origin: &str, view: View) -> String {
    format!("{origin}/helper?desk=1&view={}", view.as_str())
}

/// The wallpaper page, with the same parameters the PowerShell agent gives Edge: `talk=1` keeps the input field and
/// microphone (not when quiet), `taskbarpx` lifts the field above the taskbar, `panels=0` for the sphere only.
pub fn wallpaper_url(origin: &str, style: WallpaperStyle, quiet: bool, taskbar_px: i32) -> String {
    let talk = if quiet { "" } else { "&talk=1" };
    let panels = if style == WallpaperStyle::Sphere {
        "&panels=0"
    } else {
        ""
    };
    format!("{origin}/?wallpaper=1{talk}&taskbarpx={taskbar_px}{panels}")
}

/// The full NOVA app (tray: "Open NOVA").
pub fn app_url(origin: &str) -> String {
    format!("{origin}/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_are_normalised() {
        assert_eq!(
            normalize_origin("http://192.168.1.10:8080").unwrap(),
            "http://192.168.1.10:8080"
        );
        assert_eq!(
            normalize_origin("  https://nova.example.nl/  ").unwrap(),
            "https://nova.example.nl"
        );
        assert_eq!(
            normalize_origin("HTTPS://Nova.Example.nl:443").unwrap(),
            "https://nova.example.nl"
        );
        assert_eq!(normalize_origin("http://[::1]:5173").unwrap(), "http://[::1]:5173");
    }

    #[test]
    fn bad_origins_are_refused() {
        assert_eq!(normalize_origin(""), Err(NavError::Empty));
        assert_eq!(normalize_origin("   "), Err(NavError::Empty));
        assert_eq!(normalize_origin("nova.local"), Err(NavError::Invalid));
        assert_eq!(normalize_origin("ftp://nova.local"), Err(NavError::Scheme));
        assert_eq!(normalize_origin("file:///c:/x"), Err(NavError::Scheme));
        assert_eq!(normalize_origin("javascript:alert(1)"), Err(NavError::Scheme));
        assert_eq!(
            normalize_origin("https://user:pw@nova.local"),
            Err(NavError::Credentials)
        );
        assert_eq!(normalize_origin("https://nova.local/app"), Err(NavError::Extra));
        assert_eq!(normalize_origin("https://nova.local/?x=1"), Err(NavError::Extra));
        assert_eq!(normalize_origin("https://nova.local/#top"), Err(NavError::Extra));
    }

    fn nav(target: &str) -> Navigation {
        classify(&Url::parse(target).unwrap(), "https://nova.example.nl")
    }

    #[test]
    fn same_origin_is_allowed() {
        assert_eq!(nav("https://nova.example.nl/helper?desk=1"), Navigation::Allow);
        assert_eq!(nav("https://nova.example.nl:443/x"), Navigation::Allow);
        assert_eq!(nav("about:blank"), Navigation::Allow);
    }

    #[test]
    fn lookalike_origins_are_external() {
        assert_eq!(nav("https://nova.example.nl.evil.com/"), Navigation::External);
        assert_eq!(nav("http://nova.example.nl/"), Navigation::External);
        assert_eq!(nav("https://nova.example.nl:8443/"), Navigation::External);
        assert_eq!(nav("https://evil.com/?https://nova.example.nl"), Navigation::External);
        assert_eq!(nav("https://nova.example.nl@evil.com/"), Navigation::External);
    }

    #[test]
    fn non_web_schemes_are_blocked() {
        for t in [
            "file:///c:/windows/system32",
            "data:text/html,<b>x</b>",
            "javascript:alert(1)",
            "ms-settings:network",
            "blob:https://nova.example.nl/1",
            "tauri://localhost/",
            "ftp://x/y",
        ] {
            assert_eq!(nav(t), Navigation::Block, "{t}");
        }
    }

    #[test]
    fn urls_match_the_agent() {
        assert_eq!(
            wallpaper_url("http://nova:8080", WallpaperStyle::Full, false, 48),
            "http://nova:8080/?wallpaper=1&talk=1&taskbarpx=48"
        );
        assert_eq!(
            wallpaper_url("http://nova:8080", WallpaperStyle::Sphere, true, 40),
            "http://nova:8080/?wallpaper=1&taskbarpx=40&panels=0"
        );
        assert_eq!(
            helper_url("http://nova:8080", View::Chat),
            "http://nova:8080/helper?desk=1&view=chat"
        );
        assert_eq!(app_url("http://nova:8080"), "http://nova:8080/");
    }
}
