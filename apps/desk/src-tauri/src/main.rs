// NOVA Desk: the helper and the living wallpaper of NOVA as native Windows windows.
// A release build has no console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod commands;
mod log;
mod state;
mod tray;
mod win;
mod windows_ops;

fn main() {
    app::run();
}
