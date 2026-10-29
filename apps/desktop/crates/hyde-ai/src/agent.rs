//! The agent: deterministic matching first, the AI engine second, and an executor that
//! only ever runs actions defined in the pack.

use crate::config::{config_dir, Config};
use crate::hydecode;
use crate::llm::{self, Message, Route};
use crate::tools::{self, Jobs};
use hyde_core::{
    AppEntry, Context, Decision, Matcher, Pack, PatternToken, Plan, Risk, SlotKind, SlotValue, Task,
};
use hyde_pack::Source;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DEFAULT_INTENTS: &[(&str, &str)] = &[
    (
        "10-apps.toml",
        include_str!("../../../data/intents/10-apps.toml"),
    ),
    (
        "20-system.toml",
        include_str!("../../../data/intents/20-system.toml"),
    ),
    (
        "30-web.toml",
        include_str!("../../../data/intents/30-web.toml"),
    ),
    (
        "40-tools.toml",
        include_str!("../../../data/intents/40-tools.toml"),
    ),
    (
        "50-assistant.toml",
        include_str!("../../../data/intents/50-assistant.toml"),
    ),
    (
        "60-code.toml",
        include_str!("../../../data/intents/60-code.toml"),
    ),
];
const DEFAULT_APPS: &str = include_str!("../../../data/apps.toml");

const PENDING_TTL: Duration = Duration::from_secs(600);
const MAX_HISTORY: usize = 100;
const MAX_CHAT: usize = 12;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn next_id() -> u64 {
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Loads the command pack: either one data directory, or the built-in pack plus the user's
/// extra intents in `~/.config/hyde-ai/intents/` and an optional `apps.toml` override.
pub fn load_pack(data_dir: Option<&Path>) -> Result<Pack, String> {
    if let Some(dir) = data_dir {
        return hyde_pack::compile_directory(dir).map_err(|error| error.to_string());
    }
    let mut intents: Vec<Source> = DEFAULT_INTENTS
        .iter()
        .map(|(name, text)| Source::new(format!("built-in/{name}"), *text))
        .collect();
    let user_dir = config_dir();
    if let Ok(entries) = std::fs::read_dir(user_dir.join("intents")) {
        let mut paths: Vec<_> = entries
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("toml"))
            .collect();
        paths.sort();
        for path in paths {
            let text = std::fs::read_to_string(&path)
                .map_err(|error| format!("{}: {error}", path.display()))?;
            intents.push(Source::new(path.display().to_string(), text));
        }
    }
    let user_apps = user_dir.join("apps.toml");
    let apps = match std::fs::read_to_string(&user_apps) {
        Ok(text) => Source::new(user_apps.display().to_string(), text),
        Err(_) => Source::new("built-in/apps.toml", DEFAULT_APPS),
    };
    hyde_pack::compile_sources(&intents, Some(&apps)).map_err(|error| error.to_string())
}

// ---------------------------------------------------------------- views sent to the UI

#[derive(Clone, Debug, Serialize)]
pub struct TaskView {
    pub id: u32,
    pub action: String,
    pub label: String,
    pub risk: &'static str,
    pub depends_on: Vec<u32>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PlanView {
    pub score: f32,
    pub intents: Vec<String>,
    pub explanation: String,
    pub tasks: Vec<TaskView>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TaskOutcome {
    pub task_id: u32,
    pub success: bool,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Done,
    Partial,
    Failed,
    Confirm,
    Answer,
    Unknown,
    Cancelled,
}

#[derive(Clone, Debug, Serialize)]
pub struct Reply {
    pub id: u64,
    pub input: String,
    pub status: Status,
    /// Assistant-facing text (markdown for AI answers).
    pub text: String,
    /// `rules` when the deterministic engine understood the request, `ai` when the AI engine helped.
    pub source: &'static str,
    /// For AI-routed requests: the command phrase the AI produced.
    pub rewritten: Option<String>,
    pub plan: Option<PlanView>,
    pub results: Vec<TaskOutcome>,
    pub pending_id: Option<u64>,
    pub job_ids: Vec<u64>,
    pub at: u64,
}

impl Reply {
    fn new(input: &str, status: Status, text: impl Into<String>) -> Self {
        Self {
            id: next_id(),
            input: input.to_owned(),
            status,
            text: text.into(),
            source: "rules",
            rewritten: None,
            plan: None,
            results: Vec::new(),
            pending_id: None,
            job_ids: Vec::new(),
            at: now_secs(),
        }
    }
}

// ---------------------------------------------------------------- shared state

struct Pending {
    plan: Plan,
    input: String,
    source: &'static str,
    rewritten: Option<String>,
    created: Instant,
}

pub struct Agent {
    pub pack: Pack,
    context: Context,
    usage: BTreeMap<String, u32>,
    pending: BTreeMap<u64, Pending>,
    chat: Vec<Message>,
    pub history: Vec<Reply>,
}

impl Agent {
    pub fn new(pack: Pack) -> Self {
        Self {
            pack,
            context: Context::default(),
            usage: BTreeMap::new(),
            pending: BTreeMap::new(),
            chat: Vec::new(),
            history: Vec::new(),
        }
    }

    fn plan(&self, text: &str) -> Plan {
        Matcher::with_usage(&self.pack, self.usage.clone()).match_text(text, &self.context)
    }

    fn remember(&mut self, reply: &Reply) {
        self.history.push(reply.clone());
        if self.history.len() > MAX_HISTORY {
            let overflow = self.history.len() - MAX_HISTORY;
            self.history.drain(..overflow);
        }
        self.chat.push(Message::user(reply.input.clone()));
        self.chat.push(Message::assistant(reply.text.clone()));
        if self.chat.len() > MAX_CHAT {
            let overflow = self.chat.len() - MAX_CHAT;
            self.chat.drain(..overflow);
        }
    }

    fn find_app(&self, name: &str) -> Option<AppEntry> {
        self.pack
            .apps
            .iter()
            .find(|app| app.name == name || app.id == name)
            .cloned()
    }

    /// A compact command list the AI router uses to translate free text into commands.
    pub fn catalogue(&self) -> String {
        let mut lines = Vec::new();
        for intent in &self.pack.intents {
            let examples: Vec<String> = intent
                .patterns
                .iter()
                .take(3)
                .map(|p| render_pattern(p, &intent.triggers))
                .collect();
            lines.push(format!("- {}: {}", intent.id, examples.join(" | ")));
        }
        let apps: Vec<String> = self
            .pack
            .apps
            .iter()
            .map(|app| {
                app.aliases
                    .first()
                    .cloned()
                    .unwrap_or_else(|| app.name.to_lowercase())
            })
            .collect();
        lines.push(format!("Known <app> names: {}", apps.join(", ")));
        lines.push("<text> means free words, <number> a number.".into());
        lines.join("\n")
    }

    pub fn examples() -> Vec<&'static str> {
        vec![
            "open chrome and vs code",
            "set volume to 40",
            "search for rust async tutorials",
            "open spotify then volume 30",
            "install opencode",
            "start omniroute",
            "what time is it",
            "ask what is a monad",
            "hyde code add a dark mode toggle",
            "what is waiting for me",
        ]
    }
}

fn render_pattern(pattern: &[PatternToken], triggers: &[String]) -> String {
    pattern
        .iter()
        .map(|token| render_token(token, triggers))
        .collect::<Vec<_>>()
        .join(" ")
}

fn render_token(token: &PatternToken, triggers: &[String]) -> String {
    match token {
        PatternToken::Literal(word) => word.clone(),
        PatternToken::Optional(inner) => format!("[{}]", render_token(inner, triggers)),
        PatternToken::Slot { name, kind } => match kind {
            SlotKind::Enum(values) => format!("({})", values.join("|")),
            SlotKind::OneOrMore => "<app> [and <app>]".into(),
            SlotKind::Rest => "<text>".into(),
            SlotKind::Single if name == "trigger" => triggers.first().cloned().unwrap_or_default(),
            SlotKind::Single if name == "it" => "it".into(),
            SlotKind::Single => format!("<{name}>"),
        },
    }
}

pub struct Shared {
    pub agent: Mutex<Agent>,
    pub config: Mutex<Config>,
    pub jobs: Jobs,
    pub data_dir: Option<std::path::PathBuf>,
}

impl Shared {
    pub fn ai_config(&self) -> crate::config::AiConfig {
        self.config
            .lock()
            .map(|config| config.ai.clone())
            .unwrap_or_default()
    }
}

fn risk_str(risk: &Risk) -> &'static str {
    risk.as_str()
}

fn arg<'a>(task: &'a Task, name: &str) -> Option<&'a SlotValue> {
    task.args
        .iter()
        .find(|slot| slot.name == name)
        .map(|slot| &slot.value)
}

fn arg_text(task: &Task, name: &str) -> Option<String> {
    arg(task, name).map(SlotValue::as_text)
}

fn tool_name(id: &str) -> String {
    tools::spec(id)
        .map(|spec| spec.name.to_owned())
        .unwrap_or_else(|| id.to_owned())
}

pub fn label(task: &Task) -> String {
    let app = || {
        task.args
            .iter()
            .find_map(|slot| match &slot.value {
                SlotValue::App(app) => Some(app.name.clone()),
                SlotValue::Context(name) => Some(name.clone()),
                _ => None,
            })
            .unwrap_or_else(|| "app".into())
    };
    match task.action.as_str() {
        "app.open" => format!("Open {}", app()),
        "app.close" => format!("Close {}", app()),
        "sys.volume.set" => format!(
            "Set volume to {}%",
            arg_text(task, "number").unwrap_or_default()
        ),
        "sys.volume.step" => match arg_text(task, "dir").as_deref() {
            Some("down" | "quieter") => "Turn volume down".into(),
            _ => "Turn volume up".into(),
        },
        "sys.mute" => match arg_text(task, "state").as_deref() {
            Some("unmute") => "Unmute sound".into(),
            _ => "Mute sound".into(),
        },
        "sys.lock" => "Lock the screen".into(),
        "sys.time" => "Tell the time".into(),
        "web.search" => format!(
            "Search the web for “{}”",
            arg_text(task, "query").unwrap_or_default()
        ),
        "web.youtube" => format!(
            "Search YouTube for “{}”",
            arg_text(task, "query").unwrap_or_default()
        ),
        "web.open" => format!(
            "Open {}",
            site_url(&arg_text(task, "site").unwrap_or_default())
        ),
        "tool.install" => format!(
            "Install {}",
            tool_name(&arg_text(task, "tool").unwrap_or_default())
        ),
        "tool.launch" => format!(
            "Start {}",
            tool_name(&arg_text(task, "tool").unwrap_or_default())
        ),
        "ai.ask" => format!("Ask AI: {}", arg_text(task, "question").unwrap_or_default()),
        "hyde.help" => "Show what Hyde can do".into(),
        "code.task" => format!(
            "Give Hyde Code a task: {}",
            arg_text(task, "task").unwrap_or_default()
        ),
        "code.status" => "Check on Hyde Code".into(),
        "code.control" => {
            let verb = arg_text(task, "verb").unwrap_or_default();
            let target = arg_text(task, "ref")
                .map(|r| crate::hydecode::reference(&r).unwrap_or(r))
                .unwrap_or_default();
            let mut verb_title = verb.clone();
            if let Some(first) = verb_title.get_mut(0..1) {
                first.make_ascii_uppercase();
            }
            format!("{verb_title} {target} in Hyde Code")
        }
        "code.answer" => format!(
            "Answer Q-{}: {}",
            arg_text(task, "number").unwrap_or_default(),
            arg_text(task, "answer").unwrap_or_default()
        ),
        "code.open" => "Open the Hyde Code office".into(),
        "code.start" => "Start the Hyde Code hub".into(),
        other => other.to_owned(),
    }
}

fn plan_view(plan: &Plan) -> PlanView {
    PlanView {
        score: (plan.score * 100.0).round() / 100.0,
        intents: plan.intent_ids.clone(),
        explanation: plan.explanation.clone(),
        tasks: plan
            .tasks
            .iter()
            .map(|task| TaskView {
                id: task.id,
                action: task.action.clone(),
                label: label(task),
                risk: risk_str(&task.risk),
                depends_on: task.depends_on.clone(),
            })
            .collect(),
    }
}

// ---------------------------------------------------------------- request handling

pub fn handle(shared: &Shared, input: &str) -> Reply {
    let input = input.trim();
    if input.is_empty() {
        return Reply::new(input, Status::Unknown, "Type or say a command.");
    }
    let input: String = input.chars().take(2000).collect();
    let (plan, catalogue, chat) = {
        let agent = shared.agent.lock().expect("agent lock");
        (agent.plan(&input), agent.catalogue(), agent.chat.clone())
    };

    let reply = match plan.decision {
        Decision::Execute => execute(shared, &input, plan, "rules", None),
        Decision::Confirm if !plan.tasks.is_empty() => park(shared, &input, plan, "rules", None),
        _ => {
            let ai = shared.ai_config();
            if ai.is_ready() {
                route_with_ai(shared, &input, &ai, &catalogue, &chat)
            } else {
                let mut reply = Reply::new(
                    &input,
                    Status::Unknown,
                    "I don't have a command for that yet. Try one of the examples, or connect a free AI engine (AI engine tab) so I can handle open-ended requests.",
                );
                if !plan.intent_ids.is_empty() {
                    reply.plan = Some(plan_view(&plan));
                }
                reply
            }
        }
    };
    shared.agent.lock().expect("agent lock").remember(&reply);
    reply
}

fn route_with_ai(
    shared: &Shared,
    input: &str,
    ai: &crate::config::AiConfig,
    catalogue: &str,
    chat: &[Message],
) -> Reply {
    match llm::route(ai, catalogue, chat, input) {
        Ok(Route::Answer(text)) => {
            let mut reply = Reply::new(input, Status::Answer, text);
            reply.source = "ai";
            reply
        }
        Ok(Route::Command(command)) => {
            let plan = shared.agent.lock().expect("agent lock").plan(&command);
            let low_risk = plan.tasks.iter().all(|task| matches!(task.risk, Risk::L0));
            match plan.decision {
                Decision::Execute if low_risk => execute(shared, input, plan, "ai", Some(command)),
                Decision::Execute | Decision::Confirm if !plan.tasks.is_empty() => {
                    park(shared, input, plan, "ai", Some(command))
                }
                _ => {
                    let mut reply = Reply::new(
                        input,
                        Status::Unknown,
                        format!("The AI suggested “{command}”, but that isn't a command I can run safely."),
                    );
                    reply.source = "ai";
                    reply.rewritten = Some(command);
                    reply
                }
            }
        }
        Err(error) => {
            let mut reply = Reply::new(input, Status::Failed, format!("AI engine error: {error}"));
            reply.source = "ai";
            reply
        }
    }
}

fn park(
    shared: &Shared,
    input: &str,
    plan: Plan,
    source: &'static str,
    rewritten: Option<String>,
) -> Reply {
    let id = next_id();
    let mut reply = Reply::new(input, Status::Confirm, confirm_text(&plan));
    reply.plan = Some(plan_view(&plan));
    reply.source = source;
    reply.rewritten = rewritten.clone();
    reply.pending_id = Some(id);
    let mut agent = shared.agent.lock().expect("agent lock");
    agent
        .pending
        .retain(|_, pending| pending.created.elapsed() < PENDING_TTL);
    agent.pending.insert(
        id,
        Pending {
            plan,
            input: input.to_owned(),
            source,
            rewritten,
            created: Instant::now(),
        },
    );
    reply
}

fn confirm_text(plan: &Plan) -> String {
    if plan
        .tasks
        .iter()
        .all(|task| task.action.starts_with("code."))
    {
        return "This goes to your coding agents in Hyde Code. Confirm to send it.".into();
    }
    let risky = plan
        .tasks
        .iter()
        .any(|task| matches!(task.risk, Risk::L2 | Risk::L3));
    if risky {
        "This changes your system. Review the plan and confirm to run it.".into()
    } else if plan.score < 0.8 {
        "I'm not fully sure I understood. Is this what you meant?".into()
    } else {
        "Confirm to run this plan.".into()
    }
}

pub fn confirm(shared: &Shared, pending_id: u64, approve: bool) -> Reply {
    let pending = shared
        .agent
        .lock()
        .expect("agent lock")
        .pending
        .remove(&pending_id);
    let reply = match pending {
        Some(pending) if pending.created.elapsed() < PENDING_TTL => {
            if approve {
                execute(
                    shared,
                    &pending.input,
                    pending.plan,
                    pending.source,
                    pending.rewritten,
                )
            } else {
                let mut reply = Reply::new(
                    &pending.input,
                    Status::Cancelled,
                    "Cancelled. Nothing was run.",
                );
                reply.plan = Some(plan_view(&pending.plan));
                reply.source = pending.source;
                reply
            }
        }
        _ => Reply::new(
            "",
            Status::Failed,
            "That request expired. Please ask again.",
        ),
    };
    let mut agent = shared.agent.lock().expect("agent lock");
    agent.history.push(reply.clone());
    reply
}

fn execute(
    shared: &Shared,
    input: &str,
    plan: Plan,
    source: &'static str,
    rewritten: Option<String>,
) -> Reply {
    let mut results: Vec<TaskOutcome> = Vec::new();
    let mut answers: Vec<String> = Vec::new();
    let mut job_ids = Vec::new();
    let mut failed_ids = Vec::new();
    for task in &plan.tasks {
        if task.depends_on.iter().any(|dep| failed_ids.contains(dep)) {
            failed_ids.push(task.id);
            results.push(TaskOutcome {
                task_id: task.id,
                success: false,
                message: "skipped because an earlier step failed".into(),
            });
            continue;
        }
        let outcome = run_task(shared, task);
        if !outcome.success {
            failed_ids.push(task.id);
        }
        if let Some(answer) = outcome.answer {
            answers.push(answer);
        }
        if let Some(job) = outcome.job_id {
            job_ids.push(job);
        }
        results.push(TaskOutcome {
            task_id: task.id,
            success: outcome.success,
            message: outcome.message,
        });
    }
    if results.iter().any(|r| r.success) {
        // Usage nudges the matcher's prior toward intents the user actually runs.
        let mut agent = shared.agent.lock().expect("agent lock");
        for intent in &plan.intent_ids {
            *agent.usage.entry(intent.clone()).or_default() += 1;
        }
    }

    let ok = results.iter().filter(|r| r.success).count();
    let status = if ok == results.len() {
        if answers.is_empty() {
            Status::Done
        } else {
            Status::Answer
        }
    } else if ok == 0 {
        Status::Failed
    } else {
        Status::Partial
    };
    let text = if !answers.is_empty() {
        answers.join("\n\n")
    } else {
        results
            .iter()
            .map(|r| r.message.clone())
            .collect::<Vec<_>>()
            .join(" · ")
    };
    let mut reply = Reply::new(input, status, text);
    reply.plan = Some(plan_view(&plan));
    reply.results = results;
    reply.source = source;
    reply.rewritten = rewritten;
    reply.job_ids = job_ids;
    reply
}

struct RunResult {
    success: bool,
    message: String,
    answer: Option<String>,
    job_id: Option<u64>,
}

impl RunResult {
    fn ok(message: impl Into<String>) -> Self {
        Self {
            success: true,
            message: message.into(),
            answer: None,
            job_id: None,
        }
    }
    fn err(message: impl Into<String>) -> Self {
        Self {
            success: false,
            message: message.into(),
            answer: None,
            job_id: None,
        }
    }
    fn from(result: Result<String, String>) -> Self {
        match result {
            Ok(message) => Self::ok(message),
            Err(message) => Self::err(message),
        }
    }
}

fn run_task(shared: &Shared, task: &Task) -> RunResult {
    match task.action.as_str() {
        "app.open" => {
            let Some(app) = task.args.iter().find_map(|slot| match &slot.value {
                SlotValue::App(app) => Some(app.clone()),
                _ => None,
            }) else {
                return RunResult::err("no app named");
            };
            let result = open_app(&app);
            if result.is_ok() {
                shared.agent.lock().expect("agent lock").context.last_app = Some(app.clone());
            }
            RunResult::from(result)
        }
        "app.close" => {
            let app = task.args.iter().find_map(|slot| match &slot.value {
                SlotValue::App(app) => Some(app.clone()),
                SlotValue::Context(name) => shared.agent.lock().expect("agent lock").find_app(name),
                _ => None,
            });
            match app {
                Some(app) => RunResult::from(close_app(&app)),
                None => RunResult::err("I don't know which app to close"),
            }
        }
        "sys.volume.set" => match arg(task, "number") {
            Some(SlotValue::Number(n)) => RunResult::from(set_volume(*n)),
            _ => RunResult::err("missing volume level"),
        },
        "sys.volume.step" => {
            let up = !matches!(arg_text(task, "dir").as_deref(), Some("down" | "quieter"));
            RunResult::from(step_volume(up))
        }
        "sys.mute" => RunResult::from(set_mute(
            arg_text(task, "state").as_deref() != Some("unmute"),
        )),
        "sys.lock" => RunResult::from(
            run_quiet("loginctl", &["lock-session"]).map(|_| "Screen locked".to_string()),
        ),
        "sys.time" => {
            let text = Command::new("date")
                .arg("+%A, %-d %B %Y · %H:%M")
                .output()
                .ok()
                .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned())
                .filter(|text| !text.is_empty())
                .unwrap_or_else(|| "I couldn't read the clock".into());
            RunResult {
                success: true,
                message: "Told the time".into(),
                answer: Some(format!("It's **{text}**.")),
                job_id: None,
            }
        }
        "web.search" => {
            let query = arg_text(task, "query").unwrap_or_default();
            RunResult::from(
                tools::open_url(&format!(
                    "https://www.google.com/search?q={}",
                    url_encode(&query)
                ))
                .map(|_| format!("Searched for “{query}”")),
            )
        }
        "web.youtube" => {
            let query = arg_text(task, "query").unwrap_or_default();
            RunResult::from(
                tools::open_url(&format!(
                    "https://www.youtube.com/results?search_query={}",
                    url_encode(&query)
                ))
                .map(|_| format!("Searched YouTube for “{query}”")),
            )
        }
        "web.open" => {
            let url = site_url(&arg_text(task, "site").unwrap_or_default());
            RunResult::from(tools::open_url(&url).map(|_| format!("Opened {url}")))
        }
        "tool.install" => {
            let tool = arg_text(task, "tool").unwrap_or_default();
            match shared.jobs.start_install(&tool) {
                Ok(id) => RunResult {
                    success: true,
                    message: format!("Installing {}…", tool_name(&tool)),
                    answer: None,
                    job_id: Some(id),
                },
                Err(error) => RunResult::err(error),
            }
        }
        "tool.launch" => RunResult::from(tools::launch_tool(
            &arg_text(task, "tool").unwrap_or_default(),
        )),
        "ai.ask" => {
            let ai = shared.ai_config();
            if !ai.is_ready() {
                return RunResult::err(
                    "No AI engine is set up yet. Open the AI engine tab to connect a free one.",
                );
            }
            let question = arg_text(task, "question").unwrap_or_default();
            let chat = shared.agent.lock().expect("agent lock").chat.clone();
            match llm::ask(&ai, &chat, &question) {
                Ok(answer) => RunResult {
                    success: true,
                    message: "Answered".into(),
                    answer: Some(answer),
                    job_id: None,
                },
                Err(error) => RunResult::err(format!("AI engine error: {error}")),
            }
        }
        "hyde.help" => RunResult {
            success: true,
            message: "Listed commands".into(),
            answer: Some(help_text()),
            job_id: None,
        },
        "code.task" => {
            let text = arg_text(task, "task").unwrap_or_default();
            let default = shared
                .config
                .lock()
                .map(|c| c.code.default_project.clone())
                .unwrap_or_default();
            match code_task(&text, None, None, &default) {
                Ok(message) => RunResult::ok(message),
                Err(error) => RunResult::err(error),
            }
        }
        "code.status" => {
            let hub = hydecode::discover();
            let default = shared
                .config
                .lock()
                .map(|c| c.code.default_project.clone())
                .unwrap_or_default();
            let summary = hydecode::summary(&hub, &default);
            RunResult {
                success: true,
                message: "Checked Hyde Code".into(),
                answer: Some(hydecode::status_text(&summary)),
                job_id: None,
            }
        }
        "code.control" => {
            let verb = arg_text(task, "verb").unwrap_or_default();
            let raw = arg_text(task, "ref").unwrap_or_default();
            let target = if verb == "stop" && raw.trim() == "all" {
                Some("all".to_string())
            } else {
                hydecode::reference(&raw)
            };
            match target {
                Some(target) => RunResult::from(code_command(&format!("/{verb} {target}"))),
                None => RunResult::err(format!("I couldn't read “{raw}” as a task, question or approval id. Say it like “{verb} T 4”.")),
            }
        }
        "code.answer" => {
            let number = arg_text(task, "number").unwrap_or_default();
            let answer = arg_text(task, "answer").unwrap_or_default();
            RunResult::from(code_command(&format!("/answer Q-{number} {answer}")))
        }
        "code.open" => {
            let hub = hydecode::discover();
            let default = shared
                .config
                .lock()
                .map(|c| c.code.default_project.clone())
                .unwrap_or_default();
            RunResult::from(hydecode::ensure_up(&hub).and_then(|hub| {
                let url = hydecode::office_url(&hub, Some(&default))?;
                tools::open_url(&url).map(|_| "Opened the Hyde Code office".to_string())
            }))
        }
        "code.start" => RunResult::from(hydecode::start(&hydecode::discover())),
        other => RunResult::err(format!("unsupported action `{other}`")),
    }
}

fn help_text() -> String {
    "Here's what I can do:\n\n\
- **Apps** — “open chrome and vs code”, “close it”, “quit spotify”\n\
- **Sound** — “set volume to 40”, “volume up”, “mute”\n\
- **Web** — “search for rust tutorials”, “play lofi on youtube”, “go to github”\n\
- **Coding agents (Hyde Code)** — “hyde code add a footer in my site”, “ask hyde code to fix the login bug using codex”, “what is waiting for me”, “approve A 2”, “answer Q 3 use postgres”, “merge T 4”, “open hyde code”\n\
- **AI tools** — “install opencode”, “install omniroute”, “start omniroute”, “open opencode”\n\
- **System** — “lock the screen”, “what time is it”\n\
- **Chain steps** — “open spotify then volume 30”\n\n\
With an AI engine connected, you can also ask anything in plain words."
        .into()
}

fn run_quiet(program: &str, args: &[&str]) -> Result<(), String> {
    let path = tools::which(program).ok_or_else(|| format!("`{program}` is not installed"))?;
    let status = Command::new(path)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("{program}: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{program} failed ({status})"))
    }
}

fn open_app(app: &AppEntry) -> Result<String, String> {
    let path = tools::which(&app.command).ok_or_else(|| {
        format!(
            "{} isn't installed (looked for `{}`)",
            app.name, app.command
        )
    })?;
    Command::new(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .current_dir(crate::config::home_dir())
        .spawn()
        .map(|_| format!("Opened {}", app.name))
        .map_err(|error| format!("couldn't open {}: {error}", app.name))
}

fn close_app(app: &AppEntry) -> Result<String, String> {
    let base = Path::new(&app.command)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&app.command)
        .to_owned();
    // Exact process names only (`pkill -x`), so "code" never matches unrelated processes.
    let mut names = vec![base.clone()];
    if let Some(stripped) = base.strip_prefix("google-") {
        names.push(stripped.to_owned());
    }
    names.push(format!("{base}-bin"));
    let pkill = tools::which("pkill").ok_or("`pkill` is not installed")?;
    for name in names {
        let status = Command::new(&pkill)
            .args(["-x", &name])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if matches!(status, Ok(s) if s.success()) {
            return Ok(format!("Closed {}", app.name));
        }
    }
    Err(format!("{} doesn't seem to be running", app.name))
}

fn set_volume(level: i64) -> Result<String, String> {
    let level = level.clamp(0, 100);
    let percent = format!("{level}%");
    run_quiet("wpctl", &["set-volume", "@DEFAULT_AUDIO_SINK@", &percent])
        .or_else(|_| run_quiet("pactl", &["set-sink-volume", "@DEFAULT_SINK@", &percent]))
        .map(|_| format!("Volume set to {level}%"))
}

fn step_volume(up: bool) -> Result<String, String> {
    let step = if up { "10%+" } else { "10%-" };
    let pactl_step = if up { "+10%" } else { "-10%" };
    run_quiet(
        "wpctl",
        &["set-volume", "-l", "1.0", "@DEFAULT_AUDIO_SINK@", step],
    )
    .or_else(|_| run_quiet("pactl", &["set-sink-volume", "@DEFAULT_SINK@", pactl_step]))
    .map(|_| {
        if up {
            "Volume up".to_string()
        } else {
            "Volume down".to_string()
        }
    })
}

fn set_mute(mute: bool) -> Result<String, String> {
    let flag = if mute { "1" } else { "0" };
    run_quiet("wpctl", &["set-mute", "@DEFAULT_AUDIO_SINK@", flag])
        .or_else(|_| run_quiet("pactl", &["set-sink-mute", "@DEFAULT_SINK@", flag]))
        .map(|_| {
            if mute {
                "Muted".to_string()
            } else {
                "Unmuted".to_string()
            }
        })
}

/// Normalized speech turns "github.com" into "github com"; rebuild a URL from the words.
pub fn site_url(words: &str) -> String {
    let parts: Vec<&str> = words.split_whitespace().filter(|w| *w != "dot").collect();
    if parts.is_empty() {
        return "https://www.google.com".into();
    }
    let tlds = [
        "com", "org", "net", "io", "dev", "ai", "app", "in", "co", "uk", "edu", "gov", "me", "tv",
    ];
    let host = if parts.len() > 1 && tlds.contains(parts.last().unwrap()) {
        parts.join(".")
    } else {
        format!("{}.com", parts.join(""))
    };
    format!("https://{host}")
}

pub fn url_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 3);
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

// ---------------------------------------------------------------- Hyde Code bridge

/// Sends a hub command (starting the hub first if needed) and returns its reply.
pub fn code_command(text: &str) -> Result<String, String> {
    let hub = hydecode::ensure_up(&hydecode::discover())?;
    let reply = hydecode::run_command(&hub, text)?;
    Ok(if reply.is_empty() {
        "Done".into()
    } else {
        reply
    })
}

/// Creates a Hyde Code task. Project: explicit > named at the end of the text > default > the only one.
/// Agent: explicit > "… using codex" at the end of the text.
pub fn code_task(
    text: &str,
    project: Option<&str>,
    agent: Option<&str>,
    default_project: &str,
) -> Result<String, String> {
    let text = text.trim().trim_start_matches('/').trim();
    if text.len() < 3 {
        return Err(
            "Tell me what Hyde Code should do, e.g. “hyde code add a footer in my site”.".into(),
        );
    }
    let hub = hydecode::ensure_up(&hydecode::discover())?;
    let state = hydecode::state(&hub)?;
    let projects = hydecode::projects(&state);
    if projects.is_empty() {
        return Err("Hyde Code has no projects yet. Open a terminal in a project folder and run `hyde` once.".into());
    }

    let (mut body, agent_tag) = split_agent(text, &state);
    let agent_tag = agent
        .map(str::to_owned)
        .filter(|a| !a.is_empty())
        .or(agent_tag);
    let project_id = match project.filter(|p| !p.is_empty()) {
        Some(p) => Some(p.to_owned()),
        None => {
            let (rest, named) = hydecode::split_project(&body, &projects);
            if named.is_some() {
                body = rest;
            }
            named
        }
    }
    .or_else(|| (!default_project.is_empty()).then(|| default_project.to_owned()))
    .or_else(|| (projects.len() == 1).then(|| projects[0].id.clone()));
    let project_list = || {
        projects
            .iter()
            .map(|p| format!("“{}”", p.name))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let Some(project_id) = project_id else {
        return Err(format!(
            "Which project? End with “in <project>”, or set a default in the Hyde Code tab. Projects: {}.",
            project_list()
        ));
    };
    // Keep the task text from being read as trailing #project / @agent tags by the hub.
    let body = body.trim().trim_end_matches(['#', '@']).to_string();

    if hydecode::typed(&hub) {
        let request_id = format!("hyde-ai-{}-{}", std::process::id(), next_id());
        return match hydecode::create_task(
            &hub,
            &body,
            Some(&project_id),
            agent_tag.as_deref(),
            &request_id,
        ) {
            Ok(task) => Ok(format!(
                "Hyde Code created **{}** in #{} ({}). {}",
                task.id,
                task.project_id,
                task.status.replace('_', " "),
                task.text
            )
            .trim()
            .to_owned()),
            Err(error) if error.code.as_deref() == Some("project") => {
                // Decide on the machine `code` only; the hub's wording is for people and may change.
                Err(format!(
                    "Hyde Code couldn't match “{project_id}” to one project. Projects: {}.",
                    project_list()
                ))
            }
            Err(error) => Err(error.message),
        };
    }

    // Older hubs: the chat command.
    if !projects.iter().any(|p| p.id == project_id) {
        return Err(format!("Hyde Code has no project `{project_id}`."));
    }
    let mut command = format!("/new {body} #{project_id}");
    if let Some(agent) = agent_tag {
        command.push_str(&format!(" @{agent}"));
    }
    let reply = hydecode::command(&hub, &command)?;
    Ok(match hydecode::task_id(&reply) {
        Some(id) => format!("Hyde Code created {id} in #{project_id}. {reply}")
            .trim()
            .to_owned(),
        None if reply.is_empty() => format!("Sent to Hyde Code (#{project_id})"),
        None => reply,
    })
}

/// "… using codex" / "… with opencode" → (text without the suffix, agent profile name).
fn split_agent(text: &str, state: &serde_json::Value) -> (String, Option<String>) {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.len() < 3 {
        return (text.to_owned(), None);
    }
    let (joiner, name) = (
        words[words.len() - 2].to_lowercase(),
        words[words.len() - 1].to_lowercase(),
    );
    if !matches!(joiner.as_str(), "using" | "with" | "via" | "by") {
        return (text.to_owned(), None);
    }
    let agents = state
        .get("agents")
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default();
    let found = agents.iter().find_map(|a| {
        let profile = a.get("name")?.as_str()?;
        let adapter = a.get("adapter").and_then(|x| x.as_str()).unwrap_or("");
        let base = adapter.split('-').next().unwrap_or(adapter);
        (profile.eq_ignore_ascii_case(&name)
            || adapter.eq_ignore_ascii_case(&name)
            || base.eq_ignore_ascii_case(&name)
            || profile.to_lowercase().starts_with(&format!("{name}-")))
        .then(|| profile.to_owned())
    });
    match found {
        Some(profile) => (words[..words.len() - 2].join(" "), Some(profile)),
        None => (text.to_owned(), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent() -> Agent {
        Agent::new(load_pack(None).expect("built-in pack compiles"))
    }

    fn decide(agent: &Agent, text: &str) -> (Decision, Vec<String>) {
        let plan = agent.plan(text);
        (plan.decision, plan.tasks.iter().map(label).collect())
    }

    #[test]
    fn builtin_pack_understands_common_requests() {
        let agent = agent();
        let cases: &[(&str, Decision, &[&str])] = &[
            (
                "open chrome and vs code",
                Decision::Execute,
                &["Open Google Chrome", "Open Visual Studio Code"],
            ),
            (
                "please launch spotify",
                Decision::Execute,
                &["Open Spotify"],
            ),
            (
                "set volume to forty",
                Decision::Execute,
                &["Set volume to 40%"],
            ),
            ("volume up", Decision::Execute, &["Turn volume up"]),
            ("mute", Decision::Execute, &["Mute sound"]),
            (
                "search for rust async tutorials",
                Decision::Execute,
                &["Search the web for “rust async tutorials”"],
            ),
            ("install opencode", Decision::Confirm, &["Install OpenCode"]),
            (
                "install omniroute",
                Decision::Confirm,
                &["Install OmniRoute"],
            ),
            ("start omniroute", Decision::Execute, &["Start OmniRoute"]),
            ("open opencode", Decision::Execute, &["Start OpenCode"]),
            ("what time is it", Decision::Execute, &["Tell the time"]),
            (
                "go to github com",
                Decision::Execute,
                &["Open https://github.com"],
            ),
            ("help", Decision::Execute, &["Show what Hyde can do"]),
            (
                "hyde code add a footer in my site",
                Decision::Confirm,
                &["Give Hyde Code a task: add a footer in my site"],
            ),
            (
                "ask hyde code to fix the login bug",
                Decision::Confirm,
                &["Give Hyde Code a task: fix the login bug"],
            ),
            (
                "hyde code status",
                Decision::Execute,
                &["Check on Hyde Code"],
            ),
            (
                "what is waiting for me",
                Decision::Execute,
                &["Check on Hyde Code"],
            ),
            (
                "approve a 2",
                Decision::Confirm,
                &["Approve A-2 in Hyde Code"],
            ),
            (
                "merge task t 4",
                Decision::Confirm,
                &["Merge T-4 in Hyde Code"],
            ),
            (
                "answer q 3 use postgres",
                Decision::Confirm,
                &["Answer Q-3: use postgres"],
            ),
            (
                "open hyde code",
                Decision::Execute,
                &["Open the Hyde Code office"],
            ),
            (
                "start hyde code",
                Decision::Execute,
                &["Start the Hyde Code hub"],
            ),
            ("open code", Decision::Execute, &["Open Visual Studio Code"]),
        ];
        for (input, decision, labels) in cases {
            let (got, got_labels) = decide(&agent, input);
            assert_eq!(
                &got, decision,
                "decision for `{input}` (labels {got_labels:?})"
            );
            assert_eq!(
                got_labels,
                labels.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
                "labels for `{input}`"
            );
        }
    }

    #[test]
    fn sequences_and_unknowns() {
        let agent = agent();
        let plan = agent.plan("open spotify then volume 30");
        assert_eq!(plan.decision, Decision::Execute);
        assert_eq!(plan.tasks.len(), 2);
        assert_eq!(plan.tasks[1].depends_on, vec![plan.tasks[0].id]);
        assert_eq!(agent.plan("make me a sandwich").decision, Decision::Reject);
    }

    #[test]
    fn catalogue_mentions_tools() {
        let catalogue = agent().catalogue();
        assert!(
            catalogue.contains("install (opencode|omniroute)"),
            "{catalogue}"
        );
    }

    #[test]
    fn urls() {
        assert_eq!(site_url("github com"), "https://github.com");
        assert_eq!(site_url("youtube"), "https://youtube.com");
        assert_eq!(url_encode("a b&c"), "a+b%26c");
    }
}
