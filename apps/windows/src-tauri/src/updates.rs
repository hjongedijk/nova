//! Signed GitHub updates. Only the local settings window can request installation.
use crate::{app, log, state::Shared, tray};
use nova_win_core::update::{Phase, Status};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

pub struct Updates(pub Mutex<Inner>);
pub struct Inner {
    pub status: Status,
    candidate: Option<Update>,
    last_emit: Instant,
    last_announced: Option<String>,
}

pub fn init(app: &AppHandle) {
    app.manage(Updates(Mutex::new(Inner {
        status: Status::new(app.package_info().version.to_string()),
        candidate: None,
        last_emit: Instant::now(),
        last_announced: None,
    })));
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(20));
        loop {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = check(&handle, true).await;
            });
            std::thread::sleep(Duration::from_secs(6 * 60 * 60));
        }
    });
}

pub fn status(app: &AppHandle) -> Status {
    app.state::<Updates>()
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .status
        .clone()
}

fn publish(app: &AppHandle) {
    let _ = app.emit_to("setup", "nova-update-state", status(app));
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || tray::rebuild(&handle));
}

fn fail(app: &AppHandle, message: &str) {
    {
        let state = app.state::<Updates>();
        let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
        inner.status.failed(message);
        inner.candidate = None;
    }
    publish(app);
}

pub async fn check(app: &AppHandle, automatic: bool) -> Result<(), String> {
    {
        let state = app.state::<Updates>();
        let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
        inner.status.begin_check()?;
        inner.candidate = None;
    }
    publish(app);
    let result = async {
        let mut builder = app.updater_builder().timeout(Duration::from_secs(30));
        // Keep an installed or portable app in its current folder. NSIS /D must be the last argument.
        if let Some(directory) = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_owned()))
        {
            let mut install_dir = std::ffi::OsString::from("/D=");
            install_dir.push(directory);
            builder = builder.installer_arg(install_dir);
        }
        builder.build()?.check().await
    }
    .await;
    match result {
        Ok(mut candidate) => {
            if let Some(update) = candidate.as_mut() {
                update.timeout = Some(Duration::from_secs(5 * 60));
            }
            let announce = {
                let state = app.state::<Updates>();
                let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
                let version = candidate.as_ref().map(|u| u.version.clone());
                let announce = automatic && version.is_some() && version != inner.last_announced;
                inner.status.checked(candidate.as_ref().map(|u| {
                    (
                        u.version.clone(),
                        u.body.as_ref().map(|s| s.chars().take(2000).collect()),
                    )
                }));
                inner.candidate = candidate;
                if announce {
                    inner.last_announced = version;
                }
                announce
            };
            if announce {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || app::open_setup(&handle));
            }
            publish(app);
            Ok(())
        }
        Err(error) => {
            log!("update check failed: {error}");
            let message = "Updatecontrole mislukt. Controleer je internetverbinding of probeer later opnieuw.";
            fail(app, message);
            Err(message.into())
        }
    }
}

pub async fn install(app: &AppHandle) -> Result<(), String> {
    let update = {
        let state = app.state::<Updates>();
        let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
        if inner.candidate.is_none() {
            return Err("Controleer eerst op updates".into());
        }
        inner.status.begin_install()?;
        inner.candidate.take().expect("candidate checked while locked")
    };
    publish(app);
    let result = async {
        let progress_app = app.clone();
        // download() verifies the pinned public-key signature before returning bytes.
        let bytes = update
            .download(
                move |chunk, total| {
                    let emit = {
                        let state = progress_app.state::<Updates>();
                        let mut inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
                        inner.status.downloaded = inner.status.downloaded.saturating_add(chunk as u64);
                        inner.status.total = total;
                        let emit = inner.last_emit.elapsed() >= Duration::from_millis(200);
                        if emit {
                            inner.last_emit = Instant::now();
                        }
                        emit
                    };
                    if emit {
                        let _ = progress_app.emit_to("setup", "nova-update-state", status(&progress_app));
                    }
                },
                || {},
            )
            .await
            .map_err(|_| "De update kon niet worden gedownload of de handtekening klopt niet")?;
        // Preserve the latest settings, including changes made while the download was running.
        app.state::<Shared>()
            .lock()
            .try_save()
            .map_err(|_| "Instellingen konden niet worden opgeslagen; update gestopt")?;
        {
            let state = app.state::<Updates>();
            state.0.lock().unwrap_or_else(|e| e.into_inner()).status.phase = Phase::Installing;
        }
        publish(app);
        // On Windows the plugin hands off to NSIS and exits only after launching the installer.
        update
            .install(bytes)
            .map_err(|_| "Windows kon de update niet installeren")?;
        Ok::<(), &str>(())
    }
    .await;
    match result {
        Ok(()) => {
            app.restart();
        }
        Err(message) => {
            fail(app, message);
            Err(message.into())
        }
    }
}
