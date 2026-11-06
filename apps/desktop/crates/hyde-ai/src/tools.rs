//! Installing and launching companion AI tools (OpenCode, OmniRoute) plus small OS helpers.

use crate::config::{home_dir, state_dir};
use serde::Serialize;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const OMNIROUTE_PORT: u16 = 20128;

pub struct ToolSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub binary: &'static str,
    pub tagline: &'static str,
    pub homepage: &'static str,
    /// Shown to the user before they confirm an install.
    pub install_display: &'static str,
    pub needs: &'static [&'static str],
}

pub const TOOLS: &[ToolSpec] = &[
    ToolSpec {
        id: "opencode",
        name: "OpenCode",
        binary: "opencode",
        tagline: "Open-source AI coding agent for the terminal.",
        homepage: "https://opencode.ai",
        install_display: "curl -fsSL https://opencode.ai/install | bash",
        needs: &["curl", "bash"],
    },
    ToolSpec {
        id: "omniroute",
        name: "OmniRoute",
        binary: "omniroute",
        tagline: "Free AI gateway: one OpenAI-compatible endpoint over many free providers.",
        homepage: "https://github.com/diegosouzapw/OmniRoute",
        install_display: "npm install -g omniroute",
        needs: &["npm"],
    },
];

pub fn spec(id: &str) -> Option<&'static ToolSpec> {
    TOOLS.iter().find(|tool| tool.id == id)
}

/// Extra places installers commonly put binaries that may not be on PATH yet.
fn extra_bin_dirs() -> Vec<PathBuf> {
    let home = home_dir();
    vec![
        home.join(".opencode/bin"),
        home.join(".local/bin"),
        home.join("bin"),
        home.join(".npm-global/bin"),
        home.join(".bun/bin"),
    ]
}

pub fn which(binary: &str) -> Option<PathBuf> {
    if binary.contains('/') {
        let path = PathBuf::from(binary);
        return is_executable(&path).then_some(path);
    }
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path_var)
        .chain(extra_bin_dirs())
        .map(|dir| dir.join(binary))
        .find(|candidate| is_executable(candidate))
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

pub fn port_open(port: u16) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
}

/// Runs a command and returns its first output line, killing it after `timeout`.
pub fn quick_output(program: &PathBuf, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut text = String::new();
    child.stdout.take()?.read_to_string(&mut text).ok()?;
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(60).collect())
}

#[derive(Clone, Debug, Serialize)]
pub struct ToolStatus {
    pub id: &'static str,
    pub name: &'static str,
    pub tagline: &'static str,
    pub homepage: &'static str,
    pub install_command: &'static str,
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    /// Only meaningful for server tools (OmniRoute).
    pub running: Option<bool>,
    pub dashboard: Option<String>,
    pub missing_requirements: Vec<&'static str>,
}

pub fn status(spec: &ToolSpec) -> ToolStatus {
    let path = which(spec.binary);
    let version = path
        .as_ref()
        .and_then(|path| quick_output(path, &["--version"], Duration::from_secs(4)));
    let is_server = spec.id == "omniroute";
    ToolStatus {
        id: spec.id,
        name: spec.name,
        tagline: spec.tagline,
        homepage: spec.homepage,
        install_command: spec.install_display,
        installed: path.is_some(),
        path: path.map(|path| path.display().to_string()),
        version,
        running: is_server.then(|| port_open(OMNIROUTE_PORT)),
        dashboard: is_server.then(|| format!("http://localhost:{OMNIROUTE_PORT}")),
        missing_requirements: spec
            .needs
            .iter()
            .copied()
            .filter(|need| which(need).is_none())
            .collect(),
    }
}

pub fn all_status() -> Vec<ToolStatus> {
    // Version probes can be slow, so check the tools in parallel.
    let handles: Vec<_> = TOOLS
        .iter()
        .map(|spec| std::thread::spawn(move || status(spec)))
        .collect();
    handles
        .into_iter()
        .filter_map(|handle| handle.join().ok())
        .collect()
}

// ---------------------------------------------------------------- install jobs

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Running,
    Succeeded,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
pub struct Job {
    pub id: u64,
    pub tool: &'static str,
    pub title: String,
    pub state: JobState,
    pub log: Vec<String>,
}

#[derive(Clone, Default)]
pub struct Jobs {
    inner: Arc<Mutex<BTreeMap<u64, Job>>>,
}

static NEXT_JOB: AtomicU64 = AtomicU64::new(1);
const MAX_LOG_LINES: usize = 2000;

impl Jobs {
    pub fn get(&self, id: u64) -> Option<Job> {
        self.inner.lock().ok()?.get(&id).cloned()
    }

    pub fn running_for(&self, tool: &str) -> Option<u64> {
        let jobs = self.inner.lock().ok()?;
        jobs.values()
            .find(|job| job.tool == tool && job.state == JobState::Running)
            .map(|job| job.id)
    }

    fn push_line(&self, id: u64, line: String) {
        if let Ok(mut jobs) = self.inner.lock() {
            if let Some(job) = jobs.get_mut(&id) {
                if job.log.len() < MAX_LOG_LINES {
                    job.log.push(line);
                }
            }
        }
    }

    fn finish(&self, id: u64, state: JobState, line: String) {
        if let Ok(mut jobs) = self.inner.lock() {
            if let Some(job) = jobs.get_mut(&id) {
                job.log.push(line);
                job.state = state;
            }
        }
    }

    /// Starts an installer in the background and returns its job id.
    pub fn start_install(&self, tool_id: &str) -> Result<u64, String> {
        let spec = spec(tool_id).ok_or_else(|| format!("unknown tool `{tool_id}`"))?;
        if let Some(id) = self.running_for(spec.id) {
            return Ok(id);
        }
        let missing: Vec<_> = spec
            .needs
            .iter()
            .filter(|need| which(need).is_none())
            .collect();
        if !missing.is_empty() {
            let hint = if spec.id == "omniroute" {
                " Install Node.js 22 or newer from https://nodejs.org first."
            } else {
                ""
            };
            return Err(format!(
                "{} needs {} to install.{hint}",
                spec.name,
                missing
                    .iter()
                    .map(|m| format!("`{m}`"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        let mut command = match spec.id {
            "opencode" => {
                let mut command = Command::new("bash");
                command.args([
                    "-c",
                    "set -o pipefail; curl -fsSL https://opencode.ai/install | bash",
                ]);
                command
            }
            "omniroute" => {
                let mut command = Command::new(which("npm").unwrap_or_else(|| "npm".into()));
                command.args(["install", "-g", "omniroute"]);
                command
            }
            _ => return Err(format!("no installer for `{}`", spec.id)),
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("NO_COLOR", "1")
            .env("TERM", "dumb")
            .current_dir(home_dir());

        let id = NEXT_JOB.fetch_add(1, Ordering::Relaxed);
        let job = Job {
            id,
            tool: spec.id,
            title: format!("Install {}", spec.name),
            state: JobState::Running,
            log: vec![format!("$ {}", spec.install_display)],
        };
        self.inner
            .lock()
            .map_err(|_| "job table poisoned")?
            .insert(id, job);

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                self.finish(
                    id,
                    JobState::Failed,
                    format!("could not start installer: {error}"),
                );
                return Ok(id);
            }
        };
        let readers: Vec<_> = [
            child
                .stdout
                .take()
                .map(|s| Box::new(s) as Box<dyn Read + Send>),
            child
                .stderr
                .take()
                .map(|s| Box::new(s) as Box<dyn Read + Send>),
        ]
        .into_iter()
        .flatten()
        .map(|stream| {
            let jobs = self.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    let clean = strip_ansi(&line);
                    if !clean.trim().is_empty() {
                        jobs.push_line(id, clean);
                    }
                }
            })
        })
        .collect();
        let jobs = self.clone();
        let name = spec.name;
        std::thread::spawn(move || {
            for reader in readers {
                let _ = reader.join();
            }
            match child.wait() {
                Ok(status) if status.success() => {
                    let hint = if which(spec.binary).is_some() {
                        String::new()
                    } else {
                        " (open a new terminal so your PATH picks it up)".into()
                    };
                    jobs.finish(id, JobState::Succeeded, format!("✓ {name} installed{hint}"))
                }
                Ok(status) => jobs.finish(
                    id,
                    JobState::Failed,
                    format!("✗ installer exited with {status}"),
                ),
                Err(error) => {
                    jobs.finish(id, JobState::Failed, format!("✗ installer failed: {error}"))
                }
            }
        });
        Ok(id)
    }
}

fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else if ch == '\r' {
            out.clear();
        } else {
            out.push(ch);
        }
    }
    out
}

// ---------------------------------------------------------------- launching

fn spawn_detached(command: &mut Command) -> Result<(), String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

pub fn open_url(url: &str) -> Result<(), String> {
    let opener = which("xdg-open").ok_or("xdg-open is not available")?;
    spawn_detached(Command::new(opener).arg(url))
}

/// Opens a terminal window running `program` (for TUI apps like OpenCode).
pub fn open_in_terminal(program: &Path) -> Result<(), String> {
    let program = program.display().to_string();
    let candidates: &[(&str, &[&str])] = &[
        ("konsole", &["-e"]),
        ("gnome-terminal", &["--"]),
        ("ptyxis", &["--"]),
        ("kgx", &["-e"]),
        ("kitty", &[]),
        ("alacritty", &["-e"]),
        ("wezterm", &["start", "--"]),
        ("foot", &[]),
        ("xfce4-terminal", &["-x"]),
        ("x-terminal-emulator", &["-e"]),
        ("xterm", &["-e"]),
    ];
    for (terminal, prefix) in candidates {
        if let Some(path) = which(terminal) {
            let mut command = Command::new(path);
            command.args(*prefix).arg(&program).current_dir(home_dir());
            return spawn_detached(&mut command);
        }
    }
    Err("no terminal emulator found".into())
}

pub fn launch_tool(tool_id: &str) -> Result<String, String> {
    let spec = spec(tool_id).ok_or_else(|| format!("unknown tool `{tool_id}`"))?;
    let path = which(spec.binary).ok_or_else(|| {
        format!(
            "{} is not installed yet. Say \"install {}\" first.",
            spec.name, spec.id
        )
    })?;
    match spec.id {
        "opencode" => {
            open_in_terminal(&path)?;
            Ok("Opened OpenCode in a terminal".into())
        }
        "omniroute" => {
            let dashboard = format!("http://localhost:{OMNIROUTE_PORT}");
            if port_open(OMNIROUTE_PORT) {
                open_url(&dashboard)?;
                return Ok("OmniRoute is already running; opened its dashboard".into());
            }
            let dir = state_dir();
            std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
            let log = std::fs::File::create(dir.join("omniroute.log"))
                .map_err(|error| error.to_string())?;
            let log_err = log.try_clone().map_err(|error| error.to_string())?;
            Command::new(path)
                .stdin(Stdio::null())
                .stdout(log)
                .stderr(log_err)
                .current_dir(home_dir())
                .spawn()
                .map_err(|error| format!("could not start OmniRoute: {error}"))?;
            std::thread::spawn(move || {
                let started = Instant::now();
                while started.elapsed() < Duration::from_secs(30) {
                    if port_open(OMNIROUTE_PORT) {
                        let _ = open_url(&dashboard);
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
            });
            Ok("Starting OmniRoute; its dashboard opens when it is ready".into())
        }
        _ => Err(format!("cannot launch `{}`", spec.id)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_terminal_codes() {
        assert_eq!(strip_ansi("\u{1b}[32mok\u{1b}[0m done"), "ok done");
        assert_eq!(strip_ansi("10%\r50%"), "50%");
    }
}
