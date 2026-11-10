// NOVA for Windows: one native HTTP agent, helper and living wallpaper.
// A release build has no console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_http;
mod app;
mod app_window;
mod automation;
mod commands;
mod controls;
mod log;
use nova_win_agent::platform;
mod state;
mod tray;
mod updates;
mod webview;
mod win;
mod windows_ops;

fn main() {
    #[cfg(windows)]
    {
        let args: Vec<String> = std::env::args().collect();
        // Started by Windows at logon (Run entry or logon task): never show a UAC prompt then, start in the tray.
        let autostart = nova_win_core::autostart::is_autostart_launch(&args[1..]);
        if args.get(1).is_some_and(|a| a == "--wait-for-pid") {
            let result = args
                .get(2)
                .and_then(|v| v.parse::<u32>().ok())
                .ok_or_else(|| "Ongeldig vorig proces".to_string())
                .and_then(platform::wait_for_parent);
            if let Err(error) = result {
                platform::show_error(&error);
                return;
            }
        } else if (args.len() == 1 || autostart) && !platform::is_elevated() && !platform::instance_running() {
            let configured = std::env::var_os("LOCALAPPDATA")
                .map(std::path::PathBuf::from)
                .and_then(|dir| std::fs::read_to_string(dir.join("NOVA/config.json")).ok())
                .and_then(|text| nova_win_core::agent::decode(&text).ok())
                // No config yet (first start) counts as "elevated by default".
                .is_none_or(|(_, agent)| agent.run_elevated);
            if configured {
                // The verified logon task starts NOVA elevated without a prompt. It always starts in the tray, so a
                // start by hand leaves a note that the elevated copy should open its window.
                if !autostart {
                    win::request_window_on_start(true);
                }
                if win::start_elevated_autostart() {
                    return;
                }
                win::request_window_on_start(false);
                // At logon there is never a UAC prompt: without a valid task NOVA runs unelevated until it is started
                // by hand once (which registers the task again). Refused elevation is not an error either.
                if !autostart && platform::request_elevation(std::process::id()).is_ok() {
                    return;
                }
            }
        }
        win::refresh_run_value();
        let ordinary_start = args.len() == 1 || autostart || args.get(1).is_some_and(|arg| arg == "--wait-for-pid");
        if ordinary_start && !platform::instance_running() && platform::is_elevated() && win::autostart_enabled() {
            if let Err(error) = win::set_autostart(true) {
                crate::log!("Windows startup could not be configured: {error}");
            }
        }

        if args.get(1).is_some_and(|a| a == "--configure-network") {
            let result = args
                .get(2)
                .and_then(|s| s.parse::<u16>().ok())
                .filter(|p| *p > 0)
                .ok_or_else(|| "Ongeldige netwerkopties".to_string())
                .and_then(platform::configure_network);
            if let Err(error) = result {
                platform::show_error(&error);
                std::process::exit(1);
            }
            return;
        }
    }
    app::run();
}
