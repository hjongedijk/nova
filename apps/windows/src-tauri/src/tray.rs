//! The tray icon: a handful of quick actions. Every setting (displays, wallpaper, start-up, pairing, updates)
//! lives in the NOVA window, which a left click on the icon opens.

use crate::state::Shared;
use crate::{app, log};
use nova_win_core::mode::{apply_event, Event};
use nova_win_core::update::Phase;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

const TRAY_ID: &str = "nova-desk";

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let menu = menu(app)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(tooltip(app))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                app::open_setup(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn tooltip(app: &AppHandle) -> String {
    let shared = app.state::<Shared>();
    let inner = shared.lock();
    if inner.paused {
        "NOVA – gepauzeerd".into()
    } else if inner.config.url.is_none() {
        "NOVA – nog niet ingesteld".into()
    } else if inner.agent_error.is_some() {
        "NOVA – niet bereikbaar voor de server".into()
    } else {
        "NOVA".into()
    }
}

/// Rebuilds the menu from the current state and tells an open NOVA window about the change.
pub fn rebuild(app: &AppHandle) {
    match menu(app) {
        Ok(menu) => {
            if let Some(tray) = app.tray_by_id(TRAY_ID) {
                let _ = tray.set_menu(Some(menu));
                let _ = tray.set_tooltip(Some(tooltip(app)));
            }
        }
        Err(error) => log!("could not rebuild the tray menu: {error}"),
    }
    crate::app_window::publish(app);
}

fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let shared = app.state::<Shared>();
    let (helper_visible, wants_helper, has_url, paused) = {
        let inner = shared.lock();
        (
            inner.desired.helper_visible,
            inner.desired.mode.wants_helper(),
            inner.config.url.is_some(),
            inner.paused,
        )
    };
    let open = MenuItem::with_id(app, "open", "NOVA openen", true, None::<&str>)?;
    let helper = MenuItem::with_id(
        app,
        "helper_toggle",
        if helper_visible && wants_helper {
            "Helper verbergen"
        } else {
            "Helper tonen"
        },
        has_url && wants_helper,
        None::<&str>,
    )?;
    let pause = MenuItem::with_id(
        app,
        "pause",
        if paused {
            "Hervatten"
        } else {
            "Pauzeren (noodstop Ctrl+Alt+Shift+K)"
        },
        true,
        None::<&str>,
    )?;
    let update = crate::updates::status(app);
    let separator_a = PredefinedMenuItem::separator(app)?;
    let separator_b = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Afsluiten", true, None::<&str>)?;
    if update.phase == Phase::Available {
        let install = MenuItem::with_id(
            app,
            "update",
            format!(
                "Update naar {} installeren…",
                update.version.as_deref().unwrap_or("nieuwe versie")
            ),
            true,
            None::<&str>,
        )?;
        Menu::with_items(
            app,
            &[&open, &helper, &pause, &separator_a, &install, &separator_b, &quit],
        )
    } else {
        Menu::with_items(app, &[&open, &helper, &pause, &separator_a, &quit])
    }
}

fn toggle_helper(app: &AppHandle) {
    {
        let shared = app.state::<Shared>();
        let mut inner = shared.lock();
        if !inner.desired.mode.wants_helper() {
            return;
        }
        inner.desired = apply_event(inner.desired.clone(), Event::ToggleHelper);
    }
    app::apply(app);
    rebuild(app);
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "open" | "update" => app::open_setup(app),
        "helper_toggle" => toggle_helper(app),
        "pause" => {
            if app.state::<Shared>().lock().paused {
                crate::controls::toggle_pause(app);
            } else {
                crate::controls::stop(app);
            }
        }
        "quit" => app.exit(0),
        _ => {}
    }
}
