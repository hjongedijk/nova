//! Authentication, the unified config and non-destructive legacy import.
use crate::config::{self, DeskConfig};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::net::IpAddr;
use std::path::Path;
use subtle::ConstantTimeEq;

pub const VERSION: &str = "2026-10-18.3";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppEntry {
    pub path: String,
    pub process: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentConfig {
    pub token: String,
    pub port: u16,
    pub allowed_ips: Vec<IpAddr>,
    pub apps: BTreeMap<String, AppEntry>,
    #[serde(default)]
    pub legacy_preferences: BTreeMap<String, Value>,
    #[serde(default = "default_hotkeys")]
    pub hotkeys: BTreeMap<String, String>,
    #[serde(default)]
    pub automation: AutomationPermissions,
    #[serde(default)]
    pub run_elevated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutomationPermissions {
    pub view: bool,
    pub control: bool,
    pub browser: bool,
}

impl Default for AutomationPermissions {
    fn default() -> Self {
        Self {
            view: false,
            control: false,
            browser: true,
        }
    }
}

pub fn default_hotkeys() -> BTreeMap<String, String> {
    [
        ("open", "Ctrl+Alt+N"),
        ("speak", "Ctrl+Alt+Space"),
        ("mute", "Ctrl+Alt+M"),
        ("desktop", "Ctrl+Alt+D"),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .collect()
}

impl AgentConfig {
    pub fn fresh() -> Result<Self, String> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
        let token = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let apps = [
            ("notepad", "notepad.exe", Some("notepad")),
            ("calculator", "calc.exe", Some("CalculatorApp")),
            ("paint", "mspaint.exe", Some("mspaint")),
            ("explorer", "explorer.exe", None),
            ("settings", "ms-settings:", None),
            ("snipping-tool", "snippingtool.exe", Some("SnippingTool")),
            ("terminal", "wt.exe", Some("WindowsTerminal")),
            ("task-manager", "taskmgr.exe", Some("Taskmgr")),
            ("edge", "msedge.exe", Some("msedge")),
            ("chrome", "chrome.exe", Some("chrome")),
            ("vscode", "code", Some("Code")),
        ]
        .into_iter()
        .map(|(name, path, process)| {
            (
                name.into(),
                AppEntry {
                    path: path.into(),
                    process: process.map(str::to_owned),
                },
            )
        })
        .collect();
        Ok(Self {
            token,
            port: 8765,
            allowed_ips: Vec::new(),
            apps,
            legacy_preferences: BTreeMap::new(),
            hotkeys: default_hotkeys(),
            automation: AutomationPermissions::default(),
            run_elevated: false,
        })
    }

    pub fn validate(&self) -> Result<(), String> {
        if !(24..=256).contains(&self.token.len()) || !self.token.bytes().all(|b| b.is_ascii_graphic()) {
            return Err("Agenttoken moet 24 tot 256 zichtbare ASCII-tekens bevatten".into());
        }
        if self.port == 0 {
            return Err("Agentpoort mag niet nul zijn".into());
        }
        if self
            .apps
            .values()
            .any(|a| a.path.is_empty() || a.path.contains(['\0', '\r', '\n']))
        {
            return Err("Ongeldig programmapad in apps".into());
        }
        Ok(())
    }

    pub fn authorize(&self, source: IpAddr, header: Option<&str>) -> Result<(), u16> {
        let source = match source {
            IpAddr::V6(v) => v.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(source),
            v => v,
        };
        if !self.allowed_ips.is_empty() && !self.allowed_ips.contains(&source) {
            return Err(403);
        }
        let candidate = header.and_then(|h| h.strip_prefix("Bearer ")).unwrap_or("");
        if !bool::from(self.token.as_bytes().ct_eq(candidate.as_bytes())) {
            return Err(401);
        }
        Ok(())
    }

    /// Contains a bearer credential. Only expose this to the local setup window.
    pub fn pair_code(&self, address: &str) -> Result<String, String> {
        let url = url::Url::parse(address).map_err(|e| e.to_string())?;
        if url.scheme() != "http" || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some()
        {
            return Err("Kies het lokale HTTP-adres van deze pc".into());
        }
        Ok(format!(
            "nova1.{}",
            URL_SAFE_NO_PAD.encode(json!({"url": address, "token": self.token}).to_string())
        ))
    }
}

pub fn encode(desk: &DeskConfig, agent: &AgentConfig) -> String {
    let mut value: Value = serde_json::from_str(&desk.to_json()).expect("desk config");
    value["agent"] = serde_json::to_value(agent).expect("agent config");
    value["schemaVersion"] = json!(1);
    serde_json::to_string_pretty(&value).expect("config") + "\n"
}

pub fn decode(text: &str) -> Result<(DeskConfig, AgentConfig), String> {
    let root: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| e.to_string())?;
    if root["schemaVersion"] != 1 {
        return Err("Onbekende configversie; bestand blijft bewaard".into());
    }
    let agent: AgentConfig = serde_json::from_value(root["agent"].clone()).map_err(|e| e.to_string())?;
    agent.validate()?;
    let (desk, warnings) = config::parse(text.trim_start_matches('\u{feff}'))?;
    if !warnings.is_empty() {
        return Err(warnings.join("; "));
    }
    Ok((desk, agent))
}

/// Does not touch the source files. Existing unified config always takes precedence.
pub fn load_or_import(
    path: &Path,
    legacy_dir: &Path,
    monitor_names: &[String],
) -> Result<(DeskConfig, AgentConfig), String> {
    if path.exists() {
        return decode(&std::fs::read_to_string(path).map_err(|e| e.to_string())?);
    }
    let (desk, agent) = import_legacy(path, legacy_dir, monitor_names)?;
    atomic_save(path, &encode(&desk, &agent))?;
    Ok((desk, agent))
}

pub fn import_legacy(
    path: &Path,
    legacy_dir: &Path,
    monitor_names: &[String],
) -> Result<(DeskConfig, AgentConfig), String> {
    let desk_path = path.with_file_name("desk.json");
    let mut desk = if desk_path.exists() {
        let text = std::fs::read_to_string(&desk_path).map_err(|e| e.to_string())?;
        let (desk, warnings) = config::parse(text.trim_start_matches('\u{feff}'))?;
        if !warnings.is_empty() {
            return Err(warnings.join("; "));
        }
        desk
    } else {
        DeskConfig {
            mode: crate::mode::Mode::Helper,
            ..DeskConfig::default()
        }
    };
    let mut agent = AgentConfig::fresh()?;
    let old_path = legacy_dir.join("agent.json");
    if old_path.exists() {
        let old: Value = serde_json::from_str(
            std::fs::read_to_string(old_path)
                .map_err(|e| e.to_string())?
                .trim_start_matches('\u{feff}'),
        )
        .map_err(|e| e.to_string())?;
        if !old.is_object() {
            return Err("agent.json moet een object zijn".into());
        }
        if let Some(token) = old.get("token") {
            agent.token = serde_json::from_value(token.clone()).map_err(|e| e.to_string())?;
        }
        if let Some(port) = old.get("port") {
            agent.port = serde_json::from_value(port.clone()).map_err(|e| e.to_string())?;
        }
        if let Some(ips) = old.get("allowedIps") {
            agent.allowed_ips = serde_json::from_value(ips.clone()).map_err(|e| e.to_string())?;
        }
        if let Some(apps) = old.get("apps") {
            agent.apps = serde_json::from_value(apps.clone()).map_err(|e| e.to_string())?;
        }
        for key in ["desktop", "browser", "helperHotkeys"] {
            if let Some(value) = old.get(key) {
                agent.legacy_preferences.insert(key.into(), value.clone());
            }
        }
        let mut args = crate::args::Args::default();
        if desk.url.is_none() {
            if let Some(url) = old.get("novaUrl").and_then(Value::as_str) {
                args.url = Some(crate::nav::normalize_origin(url).map_err(|e| e.to_string())?);
            }
        }
        args.mode = old
            .get("mode")
            .and_then(Value::as_str)
            .and_then(crate::mode::Mode::parse);
        args.display = old.get("helperDisplay").and_then(Value::as_u64).map(|v| v as u32);
        for (file, wallpaper) in [("mode.json", false), ("wallpaper.json", true)] {
            let state_path = legacy_dir.join(file);
            if !state_path.exists() {
                continue;
            }
            let state: Value = serde_json::from_str(
                std::fs::read_to_string(state_path)
                    .map_err(|e| e.to_string())?
                    .trim_start_matches('\u{feff}'),
            )
            .map_err(|e| e.to_string())?;
            if wallpaper {
                if let Some(walls) = state.as_object() {
                    for (name, entry) in walls {
                        if let Some(style) = entry
                            .get("mode")
                            .and_then(Value::as_str)
                            .and_then(crate::mode::WallpaperStyle::parse)
                        {
                            desk.wallpapers.insert(name.clone(), style);
                            if desk.url.is_none() && args.url.is_none() {
                                if let Some(url) = entry.get("url").and_then(Value::as_str) {
                                    args.url = Some(crate::nav::normalize_origin(url).map_err(|e| e.to_string())?);
                                }
                            }
                        }
                    }
                }
            } else {
                if let Some(url) = state.get("url").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    args.url = Some(crate::nav::normalize_origin(url).map_err(|e| e.to_string())?);
                }
                if let Some(hotkeys) = state.get("hotkeys") {
                    agent.hotkeys = serde_json::from_value(hotkeys.clone()).map_err(|e| e.to_string())?;
                }
                args.mode = state
                    .get("mode")
                    .and_then(Value::as_str)
                    .and_then(crate::mode::Mode::parse)
                    .or(args.mode);
                args.display = state
                    .get("display")
                    .and_then(Value::as_u64)
                    .map(|v| v as u32)
                    .or(args.display);
                args.view = state
                    .get("view")
                    .and_then(Value::as_str)
                    .and_then(crate::view::View::parse);
            }
        }
        desk.apply_args(&args, monitor_names);
    }
    agent.validate()?;
    Ok((desk, agent))
}

/// A failed replacement keeps the previous valid file. No delete-before-rename fallback.
pub fn atomic_save(path: &Path, text: &str) -> Result<(), String> {
    let temp = path.with_extension("json.tmp");
    use std::io::Write;
    let mut file = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
    file.write_all(text.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    #[cfg(not(windows))]
    std::fs::rename(temp, path).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
        let from: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            MoveFileExW(
                PCWSTR(from.as_ptr()),
                PCWSTR(to.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_unified_config_defaults_to_no_desktop_or_elevation() {
        let original = AgentConfig::fresh().unwrap();
        let mut value: Value = serde_json::from_str(&encode(&DeskConfig::default(), &original)).unwrap();
        value["agent"].as_object_mut().unwrap().remove("automation");
        value["agent"].as_object_mut().unwrap().remove("runElevated");
        let (_, loaded) = decode(&value.to_string()).unwrap();
        assert!(!loaded.automation.view);
        assert!(!loaded.automation.control);
        assert!(loaded.automation.browser);
        assert!(!loaded.run_elevated);
        assert_eq!(loaded.token, original.token);
        let mut enabled = loaded;
        enabled.automation.view = true;
        enabled.run_elevated = true;
        let (_, saved) = decode(&encode(&DeskConfig::default(), &enabled)).unwrap();
        assert_eq!(saved.automation, enabled.automation);
        assert!(saved.run_elevated);
    }
    #[test]
    fn authentication_checks_both_source_and_bearer() {
        let mut c = AgentConfig::fresh().unwrap();
        let local = "127.0.0.1".parse().unwrap();
        assert_eq!(c.authorize(local, None), Err(401));
        assert_eq!(c.authorize(local, Some(&c.token)), Err(401));
        assert!(c.authorize(local, Some(&format!("Bearer {}", c.token))).is_ok());
        c.allowed_ips = vec!["192.168.1.2".parse().unwrap()];
        assert_eq!(c.authorize(local, Some(&format!("Bearer {}", c.token))), Err(403));
        assert_eq!(
            c.authorize(
                "::ffff:192.168.1.2".parse().unwrap(),
                Some(&format!("Bearer {}", c.token))
            ),
            Ok(())
        );
    }
    #[test]
    fn config_roundtrip_preserves_credentials_and_windows() {
        let a = AgentConfig::fresh().unwrap();
        let d = DeskConfig {
            url: Some("https://nova.example.nl".into()),
            ..Default::default()
        };
        let (back, agent) = decode(&encode(&d, &a)).unwrap();
        assert_eq!(back, d);
        assert_eq!(agent.token, a.token);
        assert_eq!(agent.apps, a.apps);
        assert!(decode("{}").is_err());
        assert_eq!(
            decode(&("\u{feff}".to_string() + &encode(&d, &a))).unwrap().1.token,
            a.token
        );
    }
    #[test]
    fn import_is_idempotent_and_preserves_sources() {
        let dir = std::env::temp_dir().join(format!("nova-import-{}", AgentConfig::fresh().unwrap().token));
        std::fs::create_dir_all(&dir).unwrap();
        let old = r#"{"token":"abcdefghijklmnopqrstuvwxyz","allowedIps":["192.168.1.5"],"mode":"both","novaUrl":"https://nova.example.nl"}"#;
        std::fs::write(dir.join("agent.json"), old).unwrap();
        let path = dir.join("config.json");
        let (desk, agent) = load_or_import(&path, &dir, &[]).unwrap();
        assert_eq!(agent.token, "abcdefghijklmnopqrstuvwxyz");
        assert_eq!(desk.mode, crate::mode::Mode::Both);
        assert_eq!(std::fs::read_to_string(dir.join("agent.json")).unwrap(), old);
        std::fs::write(dir.join("agent.json"), "broken").unwrap();
        assert_eq!(load_or_import(&path, &dir, &[]).unwrap().1.token, agent.token);
        std::fs::write(&path, "broken unified file").unwrap();
        assert!(load_or_import(&path, &dir, &[]).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "broken unified file");
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn powershell_bom_and_device_named_wallpapers_are_imported() {
        let dir = std::env::temp_dir().join(format!("nova-legacy-{}", AgentConfig::fresh().unwrap().token));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("agent.json"),
            "\u{feff}{\"token\":\"abcdefghijklmnopqrstuvwxyz\",\"desktop\":{\"enabled\":true}}",
        )
        .unwrap();
        std::fs::write(dir.join("mode.json"), "\u{feff}{\"mode\":\"both\",\"display\":2,\"url\":\"http://nova:8080\",\"view\":\"chat\",\"hotkeys\":{\"open\":\"Ctrl+Alt+O\",\"speak\":\"\",\"mute\":\"Ctrl+Alt+M\",\"desktop\":\"Ctrl+Alt+D\"}}" ).unwrap();
        std::fs::write(
            dir.join("wallpaper.json"),
            "\u{feff}{\"screen1\":{\"mode\":\"sphere\",\"url\":\"http://nova:8080\"}}",
        )
        .unwrap();
        let (desk, agent) =
            load_or_import(&dir.join("config.json"), &dir, &["screen1".into(), "screen2".into()]).unwrap();
        assert_eq!(desk.helper_display.as_deref(), Some("screen2"));
        assert_eq!(desk.url.as_deref(), Some("http://nova:8080"));
        assert_eq!(desk.helper_view, crate::view::View::Chat);
        assert_eq!(desk.wallpapers["screen1"], crate::mode::WallpaperStyle::Sphere);
        assert_eq!(agent.hotkeys["open"], "Ctrl+Alt+O");
        assert_eq!(agent.legacy_preferences["desktop"]["enabled"], true);
        // Imported control preferences are retained as data, never activated in stage one.
        std::fs::remove_dir_all(dir).unwrap();
    }
}
