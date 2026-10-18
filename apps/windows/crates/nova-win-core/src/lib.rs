//! Pure logic of NOVA Desk. Nothing in this crate touches a window, the registry or the network, so all of it
//! is unit-tested on any OS (`cargo test -p nova-win-core`). The thin Windows glue lives in `src-tauri`.

pub mod args;
pub mod autostart;
pub mod config;
pub mod desktop;
pub mod geometry;
pub mod mode;
pub mod nav;
pub mod script;
pub mod view;

pub mod agent;

pub mod update;
