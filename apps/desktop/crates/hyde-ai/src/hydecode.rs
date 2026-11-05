//! Bridge to Hyde Code, the coding-agent hub (Claude Code, Codex, OpenCode).
//!
//! The desktop app never runs coding agents itself: it turns plain words into hub requests
//! and shows the hub's state. Worktrees, reviews, approvals, PRs and policy stay in the hub.
//!
//! Contract: `docs/api.md` (hub client API, `apiVersion` 1). With an API v1 hub this uses
//! the client token and the typed endpoints (`POST /api/tasks`, `/api/questions/:id/answer`,
//! `/api/approvals/:id`, `GET /api/summary`, SSE `/api/events`). Older hubs fall back to the
//! owner token, `GET /api/state` and chat commands on `POST /api/commands`.
//!
//! Discovery: `$HYDE_HOME/hub.json` (written by a running hub), else `$HYDE_HOME/config.json`
//! (`port`, `dataDir`). Tokens: `<dataDir>/clients/hyde-ai.token`, else `<dataDir>/owner-token`.

use crate::config::home_dir;
use crate::tools;
use serde::Serialize;
use serde_json::{json, Value};
use std::io::BufRead;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const DEFAULT_PORT: u16 = 7420;

#[derive(Clone, Debug)]
pub struct Hub {
    pub home: PathBuf,
    pub port: u16,
    /// Token for API calls: the narrow `hyde-ai` client token when the hub made one, else the owner token.
    pub token: Option<String>,
    /// True when `token` is the client token.
    pub client_token: bool,
    /// Owner token, only for opening the office (`/login` is owner-only).
    pub owner_token: Option<String>,
    /// `apiVersion` from `hub.json`, when the running hub wrote one.
    pub api_version: Option<u64>,
    /// Hyde Code's `hyde` CLI, used to start the hub.
    pub cli: Option<PathBuf>,
}

impl Hub {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

pub fn hyde_home() -> PathBuf {
    std::env::var_os("HYDE_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| home_dir().join(".hyde"))
}

fn read_json(path: PathBuf) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null)
}

fn read_token(path: PathBuf) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty())
}

fn pid_alive(pid: u64) -> bool {
    pid > 0 && PathBuf::from(format!("/proc/{pid}")).exists()
}

/// Port from a `http://127.0.0.1:<port>` url.
fn port_of(url: &str) -> Option<u16> {
    url.rsplit(':').next()?.trim_end_matches('/').parse().ok()
}

/// Finds the hub's port, tokens and CLI. Never fails; missing parts are `None`.
pub fn discover() -> Hub {
    let home = hyde_home();
    let config = read_json(home.join("config.json"));
    let info = read_json(home.join("hub.json"));
    // hub.json is only trusted while its process is alive (a crash can leave it behind).
    let live = info
        .get("pid")
        .and_then(Value::as_u64)
        .is_some_and(pid_alive);
    let port = live
        .then(|| info.get("url").and_then(Value::as_str).and_then(port_of))
        .flatten()
        .or_else(|| {
            config
                .get("port")
                .and_then(Value::as_u64)
                .and_then(|p| u16::try_from(p).ok())
        })
        .unwrap_or(DEFAULT_PORT);
    let data_dir = live
        .then(|| info.get("dataDir").and_then(Value::as_str))
        .flatten()
        .or_else(|| config.get("dataDir").and_then(Value::as_str))
        .unwrap_or("data");
    let data_dir = if PathBuf::from(data_dir).is_absolute() {
        PathBuf::from(data_dir)
    } else {
        home.join(data_dir)
    };
    let owner_token = read_token(data_dir.join("owner-token"));
    let client = read_token(data_dir.join("clients").join("hyde-ai.token"));
    // `hyde` on PATH is Hyde Code's launcher (a bash script); make sure it isn't something else.
    let cli = tools::which("hyde").filter(|path| {
        std::fs::read(path)
            .map(|bytes| {
                bytes.starts_with(b"#!") && String::from_utf8_lossy(&bytes).contains("Hyde Code")
            })
            .unwrap_or(false)
    });
    Hub {
        home,
        port,
        client_token: client.is_some(),
        token: client.or_else(|| owner_token.clone()),
        owner_token,
        api_version: live
            .then(|| info.get("apiVersion").and_then(Value::as_u64))
            .flatten(),
        cli,
    }
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(timeout).build()
}

/// `GET /api/health`: `None` when the hub is down, else its `apiVersion` (0 for older hubs).
pub fn health(hub: &Hub) -> Option<u64> {
    if !tools::port_open(hub.port) {
        return None;
    }
    let value: Value = agent(Duration::from_millis(1500))
        .get(&format!("{}/api/health", hub.url()))
        .call()
        .ok()?
        .into_json()
        .ok()?;
    Some(value.get("apiVersion").and_then(Value::as_u64).unwrap_or(0))
}

pub fn is_up(hub: &Hub) -> bool {
    health(hub).is_some()
}

/// The hub speaks the typed client API (v1) and we hold a token for it.
pub fn typed(hub: &Hub) -> bool {
    hub.token.is_some()
        && hub
            .api_version
            .or_else(|| health(hub))
            .is_some_and(|v| v >= 1)
}

fn auth(hub: &Hub) -> Result<String, String> {
    hub.token
        .as_ref()
        .map(|t| format!("Bearer {t}"))
        .ok_or_else(|| {
            format!(
                "No Hyde Code token was found in {}. Run `hyde` once to set it up.",
                hub.home.display()
            )
        })
}

/// A hub error: the people-facing text plus the machine `code` from API v1 (`project`, `duplicate`, …).
#[derive(Debug)]
pub struct HubError {
    pub message: String,
    pub code: Option<String>,
}

impl From<HubError> for String {
    fn from(error: HubError) -> Self {
        error.message
    }
}

fn hub_error(error: ureq::Error) -> HubError {
    match error {
        ureq::Error::Status(status, response) => {
            let body = response.into_string().unwrap_or_default();
            let value = serde_json::from_str::<Value>(&body).ok();
            let detail = value
                .as_ref()
                .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_owned))
                .unwrap_or(body);
            let code = value
                .as_ref()
                .and_then(|v| v.get("code").and_then(Value::as_str).map(str::to_owned));
            let message = match status {
                401 | 403 => format!("Hyde Code didn't allow that ({status}): {detail}"),
                _ => detail,
            };
            HubError { message, code }
        }
        ureq::Error::Transport(t) => HubError {
            message: format!("couldn't reach the Hyde Code hub: {t}"),
            code: None,
        },
    }
}

fn get(hub: &Hub, path: &str) -> Result<Value, HubError> {
    let auth = auth(hub).map_err(|message| HubError {
        message,
        code: None,
    })?;
    agent(Duration::from_secs(8))
        .get(&format!("{}{path}", hub.url()))
        .set("Authorization", &auth)
        .call()
        .map_err(hub_error)?
        .into_json()
        .map_err(|e| HubError {
            message: format!("invalid hub reply: {e}"),
            code: None,
        })
}

fn post(hub: &Hub, path: &str, body: Value) -> Result<Value, HubError> {
    let auth = auth(hub).map_err(|message| HubError {
        message,
        code: None,
    })?;
    agent(Duration::from_secs(30))
        .post(&format!("{}{path}", hub.url()))
        .set("Authorization", &auth)
        .send_json(body)
        .map_err(hub_error)?
        .into_json()
        .map_err(|e| HubError {
            message: format!("invalid hub reply: {e}"),
            code: None,
        })
}

fn reply_text(value: &Value) -> String {
    value
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned()
}

pub fn state(hub: &Hub) -> Result<Value, String> {
    get(hub, "/api/state").map_err(String::from)
}

/// API v1 only: `GET /api/summary` (counts, what needs the owner, agents with quota).
pub fn summary_v1(hub: &Hub) -> Result<Value, String> {
    get(hub, "/api/summary").map_err(String::from)
}

/// Sends a chat command such as `/merge T-4` and returns the hub's reply text.
pub fn command(hub: &Hub, text: &str) -> Result<String, String> {
    post(hub, "/api/commands", json!({ "text": text }))
        .map(|v| reply_text(&v))
        .map_err(String::from)
}

#[derive(Debug)]
pub struct CreatedTask {
    pub id: String,
    pub status: String,
    pub project_id: String,
    pub text: String,
}

/// API v1: `POST /api/tasks`. `request_id` makes retries safe (a repeat returns `duplicate`).
/// API v2: `complexity` is a suggestion; the hub's rules have the final say.
pub fn create_task(
    hub: &Hub,
    text: &str,
    project: Option<&str>,
    agent: Option<&str>,
    complexity: Option<&str>,
    request_id: &str,
) -> Result<CreatedTask, HubError> {
    let mut body = json!({ "text": text, "requestId": request_id });
    if let Some(level) =
        complexity.filter(|_| hub.api_version.or_else(|| health(hub)).unwrap_or(0) >= 2)
    {
        body["complexity"] = json!(level);
    }
    if let Some(project) = project.filter(|p| !p.is_empty()) {
        body["project"] = json!(project);
    }
    if let Some(agent) = agent.filter(|a| !a.is_empty()) {
        body["agent"] = json!(agent);
    }
    let value = post(hub, "/api/tasks", body)?;
    let field = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    Ok(CreatedTask {
        id: field("id"),
        status: field("status"),
        project_id: field("projectId"),
        text: reply_text(&value),
    })
}

/// The hub's routing mode (API v2 `/api/summary`), e.g. `balanced` or `assistant-plans`.
pub fn routing_mode(hub: &Hub) -> Option<String> {
    if !typed(hub) {
        return None;
    }
    summary_v1(hub)
        .ok()?
        .pointer("/routing/mode")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// Splits a trailing `[level:<level>]` marker (from the assistant's AI) off a task text.
pub fn split_level(text: &str) -> (String, Option<String>) {
    let trimmed = text.trim_end();
    if let (Some(start), true) = (trimmed.rfind("[level:"), trimmed.ends_with(']')) {
        let level = trimmed[start + 7..trimmed.len() - 1].trim().to_lowercase();
        if crate::llm::LEVELS.contains(&level.as_str()) {
            return (trimmed[..start].trim_end().to_owned(), Some(level));
        }
    }
    (text.to_owned(), None)
}

/// "low · claude-1 · sonnet": a task's complexity and where its latest run went.
pub fn route_label(task: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(level) = task.pointer("/complexity/level").and_then(Value::as_str) {
        parts.push(level.to_owned());
    }
    if let Some(run) = task.get("run") {
        if let Some(agent) = run.get("agent").and_then(Value::as_str) {
            parts.push(agent.to_owned());
        }
        if let Some(model) = run
            .get("requestedModel")
            .or_else(|| run.get("model"))
            .and_then(Value::as_str)
        {
            parts.push(match run.get("effort").and_then(Value::as_str) {
                Some(effort) => format!("{model} ({effort})"),
                None => model.to_owned(),
            });
        }
    }
    parts.join(" · ")
}

/// API v1: `POST /api/questions/:id/answer`.
pub fn answer(hub: &Hub, question: &str, text: &str) -> Result<String, String> {
    post(
        hub,
        &format!("/api/questions/{question}/answer"),
        json!({ "text": text }),
    )
    .map(|v| reply_text(&v))
    .map_err(String::from)
}

/// API v1: `POST /api/approvals/:id`.
pub fn decide(hub: &Hub, approval: &str, approve: bool) -> Result<String, String> {
    post(
        hub,
        &format!("/api/approvals/{approval}"),
        json!({ "decision": if approve { "approve" } else { "deny" } }),
    )
    .map(|v| reply_text(&v))
    .map_err(String::from)
}

/// Runs an owner decision. On a v1 hub, answers and approvals use the typed endpoints.
pub fn run_command(hub: &Hub, text: &str) -> Result<String, String> {
    if typed(hub) {
        let mut parts = text.splitn(3, ' ');
        let (verb, target, rest) = (
            parts.next().unwrap_or(""),
            parts.next().unwrap_or(""),
            parts.next().unwrap_or("").trim(),
        );
        let is_ref = |prefix: char| target.starts_with(prefix) && target[1..].starts_with('-');
        match verb {
            "/answer" if is_ref('Q') && !rest.is_empty() => return answer(hub, target, rest),
            "/approve" if is_ref('A') => return decide(hub, target, true),
            "/deny" if is_ref('A') => return decide(hub, target, false),
            _ => {}
        }
    }
    command(hub, text)
}

/// Starts the hub in the background through Hyde Code's own CLI and waits until it answers.
pub fn start(hub: &Hub) -> Result<String, String> {
    if is_up(hub) {
        return Ok("Hyde Code hub is already running".into());
    }
    let cli = hub
        .cli
        .clone()
        .ok_or("Hyde Code isn't installed on PATH. In the repo run `pnpm install-cli`.")?;
    Command::new(cli)
        .args(["hub", "start"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .current_dir(home_dir())
        .spawn()
        .map_err(|e| format!("couldn't start the Hyde Code hub: {e}"))?;
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(45) {
        if is_up(hub) {
            return Ok("Started the Hyde Code hub".into());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Err(format!(
        "the Hyde Code hub didn't start in 45 s; see {}/hub.log",
        hub.home.display()
    ))
}

/// Makes sure the hub runs and returns a fresh discovery (a starting hub writes hub.json and the client token).
pub fn ensure_up(hub: &Hub) -> Result<Hub, String> {
    if !is_up(hub) {
        start(hub)?;
    }
    Ok(discover())
}

pub fn office_url(hub: &Hub, project: Option<&str>) -> Result<String, String> {
    let token = hub
        .owner_token
        .as_ref()
        .ok_or("Hyde Code's owner token wasn't found")?;
    let mut url = format!("{}/login?token={token}", hub.url());
    if let Some(project) = project.filter(|p| !p.is_empty()) {
        url.push_str(&format!("&project={}", crate::agent::url_encode(project)));
    }
    Ok(url)
}

// ---------------------------------------------------------------- live events → desktop notifications

/// One notification-worthy hub event, from SSE `/api/events` (API v1).
#[derive(Debug, PartialEq, Eq)]
pub struct Notice {
    pub title: String,
    pub body: String,
}

/// Turns an event record into a notification, or `None` for event types we don't announce.
pub fn notice_for(event: &Value) -> Option<Notice> {
    let kind = event.get("type")?.as_str()?;
    let p = event.get("payload").cloned().unwrap_or(Value::Null);
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    let task = s(&p, "taskId");
    let task = if task.is_empty() {
        s(event, "taskId")
    } else {
        task
    };
    let short = |text: String| -> String {
        let text = text.replace('\n', " ");
        if text.chars().count() > 180 {
            format!("{}…", text.chars().take(180).collect::<String>())
        } else {
            text
        }
    };
    Some(match kind {
        "question.asked" => Notice {
            title: format!("{} asks ({task})", s(&p, "questionId")),
            body: short(s(&p, "text")),
        },
        "approval.requested" => Notice {
            title: format!("Approval {} needed ({task})", s(&p, "approvalId")),
            body: short(s(&p, "summary")),
        },
        "task.pr_opened" => Notice {
            title: format!("Pull request ready ({task})"),
            body: s(&p, "url"),
        },
        "incident.raised" => Notice {
            title: format!(
                "Problem on {}",
                if task.is_empty() {
                    "the hub".into()
                } else {
                    task
                }
            ),
            body: short(s(&p, "about")),
        },
        "task.status_changed" if s(&p, "to") == "done" => Notice {
            title: format!("{task} is done"),
            body: String::new(),
        },
        _ => return None,
    })
}

/// Parses one SSE frame (lines up to a blank line) into (id, data).
pub fn parse_frame(lines: &[String]) -> (Option<u64>, Option<String>, Option<String>) {
    let mut id = None;
    let mut event = None;
    let mut data: Vec<&str> = Vec::new();
    for line in lines {
        if let Some(v) = line.strip_prefix("id:") {
            id = v.trim().parse().ok();
        } else if let Some(v) = line.strip_prefix("event:") {
            event = Some(v.trim().to_owned());
        } else if let Some(v) = line.strip_prefix("data:") {
            data.push(v.strip_prefix(' ').unwrap_or(v));
        }
    }
    (id, event, (!data.is_empty()).then(|| data.join("\n")))
}

/// Follows the hub's event stream forever, calling `notify` for each notice. Reconnects with
/// `?after=<last seq>` so nothing is missed or repeated; idles while the hub is down or older than v1.
pub fn watch_events(enabled: impl Fn() -> bool, notify: impl Fn(Notice)) {
    let mut last: Option<u64> = None;
    loop {
        let hub = discover();
        if !enabled() || !typed(&hub) {
            std::thread::sleep(Duration::from_secs(15));
            continue;
        }
        let path = match last {
            Some(seq) => format!("/api/events?after={seq}"),
            None => "/api/events".into(),
        };
        let Ok(auth) = auth(&hub) else {
            std::thread::sleep(Duration::from_secs(15));
            continue;
        };
        // Pings arrive every 15 s, so a 45 s read timeout means the connection is dead.
        let response = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(3))
            .timeout_read(Duration::from_secs(45))
            .build()
            .get(&format!("{}{path}", hub.url()))
            .set("Authorization", &auth)
            .set("Accept", "text/event-stream")
            .call();
        if let Ok(response) = response {
            let reader = std::io::BufReader::new(response.into_reader());
            let mut frame: Vec<String> = Vec::new();
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if !line.is_empty() {
                    frame.push(line);
                    continue;
                }
                let (id, event, data) = parse_frame(&frame);
                frame.clear();
                if let Some(id) = id {
                    last = Some(id);
                }
                if event.as_deref() == Some("ping") || !enabled() {
                    continue;
                }
                if let Some(notice) = data
                    .and_then(|d| serde_json::from_str::<Value>(&d).ok())
                    .as_ref()
                    .and_then(notice_for)
                {
                    notify(notice);
                }
            }
        }
        std::thread::sleep(Duration::from_secs(5));
    }
}

/// Shows a desktop notification through `notify-send`, if it exists.
pub fn desktop_notify(notice: &Notice) {
    if let Some(bin) = tools::which("notify-send") {
        let _ = Command::new(bin)
            .args([
                "-a",
                "Hyde AI",
                "-i",
                "hyde-ai",
                &format!("Hyde Code · {}", notice.title),
                &notice.body,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
}

// ---------------------------------------------------------------- projects

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Project {
    pub id: String,
    pub name: String,
}

pub fn projects(state: &Value) -> Vec<Project> {
    state
        .get("projects")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|p| {
                    let id = p.get("id")?.as_str()?.to_owned();
                    let name = p
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or(&id)
                        .to_owned();
                    Some(Project { id, name })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn words(text: &str) -> Vec<String> {
    hyde_core::normalize(&text.replace(['-', '_', '.'], " "))
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

/// Splits "add a footer in gamify ias lms" into ("add a footer", Some("gamify-ias-lms")).
/// Looks for a trailing "in|for|on|to [the] <project id or name> [project|repo]".
pub fn split_project(task: &str, projects: &[Project]) -> (String, Option<String>) {
    let task_words: Vec<String> = task.split_whitespace().map(str::to_owned).collect();
    let lowered: Vec<String> = task_words.iter().map(|w| w.to_lowercase()).collect();
    let mut best: Option<(usize, usize, String)> = None; // (cut index, phrase length, id)
    for project in projects {
        for phrase in [words(&project.id), words(&project.name)] {
            if phrase.is_empty() {
                continue;
            }
            for suffix in [
                &[][..],
                &["project".to_string()][..],
                &["repo".to_string()][..],
            ] {
                let full: Vec<String> = phrase.iter().chain(suffix.iter()).cloned().collect();
                if full.len() >= lowered.len() {
                    continue;
                }
                let start = lowered.len() - full.len();
                let tail: Vec<String> = lowered[start..]
                    .iter()
                    .map(|w| hyde_core::normalize(w))
                    .collect();
                if tail != full {
                    continue;
                }
                let mut cut = start;
                if cut > 0 && lowered[cut - 1] == "the" {
                    cut -= 1;
                }
                if cut > 0
                    && matches!(
                        lowered[cut - 1].as_str(),
                        "in" | "for" | "on" | "to" | "inside"
                    )
                {
                    cut -= 1;
                    if best.as_ref().is_none_or(|b| full.len() > b.1) {
                        best = Some((cut, full.len(), project.id.clone()));
                    }
                }
            }
        }
    }
    match best {
        Some((cut, _, id)) if cut > 0 => (task_words[..cut].join(" "), Some(id)),
        _ => (task.trim().to_owned(), None),
    }
}

/// "a 2" / "t-4" / "Q3" → "A-2" / "T-4" / "Q-3".
pub fn reference(text: &str) -> Option<String> {
    let compact: String = text.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let mut chars = compact.chars();
    let letter = chars.next()?.to_ascii_uppercase();
    let digits: String = chars.collect();
    if !matches!(letter, 'T' | 'A' | 'Q' | 'L' | 'R')
        || digits.is_empty()
        || !digits.chars().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    Some(format!("{letter}-{digits}"))
}

/// Pulls the first `T-<n>` out of a hub reply.
pub fn task_id(reply: &str) -> Option<String> {
    let bytes = reply.as_bytes();
    (0..bytes.len().saturating_sub(2)).find_map(|i| {
        if bytes[i] == b'T'
            && bytes[i + 1] == b'-'
            && bytes[i + 2].is_ascii_digit()
            && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric())
        {
            let end = bytes[i + 2..]
                .iter()
                .position(|b| !b.is_ascii_digit())
                .map_or(bytes.len(), |p| i + 2 + p);
            Some(reply[i..end].to_owned())
        } else {
            None
        }
    })
}

// ---------------------------------------------------------------- summary for the UI

const ACTIVE_ORDER: &[&str] = &[
    "blocked",
    "running",
    "verifying",
    "reviewing",
    "clarifying",
    "ready",
    "awaiting_merge",
    "backlog",
];

pub fn summary(hub: &Hub, default_project: &str) -> Value {
    let base = json!({
        "installed": hub.cli.is_some() || hub.home.join("config.json").exists(),
        "has_cli": hub.cli.is_some(),
        "has_token": hub.token.is_some(),
        "url": hub.url(),
        "home": hub.home.display().to_string(),
        "default_project": default_project,
    });
    let mut out = base;
    let running = is_up(hub);
    out["running"] = json!(running);
    if !running {
        return out;
    }
    let state = match state(hub) {
        Ok(state) => state,
        Err(error) => {
            out["error"] = json!(error);
            return out;
        }
    };
    let pick = |v: &Value, keys: &[&str]| -> Value {
        let mut obj = serde_json::Map::new();
        for key in keys {
            if let Some(value) = v.get(*key) {
                obj.insert((*key).to_owned(), value.clone());
            }
        }
        Value::Object(obj)
    };
    let mut tasks: Vec<Value> = state
        .get("tasks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|t| {
            pick(
                t,
                &[
                    "id",
                    "projectId",
                    "title",
                    "status",
                    "agent",
                    "pinnedAgent",
                    "prUrl",
                    "blockedBy",
                    "createdTs",
                    "parentId",
                    "attempts",
                    "complexity",
                    "waiting",
                ],
            )
        })
        .collect();
    // Where each task's latest run went (agent, tier, model, effort).
    let runs = state
        .get("runs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for task in tasks.iter_mut() {
        let id = task.get("id").cloned();
        let last = runs
            .iter()
            .filter(|r| r.get("taskId") == id.as_ref())
            .max_by_key(|r| r.get("dispatchedSeq").and_then(Value::as_u64).unwrap_or(0));
        if let Some(run) = last {
            task["run"] = pick(
                run,
                &[
                    "agent",
                    "mode",
                    "tier",
                    "model",
                    "requestedModel",
                    "effort",
                    "state",
                ],
            );
        }
    }
    let rank = |t: &Value| {
        let status = t.get("status").and_then(Value::as_str).unwrap_or("");
        ACTIVE_ORDER
            .iter()
            .position(|s| *s == status)
            .unwrap_or(ACTIVE_ORDER.len())
    };
    let num = |t: &Value| {
        t.get("id")
            .and_then(Value::as_str)
            .and_then(|id| id.trim_start_matches("T-").parse::<u64>().ok())
            .unwrap_or(0)
    };
    tasks.sort_by(|a, b| rank(a).cmp(&rank(b)).then(num(b).cmp(&num(a))));
    tasks.truncate(40);

    let open = |key: &str, fields: &[&str]| -> Vec<Value> {
        state
            .get(key)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter(|i| i.get("status").and_then(Value::as_str) == Some("open"))
                    .map(|i| pick(i, fields))
                    .collect()
            })
            .unwrap_or_default()
    };
    out["projects"] = json!(projects(&state));
    out["agents"] = json!(state
        .get("agents")
        .and_then(Value::as_array)
        .map(|a| a
            .iter()
            .map(|x| pick(
                x,
                &["name", "adapter", "model", "roles", "vendor", "health"]
            ))
            .collect::<Vec<_>>())
        .unwrap_or_default());
    out["tasks"] = json!(tasks);
    out["questions"] = json!(open(
        "questions",
        &["id", "taskId", "text", "options", "blocking"]
    ));
    out["approvals"] = json!(open("approvals", &["id", "taskId", "kind", "summary"]));
    out["merges"] = json!([]);
    out["api_version"] = json!(0);
    out["client_token"] = json!(hub.client_token);

    // API v1: the hub's own summary is the source of truth for what needs the owner and for quota.
    if typed(hub) {
        if let Ok(v1) = summary_v1(hub) {
            out["api_version"] = v1.get("apiVersion").cloned().unwrap_or(json!(1));
            let needs: Vec<Value> = v1
                .get("needsYou")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let of = |kind: &str| {
                needs
                    .iter()
                    .filter(|n| n.get("kind").and_then(Value::as_str) == Some(kind))
                    .cloned()
                    .collect::<Vec<_>>()
            };
            // The hub links repeated questions to one Q-n; keep one card per id regardless.
            let mut seen = std::collections::HashSet::new();
            out["questions"] = json!(of("question")
                .into_iter()
                .filter(|q| seen.insert(q.get("id").cloned().unwrap_or(Value::Null).to_string()))
                .collect::<Vec<_>>());
            out["routing"] = v1.get("routing").cloned().unwrap_or(Value::Null);
            out["approvals"] = json!(of("approval")
                .into_iter()
                .map(|mut a| {
                    a["kind"] = a.get("approvalKind").cloned().unwrap_or(Value::Null);
                    a
                })
                .collect::<Vec<_>>());
            out["merges"] = json!(of("merge"));
            out["counts"] = v1.get("counts").cloned().unwrap_or(Value::Null);
            out["quota_soft_ceiling"] = v1.get("quotaSoftCeiling").cloned().unwrap_or(Value::Null);
            let quota: Vec<Value> = v1
                .get("agents")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if let Some(agents) = out["agents"].as_array_mut() {
                for agent in agents.iter_mut() {
                    let name = agent.get("name").cloned();
                    if let Some(q) = quota.iter().find(|q| q.get("name") == name.as_ref()) {
                        for key in ["usable", "percent", "nearCeiling", "blocked", "resetsAt"] {
                            if let Some(value) = q.get(key) {
                                agent[key] = value.clone();
                            }
                        }
                    }
                }
            }
        }
    }
    out
}

/// A short spoken/markdown status for "what is Hyde Code doing".
pub fn status_text(summary: &Value) -> String {
    if summary.get("running") != Some(&json!(true)) {
        return "Hyde Code's hub isn't running. Say **start hyde code** to start it.".into();
    }
    let count = |status: &str| {
        summary["tasks"]
            .as_array()
            .map_or(0, |t| t.iter().filter(|x| x["status"] == status).count())
    };
    let list_len = |key: &str| summary[key].as_array().map_or(0, Vec::len);
    let needs = list_len("questions") + list_len("approvals") + list_len("merges");
    let merges = list_len("merges").max(count("awaiting_merge"));
    let mut lines = vec![format!(
        "**Hyde Code** — {} running, {} waiting for you, {} ready for merge.",
        count("running") + count("verifying") + count("reviewing"),
        needs.max(count("blocked")),
        merges
    )];
    for q in summary["questions"]
        .as_array()
        .into_iter()
        .flatten()
        .take(5)
    {
        let also: Vec<String> = q["alsoAskedBy"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| m["taskId"].as_str().map(str::to_owned))
            .collect();
        lines.push(format!(
            "- **{}** ({}) asks: {}{}",
            q["id"].as_str().unwrap_or("?"),
            q["taskId"].as_str().unwrap_or("?"),
            q["text"].as_str().unwrap_or(""),
            if also.is_empty() {
                String::new()
            } else {
                format!(" (also asked on {})", also.join(", "))
            }
        ));
    }
    for a in summary["approvals"]
        .as_array()
        .into_iter()
        .flatten()
        .take(5)
    {
        lines.push(format!(
            "- **{}** ({}) needs approval: {}",
            a["id"].as_str().unwrap_or("?"),
            a["taskId"].as_str().unwrap_or("?"),
            a["summary"].as_str().unwrap_or("")
        ));
    }
    for m in summary["merges"].as_array().into_iter().flatten().take(5) {
        lines.push(format!(
            "- **{}** is ready to merge: {}",
            m["taskId"].as_str().unwrap_or("?"),
            m["taskTitle"].as_str().unwrap_or("")
        ));
    }
    for a in summary["agents"].as_array().into_iter().flatten() {
        if let Some(blocked) = a["blocked"].as_str() {
            lines.push(format!(
                "- ⚠ {} is paused: {blocked}",
                a["name"].as_str().unwrap_or("an agent")
            ));
        } else if a["nearCeiling"] == json!(true) {
            lines.push(format!(
                "- ⚠ {} is at {}% of its quota; new runs wait",
                a["name"].as_str().unwrap_or("an agent"),
                a["percent"].as_u64().unwrap_or(0)
            ));
        }
    }
    for t in summary["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| t["status"] == "running")
        .take(5)
    {
        let route = route_label(t);
        lines.push(format!(
            "- {} is working on **{}**: {}{}",
            t["agent"].as_str().unwrap_or("an agent"),
            t["id"].as_str().unwrap_or("?"),
            t["title"].as_str().unwrap_or(""),
            if route.is_empty() {
                String::new()
            } else {
                format!(" ({route})")
            }
        ));
    }
    if lines.len() == 1 {
        lines.push("Nothing needs you right now.".into());
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn projects() -> Vec<Project> {
        vec![
            Project {
                id: "gamify-ias-lms".into(),
                name: "Gamify IAS Lms".into(),
            },
            Project {
                id: "site".into(),
                name: "Hyde Site".into(),
            },
        ]
    }

    #[test]
    fn finds_trailing_project() {
        assert_eq!(
            split_project("add a footer in gamify ias lms", &projects()),
            ("add a footer".into(), Some("gamify-ias-lms".into()))
        );
        assert_eq!(
            split_project("fix login on the hyde site project", &projects()),
            ("fix login".into(), Some("site".into()))
        );
        assert_eq!(
            split_project("add dark mode to site", &projects()),
            ("add dark mode".into(), Some("site".into()))
        );
        assert_eq!(
            split_project("write the site", &projects()),
            ("write the site".into(), None)
        );
        assert_eq!(split_project("site", &projects()), ("site".into(), None));
    }

    #[test]
    fn normalizes_references() {
        assert_eq!(reference("a 2").as_deref(), Some("A-2"));
        assert_eq!(reference("T-14").as_deref(), Some("T-14"));
        assert_eq!(reference("q3").as_deref(), Some("Q-3"));
        assert_eq!(reference("all"), None);
        assert_eq!(reference("x 2"), None);
    }

    #[test]
    fn reads_sse_frames_and_notices() {
        let frame = vec![
            "id: 813".to_string(),
            r#"data: {"seq":813,"type":"question.asked","taskId":"T-12","payload":{"questionId":"Q-3","taskId":"T-12","text":"Paginate?"}}"#.to_string(),
        ];
        let (id, event, data) = parse_frame(&frame);
        assert_eq!(id, Some(813));
        assert_eq!(event, None);
        let notice = notice_for(&serde_json::from_str(&data.unwrap()).unwrap()).unwrap();
        assert_eq!(
            notice,
            Notice {
                title: "Q-3 asks (T-12)".into(),
                body: "Paginate?".into()
            }
        );
        assert_eq!(
            parse_frame(&["event: ping".to_string(), "data:".to_string()])
                .1
                .as_deref(),
            Some("ping")
        );
        let run = json!({"type": "run.event", "payload": {}});
        assert_eq!(notice_for(&run), None);
        let done = json!({"type": "task.status_changed", "payload": {"taskId": "T-2", "from": "awaiting_merge", "to": "done"}});
        assert_eq!(notice_for(&done).unwrap().title, "T-2 is done");
    }

    #[test]
    fn reads_ports_from_urls() {
        assert_eq!(port_of("http://127.0.0.1:7420"), Some(7420));
        assert_eq!(port_of("http://127.0.0.1:17421/"), Some(17421));
        assert_eq!(port_of("nope"), None);
    }

    #[test]
    fn splits_the_level_marker_from_the_task() {
        assert_eq!(
            split_level("rename foo to bar in my site [level:trivial]"),
            (
                "rename foo to bar in my site".into(),
                Some("trivial".into())
            )
        );
        assert_eq!(
            split_level("fix it [level:huge]"),
            ("fix it [level:huge]".into(), None)
        );
        assert_eq!(
            split_level("add [x] support"),
            ("add [x] support".into(), None)
        );
    }

    #[test]
    fn labels_tier_agent_and_model() {
        let task = json!({
            "complexity": { "level": "high" },
            "run": { "agent": "claude-1", "requestedModel": "opus", "model": "claude-opus-5-5", "effort": "high" }
        });
        assert_eq!(route_label(&task), "high · claude-1 · opus (high)");
        assert_eq!(
            route_label(&json!({ "complexity": { "level": "low" } })),
            "low"
        );
    }

    #[test]
    fn status_shows_tiers_and_who_else_asked() {
        let summary = json!({
            "running": true,
            "questions": [{ "id": "Q-1", "taskId": "T-1", "text": "Which database?", "alsoAskedBy": [{ "by": "codex-1", "taskId": "T-2" }] }],
            "tasks": [{ "id": "T-3", "title": "Add auth", "status": "running", "agent": "claude-1",
                        "complexity": { "level": "high" }, "run": { "agent": "claude-1", "requestedModel": "opus", "effort": "high" } }]
        });
        let text = status_text(&summary);
        assert!(text.contains("**Q-1** (T-1) asks: Which database? (also asked on T-2)"));
        assert!(text
            .contains("claude-1 is working on **T-3**: Add auth (high · claude-1 · opus (high))"));
    }

    #[test]
    fn extracts_task_ids() {
        assert_eq!(task_id("Created T-12 in #site").as_deref(), Some("T-12"));
        assert_eq!(task_id("nothing"), None);
        assert_eq!(task_id("OUT-3 then T-7"), Some("T-7".into()));
    }
}
