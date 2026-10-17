//! The only script NOVA Desk ever runs inside a page: dispatching the two events the helper page already listens
//! for (`nova-helper-action`, `nova-helper-notification`). The payload is validated here and passed as a JSON
//! string literal that the page parses, so nothing from outside is ever spliced into code.

use serde_json::Value;

/// Actions the helper page understands (see `nativeAction` in the helper page).
pub const ACTIONS: [&str; 5] = ["open", "speak", "mute", "settings", "pause"];
/// A decoded notification may not be larger than this many bytes.
pub const MAX_NOTIFICATION_BYTES: usize = 2048;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScriptError {
    UnknownAction,
    NotJson,
    NotAnObject,
    TooLarge,
}

fn literal(value: &Value) -> String {
    // A JSON string containing JSON: `JSON.parse("{\"a\":1}")`. serde_json escapes everything that matters.
    serde_json::to_string(&value.to_string()).expect("a string always serializes")
}

/// `{ "action": "pause", "paused": true }` as the page expects it.
pub fn action_script(action: &str, paused: Option<bool>) -> Result<String, ScriptError> {
    if !ACTIONS.contains(&action) {
        return Err(ScriptError::UnknownAction);
    }
    let mut detail = serde_json::Map::new();
    detail.insert("action".into(), Value::String(action.to_string()));
    if let Some(paused) = paused {
        detail.insert("paused".into(), Value::Bool(paused));
    }
    Ok(format!(
        "window.dispatchEvent(new CustomEvent('nova-helper-action',{{detail:JSON.parse({})}}))",
        literal(&Value::Object(detail))
    ))
}

/// A notification event from the agent (already validated there; checked again for shape and size here).
/// It is queued in `window.__novaHelperNotifications` first, because the page reads that queue after it mounts.
pub fn notification_script(json: &str) -> Result<String, ScriptError> {
    if json.len() > MAX_NOTIFICATION_BYTES {
        return Err(ScriptError::TooLarge);
    }
    let value: Value = serde_json::from_str(json).map_err(|_| ScriptError::NotJson)?;
    if !value.is_object() {
        return Err(ScriptError::NotAnObject);
    }
    Ok(format!(
        "(() => {{ const event = JSON.parse({}); window.__novaHelperNotifications = [...(window.__novaHelperNotifications || []).filter(item => item.seq !== event.seq), event].slice(-20); window.dispatchEvent(new CustomEvent('nova-helper-notification',{{detail:event}})); }})()",
        literal(&value)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_actions_become_an_event() {
        let s = action_script("speak", None).unwrap();
        assert!(s.starts_with("window.dispatchEvent(new CustomEvent('nova-helper-action'"));
        assert!(s.contains(r#"JSON.parse("{\"action\":\"speak\"}")"#), "{s}");
        let p = action_script("pause", Some(true)).unwrap();
        assert!(p.contains(r#"\"paused\":true"#), "{p}");
    }

    #[test]
    fn unknown_actions_are_refused() {
        assert_eq!(action_script("exit", None), Err(ScriptError::UnknownAction));
        assert_eq!(action_script("'); alert(1); ('", None), Err(ScriptError::UnknownAction));
        assert_eq!(action_script("", None), Err(ScriptError::UnknownAction));
    }

    #[test]
    fn a_notification_is_embedded_as_a_string_never_as_code() {
        let evil = r#"{"seq":1,"title":"x\"});alert(1);//","detail":"</script>"}"#;
        let s = notification_script(evil).unwrap();
        // the whole payload sits inside one JSON.parse("...") literal
        assert!(s.contains("JSON.parse(\"{"));
        assert!(!s.contains("alert(1);//\"}"), "{s}");
        assert!(s.contains("\\\\\\\"})"), "quote escapes are doubled: {s}");
        assert!(s.contains("window.__novaHelperNotifications"));
    }

    #[test]
    fn bad_notifications_are_refused() {
        assert_eq!(notification_script("not json"), Err(ScriptError::NotJson));
        assert_eq!(notification_script("[1,2]"), Err(ScriptError::NotAnObject));
        assert_eq!(notification_script("\"text\""), Err(ScriptError::NotAnObject));
        let big = format!("{{\"title\":\"{}\"}}", "a".repeat(MAX_NOTIFICATION_BYTES));
        assert_eq!(notification_script(&big), Err(ScriptError::TooLarge));
    }
}
