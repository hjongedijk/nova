//! The tray icon and its menu (Dutch). The menu is rebuilt from the current state after every change.

use crate::state::Shared;
use crate::windows_ops::{app_address, monitors, open_external};
use crate::{app, log, win};
use nova_win_core::args::{Args, WallpaperArg};
use nova_win_core::geometry::{resolve_display, Anchor};
use nova_win_core::mode::{apply_event, Event, Mode, WallpaperStyle};
use nova_win_core::view::View;
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

const TRAY_ID: &str = "nova-desk";

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let menu = menu(app)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("NOVA")
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
                toggle_helper(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub fn rebuild(app: &AppHandle) {
    match menu(app) {
        Ok(menu) => {
            if let Some(tray) = app.tray_by_id(TRAY_ID) {
                let _ = tray.set_menu(Some(menu));
            }
        }
        Err(error) => log!("could not rebuild the tray menu: {error}"),
    }
}

fn label(index: usize, width: i32, height: i32, primary: bool) -> String {
    format!(
        "Scherm {} ({}x{}{})",
        index + 1,
        width,
        height,
        if primary { ", hoofdscherm" } else { "" }
    )
}

fn menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let list = monitors(app);
    let shared = app.state::<Shared>();
    let (desired, config, has_url) = {
        let inner = shared.lock();
        (inner.desired.clone(), inner.config.clone(), inner.config.url.is_some())
    };
    let current = if list.is_empty() {
        0
    } else {
        resolve_display(&list, config.helper_display.as_deref(), 0)
    };

    let helper_text = if desired.helper_visible {
        "Helper verbergen"
    } else {
        "Helper tonen"
    };
    let helper = MenuItem::with_id(
        app,
        "helper_toggle",
        helper_text,
        has_url && desired.mode.wants_helper(),
        None::<&str>,
    )?;

    let mut screens: Vec<CheckMenuItem<tauri::Wry>> = Vec::new();
    let mut walls: Vec<CheckMenuItem<tauri::Wry>> = Vec::new();
    for (i, m) in list.iter().enumerate() {
        let text = label(i, m.bounds.w, m.bounds.h, m.primary);
        screens.push(CheckMenuItem::with_id(
            app,
            format!("screen:{}", i + 1),
            &text,
            true,
            i == current,
            None::<&str>,
        )?);
        let on = desired.wallpapers.contains_key(&m.name);
        walls.push(CheckMenuItem::with_id(
            app,
            format!("wall:{}", i + 1),
            format!("Wallpaper op {}", text.to_lowercase()),
            true,
            on,
            None::<&str>,
        )?);
    }
    let screen_refs: Vec<&dyn IsMenuItem<tauri::Wry>> =
        screens.iter().map(|i| i as &dyn IsMenuItem<tauri::Wry>).collect();
    let screen_menu = Submenu::with_items(app, "Scherm kiezen", !screens.is_empty(), &screen_refs)?;
    let wall_refs: Vec<&dyn IsMenuItem<tauri::Wry>> = walls.iter().map(|i| i as &dyn IsMenuItem<tauri::Wry>).collect();
    let wall_menu = Submenu::with_items(app, "Wallpaper aan/uit per scherm", !walls.is_empty(), &wall_refs)?;

    let modes: Vec<CheckMenuItem<tauri::Wry>> = [
        (Mode::Helper, "Alleen helper"),
        (Mode::Wallpaper, "Alleen wallpaper"),
        (Mode::Both, "Helper en wallpaper"),
    ]
    .iter()
    .map(|(mode, text)| {
        CheckMenuItem::with_id(
            app,
            format!("mode:{}", mode.as_str()),
            text,
            true,
            desired.mode == *mode,
            None::<&str>,
        )
    })
    .collect::<tauri::Result<_>>()?;
    let mode_refs: Vec<&dyn IsMenuItem<tauri::Wry>> = modes.iter().map(|i| i as &dyn IsMenuItem<tauri::Wry>).collect();
    let mode_menu = Submenu::with_items(app, "Wat toon ik", true, &mode_refs)?;

    let anchors: Vec<CheckMenuItem<tauri::Wry>> = [
        (Anchor::TopCentre, "Boven in het midden"),
        (Anchor::TopLeft, "Linksboven"),
        (Anchor::TopRight, "Rechtsboven"),
    ]
    .iter()
    .map(|(anchor, text)| {
        CheckMenuItem::with_id(
            app,
            format!("anchor:{}", anchor.as_str()),
            text,
            true,
            config.helper_anchor == *anchor,
            None::<&str>,
        )
    })
    .collect::<tauri::Result<_>>()?;
    let reset = MenuItem::with_id(app, "position_reset", "Positie herstellen", true, None::<&str>)?;
    let mut anchor_refs: Vec<&dyn IsMenuItem<tauri::Wry>> =
        anchors.iter().map(|i| i as &dyn IsMenuItem<tauri::Wry>).collect();
    anchor_refs.push(&reset);
    let anchor_menu = Submenu::with_items(app, "Positie van de helper", true, &anchor_refs)?;

    let login = MenuItem::with_id(
        app,
        "login",
        "Inloggen (helper groot tonen)",
        has_url && desired.mode.wants_helper(),
        None::<&str>,
    )?;
    let open = MenuItem::with_id(app, "open_nova", "NOVA openen in de browser", has_url, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "Starten met Windows",
        true,
        win::autostart_enabled(),
        None::<&str>,
    )?;
    let pause = MenuItem::with_id(
        app,
        "pause",
        if shared.lock().paused { "Hervatten" } else { "Pauzeren" },
        true,
        None::<&str>,
    )?;
    let setup = MenuItem::with_id(app, "setup", "Instellen en koppelen", true, None::<&str>)?;
    let update = crate::updates::status(app);
    let update_text = match update.phase {
        nova_win_core::update::Phase::Available => format!(
            "Update naar {} beschikbaar",
            update.version.as_deref().unwrap_or("NOVA")
        ),
        nova_win_core::update::Phase::Checking => "Updates controleren…".into(),
        nova_win_core::update::Phase::Downloading | nova_win_core::update::Phase::Installing => {
            "NOVA wordt bijgewerkt…".into()
        }
        _ => "Controleren op updates".into(),
    };
    let updates = MenuItem::with_id(app, "updates", &update_text, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Afsluiten", true, None::<&str>)?;
    let separator_a = PredefinedMenuItem::separator(app)?;
    let separator_b = PredefinedMenuItem::separator(app)?;
    Menu::with_items(
        app,
        &[
            &helper,
            &pause,
            &screen_menu,
            &anchor_menu,
            &separator_a,
            &mode_menu,
            &wall_menu,
            &separator_b,
            &login,
            &open,
            &autostart,
            &setup,
            &updates,
            &quit,
        ],
    )
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
        "helper_toggle" => toggle_helper(app),
        "login" => app::handle_args(
            app,
            Args {
                view: Some(View::Chat),
                show: true,
                ..Args::default()
            },
        ),
        "open_nova" => {
            if let Some(url) = app_address(app) {
                open_external(app, &url);
            }
        }
        "autostart" => {
            if let Err(error) = win::set_autostart(!win::autostart_enabled()) {
                log!("start with Windows: {error}");
            }
            rebuild(app);
        }
        "pause" => crate::controls::toggle_pause(app),
        "setup" => app::open_setup(app),
        "updates" => {
            app::open_setup(app);
            let phase = crate::updates::status(app).phase;
            if !matches!(
                phase,
                nova_win_core::update::Phase::Available
                    | nova_win_core::update::Phase::Checking
                    | nova_win_core::update::Phase::Downloading
                    | nova_win_core::update::Phase::Installing
            ) {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::updates::check(&handle, false).await;
                });
            }
        }
        "quit" => app.exit(0),
        "position_reset" => {
            {
                let shared = app.state::<Shared>();
                let mut inner = shared.lock();
                let list = monitors(app);
                let index = resolve_display(&list, inner.config.helper_display.as_deref(), 0);
                if let Some(m) = list.get(index) {
                    inner.config.positions.remove(&m.name);
                }
                inner.save();
            }
            crate::windows_ops::apply_layout(app);
        }
        other => {
            if let Some(n) = other.strip_prefix("screen:").and_then(|n| n.parse::<u32>().ok()) {
                app::handle_args(
                    app,
                    Args {
                        display: Some(n),
                        show: true,
                        ..Args::default()
                    },
                );
            } else if let Some(mode) = other.strip_prefix("mode:").and_then(Mode::parse) {
                app::handle_args(
                    app,
                    Args {
                        mode: Some(mode),
                        ..Args::default()
                    },
                );
            } else if let Some(anchor) = other.strip_prefix("anchor:").and_then(Anchor::parse) {
                {
                    let shared = app.state::<Shared>();
                    let mut inner = shared.lock();
                    inner.config.helper_anchor = anchor;
                    let list = monitors(app);
                    let index = resolve_display(&list, inner.config.helper_display.as_deref(), 0);
                    if let Some(m) = list.get(index) {
                        inner.config.positions.remove(&m.name);
                    }
                    inner.save();
                }
                crate::windows_ops::apply_layout(app);
                rebuild(app);
            } else if let Some(n) = other.strip_prefix("wall:").and_then(|n| n.parse::<u32>().ok()) {
                let on = {
                    let list = monitors(app);
                    let shared = app.state::<Shared>();
                    let inner = shared.lock();
                    list.get(n as usize - 1)
                        .map(|m| inner.config.wallpapers.contains_key(&m.name))
                        .unwrap_or(false)
                };
                let style = if on { None } else { Some(WallpaperStyle::Full) };
                app::handle_args(
                    app,
                    Args {
                        wallpapers: vec![WallpaperArg { display: n, style }],
                        ..Args::default()
                    },
                );
            }
        }
    }
}
