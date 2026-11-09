//! Typing into a wallpaper page. The wallpaper is a child of Explorer's desktop window, so Windows sends keys to the
//! desktop (icon type-ahead), never to the page. After a click on one of the page's text fields
//! (`forward::PointerForwarder::typing_target`) and while the desktop itself is the active window, the low-level
//! keyboard hook takes the keys and the glue replays them as DevTools key events. Any other active window keeps its
//! keys; Esc and Alt (Alt+Tab, Alt+F4) end typing and go to Windows as usual.

/// Modifier keys held while a key is pressed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Mods {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    /// A Windows key: Win+... is always the shell's.
    pub win: bool,
}

impl Mods {
    /// DevTools modifier bits: Alt=1, Ctrl=2, Meta=4, Shift=8.
    fn bits(self) -> u8 {
        u8::from(self.alt) | u8::from(self.ctrl) << 1 | u8::from(self.win) << 2 | u8::from(self.shift) << 3
    }
}

/// One DevTools call for the page.
#[derive(Debug, Clone, PartialEq)]
pub struct Call {
    pub method: &'static str,
    pub params: String,
}

/// What the keyboard hook does with one key event while typing goes to the page.
#[derive(Debug, Clone, PartialEq)]
pub enum KeyPlan {
    /// Let Windows deliver it as usual.
    Pass,
    /// Let Windows deliver it, and stop sending keys to the page.
    Stop,
    /// Swallow it; send these calls to the page (possibly none, e.g. an unsupported Ctrl shortcut).
    Page(Vec<Call>),
}

const MODIFIERS: &[u32] = &[
    0x10, 0x11, 0x12, 0x14, 0x5B, 0x5C, 0x90, 0x91, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5,
];

/// Editing keys with a DOM `key`/`code` name.
fn named(vk: u32) -> Option<String> {
    let name = match vk {
        0x08 => "Backspace",
        0x09 => "Tab",
        0x0D => "Enter",
        0x21 => "PageUp",
        0x22 => "PageDown",
        0x23 => "End",
        0x24 => "Home",
        0x25 => "ArrowLeft",
        0x26 => "ArrowUp",
        0x27 => "ArrowRight",
        0x28 => "ArrowDown",
        0x2E => "Delete",
        // F1..F12: the page uses F8 (push to talk) and F9 (quick note).
        0x70..=0x7B => return Some(format!("F{}", vk - 0x6F)),
        _ => return None,
    };
    Some(name.to_string())
}

/// Ctrl shortcuts handled by Chromium's editing commands (the browser accelerators are switched off).
fn command(vk: u32) -> Option<&'static str> {
    Some(match vk {
        0x41 => "selectAll",
        0x43 => "copy",
        0x56 => "paste",
        0x58 => "cut",
        0x59 => "redo",
        0x5A => "undo",
        _ => return None,
    })
}

fn call(params: serde_json::Value) -> Call {
    Call {
        method: "Input.dispatchKeyEvent",
        params: params.to_string(),
    }
}

/// Decides one key event. `text` is what the active keyboard layout produces for it (with Shift, Caps Lock and
/// AltGr applied), `None` for keys without text or a dead key that is still waiting for its letter.
pub fn plan(vk: u32, down: bool, mods: Mods, text: Option<&str>) -> KeyPlan {
    if MODIFIERS.contains(&vk) || mods.win {
        return KeyPlan::Pass;
    }
    // Esc leaves the field; Alt without Ctrl (not AltGr) is Alt+Tab, Alt+F4 or a menu: Windows' own.
    if down && (vk == 0x1B || mods.alt && !mods.ctrl) {
        return KeyPlan::Stop;
    }
    if vk == 0x1B {
        return KeyPlan::Pass;
    }
    let code = |key: &str| {
        serde_json::json!({
            "windowsVirtualKeyCode": vk,
            "nativeVirtualKeyCode": vk,
            "key": key,
            "code": key,
            "modifiers": mods.bits(),
        })
    };
    let altgr = mods.ctrl && mods.alt;
    let printable = text.filter(|t| !t.is_empty() && t.chars().all(|c| !c.is_control()));
    if !down {
        let mut params = code(named(vk).as_deref().or(printable).unwrap_or(""));
        params["type"] = "keyUp".into();
        return KeyPlan::Page(vec![call(params)]);
    }
    if mods.ctrl && !altgr {
        if let Some(command) = command(vk) {
            let mut params = code("");
            params["type"] = "rawKeyDown".into();
            params["commands"] = serde_json::json!([command]);
            return KeyPlan::Page(vec![call(params)]);
        }
        // Ctrl+arrows/Backspace/Delete move and delete by word; other shortcuts are not the page's to take.
        return match named(vk) {
            Some(name) => {
                let mut params = code(&name);
                params["type"] = "rawKeyDown".into();
                KeyPlan::Page(vec![call(params)])
            }
            None => KeyPlan::Page(Vec::new()),
        };
    }
    if let Some(name) = named(vk) {
        let mut params = code(&name);
        if vk == 0x0D {
            params["type"] = "keyDown".into();
            params["text"] = "\r".into();
            params["unmodifiedText"] = "\r".into();
        } else {
            params["type"] = "rawKeyDown".into();
        }
        return KeyPlan::Page(vec![call(params)]);
    }
    match printable {
        Some(text) => {
            let mut params = code(text);
            params["code"] = "".into();
            params["type"] = "keyDown".into();
            params["text"] = text.into();
            params["unmodifiedText"] = text.into();
            KeyPlan::Page(vec![call(params)])
        }
        // A dead key waiting for its letter, or a key without text (Insert, media keys) while typing.
        None => KeyPlan::Page(Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(plan: &KeyPlan) -> serde_json::Value {
        match plan {
            KeyPlan::Page(calls) => serde_json::from_str(&calls[0].params).unwrap(),
            other => panic!("expected page calls, got {other:?}"),
        }
    }

    #[test]
    fn a_letter_types_its_layout_text() {
        let plan = plan(0x51, true, Mods::default(), Some("q"));
        let p = params(&plan);
        assert_eq!(p["type"], "keyDown");
        assert_eq!(p["text"], "q");
        assert_eq!(p["key"], "q");
        assert_eq!(p["windowsVirtualKeyCode"], 0x51);
        let shifted = Mods {
            shift: true,
            ..Mods::default()
        };
        assert_eq!(params(&super::plan(0x31, true, shifted, Some("!")))["text"], "!");
        assert_eq!(params(&super::plan(0x31, true, shifted, Some("!")))["modifiers"], 8);
    }

    #[test]
    fn altgr_produces_text_instead_of_a_shortcut() {
        let altgr = Mods {
            ctrl: true,
            alt: true,
            ..Mods::default()
        };
        assert_eq!(params(&plan(0x45, true, altgr, Some("€")))["text"], "€");
    }

    #[test]
    fn enter_backspace_arrows_and_function_keys_are_named() {
        let enter = params(&plan(0x0D, true, Mods::default(), Some("\r")));
        assert_eq!(
            (enter["type"].as_str(), enter["text"].as_str()),
            (Some("keyDown"), Some("\r"))
        );
        for (vk, name) in [(0x08, "Backspace"), (0x25, "ArrowLeft"), (0x2E, "Delete"), (0x77, "F8")] {
            let p = params(&plan(vk, true, Mods::default(), None));
            assert_eq!(p["type"], "rawKeyDown");
            assert_eq!(p["key"], name);
            assert_eq!(p["code"], name);
        }
        let up = params(&plan(0x77, false, Mods::default(), None));
        assert_eq!((up["type"].as_str(), up["key"].as_str()), (Some("keyUp"), Some("F8")));
    }

    #[test]
    fn ctrl_shortcuts_become_editing_commands_and_others_are_dropped() {
        let ctrl = Mods {
            ctrl: true,
            ..Mods::default()
        };
        let paste = params(&plan(0x56, true, ctrl, None));
        assert_eq!(paste["commands"], serde_json::json!(["paste"]));
        assert_eq!(paste["modifiers"], 2);
        assert_eq!(params(&plan(0x25, true, ctrl, None))["key"], "ArrowLeft");
        assert_eq!(plan(0x4C, true, ctrl, None), KeyPlan::Page(vec![]));
    }

    #[test]
    fn modifiers_windows_key_escape_and_alt_belong_to_windows() {
        for vk in [0x10, 0xA2, 0x12, 0x14, 0x5B] {
            assert_eq!(plan(vk, true, Mods::default(), None), KeyPlan::Pass);
        }
        let win = Mods {
            win: true,
            ..Mods::default()
        };
        assert_eq!(plan(0x44, true, win, Some("d")), KeyPlan::Pass);
        assert_eq!(plan(0x1B, true, Mods::default(), None), KeyPlan::Stop);
        assert_eq!(plan(0x1B, false, Mods::default(), None), KeyPlan::Pass);
        let alt = Mods {
            alt: true,
            ..Mods::default()
        };
        assert_eq!(plan(0x09, true, alt, None), KeyPlan::Stop);
        assert_eq!(plan(0x73, true, alt, None), KeyPlan::Stop);
    }

    #[test]
    fn dead_keys_and_textless_keys_are_held_back_without_reaching_the_desktop() {
        assert_eq!(plan(0xDE, true, Mods::default(), None), KeyPlan::Page(vec![]));
        assert_eq!(plan(0x2D, true, Mods::default(), Some("")), KeyPlan::Page(vec![]));
        assert_eq!(plan(0x41, true, Mods::default(), Some("\u{1}")), KeyPlan::Page(vec![]));
    }
}
