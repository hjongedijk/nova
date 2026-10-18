//! Global shortcuts run on the GUI thread and share the agent's pause state.
use crate::{app, state::Shared};
use nova_win_core::args::Args;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

fn register(app: &AppHandle, hotkeys: &BTreeMap<String, String>) -> Result<Vec<String>, String> {
    let mut shortcuts = Vec::new();
    let mut ids = HashSet::new();
    for (action, key) in hotkeys {
        if !["open", "speak", "mute", "desktop"].contains(&action.as_str()) || key.len() > 80 {
            return Err("Onbekende sneltoets".into());
        }
        if key.is_empty() {
            continue;
        }
        let shortcut: Shortcut = key.parse().map_err(|_| format!("Ongeldige sneltoets voor {action}"))?;
        if !ids.insert(shortcut.id()) {
            return Err("Sneltoetsen moeten verschillend zijn".into());
        }
        shortcuts.push((action.clone(), key.clone(), shortcut));
    }
    let mut warnings = Vec::new();
    let emergency: Shortcut = "Ctrl+Alt+Shift+K".parse().expect("fixed emergency shortcut");
    if ids.contains(&emergency.id()) {
        return Err("Ctrl+Alt+Shift+K is gereserveerd om pc-bediening te stoppen".into());
    }
    app.state::<Shared>().lock().emergency_ready = false;
    crate::automation::cancel(app);
    crate::automation::disarm(app);
    app.global_shortcut().unregister_all().map_err(|e| e.to_string())?;
    if app
        .global_shortcut()
        .on_shortcut(emergency, |app, _, event| {
            if event.state == ShortcutState::Pressed {
                // Disarm immediately; GUI changes can follow on the main thread.
                stop(app);
            }
        })
        .is_err()
    {
        warnings.push("Noodstop Ctrl+Alt+Shift+K kon niet worden geregistreerd".into());
    } else {
        app.state::<Shared>().lock().emergency_ready = true;
    }
    for (action, key, shortcut) in shortcuts {
        let name = action.clone();
        if let Err(_error) = app.global_shortcut().on_shortcut(shortcut, move |app, _, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            let handle = app.clone();
            let action = name.clone();
            let _ = app.run_on_main_thread(move || {
                if handle.state::<Shared>().lock().paused {
                    return;
                }
                if action == "desktop" {
                    crate::platform::show_desktop();
                } else {
                    app::handle_args(
                        &handle,
                        Args {
                            action: Some(action),
                            show: true,
                            ..Default::default()
                        },
                    );
                }
            });
        }) {
            warnings.push(format!("Agent controls: {action}: {key}"));
        }
    }
    Ok(warnings)
}

pub fn restore(app: &AppHandle) -> Result<(), String> {
    let hotkeys = app.state::<Shared>().lock().agent.hotkeys.clone();
    match register(app, &hotkeys) {
        Ok(warnings) => {
            app.state::<Shared>().lock().hotkey_warnings = warnings;
            Ok(())
        }
        Err(error) => {
            app.state::<Shared>().lock().hotkey_warnings = vec!["Shortcut registration did not complete".into()];
            Err(error)
        }
    }
}

pub fn preferences(app: &AppHandle) -> Value {
    let shared = app.state::<Shared>();
    let inner = shared.lock();
    json!({"hotkeys":inner.agent.hotkeys,"warnings":inner.hotkey_warnings,"paused":inner.paused,"view":inner.view.as_str()})
}

pub fn set(app: &AppHandle, body: &Value) -> Result<(), String> {
    let hotkeys: BTreeMap<String, String> =
        serde_json::from_value(body["hotkeys"].clone()).map_err(|_| "Ongeldige sneltoetsen")?;
    if hotkeys.len() != 4
        || ["open", "speak", "mute", "desktop"]
            .iter()
            .any(|k| !hotkeys.contains_key(*k))
    {
        return Err("Vul alle vier sneltoetsen in; leeg schakelt een sneltoets uit".into());
    }
    let warnings = register(app, &hotkeys)?;
    let shared = app.state::<Shared>();
    let mut inner = shared.lock();
    inner.agent.hotkeys = hotkeys;
    inner.hotkey_warnings = warnings;
    inner.save();
    Ok(())
}

pub fn toggle_pause(app: &AppHandle) {
    let paused = {
        let shared = app.state::<Shared>();
        let mut inner = shared.lock();
        inner.paused = !inner.paused;
        inner.paused
    };
    if paused {
        crate::automation::cancel(app);
        crate::automation::disarm(app);
    }
    app::handle_args(
        app,
        Args {
            action: Some("pause".into()),
            paused: Some(paused),
            ..Default::default()
        },
    );
}

pub fn stop(app: &AppHandle) {
    app.state::<Shared>().lock().paused = true;
    crate::automation::cancel(app);
    crate::automation::disarm(app);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        app::handle_args(
            &handle,
            Args {
                action: Some("pause".into()),
                paused: Some(true),
                ..Args::default()
            },
        );
        crate::tray::rebuild(&handle);
    });
}
