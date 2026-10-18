//! The commands a page can call. Each one is its own permission (see build.rs and the capabilities), the helper
//! commands check that they come from the helper window, and none of them takes a path, a command line or a script.

use crate::state::Shared;
use crate::windows_ops::{apply_layout, monitors, HELPER};
use crate::{app, log, tray};
use nova_win_core::geometry::resolve_display;
use nova_win_core::nav::normalize_origin;
use nova_win_core::view::View;
use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewWindow};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayDto {
    index: u32,
    name: String,
    primary: bool,
    width: i32,
    height: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InfoDto {
    version: &'static str,
    /// 1-based number of the display the helper is on.
    display: u32,
    displays: Vec<DisplayDto>,
    fullscreen: bool,
}

fn only(window: &WebviewWindow, label: &str) -> Result<(), String> {
    if window.label() == label {
        Ok(())
    } else {
        Err("niet toegestaan voor dit venster".into())
    }
}

#[tauri::command]
pub async fn desk_info(window: WebviewWindow, app: AppHandle) -> Result<InfoDto, String> {
    only(&window, HELPER)?;
    let list = monitors(&app);
    let shared = app.state::<Shared>();
    let (current, fullscreen) = {
        let inner = shared.lock();
        (
            resolve_display(&list, inner.config.helper_display.as_deref(), 0),
            inner.fullscreen,
        )
    };
    Ok(InfoDto {
        version: env!("CARGO_PKG_VERSION"),
        display: current as u32 + 1,
        displays: list
            .iter()
            .enumerate()
            .map(|(i, m)| DisplayDto {
                index: i as u32 + 1,
                name: m.name.clone(),
                primary: m.primary,
                width: m.bounds.w,
                height: m.bounds.h,
            })
            .collect(),
        fullscreen,
    })
}

/// Moves the helper to another display (1-based) and remembers it.
#[tauri::command]
pub async fn desk_set_display(window: WebviewWindow, app: AppHandle, index: u32) -> Result<(), String> {
    only(&window, HELPER)?;
    let list = monitors(&app);
    let name = index
        .checked_sub(1)
        .and_then(|i| list.get(i as usize))
        .map(|m| m.name.clone())
        .ok_or_else(|| format!("scherm {index} bestaat niet"))?;
    {
        let shared = app.state::<Shared>();
        let mut inner = shared.lock();
        inner.config.helper_display = Some(name);
        inner.fullscreen = false;
        inner.save();
    }
    let handle = app.clone();
    app.run_on_main_thread(move || {
        apply_layout(&handle);
        tray::rebuild(&handle);
    })
    .map_err(|e| e.to_string())
}

/// The panel changes view (and may be the thin autohide strip): the window follows.
#[tauri::command]
pub async fn desk_set_view(window: WebviewWindow, app: AppHandle, view: String, hidden: bool) -> Result<(), String> {
    only(&window, HELPER)?;
    let view = View::parse(&view).ok_or("onbekende weergave")?;
    {
        let shared = app.state::<Shared>();
        let mut inner = shared.lock();
        inner.view = view;
        inner.hidden = hidden;
        if !hidden && view.is_persistent() {
            inner.config.helper_view = view;
            inner.save();
        }
    }
    let handle = app.clone();
    app.run_on_main_thread(move || apply_layout(&handle))
        .map_err(|e| e.to_string())
}

/// The "hide" button: the helper goes away until the tray (or a notification) brings it back.
#[tauri::command]
pub async fn desk_hide_helper(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    only(&window, HELPER)?;
    app::helper_hidden_by_user(&app);
    Ok(())
}

/// The expand button: the helper covers the work area of its display, or goes back to its size.
#[tauri::command]
pub async fn desk_set_fullscreen(window: WebviewWindow, app: AppHandle, on: bool) -> Result<(), String> {
    only(&window, HELPER)?;
    app.state::<Shared>().lock().fullscreen = on;
    let handle = app.clone();
    app.run_on_main_thread(move || apply_layout(&handle))
        .map_err(|e| e.to_string())
}

/// First-run page only: the address of NOVA.
#[tauri::command]
pub async fn desk_set_url(window: WebviewWindow, app: AppHandle, url: String) -> Result<(), String> {
    only(&window, "setup")?;
    let origin = normalize_origin(&url).map_err(|e| e.to_string())?;
    log!("the NOVA address was set from the setup page");
    let handle = app.clone();
    app.run_on_main_thread(move || {
        app::handle_args(
            &handle,
            nova_win_core::args::Args {
                url: Some(origin),
                show: true,
                ..Default::default()
            },
        );
    })
    .map_err(|e| e.to_string())
}

/// Local settings only. Remote helper pages never receive the pairing credential.
#[tauri::command]
pub async fn agent_setup_info(window: WebviewWindow, app: AppHandle) -> Result<serde_json::Value, String> {
    only(&window, "setup")?;
    let shared = app.state::<Shared>();
    let inner = shared.lock();
    let addresses: Vec<String> = local_ip_addresses()
        .into_iter()
        .map(|ip| format!("http://{ip}:{}", inner.agent.port))
        .collect();
    Ok(
        serde_json::json!({"url":inner.config.url,"addresses":addresses,"source":inner.agent.allowed_ips.first(),"error":inner.agent_error,"version":nova_win_core::agent::VERSION,"automation":inner.agent.automation,"runElevated":inner.agent.run_elevated,"elevated":crate::platform::is_elevated()}),
    )
}

fn local_ip_addresses() -> Vec<std::net::Ipv4Addr> {
    // Enumerating interfaces does not depend on Internet access or a DNS lookup.
    let mut addresses: Vec<_> = sysinfo::Networks::new_with_refreshed_list()
        .values()
        .flat_map(|n| n.ip_networks().iter().map(|n| n.addr))
        .filter_map(|ip| match ip {
            std::net::IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified() => Some(ip),
            _ => None,
        })
        .collect();
    addresses.sort();
    addresses.dedup();
    addresses
}

#[tauri::command]
pub async fn agent_pair_code(window: WebviewWindow, app: AppHandle, address: String) -> Result<String, String> {
    only(&window, "setup")?;
    let shared = app.state::<Shared>();
    let inner = shared.lock();
    if inner.agent_error.is_some() {
        return Err("De agent luistert nog niet. Schakel eerst de oude agent uit of controleer de poort.".into());
    }
    let addresses: Vec<_> = local_ip_addresses()
        .iter()
        .map(|ip| format!("http://{ip}:{}", inner.agent.port))
        .collect();
    if !addresses.contains(&address) {
        return Err("Kies een netwerkadres van deze pc".into());
    }
    inner.agent.pair_code(&address)
}

#[tauri::command]
pub async fn agent_configure_network(window: WebviewWindow, app: AppHandle, source: String) -> Result<(), String> {
    only(&window, "setup")?;
    let ip: std::net::IpAddr = source.parse().map_err(|_| "Vul het IP-adres van de NOVA-server in")?;
    let port = app.state::<Shared>().lock().agent.port;
    let address = ip.to_string();
    tauri::async_runtime::spawn_blocking(move || crate::platform::request_network(port, &address))
        .await
        .map_err(|e| e.to_string())??;
    let shared = app.state::<Shared>();
    let mut inner = shared.lock();
    inner.agent.allowed_ips = vec![ip];
    inner.try_save()?;
    // Transport reads current source restrictions on every request.
    Ok(())
}

#[tauri::command]
pub async fn agent_retire_legacy(window: WebviewWindow, app: AppHandle, directory: String) -> Result<(), String> {
    only(&window, "setup")?;
    let dir = std::path::PathBuf::from(directory);
    if !dir.is_absolute() || !dir.is_dir() {
        return Err("Vul een bestaande absolute map in".into());
    }
    let work = dir.clone();
    tauri::async_runtime::spawn_blocking(move || crate::platform::retire_legacy(&work))
        .await
        .map_err(|e| e.to_string())??;
    if app.state::<Shared>().lock().agent_error.is_some() {
        match crate::agent_http::start(&app) {
            Ok(()) => app.state::<Shared>().lock().agent_error = None,
            Err(error) => {
                app.state::<Shared>().lock().agent_error = Some(error.clone());
                return Err(error);
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn agent_import_legacy(window: WebviewWindow, app: AppHandle, directory: String) -> Result<(), String> {
    only(&window, "setup")?;
    let dir = std::path::PathBuf::from(directory);
    if !dir.is_absolute() || !dir.join("agent.json").is_file() {
        return Err("Deze map bevat geen agent.json".into());
    }
    let names: Vec<_> = monitors(&app).into_iter().map(|m| m.name).collect();
    let path = app.state::<Shared>().lock().config_path.clone();
    let (config, agent) = nova_win_core::agent::import_legacy(&path, &dir, &names)?;
    let restart_required = {
        let shared = app.state::<Shared>();
        let mut inner = shared.lock();
        let backup = path.with_extension("json.before-import");
        if !backup.exists() {
            std::fs::copy(&path, &backup).map_err(|e| e.to_string())?;
        }
        nova_win_core::agent::atomic_save(&path, &nova_win_core::agent::encode(&config, &agent))?;
        let restart_required = inner.agent.port != agent.port;
        inner.agent = agent;
        inner.view = config.helper_view;
        inner.desired = nova_win_core::mode::Desired {
            mode: config.mode,
            helper_visible: true,
            wallpapers: config.wallpapers.clone(),
        };
        inner.config = config;
        restart_required
    };
    if restart_required {
        app.restart();
    }
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Err(error) = crate::controls::restore(&handle) {
            log!("imported shortcuts: {error}");
        }
        app::reload(&handle);
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_update_status(
    window: WebviewWindow,
    app: AppHandle,
) -> Result<nova_win_core::update::Status, String> {
    only(&window, "setup")?;
    Ok(crate::updates::status(&app))
}

#[tauri::command]
pub async fn agent_check_update(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    only(&window, "setup")?;
    crate::updates::check(&app, false).await
}

#[tauri::command]
pub async fn agent_install_update(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    only(&window, "setup")?;
    crate::updates::install(&app).await
}

#[tauri::command]
pub async fn agent_set_automation(
    window: WebviewWindow,
    app: AppHandle,
    permissions: nova_win_core::agent::AutomationPermissions,
) -> Result<(), String> {
    only(&window, "setup")?;
    if permissions.control && !permissions.view {
        return Err("Zet meekijken aan voordat je bedienen toestaat".into());
    }
    {
        let shared = app.state::<Shared>();
        let mut inner = shared.lock();
        let previous = inner.agent.automation.clone();
        inner.agent.automation = permissions.clone();
        if let Err(error) = inner.try_save() {
            inner.agent.automation = previous;
            return Err(error);
        }
        crate::automation::cancel(&app);
    }
    if !permissions.control || !permissions.view {
        crate::automation::disarm(&app);
    }
    if !permissions.browser {
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || crate::automation::shutdown_browser(&handle))
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
pub async fn agent_set_elevation(
    window: WebviewWindow,
    app: AppHandle,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    only(&window, "setup")?;
    let previous = {
        let shared = app.state::<Shared>();
        let mut inner = shared.lock();
        let old = inner.agent.run_elevated;
        inner.agent.run_elevated = enabled;
        if let Err(error) = inner.try_save() {
            inner.agent.run_elevated = old;
            return Err(error);
        }
        old
    };
    if enabled && !crate::platform::is_elevated() {
        let result = tauri::async_runtime::spawn_blocking(|| crate::platform::request_elevation(std::process::id()))
            .await
            .map_err(|e| e.to_string())?;
        if let Err(error) = result {
            let shared = app.state::<Shared>();
            let mut inner = shared.lock();
            inner.agent.run_elevated = previous;
            inner.try_save()?;
            return Err(error);
        }
        crate::automation::disarm(&app);
        app.exit(0);
    }
    Ok(
        serde_json::json!({"elevated":crate::platform::is_elevated(),"restartRequired":!enabled&&crate::platform::is_elevated()}),
    )
}
