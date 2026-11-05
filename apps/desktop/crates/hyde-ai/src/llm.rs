//! OpenAI-compatible chat client. Every supported engine (OmniRoute, OpenRouter, Groq,
//! Gemini, Ollama) speaks the same `/chat/completions` and `/models` API.

use crate::config::AiConfig;
use serde::Serialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Serialize)]
pub struct Provider {
    pub id: &'static str,
    pub name: &'static str,
    pub base_url: &'static str,
    pub default_model: &'static str,
    pub needs_key: bool,
    pub local: bool,
    pub key_url: &'static str,
    pub note: &'static str,
}

pub const PROVIDERS: &[Provider] = &[
    Provider {
        id: "omniroute",
        name: "OmniRoute",
        base_url: "http://localhost:20128/v1",
        default_model: "",
        needs_key: false,
        local: true,
        key_url: "http://localhost:20128",
        note: "Local router that pools free providers behind one endpoint. Install it from the Tools tab, then add providers in its dashboard.",
    },
    Provider {
        id: "openrouter",
        name: "OpenRouter",
        base_url: "https://openrouter.ai/api/v1",
        default_model: "meta-llama/llama-3.3-70b-instruct:free",
        needs_key: true,
        local: false,
        key_url: "https://openrouter.ai/keys",
        note: "Many models with a `:free` suffix. Free key, rate limited.",
    },
    Provider {
        id: "groq",
        name: "Groq",
        base_url: "https://api.groq.com/openai/v1",
        default_model: "llama-3.3-70b-versatile",
        needs_key: true,
        local: false,
        key_url: "https://console.groq.com/keys",
        note: "Very fast Llama and Qwen models on a free tier.",
    },
    Provider {
        id: "gemini",
        name: "Google Gemini",
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        default_model: "gemini-2.5-flash",
        needs_key: true,
        local: false,
        key_url: "https://aistudio.google.com/apikey",
        note: "Generous free tier through Google AI Studio.",
    },
    Provider {
        id: "ollama",
        name: "Ollama",
        base_url: "http://localhost:11434/v1",
        default_model: "llama3.2",
        needs_key: false,
        local: true,
        key_url: "https://ollama.com/download",
        note: "Runs models fully offline on this computer.",
    },
    Provider {
        id: "custom",
        name: "Custom",
        base_url: "",
        default_model: "",
        needs_key: false,
        local: false,
        key_url: "",
        note: "Any OpenAI-compatible endpoint.",
    },
];

#[derive(Clone, Debug, Serialize)]
pub struct Message {
    pub role: &'static str,
    pub content: String,
}

impl Message {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: "system",
            content: content.into(),
        }
    }
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: "user",
            content: content.into(),
        }
    }
    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: "assistant",
            content: content.into(),
        }
    }
}

fn endpoint(base_url: &str, path: &str) -> String {
    format!("{}/{}", base_url.trim().trim_end_matches('/'), path)
}

fn with_auth(request: ureq::Request, api_key: &str) -> ureq::Request {
    let request = request.set("User-Agent", concat!("hyde-ai/", env!("CARGO_PKG_VERSION")));
    if api_key.trim().is_empty() {
        request
    } else {
        request.set("Authorization", &format!("Bearer {}", api_key.trim()))
    }
}

fn describe_error(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(code, response) => {
            let body = response.into_string().unwrap_or_default();
            let detail = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|value| {
                    value
                        .pointer("/error/message")
                        .or_else(|| value.pointer("/error"))
                        .or_else(|| value.pointer("/message"))
                        .map(|v| {
                            v.as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| v.to_string())
                        })
                })
                .unwrap_or_else(|| body.chars().take(200).collect());
            match code {
                401 | 403 => format!("the API key was rejected ({code}): {detail}"),
                404 => format!("endpoint or model not found (404): {detail}"),
                429 => format!("rate limited by the provider (429): {detail}"),
                _ => format!("provider returned {code}: {detail}"),
            }
        }
        ureq::Error::Transport(transport) => {
            format!("could not reach the AI engine: {transport}")
        }
    }
}

pub fn chat(config: &AiConfig, messages: &[Message], temperature: f32) -> Result<String, String> {
    let body = json!({
        "model": config.model.trim(),
        "messages": messages,
        "temperature": temperature,
        "stream": false,
    });
    let request = ureq::post(&endpoint(&config.base_url, "chat/completions"))
        .timeout(Duration::from_secs(90));
    let response = with_auth(request, &config.api_key)
        .send_json(body)
        .map_err(describe_error)?;
    let value: Value = response
        .into_json()
        .map_err(|error| format!("invalid response from AI engine: {error}"))?;
    value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty())
        .ok_or_else(|| "the AI engine returned an empty answer".into())
}

pub fn list_models(base_url: &str, api_key: &str) -> Result<Vec<String>, String> {
    let request = ureq::get(&endpoint(base_url, "models")).timeout(Duration::from_secs(15));
    let response = with_auth(request, api_key).call().map_err(describe_error)?;
    let value: Value = response
        .into_json()
        .map_err(|error| format!("invalid model list: {error}"))?;
    let mut models: Vec<String> = value
        .get("data")
        .or_else(|| value.get("models"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    item.get("id")
                        .or_else(|| item.get("name"))
                        .and_then(Value::as_str)
                })
                .map(|id| id.trim_start_matches("models/").to_owned())
                .collect()
        })
        .unwrap_or_default();
    models.sort();
    models.dedup();
    Ok(models)
}

pub struct TestResult {
    pub ok: bool,
    pub message: String,
    pub millis: u128,
}

pub fn test(config: &AiConfig) -> TestResult {
    let started = Instant::now();
    if config.model.trim().is_empty() {
        return TestResult {
            ok: false,
            message: "choose a model first".into(),
            millis: 0,
        };
    }
    let messages = [Message::user("Reply with exactly the word: ready")];
    match chat(config, &messages, 0.0) {
        Ok(text) => TestResult {
            ok: true,
            message: format!(
                "{} answered: {}",
                config.model,
                text.chars().take(60).collect::<String>()
            ),
            millis: started.elapsed().as_millis(),
        },
        Err(error) => TestResult {
            ok: false,
            message: error,
            millis: started.elapsed().as_millis(),
        },
    }
}

/// What the AI router decided to do with a request the rules engine missed.
#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    /// A rewritten command that the deterministic matcher should understand.
    Command(String),
    /// A direct conversational answer.
    Answer(String),
}

/// What the assistant's own (free or cheap) model may do with a coding request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Coding {
    /// Route it only: pass the owner's words on; Hyde Code's planner writes the instructions
    /// (every mode except `assistant-plans`).
    Route,
    /// `assistant-plans` mode: write the task as a precise instruction; Hyde Code won't plan it again.
    Plan,
}

/// Complexity levels Hyde Code understands; the assistant may suggest one, the hub decides.
pub const LEVELS: [&str; 4] = ["trivial", "low", "medium", "high"];

fn coding_rule(coding: Coding) -> &'static str {
    match coding {
        Coding::Route => "Coding work (build, fix, refactor, write tests, add a feature to a software project) goes to \
Hyde Code with \"hyde code <the user's request in their own words> [in <project>] [using <agent>]\". Keep their words: \
do not add requirements, files, steps or details; Hyde Code's planner writes the instructions for the coding agent.",
        Coding::Plan => "Coding work (build, fix, refactor, write tests, add a feature to a software project) goes to \
Hyde Code with \"hyde code <clear task description> [in <project>] [using <agent>]\"; write the task \
as a precise instruction a developer could act on: what to change, the files if you know them, and how to tell it is done. \
Hyde Code will not plan it again.",
    }
}

pub fn route(
    config: &AiConfig,
    catalogue: &str,
    history: &[Message],
    input: &str,
    coding: Coding,
) -> Result<Route, String> {
    let system = format!(
        "You are Hyde, a concise desktop assistant on Linux. You control the computer ONLY through \
the command phrases listed below; you cannot run anything else.\n\n\
COMMANDS (examples of phrasing the command engine understands):\n{catalogue}\n\n\
Respond with ONE JSON object and nothing else:\n\
- If the user wants an action that one or more listed commands can do, reply \
{{\"command\": \"<plain command phrase(s)>\"}}. Join several steps with \" then \" and \
parallel steps with \" and \". Use the exact words from the list.\n\
- Otherwise answer the user yourself: {{\"answer\": \"<helpful reply in markdown, short>\"}}.\n\
{coding}\n\
For a Hyde Code command you may add \"level\": your guess at how hard it is, one of trivial (a rename, typo or \
one-line change), low (one small file, docs or config), medium (a feature or fix in a few files) or high (design work, \
many files, security or data). Hyde Code makes the final call.\n\
Never invent commands that are not listed.",
        coding = coding_rule(coding)
    );
    let mut messages = vec![Message::system(system)];
    messages.extend(history.iter().cloned());
    messages.push(Message::user(input));
    let text = chat(config, &messages, 0.1)?;
    Ok(parse_route(&text))
}

pub fn parse_route(text: &str) -> Route {
    let trimmed = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let json_slice = match (trimmed.find('{'), trimmed.rfind('}')) {
        (Some(start), Some(end)) if end > start => &trimmed[start..=end],
        _ => return Route::Answer(text.trim().to_owned()),
    };
    match serde_json::from_str::<Value>(json_slice) {
        Ok(value) => {
            if let Some(command) = value
                .get("command")
                .and_then(Value::as_str)
                .filter(|c| !c.trim().is_empty())
            {
                let mut command = command.trim().to_owned();
                // A level guess rides along on Hyde Code commands as a trailing marker that
                // `agent::code_task` strips and sends as the hub's `complexity` hint.
                let level = value
                    .get("level")
                    .and_then(Value::as_str)
                    .map(str::to_lowercase)
                    .filter(|l| LEVELS.contains(&l.as_str()));
                if let Some(level) = level {
                    if command.to_lowercase().starts_with("hyde code ") {
                        command.push_str(&format!(" [level:{level}]"));
                    }
                }
                Route::Command(command)
            } else if let Some(answer) = value.get("answer").and_then(Value::as_str) {
                Route::Answer(answer.trim().to_owned())
            } else {
                Route::Answer(text.trim().to_owned())
            }
        }
        Err(_) => Route::Answer(text.trim().to_owned()),
    }
}

pub fn ask(config: &AiConfig, history: &[Message], question: &str) -> Result<String, String> {
    let mut messages = vec![Message::system(
        "You are Hyde, a friendly and concise desktop assistant. Answer in short markdown.",
    )];
    messages.extend(history.iter().cloned());
    messages.push(Message::user(question));
    chat(config, &messages, 0.5)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_router_replies() {
        assert_eq!(
            parse_route("{\"command\": \"open chrome\"}"),
            Route::Command("open chrome".into())
        );
        assert_eq!(
            parse_route("```json\n{\"answer\": \"hi\"}\n```"),
            Route::Answer("hi".into())
        );
        assert_eq!(
            parse_route("plain text"),
            Route::Answer("plain text".into())
        );
        assert_eq!(
            parse_route("{\"command\": \"\"}"),
            Route::Answer("{\"command\": \"\"}".into())
        );
    }

    #[test]
    fn carries_a_level_guess_on_hyde_code_commands_only() {
        assert_eq!(
            parse_route("{\"command\": \"hyde code rename foo to bar\", \"level\": \"Trivial\"}"),
            Route::Command("hyde code rename foo to bar [level:trivial]".into())
        );
        assert_eq!(
            parse_route("{\"command\": \"open chrome\", \"level\": \"low\"}"),
            Route::Command("open chrome".into())
        );
        assert_eq!(
            parse_route("{\"command\": \"hyde code fix it\", \"level\": \"huge\"}"),
            Route::Command("hyde code fix it".into())
        );
    }

    #[test]
    fn only_assistant_plans_mode_lets_the_free_model_write_instructions() {
        assert!(coding_rule(Coding::Route).contains("in their own words"));
        assert!(coding_rule(Coding::Route).contains("do not add requirements"));
        assert!(coding_rule(Coding::Plan).contains("precise instruction"));
    }

    #[test]
    fn builds_endpoints() {
        assert_eq!(endpoint("http://x/v1/", "models"), "http://x/v1/models");
    }
}
