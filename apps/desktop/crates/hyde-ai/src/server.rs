//! Local HTTP server for the UI. It binds to 127.0.0.1 only, checks the Host header
//! (DNS rebinding) and requires a per-session token on every API call (cross-site requests).

use crate::agent::{self, Shared};
use crate::config::AiConfig;
use crate::hydecode;
use crate::llm::{self, PROVIDERS};
use crate::tools;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::Arc;
use tiny_http::{Header, Method, Request, Response, Server};

const INDEX: &str = include_str!("../ui/index.html");
const APP_JS: &str = include_str!("../ui/app.js");
const STYLE: &str = include_str!("../ui/style.css");
const ICON: &str = include_str!("../ui/icon.svg");
const MAX_BODY: u64 = 64 * 1024;

pub fn session_token() -> String {
    let mut bytes = [0u8; 24];
    let filled = std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .is_ok();
    if !filled {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
            ^ (std::process::id() as u128) << 64;
        for (i, byte) in bytes.iter_mut().enumerate() {
            *byte = (seed >> ((i % 16) * 8)) as u8 ^ (i as u8).wrapping_mul(31);
        }
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}

/// Opens the UI in a chromeless app window when a Chromium browser exists, else the default browser.
pub fn open_ui(port: u16) {
    let target = url(port);
    for browser in [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "brave-browser",
        "microsoft-edge",
    ] {
        if let Some(path) = tools::which(browser) {
            let spawned = Command::new(path)
                .arg(format!("--app={target}"))
                .arg("--window-size=1180,820")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
            if spawned.is_ok() {
                return;
            }
        }
    }
    if tools::open_url(&target).is_err() {
        println!("Open {target} in your browser.");
    }
}

pub fn serve(shared: Arc<Shared>, port: u16, open: bool) -> Result<(), String> {
    let server = match Server::http(("127.0.0.1", port)) {
        Ok(server) => server,
        Err(error) => {
            if tools::port_open(port) {
                println!("Hyde is already running at {}", url(port));
                if open {
                    open_ui(port);
                }
                return Ok(());
            }
            return Err(format!("could not listen on 127.0.0.1:{port}: {error}"));
        }
    };
    let token: Arc<str> = session_token().into();
    // Desktop notifications for Hyde Code questions, approvals and PRs (hub API v1 event stream).
    {
        let watcher = Arc::clone(&shared);
        std::thread::spawn(move || {
            hydecode::watch_events(
                || {
                    watcher
                        .config
                        .lock()
                        .map(|c| c.code.notify)
                        .unwrap_or(false)
                },
                |notice| hydecode::desktop_notify(&notice),
            )
        });
    }
    println!("Hyde AI is running at {}  (Ctrl+C to stop)", url(port));
    if open {
        open_ui(port);
    }
    for request in server.incoming_requests() {
        let shared = Arc::clone(&shared);
        let token = Arc::clone(&token);
        std::thread::spawn(move || handle(request, &shared, &token, port));
    }
    Ok(())
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid header")
}

fn security_headers<R: Read>(response: Response<R>) -> Response<R> {
    response
        .with_header(header("X-Content-Type-Options", "nosniff"))
        .with_header(header("X-Frame-Options", "DENY"))
        .with_header(header("Referrer-Policy", "no-referrer"))
        .with_header(header("Cache-Control", "no-store"))
}

fn send_text(request: Request, status: u16, content_type: &str, body: String) {
    let response = Response::from_string(body)
        .with_status_code(status)
        .with_header(header("Content-Type", content_type));
    let _ = request.respond(security_headers(response));
}

fn send_json(request: Request, status: u16, value: Value) {
    send_text(
        request,
        status,
        "application/json; charset=utf-8",
        value.to_string(),
    );
}

fn get_header<'a>(request: &'a Request, name: &'static str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str())
}

fn read_json<T: for<'de> Deserialize<'de>>(request: &mut Request) -> Result<T, String> {
    let mut body = String::new();
    request
        .as_reader()
        .take(MAX_BODY)
        .read_to_string(&mut body)
        .map_err(|error| format!("could not read request: {error}"))?;
    serde_json::from_str(&body).map_err(|error| format!("invalid JSON: {error}"))
}

fn handle(mut request: Request, shared: &Shared, token: &str, port: u16) {
    let host_ok = get_header(&request, "Host")
        .map(|host| host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}"))
        .unwrap_or(false);
    if !host_ok {
        return send_text(request, 403, "text/plain", "forbidden host".into());
    }
    let method = request.method().clone();
    let path = request.url().split('?').next().unwrap_or("/").to_owned();

    if !path.starts_with("/api/") {
        return match (method, path.as_str()) {
            (Method::Get, "/" | "/index.html") => {
                let csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";
                let response = Response::from_string(INDEX.replace("__HYDE_TOKEN__", token))
                    .with_header(header("Content-Type", "text/html; charset=utf-8"))
                    .with_header(header("Content-Security-Policy", csp));
                let _ = request.respond(security_headers(response));
            }
            (Method::Get, "/app.js") => send_text(
                request,
                200,
                "text/javascript; charset=utf-8",
                APP_JS.into(),
            ),
            (Method::Get, "/style.css") => {
                send_text(request, 200, "text/css; charset=utf-8", STYLE.into())
            }
            (Method::Get, "/icon.svg") => send_text(request, 200, "image/svg+xml", ICON.into()),
            _ => send_text(request, 404, "text/plain", "not found".into()),
        };
    }

    if get_header(&request, "X-Hyde-Token") != Some(token) {
        return send_json(
            request,
            401,
            json!({ "error": "missing or wrong session token; reload the page" }),
        );
    }

    match api(&mut request, shared, &method, &path) {
        Ok(value) => send_json(request, 200, value),
        Err((status, message)) => send_json(request, status, json!({ "error": message })),
    }
}

type ApiResult = Result<Value, (u16, String)>;

fn bad(message: impl Into<String>) -> (u16, String) {
    (400, message.into())
}

#[derive(Deserialize)]
struct CommandBody {
    text: String,
}

#[derive(Deserialize)]
struct ConfirmBody {
    pending_id: u64,
    approve: bool,
}

#[derive(Deserialize)]
struct NotifyBody {
    enabled: bool,
}

#[derive(Deserialize)]
struct CodeBody {
    text: Option<String>,
    project: Option<String>,
    agent: Option<String>,
}

#[derive(Deserialize)]
struct ToolBody {
    tool: String,
}

#[derive(Deserialize)]
struct AiBody {
    enabled: Option<bool>,
    provider: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    /// Absent keeps the saved key; an empty string clears it.
    api_key: Option<String>,
}

fn merged_ai(saved: &AiConfig, body: AiBody) -> AiConfig {
    let provider_changed = body
        .provider
        .as_deref()
        .is_some_and(|p| p != saved.provider);
    AiConfig {
        enabled: body.enabled.unwrap_or(saved.enabled),
        provider: body.provider.unwrap_or_else(|| saved.provider.clone()),
        base_url: body
            .base_url
            .map(|u| u.trim().to_owned())
            .unwrap_or_else(|| saved.base_url.clone()),
        model: body
            .model
            .map(|m| m.trim().to_owned())
            .unwrap_or_else(|| saved.model.clone()),
        api_key: match body.api_key {
            Some(key) => key.trim().to_owned(),
            None if provider_changed => String::new(),
            None => saved.api_key.clone(),
        },
    }
}

fn ai_view(ai: &AiConfig) -> Value {
    let key = ai.api_key.trim();
    let hint = if key.len() > 8 {
        format!("…{}", &key[key.len() - 4..])
    } else if key.is_empty() {
        String::new()
    } else {
        "set".into()
    };
    json!({
        "enabled": ai.enabled,
        "provider": ai.provider,
        "base_url": ai.base_url,
        "model": ai.model,
        "has_key": !key.is_empty(),
        "key_hint": hint,
        "ready": ai.is_ready(),
    })
}

fn api(request: &mut Request, shared: &Shared, method: &Method, path: &str) -> ApiResult {
    match (method, path) {
        (Method::Get, "/api/state") => {
            let ai = shared.ai_config();
            let agent = shared
                .agent
                .lock()
                .map_err(|_| (500, "agent lock".to_string()))?;
            let apps: Vec<Value> = agent
                .pack
                .apps
                .iter()
                .map(|app| {
                    json!({
                        "id": app.id, "name": app.name, "aliases": app.aliases,
                        "command": app.command, "installed": tools::which(&app.command).is_some(),
                    })
                })
                .collect();
            let history: Vec<_> = agent.history.iter().rev().take(60).rev().collect();
            Ok(json!({
                "version": env!("CARGO_PKG_VERSION"),
                "ai": ai_view(&ai),
                "providers": PROVIDERS,
                "apps": apps,
                "intents": agent.pack.intents.len(),
                "examples": agent::Agent::examples(),
                "history": history,
                "config_dir": crate::config::config_dir().display().to_string(),
            }))
        }
        (Method::Post, "/api/command") => {
            let body: CommandBody = read_json(request).map_err(bad)?;
            Ok(serde_json::to_value(agent::handle(shared, &body.text)).unwrap_or_default())
        }
        (Method::Post, "/api/confirm") => {
            let body: ConfirmBody = read_json(request).map_err(bad)?;
            Ok(
                serde_json::to_value(agent::confirm(shared, body.pending_id, body.approve))
                    .unwrap_or_default(),
            )
        }
        (Method::Post, "/api/history/clear") => {
            let mut agent = shared
                .agent
                .lock()
                .map_err(|_| (500, "agent lock".to_string()))?;
            agent.history.clear();
            Ok(json!({ "ok": true }))
        }
        (Method::Post, "/api/ai/config") => {
            let body: AiBody = read_json(request).map_err(bad)?;
            let mut config = shared
                .config
                .lock()
                .map_err(|_| (500, "config lock".to_string()))?;
            let ai = merged_ai(&config.ai, body);
            if !ai.base_url.is_empty()
                && !(ai.base_url.starts_with("http://") || ai.base_url.starts_with("https://"))
            {
                return Err(bad("the endpoint must start with http:// or https://"));
            }
            config.ai = ai;
            config.save().map_err(|error| (500, error))?;
            Ok(json!({ "ok": true, "ai": ai_view(&config.ai) }))
        }
        (Method::Post, "/api/ai/test") => {
            let body: AiBody = read_json(request).map_err(bad)?;
            let ai = merged_ai(&shared.ai_config(), body);
            let result = llm::test(&ai);
            Ok(json!({ "ok": result.ok, "message": result.message, "millis": result.millis }))
        }
        (Method::Post, "/api/ai/models") => {
            let body: AiBody = read_json(request).map_err(bad)?;
            let ai = merged_ai(&shared.ai_config(), body);
            match llm::list_models(&ai.base_url, &ai.api_key) {
                Ok(models) => Ok(json!({ "ok": true, "models": models })),
                Err(error) => Ok(json!({ "ok": false, "error": error, "models": [] })),
            }
        }
        (Method::Get, "/api/code") => {
            let (default, notify) = shared
                .config
                .lock()
                .map(|c| (c.code.default_project.clone(), c.code.notify))
                .unwrap_or_default();
            let mut summary = hydecode::summary(&hydecode::discover(), &default);
            summary["notify"] = json!(notify);
            summary["can_notify"] = json!(tools::which("notify-send").is_some());
            Ok(summary)
        }
        (Method::Post, "/api/code/start") => {
            let message = hydecode::start(&hydecode::discover()).map_err(bad)?;
            Ok(json!({ "ok": true, "message": message }))
        }
        (Method::Post, "/api/code/open") => {
            let body: CodeBody = read_json(request).map_err(bad)?;
            let hub = hydecode::ensure_up(&hydecode::discover()).map_err(bad)?;
            let url = hydecode::office_url(&hub, body.project.as_deref()).map_err(bad)?;
            tools::open_url(&url).map_err(bad)?;
            Ok(json!({ "ok": true, "message": "Opened the Hyde Code office" }))
        }
        (Method::Post, "/api/code/task") => {
            let body: CodeBody = read_json(request).map_err(bad)?;
            let default = shared
                .config
                .lock()
                .map(|c| c.code.default_project.clone())
                .unwrap_or_default();
            let message = agent::code_task(
                body.text.as_deref().unwrap_or(""),
                body.project.as_deref(),
                body.agent.as_deref(),
                None,
                &default,
            )
            .map_err(bad)?;
            Ok(json!({ "ok": true, "message": message }))
        }
        (Method::Post, "/api/code/command") => {
            let body: CodeBody = read_json(request).map_err(bad)?;
            let text = body.text.unwrap_or_default();
            let verb = text.split_whitespace().next().unwrap_or("");
            // Only the decisions the owner makes from this UI; everything else stays in Hyde Code.
            if !matches!(
                verb,
                "/approve" | "/deny" | "/merge" | "/stop" | "/retry" | "/answer"
            ) {
                return Err(bad(
                    "only /approve, /deny, /merge, /stop, /retry and /answer are allowed here",
                ));
            }
            let message = agent::code_command(&text).map_err(bad)?;
            Ok(json!({ "ok": true, "message": message }))
        }
        (Method::Post, "/api/code/notify") => {
            let body: NotifyBody = read_json(request).map_err(bad)?;
            let mut config = shared
                .config
                .lock()
                .map_err(|_| (500, "config lock".to_string()))?;
            config.code.notify = body.enabled;
            config.save().map_err(|error| (500, error))?;
            Ok(json!({ "ok": true, "notify": body.enabled }))
        }
        (Method::Post, "/api/code/default") => {
            let body: CodeBody = read_json(request).map_err(bad)?;
            let mut config = shared
                .config
                .lock()
                .map_err(|_| (500, "config lock".to_string()))?;
            config.code.default_project = body.project.unwrap_or_default();
            config.save().map_err(|error| (500, error))?;
            Ok(json!({ "ok": true }))
        }
        (Method::Get, "/api/tools") => Ok(json!({ "tools": tools::all_status() })),
        (Method::Post, "/api/tools/install") => {
            let body: ToolBody = read_json(request).map_err(bad)?;
            let id = shared.jobs.start_install(&body.tool).map_err(bad)?;
            Ok(json!({ "job_id": id }))
        }
        (Method::Post, "/api/tools/launch") => {
            let body: ToolBody = read_json(request).map_err(bad)?;
            let message = tools::launch_tool(&body.tool).map_err(bad)?;
            Ok(json!({ "ok": true, "message": message }))
        }
        (Method::Post, "/api/reload") => {
            let pack = agent::load_pack(shared.data_dir.as_deref()).map_err(bad)?;
            let count = pack.intents.len();
            shared
                .agent
                .lock()
                .map_err(|_| (500, "agent lock".to_string()))?
                .pack = pack;
            Ok(json!({ "ok": true, "intents": count }))
        }
        (Method::Get, job) if job.starts_with("/api/jobs/") => {
            let id: u64 = job
                .trim_start_matches("/api/jobs/")
                .parse()
                .map_err(|_| bad("bad job id"))?;
            shared
                .jobs
                .get(id)
                .map(|job| serde_json::to_value(job).unwrap_or_default())
                .ok_or((404, "no such job".into()))
        }
        _ => Err((404, format!("no route for {method} {path}"))),
    }
}
