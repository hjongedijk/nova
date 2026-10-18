// NOVA for Windows: one native HTTP agent, helper and living wallpaper.
// A release build has no console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_http;
mod app;
mod commands;
mod controls;
mod log;
use nova_win_agent::platform;
mod state;
mod tray;
mod updates;
mod win;
mod windows_ops;

fn main() {
    #[cfg(windows)]
    {
        let args: Vec<String> = std::env::args().collect();
        if args.get(1).is_some_and(|a| a == "--configure-network") {
            let result = args
                .get(2)
                .and_then(|s| s.parse::<u16>().ok())
                .filter(|p| *p > 0)
                .zip(args.get(3))
                .ok_or_else(|| "Ongeldige netwerkopties".to_string())
                .and_then(|(port, source)| platform::configure_network(port, source));
            if let Err(error) = result {
                platform::show_error(&error);
                std::process::exit(1);
            }
            return;
        }
    }
    app::run();
}
