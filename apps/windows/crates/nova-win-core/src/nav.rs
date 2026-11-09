//! Which addresses the helper and wallpaper windows show. They display the configured NOVA origin; ordinary web links
//! open in the default browser instead. This only decides where a link is shown, it never limits what NOVA may do.

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
    if target.scheme() == "http" || target.scheme() == "https" {
        let target_origin = target.origin().ascii_serialization();
        if target_origin == origin {
            return Navigation::Allow;
        }
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

/// Extra WebView2 (Chromium) arguments. Speech playback may start without a click (NOVA answers "Hey NOVA"), and a
/// plain-http NOVA on the home network is treated as secure so that the microphone works there, as the PowerShell
/// agent does for Edge. Windows are not given any other flag (no remote debugging port, no disabled web security).
pub fn browser_args(origin: &str) -> String {
    let mut args = String::from(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,msSpeechRecognitionServiceUseCetoService --autoplay-policy=no-user-gesture-required",
    );
    if origin.starts_with("http://") {
        args.push_str(" --unsafely-treat-insecure-origin-as-secure=");
        args.push_str(origin);
    }
    args
}

/// The full NOVA app (tray: "Open NOVA").
pub fn app_url(origin: &str) -> String {
    format!("{origin}/")
}

/// Shown instead of a browser error page when the NOVA server cannot be reached. It says so in Dutch and loads
/// `target` again by itself after `seconds`. `target` must be a NOVA page URL (it is JSON-encoded, never spliced).
pub fn offline_page(target: &str, seconds: u64) -> String {
    let script_target = serde_json::to_string(target)
        .unwrap_or_else(|_| "\"about:blank\"".into())
        .replace("</", "<\\/");
    let seconds = seconds.clamp(1, 3600);
    format!(
        r#"<!doctype html><html lang="nl"><head><meta charset="utf-8"><title>NOVA</title><style>
html,body{{margin:0;height:100%;background:transparent;font:13px/1.4 "Segoe UI",system-ui,sans-serif;color:#edf5ff;
user-select:none;overflow:hidden;cursor:default}}
body{{display:flex;align-items:flex-start;justify-content:center}}
div{{margin:12px;padding:10px 16px;border:1px solid #29415b;border-radius:14px;background:#091321;max-width:420px;text-align:center}}
b{{display:block;font-weight:600}}span{{color:#a6bbd2}}button{{margin-top:6px;font:inherit;color:#091321;background:#8dd8ff;border:0;border-radius:6px;padding:4px 12px;cursor:pointer}}
</style></head><body><div role="status"><b>NOVA is niet bereikbaar</b><span id="t">Opnieuw proberen over {seconds} s</span><br>
<button id="r" type="button">Nu opnieuw proberen</button></div><script>
(function(){{var target={script_target},left={seconds};function go(){{location.replace(target)}}
document.getElementById("r").onclick=go;document.addEventListener("contextmenu",function(e){{e.preventDefault()}});
setInterval(function(){{left-=1;if(left<=0)go();else document.getElementById("t").textContent="Opnieuw proberen over "+left+" s"}},1000)}})();
</script></body></html>"#
    )
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
    fn browser_args_only_relax_security_for_plain_http() {
        let https = browser_args("https://nova.example.nl");
        assert!(https.contains("--autoplay-policy=no-user-gesture-required"));
        // WebView2's Ceto speech backend can return HTTP 403 as a misleading
        // SpeechRecognition "network" error (MicrosoftEdge/WebView2Feedback#5724).
        assert!(https.contains("msSpeechRecognitionServiceUseCetoService"));
        assert!(!https.contains("unsafely"));
        let http = browser_args("http://192.168.1.10:8080");
        assert!(http.ends_with("--unsafely-treat-insecure-origin-as-secure=http://192.168.1.10:8080"));
        assert!(!http.contains("remote-debugging"));
    }

    #[test]
    fn offline_page_retries_the_page_without_injection() {
        let page = offline_page("https://nova.example.nl/helper?desk=1&view=chat", 20);
        assert!(page.contains("NOVA is niet bereikbaar"));
        assert!(page.contains(r#"var target="https://nova.example.nl/helper?desk=1&view=chat""#));
        assert!(page.contains("left=20"));
        let hostile = offline_page("https://x/</script><script>alert(1)</script>\"", 0);
        assert!(!hostile.contains("</script><script>alert"));
        assert!(hostile.contains("left=1"));
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
