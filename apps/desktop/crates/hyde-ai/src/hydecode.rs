//! Bridge to Hyde Code, the coding-agent hub (Claude Code, Codex, OpenCode).
//!
//! Hyde AI never runs coding agents itself: it turns plain words into Hyde Code hub
//! commands (`/new`, `/approve`, `/merge`, …) and shows the hub's state. Everything the
//! hub does (worktrees, reviews, approvals, PRs, policy) stays in Hyde Code.
//!
//! Contract used (Hyde Code `apps/hub/src/http.ts`):
//! - `GET  /api/health`                       no auth
//! - `GET  /api/state`                        `Authorization: Bearer <owner-token>`
//! - `POST /api/commands {"text": "/new …"}`  same auth, returns `{"text": reply}`
//! - `GET  /login?token=…&project=…`          opens the web office with a cookie
//!
//! Discovery: `$HYDE_HOME` (default `~/.hyde`) holds `config.json` (`port`, `dataDir`) and
//! `<dataDir>/owner-token`.

use crate::config::home_dir;
use crate::tools;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const DEFAULT_PORT: u16 = 7420;

#[derive(Clone, Debug)]
pub struct Hub {
    pub home: PathBuf,
    pub port: u16,
    pub token: Option<String>,
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

/// Finds the hub's port, owner token and CLI. Never fails; missing parts are `None`.
pub fn discover() -> Hub {
    let home = hyde_home();
    let config: Value = std::fs::read_to_string(home.join("config.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    let port = config
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|p| u16::try_from(p).ok())
        .unwrap_or(DEFAULT_PORT);
    let data_dir = config
        .get("dataDir")
        .and_then(Value::as_str)
        .unwrap_or("data");
    let data_dir = if PathBuf::from(data_dir).is_absolute() {
        PathBuf::from(data_dir)
    } else {
        home.join(data_dir)
    };
    let token = std::fs::read_to_string(data_dir.join("owner-token"))
        .ok()
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty());
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
        token,
        cli,
    }
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new().timeout(timeout).build()
}

pub fn is_up(hub: &Hub) -> bool {
    tools::port_open(hub.port)
        && agent(Duration::from_millis(1500))
            .get(&format!("{}/api/health", hub.url()))
            .call()
            .is_ok()
}

fn auth(hub: &Hub) -> Result<String, String> {
    hub.token
        .as_ref()
        .map(|t| format!("Bearer {t}"))
        .ok_or_else(|| {
            format!(
                "Hyde Code's owner token wasn't found in {}. Run `hyde` once to set it up.",
                hub.home.display()
            )
        })
}

fn hub_error(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(code, response) => {
            let body = response.into_string().unwrap_or_default();
            let detail = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_owned))
                .unwrap_or(body);
            format!("Hyde Code hub returned {code}: {detail}")
        }
        ureq::Error::Transport(t) => format!("couldn't reach the Hyde Code hub: {t}"),
    }
}

pub fn state(hub: &Hub) -> Result<Value, String> {
    agent(Duration::from_secs(8))
        .get(&format!("{}/api/state", hub.url()))
        .set("Authorization", &auth(hub)?)
        .call()
        .map_err(hub_error)?
        .into_json()
        .map_err(|e| format!("invalid hub state: {e}"))
}

/// Sends a hub command such as `/new add a footer #site` and returns the hub's reply text.
pub fn command(hub: &Hub, text: &str) -> Result<String, String> {
    let reply: Value = agent(Duration::from_secs(30))
        .post(&format!("{}/api/commands", hub.url()))
        .set("Authorization", &auth(hub)?)
        .send_json(json!({ "text": text }))
        .map_err(hub_error)?
        .into_json()
        .map_err(|e| format!("invalid hub reply: {e}"))?;
    Ok(reply
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned())
}

/// Starts the hub in the background through Hyde Code's own CLI and waits until it answers.
pub fn start(hub: &Hub) -> Result<String, String> {
    if is_up(hub) {
        return Ok("Hyde Code hub is already running".into());
    }
    let cli = hub.cli.clone().ok_or(
        "Hyde Code isn't installed on PATH. In the Hyde Code folder run `pnpm install-cli`.",
    )?;
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

pub fn ensure_up(hub: &Hub) -> Result<(), String> {
    if is_up(hub) {
        Ok(())
    } else {
        start(hub).map(|_| ())
    }
}

pub fn office_url(hub: &Hub, project: Option<&str>) -> Result<String, String> {
    let token = hub
        .token
        .as_ref()
        .ok_or("Hyde Code's owner token wasn't found")?;
    let mut url = format!("{}/login?token={token}", hub.url());
    if let Some(project) = project.filter(|p| !p.is_empty()) {
        url.push_str(&format!("&project={}", crate::agent::url_encode(project)));
    }
    Ok(url)
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
                ],
            )
        })
        .collect();
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
    let mut lines = vec![format!(
        "**Hyde Code** — {} running, {} waiting for you, {} ready for merge.",
        count("running") + count("verifying") + count("reviewing"),
        count("blocked"),
        count("awaiting_merge")
    )];
    for q in summary["questions"]
        .as_array()
        .into_iter()
        .flatten()
        .take(5)
    {
        lines.push(format!(
            "- **{}** ({}) asks: {}",
            q["id"].as_str().unwrap_or("?"),
            q["taskId"].as_str().unwrap_or("?"),
            q["text"].as_str().unwrap_or("")
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
    for t in summary["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| t["status"] == "running")
        .take(5)
    {
        lines.push(format!(
            "- {} is working on **{}**: {}",
            t["agent"].as_str().unwrap_or("an agent"),
            t["id"].as_str().unwrap_or("?"),
            t["title"].as_str().unwrap_or("")
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
    fn extracts_task_ids() {
        assert_eq!(task_id("Created T-12 in #site").as_deref(), Some("T-12"));
        assert_eq!(task_id("nothing"), None);
        assert_eq!(task_id("OUT-3 then T-7"), Some("T-7".into()));
    }
}
