//! Bounded JSON protocol shared by the native app and transport tests.
use crate::live::{self, LatestFrame, Stop, StreamOptions, StreamPermit};
use serde_json::{json, Value};
use std::{io::Read, net::IpAddr, sync::Arc};
use tiny_http::{Header, Method, Request, Response};
pub const BODY_LIMIT: usize = 16 * 1024;
pub type Outcome = Result<Value, (u16, String)>;

/// What a live route hands to the writer: the frame slot, the producer's stop switch and the owner's pause check.
pub struct LiveSource {
    pub slot: Arc<LatestFrame>,
    pub stop: Stop,
    pub alive: Box<dyn Fn() -> bool + Send>,
}

/// `/v1/stream/browser` and `/v1/stream/desktop`: long-lived MJPEG instead of one JSON reply.
pub fn is_stream(request: &Request) -> bool {
    request.url().starts_with("/v1/stream/")
}

fn json_reply(request: Request, status: u16, body: Value) {
    let response = Response::from_string(body.to_string())
        .with_status_code(status)
        .with_header(Header::from_bytes("Content-Type", "application/json; charset=utf-8").unwrap())
        .with_header(Header::from_bytes("Cache-Control", "no-store").unwrap())
        .with_header(Header::from_bytes("Connection", "close").unwrap());
    let _ = request.respond(response);
}

/// Same pairing-token check as every other route, then frames until the viewer leaves, the owner pauses or the
/// stream reaches its time limit. At most `live::MAX_STREAMS` at once.
pub fn respond_stream(
    request: Request,
    authorize: impl FnOnce(IpAddr, Option<&str>) -> Result<(), u16>,
    open: impl FnOnce(&str, StreamOptions) -> Result<LiveSource, (u16, String)>,
) {
    let auth = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Authorization"))
        .map(|h| h.value.as_str());
    let allowed = request
        .remote_addr()
        .ok_or(403)
        .and_then(|addr| authorize(addr.ip(), auth));
    let url = request.url().to_string();
    let (path, query) = url.split_once('?').unwrap_or((url.as_str(), ""));
    let started = allowed
        .map_err(|code| (code, "Niet toegestaan".to_string()))
        .and_then(|_| {
            if *request.method() != Method::Get {
                return Err((405, "Onjuiste HTTP-methode".into()));
            }
            let kind = match path {
                "/v1/stream/browser" => "browser",
                "/v1/stream/desktop" => "desktop",
                _ => return Err((404, "Onbekende route".into())),
            };
            let options = StreamOptions::parse(query)?;
            let permit = StreamPermit::acquire().ok_or((429, "Te veel live beelden tegelijk".to_string()))?;
            open(kind, options).map(|source| (permit, source))
        });
    match started {
        Err((status, error)) => json_reply(request, status, json!({"ok":false,"error":error})),
        Ok((_permit, source)) => {
            let mut writer = request.into_writer();
            let _ = live::pump(
                &mut *writer,
                &source.slot,
                &*source.alive,
                live::MAX_STREAM,
                live::STREAM_BYTES_PER_SECOND,
            );
            source.stop.stop();
        }
    }
}

pub fn respond(
    mut request: Request,
    authorize: impl FnOnce(IpAddr, Option<&str>) -> Result<(), u16>,
    dispatch: impl FnOnce(&str, &Method, Value) -> Outcome,
) {
    let auth = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Authorization"))
        .map(|h| h.value.as_str());
    let allowed = request
        .remote_addr()
        .ok_or(403)
        .and_then(|addr| authorize(addr.ip(), auth));
    let result = allowed.map_err(|code| (code, "Niet toegestaan".into())).and_then(|_| {
        let path = request.url().split('?').next().unwrap_or("").to_string();
        let method = request.method().clone();
        let read = matches!(
            path.as_str(),
            "/v1/status"
                | "/v1/displays"
                | "/v1/helper-debug"
                | "/v1/wallpaper-debug"
                | "/v1/browser/status"
                | "/v1/desktop/status"
                | "/v1/desktop/windows"
                | "/v1/desktop/screenshot"
        );
        let preferences = path == "/v1/helper/preferences";
        let known = read
            || preferences
            || matches!(
                path.as_str(),
                "/v1/mode"
                    | "/v1/wallpaper"
                    | "/v1/helper/size"
                    | "/v1/helper/notify"
                    | "/v1/open-app"
                    | "/v1/close-app"
                    | "/v1/open-url"
                    | "/v1/lock"
            )
            || path.starts_with("/v1/desktop/")
            || path.starts_with("/v1/browser/");
        if !known {
            return Err((404, "Onbekende route".into()));
        }
        let expected = if read { Method::Get } else { Method::Post };
        if method != expected && !(preferences && method == Method::Get) {
            return Err((405, "Onjuiste HTTP-methode".into()));
        }
        if request.body_length().unwrap_or(0) > BODY_LIMIT {
            return Err((413, "Bericht te groot".into()));
        }
        let value = if method == Method::Get {
            let mut value = json!({});
            if path == "/v1/desktop/screenshot" {
                let url = url::Url::parse(&format!("http://localhost{}", request.url()))
                    .map_err(|_| (400, "Ongeldige schermparameters".into()))?;
                for (key, raw) in url.query_pairs() {
                    if !matches!(key.as_ref(), "display" | "maxWidth") || value.get(key.as_ref()).is_some() {
                        return Err((400, "Onbekende of dubbele schermparameter".into()));
                    }
                    let number = raw
                        .parse::<u32>()
                        .map_err(|_| (400, "Ongeldige schermparameter".into()))?;
                    value[key.as_ref()] = json!(number);
                }
            }
            value
        } else {
            if request.body_length().is_none() {
                return Err((411, "Content-Length vereist".into()));
            }
            let mut body = String::new();
            request
                .as_reader()
                .take(BODY_LIMIT as u64 + 1)
                .read_to_string(&mut body)
                .map_err(|_| (400, "Ongeldig bericht".into()))?;
            if body.len() > BODY_LIMIT {
                return Err((413, "Bericht te groot".into()));
            }
            let value: Value = serde_json::from_str(&body).map_err(|_| (400, "Ongeldige JSON".into()))?;
            if !value.is_object() {
                return Err((400, "JSON-object vereist".into()));
            }
            value
        };
        dispatch(&path, &method, value)
    });
    let (status, body) = match result {
        Ok(v) => (200, v),
        Err((code, error)) => (code, json!({"ok":false,"error":error})),
    };
    json_reply(request, status, body);
}

#[cfg(test)]
mod tests {
    use super::*;
    use nova_win_core::agent::AgentConfig;
    use std::{
        io::Write,
        net::TcpStream,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::Duration,
    };
    fn request(method: &str, path: &str, token: Option<&str>, body: &str) -> (String, usize) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let address = server.server_addr().to_ip().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let mut config = AgentConfig::fresh().unwrap();
        config.token = "abcdefghijklmnopqrstuvwxyz".into();
        let worker = std::thread::spawn(move || {
            respond(
                server.recv().unwrap(),
                |ip, header| config.authorize(ip, header),
                |path, _, body| {
                    count.fetch_add(1, Ordering::SeqCst);
                    Ok(json!({"ok":true,"path":path,"body":body}))
                },
            )
        });
        let mut stream = TcpStream::connect(address).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        write!(
            stream,
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: {}\r\n{}\r\n{body}",
            body.len(),
            token.map(|v| format!("Authorization: {v}\r\n")).unwrap_or_default()
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        worker.join().unwrap();
        (response, calls.load(Ordering::SeqCst))
    }
    #[test]
    fn only_the_pairing_token_is_checked_before_dispatch() {
        for token in [None, Some("Bearer wrong"), Some("abcdefghijklmnopqrstuvwxyz")] {
            let (response, calls) = request("POST", "/v1/lock", token, "{}");
            assert!(response.starts_with("HTTP/1.1 401"), "{response}");
            assert_eq!(calls, 0);
        }
        let (response, calls) = request("POST", "/v1/lock", Some("Bearer abcdefghijklmnopqrstuvwxyz"), "{}");
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert_eq!(calls, 1);
    }
    #[test]
    fn validates_methods_json_and_size_before_dispatch() {
        for (method, path, body, status) in [
            ("GET", "/v1/lock", "{}", 405),
            ("POST", "/v1/lock", "{", 400),
            ("POST", "/v1/lock", "[]", 400),
            ("POST", "/v1/lock", &"x".repeat(BODY_LIMIT + 1), 413),
        ] {
            let (response, calls) = request(method, path, Some("Bearer abcdefghijklmnopqrstuvwxyz"), body);
            assert!(response.starts_with(&format!("HTTP/1.1 {status}")), "{response}");
            assert_eq!(calls, 0);
        }
    }
    #[test]
    fn accepted_json_reaches_dispatch_and_responses_are_not_cached() {
        let (response, calls) = request(
            "POST",
            "/v1/mode",
            Some("Bearer abcdefghijklmnopqrstuvwxyz"),
            r#"{"mode":"helper"}"#,
        );
        assert!(response.starts_with("HTTP/1.1 200"));
        assert_eq!(calls, 1);
        assert!(response.to_lowercase().contains("cache-control: no-store"));
        assert!(response.contains(r#""body":{"mode":"helper"}"#));
        assert!(!response.contains("abcdefghijklmnopqrstuvwxyz"));
    }
    #[test]
    fn desktop_reads_preserve_the_existing_get_contract() {
        for path in [
            "/v1/desktop/windows",
            "/v1/desktop/screenshot?display=1",
            "/v1/helper/preferences",
        ] {
            let (response, calls) = request("GET", path, Some("Bearer abcdefghijklmnopqrstuvwxyz"), "");
            assert!(response.starts_with("HTTP/1.1 200"), "{response}");
            assert_eq!(calls, 1);
        }
        let (response, calls) = request("GET", "/unknown", Some("Bearer abcdefghijklmnopqrstuvwxyz"), "");
        assert!(response.starts_with("HTTP/1.1 404"));
        assert_eq!(calls, 0);
    }
    fn stream(path: &str, token: Option<&str>) -> (String, usize) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let address = server.server_addr().to_ip().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let mut config = AgentConfig::fresh().unwrap();
        config.token = "abcdefghijklmnopqrstuvwxyz".into();
        let worker = std::thread::spawn(move || {
            let request = server.recv().unwrap();
            assert!(is_stream(&request));
            respond_stream(
                request,
                |ip, header| config.authorize(ip, header),
                |kind, options| {
                    count.fetch_add(1, Ordering::SeqCst);
                    let slot = LatestFrame::new();
                    slot.publish(
                        vec![0xff, 0xd8, 0xff, 0xd9],
                        2,
                        2,
                        format!(r#"{{"kind":"{kind}","fps":{}}}"#, options.fps),
                    );
                    slot.close();
                    Ok(LiveSource {
                        slot,
                        stop: Stop::default(),
                        alive: Box::new(|| true),
                    })
                },
            )
        });
        let mut stream = TcpStream::connect(address).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        write!(
            stream,
            "GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n{}\r\n",
            token.map(|v| format!("Authorization: {v}\r\n")).unwrap_or_default()
        )
        .unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).unwrap();
        worker.join().unwrap();
        (
            String::from_utf8_lossy(&bytes).into_owned(),
            calls.load(Ordering::SeqCst),
        )
    }
    #[test]
    fn live_streams_need_the_pairing_token_and_valid_options() {
        let (response, calls) = stream("/v1/stream/desktop", None);
        assert!(response.starts_with("HTTP/1.1 401"), "{response}");
        assert_eq!(calls, 0);
        let token = Some("Bearer abcdefghijklmnopqrstuvwxyz");
        let (response, calls) = stream("/v1/stream/desktop?fps=99&fps=1", token);
        assert!(response.starts_with("HTTP/1.1 400"), "{response}");
        assert_eq!(calls, 0);
        let (response, calls) = stream("/v1/stream/other", token);
        assert!(response.starts_with("HTTP/1.1 404"), "{response}");
        assert_eq!(calls, 0);
        let (response, calls) = stream("/v1/stream/browser?fps=99", token);
        assert_eq!(calls, 1);
        assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
        assert!(response.contains("multipart/x-mixed-replace; boundary=novaframe"));
        assert!(response.contains(r#"X-Nova-Meta: {"kind":"browser","fps":30}"#));
        assert!(response.ends_with("--novaframe--\r\n"));
    }
    #[test]
    fn screenshot_query_is_validated_and_forwarded() {
        let token = Some("Bearer abcdefghijklmnopqrstuvwxyz");
        let (response, calls) = request("GET", "/v1/desktop/screenshot?display=2&maxWidth=960", token, "");
        assert_eq!(calls, 1);
        assert!(response.contains(r#""body":{"display":2,"maxWidth":960}"#));
        for path in [
            "/v1/desktop/screenshot?display=-1",
            "/v1/desktop/screenshot?display=1&display=2",
            "/v1/desktop/screenshot?unknown=1",
        ] {
            let (response, calls) = request("GET", path, token, "");
            assert!(response.starts_with("HTTP/1.1 400"));
            assert_eq!(calls, 0);
        }
    }
}
