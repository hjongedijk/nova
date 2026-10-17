//! Start-up, single instance, arguments from a second start, and keeping the windows equal to what is wanted.

use crate::state::{Inner, Shared};
use crate::windows_ops::{
    apply_layout, close_wallpaper, create_helper, create_wallpaper, fingerprint, grant_origin, monitors, HELPER,
};
use crate::{commands, log, tray};
use nova_desk_core::args::{self, Args};
use nova_desk_core::config::{self, DeskConfig};
use nova_desk_core::mode::{apply_event, reconcile, Action, Desired, Event, Running};
use nova_desk_core::script::{action_script, notification_script};
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

pub fn run() {
    let first = args::parse(std::env::args().skip(1));
    let app = tauri::Builder::default()
        // Must be the first plugin: a second start hands its arguments to the running instance and ends.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let handle = app.clone();
            match args::parse(argv.into_iter().skip(1)) {
                Ok(parsed) => {
                    let again = handle.clone();
                    let _ = handle.run_on_main_thread(move || handle_args(&again, parsed));
                }
                Err(error) => log!("ignored the arguments of a second start: {error}"),
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::desk_info,
            commands::desk_set_display,
            commands::desk_set_view,
            commands::desk_hide_helper,
            commands::desk_set_fullscreen,
            commands::desk_set_url,
        ])
        .setup(move |app| {
            let parsed = match first {
                Ok(parsed) => parsed,
                Err(error) => {
                    eprintln!("NOVA Desk: {error}");
                    Args::default()
                }
            };
            init(app.handle(), parsed);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("NOVA Desk could not start");
    app.run(|_app, event| {
        // A tray app: with every window hidden or closed it keeps running until "Afsluiten".
        if let RunEvent::ExitRequested { code, api, .. } = event {
            if code.is_none() {
                api.prevent_exit();
            }
        }
    });
}

fn data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("NOVA")
}

fn load_config(path: &PathBuf) -> DeskConfig {
    let Ok(text) = std::fs::read_to_string(path) else {
        return DeskConfig::default();
    };
    match config::parse(&text) {
        Ok((config, warnings)) => {
            for warning in warnings {
                log!("desk.json: {warning}");
            }
            config
        }
        Err(error) => {
            // Keep the broken file for the user to look at, and start clean instead of not starting at all.
            log!("{error}; the file is kept as desk.json.bad");
            let _ = std::fs::rename(path, path.with_extension("json.bad"));
            DeskConfig::default()
        }
    }
}

fn init(app: &AppHandle, args: Args) {
    let dir = data_dir(app);
    let _ = std::fs::create_dir_all(&dir);
    crate::log::init(dir.join("desk.log"));
    let config_path = dir.join("desk.json");
    let mut config = load_config(&config_path);
    let list = monitors(app);
    let names: Vec<String> = list.iter().map(|m| m.name.clone()).collect();
    for warning in config.apply_args(&args, &names) {
        log!("{warning}");
    }
    let desired = Desired {
        mode: config.mode,
        helper_visible: !args.hide,
        wallpapers: config.wallpapers.clone(),
    };
    // The very first start has no login yet: the reverse proxy's login page then appears in the helper window, so the
    // window starts large enough for it (the page chooses its own size once NOVA itself has loaded).
    let first_run = !dir.join("desk-profile").exists();
    let view = if first_run {
        nova_desk_core::view::View::Chat
    } else {
        config.helper_view
    };
    app.manage(Shared {
        inner: Mutex::new(Inner {
            config,
            config_path,
            profile_dir: dir.join("desk-profile"),
            desired,
            view,
            hidden: false,
            fullscreen: false,
            wallpapers: BTreeMap::new(),
            granted: HashSet::new(),
            ignore_moves_until: Instant::now(),
            last_move: Instant::now(),
            commit_pending: false,
            monitor_fingerprint: fingerprint(&list),
        }),
    });
    app.state::<Shared>().lock().save();
    if let Err(error) = tray::build(app) {
        log!("could not create the tray icon: {error}");
    }
    log!(
        "NOVA Desk {} started with {} display(s)",
        env!("CARGO_PKG_VERSION"),
        list.len()
    );
    if args.quit {
        app.exit(0);
        return;
    }
    start(app);
    watch_monitors(app);
}

/// With an address: show what the mode asks. Without: the one-time setup page.
pub fn start(app: &AppHandle) {
    let url = app.state::<Shared>().lock().config.url.clone();
    match url {
        Some(origin) => {
            grant_origin(app, &origin);
            apply(app);
        }
        None => open_setup(app),
    }
    tray::rebuild(app);
}

fn open_setup(app: &AppHandle) {
    if app.get_webview_window("setup").is_some() {
        return;
    }
    // Its own browser profile: it must not share one with the NOVA windows, which start WebView2 with other arguments.
    let profile = app.state::<Shared>().lock().profile_dir.with_file_name("setup-profile");
    let built = WebviewWindowBuilder::new(app, "setup", WebviewUrl::App("index.html".into()))
        .title("NOVA Desk")
        .inner_size(520.0, 420.0)
        .resizable(false)
        .data_directory(profile)
        .on_navigation(|url| url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost"))
        .build();
    if let Err(error) = built {
        log!("could not open the setup window: {error}");
    }
}

pub fn running(app: &AppHandle) -> Running {
    let helper = app.get_webview_window(HELPER);
    Running {
        helper_exists: helper.is_some(),
        helper_shown: helper.as_ref().and_then(|w| w.is_visible().ok()).unwrap_or(false),
        wallpapers: app.state::<Shared>().lock().wallpapers.clone(),
    }
}

/// Makes the windows match what is wanted. Safe to call at any time.
pub fn apply(app: &AppHandle) {
    let shared = app.state::<Shared>();
    let (desired, has_url) = {
        let inner = shared.lock();
        (inner.desired.clone(), inner.config.url.is_some())
    };
    if !has_url {
        return;
    }
    let connected: Vec<String> = monitors(app).into_iter().map(|m| m.name).collect();
    for action in reconcile(&desired, &connected, &running(app)) {
        match action {
            Action::CloseWallpaper { monitor } => close_wallpaper(app, &monitor),
            Action::CreateWallpaper { monitor, spec } => create_wallpaper(app, &monitor, spec),
            Action::ShowHelper => {
                if let Some(window) = create_helper(app) {
                    apply_layout(app);
                    let _ = window.show();
                    let _ = window.set_always_on_top(true);
                }
            }
            Action::HideHelper => {
                if let Some(window) = app.get_webview_window(HELPER) {
                    let _ = window.hide();
                }
            }
            Action::CloseHelper => {
                if let Some(window) = app.get_webview_window(HELPER) {
                    let _ = window.destroy();
                }
            }
        }
    }
}

/// Closes every NOVA window (the address changed: the old pages may not stay).
fn close_all(app: &AppHandle) {
    for monitor in app
        .state::<Shared>()
        .lock()
        .wallpapers
        .keys()
        .cloned()
        .collect::<Vec<_>>()
    {
        close_wallpaper(app, &monitor);
    }
    if let Some(window) = app.get_webview_window(HELPER) {
        let _ = window.destroy();
    }
}

pub fn helper_hidden_by_user(app: &AppHandle) {
    {
        let shared = app.state::<Shared>();
        let mut inner = shared.lock();
        inner.desired = apply_event(inner.desired.clone(), Event::HideHelper);
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        apply(&handle);
        tray::rebuild(&handle);
    });
}

/// Arguments from a second start (the agent steers NOVA Desk this way) or a tray choice.
pub fn handle_args(app: &AppHandle, args: Args) {
    if args.quit {
        app.exit(0);
        return;
    }
    let list = monitors(app);
    let names: Vec<String> = list.iter().map(|m| m.name.clone()).collect();
    let shared = app.state::<Shared>();
    let url_changed = {
        let mut inner = shared.lock();
        let before = inner.config.url.clone();
        for warning in inner.config.apply_args(&args, &names) {
            log!("{warning}");
        }
        let mut desired = inner.desired.clone();
        if let Some(mode) = args.mode {
            desired = apply_event(desired, Event::SetMode(mode));
        }
        desired.wallpapers = inner.config.wallpapers.clone();
        if args.show {
            desired = apply_event(desired, Event::ShowHelper);
        }
        if args.hide {
            desired = apply_event(desired, Event::HideHelper);
        }
        inner.desired = desired;
        if let Some(view) = args.view {
            inner.view = view;
            inner.hidden = args.hidden;
        }
        inner.save();
        before != inner.config.url
    };
    if url_changed {
        close_all(app);
        let origin = shared.lock().config.url.clone();
        if let Some(origin) = origin {
            grant_origin(app, &origin);
        }
        if app.get_webview_window("setup").is_some() {
            if let Some(setup) = app.get_webview_window("setup") {
                let _ = setup.destroy();
            }
        }
    }
    if shared.lock().config.url.is_none() {
        open_setup(app);
        return;
    }
    // An action or a notification needs the helper on screen, in the modes that have one.
    let wants_helper = args.action.is_some() || args.notify.is_some();
    if wants_helper {
        let mut inner = shared.lock();
        if inner.desired.mode.wants_helper() && !inner.desired.helper_visible {
            inner.desired = apply_event(inner.desired.clone(), Event::ShowHelper);
        }
    }
    apply(app);
    apply_layout(app);
    if let Some(window) = app.get_webview_window(HELPER) {
        if let Some(action) = &args.action {
            if let Ok(script) = action_script(action, args.paused) {
                let _ = window.eval(script);
            }
        }
        if let Some(json) = &args.notify {
            match notification_script(json) {
                Ok(script) => {
                    let _ = window.eval(script);
                }
                Err(error) => log!("notification refused: {error:?}"),
            }
        }
    }
    tray::rebuild(app);
}

/// Displays come and go (a monitor is unplugged, the resolution or scaling changes): check now and then, and make
/// the helper and the wallpaper windows follow, so the helper is never off-screen.
fn watch_monitors(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(5));
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let list = monitors(&handle);
            let now = fingerprint(&list);
            let changed = {
                let shared = handle.state::<Shared>();
                let mut inner = shared.lock();
                let changed = inner.monitor_fingerprint != now;
                inner.monitor_fingerprint = now;
                changed
            };
            if changed {
                log!("the displays changed");
                // Wallpaper windows keep a fixed size: build them again on the new geometry.
                for monitor in handle
                    .state::<Shared>()
                    .lock()
                    .wallpapers
                    .keys()
                    .cloned()
                    .collect::<Vec<_>>()
                {
                    close_wallpaper(&handle, &monitor);
                }
                apply(&handle);
                apply_layout(&handle);
                tray::rebuild(&handle);
            }
        });
    });
}
