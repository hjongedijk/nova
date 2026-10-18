//! LAN HTTP transport. Authentication precedes parsing and UI dispatch.
use crate::{app, platform, state::Shared, windows_ops};
use nova_win_core::{
    agent::VERSION,
    args::{Args, WallpaperArg},
    geometry::resolve_display,
    mode::{Mode, WallpaperStyle},
    view::View,
};
use serde_json::{json, Value};
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use tiny_http::{Method, Server};

type Outcome = Result<Value, (u16, String)>;
fn bad(message: &str) -> (u16, String) {
    (400, message.into())
}

pub fn start(app: &AppHandle) -> Result<(), String> {
    let port = app.state::<Shared>().lock().agent.port;
    let server = std::sync::Arc::new(Server::http(("0.0.0.0", port)).map_err(|e| format!("Poort {}: {e}", port))?);
    // Bounded workers let the stop/status routes run while a CDP call is waiting.
    for _ in 0..3 {
        let app = app.clone();
        let server = server.clone();
        std::thread::spawn(move || {
            for request in server.incoming_requests() {
                nova_win_agent::transport::respond(
                    request,
                    |ip, header| app.state::<Shared>().lock().agent.authorize(ip, header),
                    |path, method, body| {
                        if path.starts_with("/v1/desktop/") || path.starts_with("/v1/browser/") {
                            return crate::automation::route(&app, path, body);
                        }
                        let (sender, receiver) = mpsc::sync_channel(1);
                        let handle = app.clone();
                        let path = path.to_owned();
                        let method = method.clone();
                        let deadline = Instant::now() + Duration::from_secs(30);
                        app.run_on_main_thread(move || {
                            if Instant::now() > deadline {
                                return;
                            }
                            let _ = sender.send(route(&handle, &path, &method, body));
                        })
                        .map_err(|_| (503, "NOVA sluit af".into()))?;
                        receiver
                            .recv_timeout(Duration::from_secs(30))
                            .unwrap_or_else(|_| Err((503, "Windows antwoordt niet op tijd".into())))
                    },
                );
            }
        });
    }
    Ok(())
}

fn desktop_state(app: &AppHandle) -> Value {
    let list = windows_ops::monitors(app);
    let state = app.state::<Shared>();
    let inner = state.lock();
    let display = if list.is_empty() {
        0
    } else {
        resolve_display(&list, inner.config.helper_display.as_deref(), 0) + 1
    };
    let displays: Vec<Value> = list
        .iter()
        .enumerate()
        .map(|(i, m)| {
            json!({
                "index": i+1, "name": m.name, "primary": m.primary, "width": m.bounds.w, "height": m.bounds.h,
                "mode": inner.wallpapers.get(&m.name).map(|w| w.style.as_str()).unwrap_or("off")
            })
        })
        .collect();
    json!({"ok": true, "displays": displays, "mode": inner.config.mode.as_str(), "helperDisplay": display, "helperView": inner.view.as_str()})
}

fn display(body: &Value, app: &AppHandle) -> Result<u32, (u16, String)> {
    let n = body
        .get("display")
        .map(|v| v.as_u64().ok_or_else(|| bad("Ongeldig scherm")))
        .transpose()?
        .unwrap_or(0);
    if n > windows_ops::monitors(app).len() as u64 {
        return Err(bad("Scherm bestaat niet"));
    }
    Ok(n as u32)
}

fn route(app: &AppHandle, path: &str, method: &Method, body: Value) -> Outcome {
    match path {
        "/v1/status" => {
            let mut result = desktop_state(app);
            let state = app.state::<Shared>();
            let inner = state.lock();
            result["hostname"] = json!(std::env::var("COMPUTERNAME").unwrap_or_default());
            result["user"] = json!(std::env::var("USERNAME").unwrap_or_default());
            result["uptimeHours"] = json!(sysinfo::System::uptime() as f64 / 3600.0);
            result["features"] = json!(["wallpaper", "helper", "desktop", "browser"]);
            result["agent"] = json!(VERSION);
            result["helperWarnings"] = json!(inner.hotkey_warnings);
            result["agentPaused"] = json!(inner.paused);
            result["helperOpen"] = json!(app
                .get_webview_window(windows_ops::HELPER)
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(false));
            result["apps"] = json!(inner.agent.apps.keys().collect::<Vec<_>>());
            result["running"] = json!(platform::running_apps(&inner.agent.apps));
            Ok(result)
        }
        "/v1/displays" => Ok(desktop_state(app)),
        "/v1/mode" | "/v1/wallpaper" => {
            let display = display(&body, app)?;
            let mode = body["mode"].as_str().ok_or_else(|| bad("Modus ontbreekt"))?;
            let mut args = Args {
                display: if path == "/v1/mode" { Some(display) } else { None },
                ..Args::default()
            };
            if let Some(url) = body.get("url") {
                args.url = Some(
                    nova_win_core::nav::normalize_origin(url.as_str().ok_or_else(|| bad("Ongeldig NOVA-adres"))?)
                        .map_err(|e| bad(&e.to_string()))?,
                );
            }
            if path == "/v1/mode" {
                args.mode = Some(Mode::parse(mode).ok_or_else(|| bad("Onbekende modus"))?);
                args.show = true;
                // API display 0 explicitly selects primary; CLI display 0 preserves preference.
                if display == 0 {
                    app.state::<Shared>().lock().config.helper_display = None;
                }
            } else {
                let style = if mode == "off" {
                    None
                } else {
                    Some(WallpaperStyle::parse(mode).ok_or_else(|| bad("Onbekende wallpaper"))?)
                };
                args.wallpapers.push(WallpaperArg { display, style });
            }
            app::handle_args(app, args);
            Ok(desktop_state(app))
        }
        "/v1/helper/size" => {
            let view = match body.get("view") {
                Some(v) => View::parse(v.as_str().ok_or_else(|| bad("Ongeldige weergave"))?)
                    .ok_or_else(|| bad("Onbekende weergave"))?,
                None => {
                    if body["expanded"].as_bool().unwrap_or(false) {
                        View::Chat
                    } else {
                        View::Compact
                    }
                }
            };
            let hidden = body["hidden"].as_bool().unwrap_or(false);
            app::handle_args(
                app,
                Args {
                    view: Some(view),
                    hidden,
                    ..Args::default()
                },
            );
            Ok(json!({"ok":true,"view":view.as_str(),"hidden":hidden,"expanded":view != View::Compact}))
        }
        "/v1/helper/notify" => {
            let event = &body["event"];
            let text = event.to_string();
            if event["seq"]
                .as_u64()
                .filter(|s| *s > 0 && *s <= 9_007_199_254_740_991)
                .is_none()
                || event["title"].as_str().filter(|s| s.len() <= 240).is_none()
                || nova_win_core::script::notification_script(&text).is_err()
            {
                return Err(bad("Ongeldige melding"));
            }
            let reason = {
                let shared = app.state::<Shared>();
                let inner = shared.lock();
                if inner.paused {
                    Some("paused")
                } else if !inner.config.mode.wants_helper() {
                    Some("helper-disabled")
                } else {
                    None
                }
            };
            if let Some(reason) = reason {
                return Ok(json!({"ok":true,"delivered":false,"reason":reason,"seq":event["seq"]}));
            }
            app::handle_args(
                app,
                Args {
                    notify: Some(text),
                    ..Args::default()
                },
            );
            if app.get_webview_window(windows_ops::HELPER).is_none() {
                return Err((503, "Helper kon niet worden geopend".into()));
            }
            Ok(json!({"ok":true,"delivered":true,"seq":event["seq"]}))
        }
        "/v1/helper/preferences" => {
            if *method == Method::Post {
                crate::controls::set(app, &body).map_err(|e| bad(&e))?;
            }
            Ok(json!({"ok":true,"preferences":crate::controls::preferences(app)}))
        }
        "/v1/open-app" | "/v1/close-app" => {
            let entry = {
                let shared = app.state::<Shared>();
                let inner = shared.lock();
                inner
                    .agent
                    .apps
                    .get(body["app"].as_str().ok_or_else(|| bad("App ontbreekt"))?)
                    .cloned()
                    .ok_or_else(|| (403, "App staat niet in de lijst met toegestane apps".into()))?
            };
            if path == "/v1/open-app" {
                platform::open(&entry.path).map_err(|e| (500, e))?;
                Ok(json!({"ok":true}))
            } else {
                let closed = platform::close_app(
                    entry
                        .process
                        .as_deref()
                        .ok_or_else(|| bad("Deze app kan niet worden gesloten"))?,
                )
                .map_err(|e| (500, e))?;
                Ok(json!({"ok":true,"closed":closed}))
            }
        }
        "/v1/open-url" => {
            let raw = body["url"].as_str().ok_or_else(|| bad("URL ontbreekt"))?;
            let url = url::Url::parse(raw).map_err(|_| bad("Ongeldige URL"))?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err(bad("Alleen HTTP(S)-adressen zonder inloggegevens toegestaan"));
            }
            platform::open(url.as_str()).map_err(|e| (500, e))?;
            Ok(json!({"ok":true}))
        }
        "/v1/lock" => {
            platform::lock().map_err(|e| (500, e))?;
            Ok(json!({"ok":true}))
        }
        "/v1/desktop/status" => {
            Ok(json!({"ok":true,"enabled":false,"control":false,"paused":false,"version":VERSION,"displays":[]}))
        }
        "/v1/browser/status" => {
            Ok(json!({"ok":true,"enabled":false,"running":false,"browser":"edge","headless":false,"tabs":[]}))
        }
        _ if path.starts_with("/v1/desktop/")
            || path.starts_with("/v1/browser/")
            || matches!(path, "/v1/helper-debug" | "/v1/wallpaper-debug") =>
        {
            Err((501, "Nog niet beschikbaar in deze versie van NOVA voor Windows".into()))
        }
        _ => Err((404, "Onbekende route".into())),
    }
}
