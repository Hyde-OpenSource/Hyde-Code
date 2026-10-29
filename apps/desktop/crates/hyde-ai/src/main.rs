//! `hyde-ai` — Hyde AI desktop assistant.

mod agent;
mod config;
mod hydecode;
mod llm;
mod server;
mod tools;

use agent::{Shared, Status};
use clap::{Parser, Subcommand};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Parser)]
#[command(
    name = "hyde-ai",
    version,
    about = "Hyde AI — control your desktop and your coding agents in plain words"
)]
struct Cli {
    /// Use this data directory (intents/ + apps.toml) instead of the built-in commands.
    #[arg(long, global = true)]
    data: Option<PathBuf>,
    #[command(subcommand)]
    command: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Start the app and open its window (default).
    Ui {
        /// Port for the local UI server.
        #[arg(long)]
        port: Option<u16>,
        /// Do not open a browser window.
        #[arg(long)]
        no_browser: bool,
    },
    /// Run one command from the terminal, e.g. `hyde-ai run open chrome and vs code`.
    Run {
        /// Approve plans that need confirmation without asking.
        #[arg(short, long)]
        yes: bool,
        /// The request, in plain words.
        #[arg(required = true, trailing_var_arg = true)]
        text: Vec<String>,
    },
    /// Install a companion AI tool (opencode or omniroute).
    Install { tool: String },
    /// Check this computer for everything Hyde can use.
    Doctor,
}

fn main() {
    let cli = Cli::parse();
    let pack = match agent::load_pack(cli.data.as_deref()) {
        Ok(pack) => pack,
        Err(error) => {
            eprintln!("hyde: could not load commands: {error}");
            std::process::exit(2);
        }
    };
    let config = config::Config::load();
    let shared = Arc::new(Shared {
        agent: Mutex::new(agent::Agent::new(pack)),
        config: Mutex::new(config.clone()),
        jobs: tools::Jobs::default(),
        data_dir: cli.data.clone(),
    });

    let code = match cli.command.unwrap_or(Cmd::Ui {
        port: None,
        no_browser: false,
    }) {
        Cmd::Ui { port, no_browser } => {
            let port = port.unwrap_or(config.ui.port);
            match server::serve(shared, port, config.ui.open_browser && !no_browser) {
                Ok(()) => 0,
                Err(error) => {
                    eprintln!("hyde: {error}");
                    1
                }
            }
        }
        Cmd::Run { yes, text } => run_once(&shared, &text.join(" "), yes),
        Cmd::Install { tool } => install(&shared, &tool),
        Cmd::Doctor => doctor(&shared),
    };
    std::process::exit(code);
}

fn print_reply(reply: &agent::Reply) {
    if let Some(plan) = &reply.plan {
        if let Some(rewritten) = &reply.rewritten {
            println!("  AI understood: {rewritten}");
        }
        for task in &plan.tasks {
            let result = reply.results.iter().find(|r| r.task_id == task.id);
            let mark = match result {
                Some(r) if r.success => "✓",
                Some(_) => "✗",
                None => "•",
            };
            let after = if task.depends_on.is_empty() {
                String::new()
            } else {
                format!("  (after {:?})", task.depends_on)
            };
            let detail = result
                .map(|r| format!(" — {}", r.message))
                .unwrap_or_default();
            println!("  {mark} [{}] {}{after}{detail}", task.risk, task.label);
        }
    }
    if reply.status == Status::Answer || reply.plan.is_none() || reply.status == Status::Confirm {
        println!("{}", reply.text);
    }
}

fn run_once(shared: &Shared, text: &str, yes: bool) -> i32 {
    let mut reply = agent::handle(shared, text);
    print_reply(&reply);
    if reply.status == Status::Confirm {
        let approve = yes || {
            print!("Run this plan? [y/N] ");
            let _ = std::io::stdout().flush();
            let mut line = String::new();
            let _ = std::io::stdin().lock().read_line(&mut line);
            matches!(line.trim().to_lowercase().as_str(), "y" | "yes")
        };
        reply = agent::confirm(shared, reply.pending_id.unwrap_or_default(), approve);
        print_reply(&reply);
    }
    for job in &reply.job_ids {
        follow_job(shared, *job);
    }
    match reply.status {
        Status::Done | Status::Answer | Status::Cancelled => 0,
        Status::Partial => 1,
        _ => 2,
    }
}

fn follow_job(shared: &Shared, id: u64) -> bool {
    let mut printed = 0;
    loop {
        let Some(job) = shared.jobs.get(id) else {
            return false;
        };
        for line in &job.log[printed..] {
            println!("  │ {line}");
        }
        printed = job.log.len();
        match job.state {
            tools::JobState::Running => std::thread::sleep(Duration::from_millis(200)),
            tools::JobState::Succeeded => return true,
            tools::JobState::Failed => return false,
        }
    }
}

fn install(shared: &Shared, tool: &str) -> i32 {
    match shared.jobs.start_install(&tool.to_lowercase()) {
        Ok(id) => {
            if follow_job(shared, id) {
                0
            } else {
                1
            }
        }
        Err(error) => {
            eprintln!("hyde: {error}");
            2
        }
    }
}

fn doctor(shared: &Shared) -> i32 {
    let check = |ok: bool, label: &str, detail: &str| {
        println!(
            "  {} {label}{}",
            if ok { "✓" } else { "·" },
            if detail.is_empty() {
                String::new()
            } else {
                format!(" — {detail}")
            }
        );
    };
    println!("Hyde AI {}\n", env!("CARGO_PKG_VERSION"));
    println!("System");
    for (bin, why) in [
        ("xdg-open", "open websites"),
        ("wpctl", "volume control (PipeWire)"),
        ("pactl", "volume control fallback (PulseAudio)"),
        ("pkill", "close apps"),
        ("loginctl", "lock the screen"),
        ("curl", "install OpenCode"),
        ("npm", "install OmniRoute"),
    ] {
        check(tools::which(bin).is_some(), bin, why);
    }
    println!("\nApps");
    for app in &shared.agent.lock().expect("agent lock").pack.apps {
        check(
            tools::which(&app.command).is_some(),
            &app.name,
            &app.command,
        );
    }
    println!("\nAI tools");
    for tool in tools::all_status() {
        let mut detail = tool.version.clone().unwrap_or_else(|| {
            if tool.installed {
                "installed".into()
            } else {
                format!("not installed — `hyde-ai install {}`", tool.id)
            }
        });
        if tool.running == Some(true) {
            detail.push_str(", running");
        }
        check(tool.installed, tool.name, &detail);
    }
    let hub = hydecode::discover();
    println!("\nHyde Code");
    check(
        hub.cli.is_some(),
        "`hyde` CLI",
        &hub.cli
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| {
                "not on PATH — run `pnpm install-cli` in the Hyde Code folder".into()
            }),
    );
    check(
        hub.token.is_some(),
        "owner token",
        &hub.home.display().to_string(),
    );
    let up = hydecode::is_up(&hub);
    check(
        up,
        "hub",
        &if up {
            format!("running at {}", hub.url())
        } else {
            "stopped — say “start hyde code”".into()
        },
    );
    if up {
        if let Ok(state) = hydecode::state(&hub) {
            let names: Vec<String> = hydecode::projects(&state)
                .iter()
                .map(|p| p.id.clone())
                .collect();
            check(!names.is_empty(), "projects", &names.join(", "));
        }
    }
    let ai = shared.ai_config();
    println!("\nAI engine");
    if ai.is_ready() {
        let result = llm::test(&ai);
        check(
            result.ok,
            &format!("{} · {}", ai.provider, ai.model),
            &result.message,
        );
    } else {
        check(false, "not configured", "open the app → AI engine tab");
    }
    println!("\nConfig: {}", config::config_dir().display());
    0
}
