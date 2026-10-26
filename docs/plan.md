# DevFlow Harness — Research & Build Plan

Oct 26, 2026 · @GamifyIAS Management

## Executive summary

**Build a self-hosted control plane that drives the official agent CLIs you already pay for (Claude Code and Codex first) and owns everything around them: tasks, routing, worktrees, approvals, chat, UI and memory.** Do not build your own model loop on top of subscription logins. Anthropic and Google now block that, while the official CLIs expose enough programmatic surface to orchestrate them safely.

How it works for you: you message the harness on Telegram, Slack or the web dashboard. It asks clarifying questions, splits the work into a task graph, and assigns each task to the best available agent (Claude Code, Codex, OpenCode or any ACP agent). Each agent works in its own git worktree, gets verified by tests and a browser, and is reviewed by a different vendor's agent. You get a PR link and a summary to approve. Nothing merges into `main` or `staging` without your tap: your devflow rules, enforced as code.

| Decision | Choice | Why |
| --- | --- | --- |
| Model access | Drive unmodified CLIs (Claude Code, Codex, OpenCode) under each user's own login | The only compliant way to use Claude Pro/Max; Codex is officially scriptable |
| Harness brain | Deterministic state machine, plus LLM calls for planning and routing through the CLIs' structured output | Predictable and resumable (OpenAI Symphony pattern): code decides control flow, models decide content |
| Core design | Plugin kernel plus an append-only event log | DeepSeek Harness pattern: every part swappable, every run replayable |
| Isolation | One git worktree per task; containers for untrusted repos | Parallel agents without collisions |
| Chat | Telegram first, then Slack and Discord; WhatsApp for client-message intake | Free bots with buttons; WhatsApp restricts general AI bots |
| UI | Web Command Center: agent cards, task board, live terminals, inbox, diff review | Patterns proven by Munder Difflin and Vibe Kanban |
| Stack | TypeScript monorepo, SQLite, node-pty, xterm.js, Playwright | The agent and chat SDKs all ship TypeScript versions |
| Throughput | Quota-aware scheduler per account | Subscriptions have 5-hour and weekly limits |

Inspirations, each covered below: DeepSeek Harness for the kernel, OpenAI Symphony for the orchestrator, Munder Difflin for the UI and mailboxes, Gas Town for the merge queue and watchdogs, and your [devflow-skills](https://github.com/Thenn-Labs/devflow-skills) for the rules.

First milestone: one Telegram message becomes one Claude Code run in a worktree, which ends with a PR link and a done message. "DevFlow Harness" is a working name.

## Goals, assumptions and constraints

**The harness must make "send a task, get a reviewed PR back" a daily routine, using only the subscriptions and machines you and your users already own.**

**Goals**

- **One front door.** Send work from chat, the web dashboard, a CLI command, a GitHub issue or a webhook. Updates come back to the same place.
- **Many agents, many vendors, at once.** Run several Claude Code, Codex and OpenCode sessions in parallel, with room for Gemini CLI, Copilot CLI, Cursor CLI and any ACP agent.
- **Full management.** Roles and permissions, a task board, questions and answers, incident reports, usage and quota tracking, audit history: your devflow files, made live.
- **Autonomy with a leash.** Agents work unattended. The harness escalates only questions, risky actions and merges.
- **Reach.** Telegram, Slack, Discord, WhatsApp for client intake, plus browser automation for testing and proof of work.
- **It learns.** Lessons and project context carry across sessions, agents and vendors.

**Assumptions**

- The harness runs on a machine that stays on: your desktop, a mini PC or a VPS. Each agent CLI is installed and signed in there.
- Each person signs in to their own Claude, ChatGPT and other accounts on their own worker machine. The harness never reads, copies or stores those tokens.
- Repos live on GitHub and the deliverable is a pull request. GitLab can come later.
- Hosts run Linux or macOS; Windows works through WSL2.
- "My users" means teammates or clients who run their own worker node with their own logins, not people sharing your subscription. If this becomes a commercial product, every rule in the next section applies in full.

**Constraints**

- Subscription limits (5-hour and weekly windows) cap throughput, so concurrency must be quota-aware.
- Anthropic, Google and OpenAI all changed their rules for third-party tools during 2026, so every vendor sits behind a swappable adapter.
- One subscription is never pooled, shared or resold across users.

**Non-goals:** training models, building an IDE, a hosted SaaS that resells model usage, or replacing GitHub.

## The ground rule: how each subscription may be used

**Drive each vendor's official tool, signed in by the person who owns the subscription, and never touch the tokens yourself.** That keeps the harness inside every vendor's published terms as of October 2026. This is a reading of public terms, not legal advice; confirm with the vendor before shipping a commercial product.

| Vendor | Allowed in your harness | Not allowed | What it means for the design |
| --- | --- | --- | --- |
| [Anthropic](https://code.claude.com/docs/en/legal-and-compliance) (Claude Free, Pro, Max) | Launching and supervising the unmodified `claude` binary, signed in with the user's own subscription: interactive, `claude -p`, background sessions, channels. Pro and Max limits assume ordinary, individual usage of Claude Code and the Agent SDK. | Reusing subscription OAuth tokens in any other tool; offering Claude.ai login in your app; routing requests through Free, Pro or Max credentials for other users; collecting or storing Claude.ai credentials. Since [Apr 4, 2026](https://thenextweb.com/news/anthropic-openclaw-claude-subscription-ban-cost/), third-party harnesses such as OpenClaw no longer draw on subscription limits. | Claude runs only as the `claude` process. Never use `--bare` for subscription runs: bare mode never reads OAuth credentials. Hosting Claude Code inside a product for others needs Anthropic's Commercial Terms and each end user's own login. |
| [OpenAI](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites) (ChatGPT Go, Plus, Pro) | Codex CLI, app server and SDK with Sign in with ChatGPT; Codex and ChatGPT share one usage pool. Since DevDay on Sep 29, 2026, [Sign in with ChatGPT](https://dev.to/hassann/sign-in-with-chatgpt-for-developers-the-oauth-flow-plan-usage-and-what-it-means-for-your-api-bill-48f7) lets apps spend plan usage; open-source and local tools self-serve. | Calling private `backend-api` endpoints. Reusing Codex's client identity is an unofficial gray area. Commercial apps are in a limited trial. | Codex is a first-class worker. If the harness is open source or runs locally, its own planner can call the Responses API on your plan. |
| [Google](https://metricnexus.ai/blog/google-banning-openclaw-antigravity-users) (Gemini CLI, Antigravity) | The official apps; AI Studio API keys for anything else. | Using Gemini CLI or Antigravity OAuth in third-party tools. Bans began Feb 11, 2026; accounts were reinstated from Feb 27, but the policy stands and a second violation is permanent. | Optional worker, run only as the official `gemini` binary, with care around heavy headless loops. |
| OpenCode and other open tools | [OpenCode](https://opencode.ai/docs/server/) is open source and bring-your-own-provider, and a Sign in with ChatGPT launch partner. It [dropped Claude Pro/Max support](https://docs.bswen.com/blog/2026-03-09-claude-code-sdk-third-party-harness/) in Feb 2026. | Feeding it Claude subscription tokens. | A good third worker type, on a ChatGPT plan or a cheap pay-per-token model such as DeepSeek V4. |

**What this means for you and your users**

- **You:** your harness launches your own signed-in CLIs on your own machine. That fits ordinary individual use while the volume stays at what one person would generate.
- **Teammates and clients:** each runs a worker node with their own logins. The hub sends tasks to nodes, never credentials. One human, one login.
- **A commercial product:** the orchestration can be your product, but model usage is always the end user's own account, signed in through the vendor's own flow. Talk to Anthropic sales before preinstalling Claude Code for customers.
- **Etiquette that protects your accounts:** cap concurrent runs per account (start with 2 or 3), keep a reserve for your own interactive work, and pause on rate-limit events instead of retrying in a loop.
- **Optional API keys:** for cheap planner or summary calls you can add a pay-per-token key. DeepSeek V4 is the low-cost option, with [time-based pricing since Aug 16, 2026](https://venturebeat.com/technology/deepseek-harness-launches-as-open-source-rival-to-claude-code-alongside-v4-pro-on-api-with-higher-prices) where off-peak costs half of peak.

## Landscape: harnesses worth learning from

**No single project does everything you described, but ten of them each solved one part well. Copy those parts, skip the rest.** DeepSeek Harness is the closest match, yet its main loop calls model APIs (API keys), so take its architecture and let its Claude Code and Codex backends show how to drive the CLIs.

| Project | What it is | Agents it drives | Borrow this | Status, license |
| --- | --- | --- | --- | --- |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | Open-source harness launched Aug 13, 2026 with DeepSeek V4-Pro. `npx @deepseek-ai/dsh web` opens a web UI at `127.0.0.1:3080`. Built on Cordis, where models, tools, sessions, sandboxes, loops and UIs are all plugins. | Its own loop on DeepSeek, Anthropic, OpenAI or compatible APIs; Claude Code (pinned Agent SDK, native login) and Codex (app server) as one-shot subagent backends; any ACP agent | Plugin kernel with service seams; sessions as an append-only typed event log ("model-visible means logged"); approvals kept separate from sandboxing; a team task graph with revisions and write scopes; profiles for web, headless, SDK and ACP | Developer preview, MIT, breaking changes expected |
| [OpenAI Symphony](https://github.com/openai/symphony) | A spec plus an Elixir reference daemon: polls Linear, makes a workspace per issue, runs Codex app-server sessions until the issue reaches a handoff state | Codex | One orchestrator owns all state; poll, reconcile, dispatch with bounded concurrency; `WORKFLOW.md` in the repo (YAML front matter plus prompt template); stall detection; exponential backoff; proof of work (CI, review notes, walkthrough videos) | Engineering preview, Apache-2.0 |
| [Munder Difflin](https://github.com/chaitanyagiri/munder-difflin) | Electron desktop app that runs terminal agents as an office team. One orchestrator agent, "Michael", routes work and escalates only spend, destructive actions and scope changes | 12 CLIs: Claude Code, Codex, Gemini CLI, Antigravity, Grok, Kimi, Qwen, OpenCode, Crush, pi, Copilot CLI, Cursor | Real terminals (node-pty, xterm.js); agent cards with status, model, context gauge and current action; a Pixi.js office floor; file mailboxes (outbox, router, inbox) with atomic writes; one git committer; typed messages with a hop cap; a Stop hook that keeps agents draining their inbox | v0.4.5 (Aug 22, 2026), MIT, "working prototype" |
| [Gas Town](https://github.com/steveyegge/gastown) | Steve Yegge's Go orchestrator for 20 to 30 agents, with work persisted in Beads, a git-backed issue tracker | Claude Code by default; Codex, Copilot, Gemini, Cursor | The Mayor (one coordinator you talk to); ephemeral workers with persistent identity; the Refinery merge queue with bisecting batches; watchdogs for stuck agents; severity-routed escalation; a capacity scheduler against rate limits | Active, MIT |
| [Paperclip](https://github.com/paperclipai/paperclip) | Node server and React UI that runs teams of agents as a company: org charts, budgets, governance, goals | OpenClaw, Claude Code, Codex, Cursor, Gemini CLI, OpenCode, Pi, Hermes, Grok, Kimi, custom HTTP | An adapter registry ("if it can receive a heartbeat, it's hired"); per-agent budgets and cost tracking; goals above tasks | Active, MIT |
| [OpenClaw](https://github.com/openclaw/openclaw) | Self-hosted assistant whose Gateway is the control plane for sessions, tools, events and 20+ chat channels | Pluggable models and harnesses (Claude, Codex, local) | Trusted gateway, untrusted execution, policy enforced by code; pairing codes for unknown senders; one adapter per channel | Active, MIT, OpenClaw Foundation |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Nous Research's self-improving agent with one gateway for Telegram, Discord, Slack, WhatsApp and Signal | Its own loop on many providers | Cron jobs that deliver results to chat; skills created from experience; six terminal backends (local, Docker, SSH, Modal, Daytona, Vercel Sandbox) | Active, MIT |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | Kanban board where each workspace gives an agent a branch, a terminal and a dev server | 10+ including Claude Code, Codex, Gemini CLI, Copilot, Amp, Cursor, OpenCode | Card-to-workspace flow; inline diff comments sent back to the agent; a built-in preview browser | Sunsetting since Apr 10, 2026; community-run, Apache-2.0 |
| Claude Code built-ins: [agent view](https://code.claude.com/docs/en/agent-view.md), [workflows](https://code.claude.com/docs/en/workflows.md), [channels](https://code.claude.com/docs/en/channels.md) | Background sessions under a supervisor (`claude agents --json`); JavaScript workflows with up to 16 concurrent subagents and 1,000 per run; Telegram, Discord and iMessage channels | Claude only | Building blocks inside a Claude worker, not your control plane, since they cover one vendor | Agent view and channels are research previews |
| [ACP Registry](https://zed.dev/blog/acp-registry) | Registry of agents that speak the Agent Client Protocol, live since Jan 28, 2026 | Claude Code, Codex CLI, Copilot CLI, OpenCode, Gemini CLI and more | One adapter that reaches many agents | Open protocol |

Other parallel-agent desktop apps exist (Conductor, Superset, Emdash, Claude Squad); they were not reviewed for this doc.

## How to drive each agent CLI

**Every worker is an adapter that turns one CLI's programmatic surface into the same normalized event stream.** Claude Code and Codex have the richest surfaces; ACP covers most other agents; a raw terminal covers the rest.

| Agent | Surface to use | Sessions and resume | Live events | Permission control | Quota signal |
| --- | --- | --- | --- | --- | --- |
| [Claude Code](https://code.claude.com/docs/en/headless.md) | `claude -p --output-format stream-json --verbose`, or `--input-format stream-json` to keep one process for many turns; `claude --bg` for background sessions | `--resume <session_id>` (the id is in every result); `claude agents --json` lists background sessions | Stream lines (`system/init`, messages, `system/api_retry`, `rate_limit_event`, final `result`); [HTTP hooks](https://code.claude.com/docs/en/hooks.md) such as `Stop`, `Notification`, `PermissionRequest`, `SessionEnd` that POST to the harness | `--permission-mode auto`, `acceptEdits` or `dontAsk`; `--allowedTools`; deny rules; `--permission-prompts none` for unattended runs | [`rate_limit_event`](https://claude-code.hexdocs.pm/ClaudeCode.Message.RateLimitEvent.html) with status, utilization, reset time and window (`five_hour`, `seven_day`) |
| Codex | `codex app-server` (JSON-RPC over stdio, or WebSocket with `--listen`); or the TypeScript [Codex SDK](https://github.com/openai/codex/tree/main/sdk/typescript), which wraps the CLI's JSONL; `codex exec --json` for one-shots | `thread/start`, `thread/resume`, `thread/fork`, `thread/list`; SDK `resumeThread(id)`; threads saved in `~/.codex/sessions` | Item notifications and `turn/completed`; SDK `runStreamed()` with `item.completed` and `turn.completed` (with usage) | Approval policy (`never`, `on-request`) and sandbox (`workspace-write`, `danger-full-access`) per thread; approval requests come back to the client | `account/rateLimits/read` and `account/rateLimits/updated` |
| [OpenCode](https://opencode.ai/docs/server/) | `opencode serve` (HTTP plus server-sent events, OpenAPI at `/doc`), protected with `OPENCODE_SERVER_PASSWORD` | `POST /session`, `GET /session/:id`, `POST /session/:id/prompt_async` | `GET /event` stream | `POST /session/:id/permissions/:permissionID` | Depends on the provider |
| Gemini CLI, Copilot CLI, Cursor, Kimi, Qwen and others | [ACP](https://zed.dev/blog/acp-registry): JSON-RPC over stdio with `session/new`, `session/prompt`, streamed `session/update` | `session/load` where the agent supports it | `session/update` | `session/request_permission`, answered by the harness | None standard |
| Anything else | A real terminal (node-pty), as Munder Difflin does, plus the CLI's own hooks | The CLI's own resume flag | Terminal output; hooks if available | The CLI's own flags | None |

**The adapter contract** (TypeScript; the orchestrator only ever sees this):

```ts
export interface AgentAdapter {
  readonly kind: 'claude-code' | 'codex' | 'opencode' | 'acp' | 'pty';
  detect(): Promise<{ installed: boolean; version?: string; signedIn: boolean; account?: string }>;
  start(spec: RunSpec): Promise<RunHandle>;             // cwd = task worktree, prompt = task packet
  send(run: RunHandle, text: string): Promise<void>;    // answers, follow-ups, review feedback
  interrupt(run: RunHandle): Promise<void>;             // end the current turn cleanly
  resume(sessionRef: string, spec: RunSpec): Promise<RunHandle>;
  events(run: RunHandle): AsyncIterable<HarnessEvent>;  // normalized stream
  quota(account: string): Promise<QuotaSnapshot | null>;
}

export type HarnessEvent =
  | { type: 'run.started'; sessionRef: string; model: string }
  | { type: 'text.delta'; text: string }
  | { type: 'tool.started' | 'tool.finished'; tool: string; summary: string }
  | { type: 'file.changed'; path: string }
  | { type: 'permission.requested'; requestId: string; action: string }
  | { type: 'question.asked'; questionId: string; text: string; blocking: boolean }
  | { type: 'rate_limit'; status: 'allowed' | 'warning' | 'rejected'; window: string; resetsAt?: number; utilization?: number }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: 'run.completed'; summary: string; structured?: unknown }
  | { type: 'run.failed'; reason: 'auth' | 'rate_limit' | 'stalled' | 'crashed' | 'cancelled'; detail?: string };
```

**Practical rules learned from the docs and from DeepSeek Harness, Symphony and Munder Difflin**

- **Give every worker a harness MCP server.** Tools such as `ask_question`, `report_progress`, `request_approval`, `send_message` and `complete_task` are how agents talk to the harness. Unattended Claude runs with `--permission-prompts none` lose `AskUserQuestion`, so this tool is the clean way to ask you something.
- **Stop Claude runs with SIGINT, not SIGTERM.** SIGTERM exits with code 143 and records no result for the turn in progress.
- **Pass context as files.** Use `--append-system-prompt-file` for Claude and developer instructions or `AGENTS.md` for Codex; use `--json-schema` (Claude) or `outputSchema` (Codex) when you need structured results such as a plan.
- **Pin CLI versions per node and feature-detect.** Claude's `system/init` carries a `capabilities` list. CLIs ship weekly and stream formats change.
- **Scrub the child environment.** DeepSeek Harness strips credential-shaped variables before launching an agent and then adds an explicit allowlist; Symphony's spec keeps tracker secrets out of agent processes.
- **Claude background sessions are an escape hatch, not the engine.** `claude --bg` gives each session a supervisor and its own worktree, and `claude attach <id>` lets you take over by hand; the harness still owns task state.
- **Mods are optional.** Since Claude Code v2.1.287, [mods](https://code.claude.com/docs/en/plugins/mods/overview.md) run JavaScript handlers inside Claude Code, also under `claude -p`. HTTP settings hooks are enough for version 1.

## Your devflow-skills become the pipeline

**Your [devflow-skills](https://github.com/Thenn-Labs/devflow-skills) already describe a multi-agent operating system in files. The harness becomes the main session, agents become child sessions, and every devflow file becomes a live table that is still written back to the repo.**

| Devflow piece | Today (files, by hand) | In the harness |
| --- | --- | --- |
| Main session | A Claude session you designate as main | The orchestrator, plus an optional Main agent you chat with (like Gas Town's Mayor or Munder Difflin's Michael) |
| Child sessions | Sessions you start and name | Runs the harness starts, each with a name, model, role and worktree; the registry row updates itself |
| `agents.md` registry | Each agent edits its own row | Live agent table, rendered back to `agents.md` |
| `tasks.md` (T-000 format) | Main assigns; agents update status and notes | Task table with the same fields: assigned to, priority, repeats, files or area, branch, status, done when, notes. `Repeats: daily` becomes a scheduled task |
| `role.md` permissions | Rules the agent is asked to follow | Permission profiles compiled into CLI flags and deny rules, plus a harness policy check on risky tool calls |
| `AgentQuestions.md`, `AgentAnswers.md` | Agents append; main answers | The `ask_question` tool sends you a chat message with buttons; your answer returns to the agent and is written to both files |
| `report.md` | Agents report misbehaviour | Incidents raised by agents or by the harness itself (stalls, rule breaks), each with a decision |
| `progress.md` | Each agent appends an entry per change | Written by the harness from run events (what, why, files, how verified), so entries are never skipped |
| `CLAUDE.md` lessons | Added after corrections | Proposed by agents, approved by you, written to `CLAUDE.md` and `AGENTS.md` so Codex reads them too |
| Protected branches | Trust the agent | Enforced four ways: deny rules on `git push` to protected branches, a pre-push hook, GitHub branch protection, and merges only through the harness merge gate |
| Branch naming | Agent follows `<agent>/<type>/<short-name>` | The harness creates the branch and worktree before the agent starts |
| `/devflow-messages` | You paste client messages | Client messages forwarded from WhatsApp or Telegram start the pipeline; the reply draft comes back to you, never straight to the client |
| `/devflow-test` | Run on request | A Verify stage after every implementation; Critical and High findings are re-checked by another vendor's agent, the skill's "try to disprove it" step |

**The pipeline every task runs through**

1. **Intake.** A task arrives from chat, the dashboard, a GitHub issue, a schedule or a client message, and becomes a draft task.
2. **Clarify.** The planner lists open questions (devflow rule 4: never assume) and you answer in chat. Parts that don't depend on the answers may proceed.
3. **Plan.** The planner writes a task graph. Each subtask has a done-when condition, a write scope (files or area), a role and its dependencies. Large plans wait for your one-tap approval.
4. **Dispatch.** The scheduler picks agent, vendor, model and account for each ready task, respecting quotas and write-scope overlaps.
5. **Execute.** The agent works on its own branch in its own worktree and reports through the harness tools.
6. **Verify.** Tests, lint, the `/devflow-test` checklist and browser checks for UI work. Failures go back to the same agent with the evidence.
7. **Review.** A different vendor's agent reviews the diff against the done-when condition. Findings go back to the author, for a capped number of rounds.
8. **Report.** A `progress.md` entry and a chat summary with the PR link, test results and screenshots.
9. **Merge gate.** You tap Merge: staging first, main only when you say so (devflow-setup Step 4).
10. **Learn.** Lessons go to `CLAUDE.md` and `AGENTS.md`; every fixed bug gets a regression test.

**Small changes to make in devflow-skills for harness mode**

- Add a harness mode: when `DEVFLOW_HARNESS=1` is set, skip Step 1's "main or child?" question and read the agent's name, model, role and task from the injected task packet.
- Where the skills say "use `AskUserQuestion`", add "or the harness `ask_question` tool when present", because unattended runs have no interactive prompt.
- Let the harness be the only writer of shared files (`tasks.md`, `agents.md`, `progress.md`); agents propose changes through tools. This is Munder Difflin's single-writer rule, and it stops two agents editing one file.
- Keep the skills vendor-neutral: your README already installs them for Codex through the Skills CLI, and the harness mirrors `CLAUDE.md` rules into `AGENTS.md`.

## Reference architecture

**One hub process (`harnessd`) owns all state and decisions. Worker nodes on each user's machine run the agent CLIs under that user's own logins and talk to the hub over one outbound WebSocket.** For you alone, hub and node run as one process on one machine.

&#91;embedded content: architecture · front doors, hub, worker nodes\]

Read it top-down: work enters through any front door, the hub plans and schedules it, and a worker node runs it in an official CLI under its owner's login. Every result travels back up the same path.

| Part | Component | Job | Pattern borrowed from |
| --- | --- | --- | --- |
| Hub | Gateways | Telegram, Slack, Discord, WhatsApp, web, CLI, GitHub and CI webhooks in; commands and events out | OpenClaw Gateway, Vercel Chat SDK |
| Hub | API server | HTTP and WebSocket for the UI, the CLI and worker nodes, with auth |  |
| Hub | Intake and command router | Turns messages into tasks, answers, approvals and commands |  |
| Hub | Orchestrator | The only writer of task state; a tick loop that reconciles, validates and dispatches | OpenAI Symphony |
| Hub | Planner | LLM calls through a CLI with a JSON schema, producing task graphs and routing hints |  |
| Hub | Scheduler | Quota-aware queues per account, concurrency caps per vendor and project, write-scope locks | Gas Town scheduler |
| Hub | Policy engine | Devflow rules as code: permission profiles, approval classes, protected branches | DeepSeek Harness (approvals separate from sandboxing) |
| Hub | Event store | Append-only events in SQLite, with projections for the UI and reports | DeepSeek Harness session log |
| Hub | Notifier | Routes messages by severity, batches progress, respects quiet hours |  |
| Hub | Merge queue | Rebases, re-runs checks, merges after your approval | Gas Town Refinery |
| Node | Node agent | Connects out to the hub; reports installed CLIs, sign-in state and quotas; never sends credentials |  |
| Node | Workspace manager | Worktrees, branches, ports, dev servers, cleanup | Symphony workspace manager |
| Node | Adapters and supervisor | Start, stream, interrupt and resume runs; stall detection; restarts | DeepSeek Harness subagent providers |
| Node | Harness MCP server | The tools agents use to ask, report, request approval and finish |  |
| Node | Browser service | Playwright and Chrome DevTools for checks, screenshots and videos | Symphony proof of work |
| Shared | Knowledge | `CLAUDE.md`, `AGENTS.md`, `context.md`, lessons, artifacts, run transcripts | OpenAI harness engineering |

## The orchestrator brain

**Code decides control flow; models decide content.** The orchestrator is a deterministic state machine, as in [Symphony's spec](https://github.com/openai/symphony/blob/main/SPEC.md). It calls a model only to plan, route and review, and every decision is an event you can replay.

&#91;embedded content: task lifecycle · 8 states, 1 rework loop, 2 side states\]

A task moves down the column. Failed checks, review findings and your change requests all return to the same agent session, and only your tap moves a task from Awaiting merge to Done.

**The tick loop** (every few seconds and on every event)

1. **Reconcile running work.** Interrupt and retry runs with no events for the stall timeout; notice dead processes and tasks cancelled from chat.
2. **Validate.** Config loads, nodes are online, CLIs are signed in, quota snapshots are fresh.
3. **Collect ready tasks.** Dependencies done, no open blocking question, write scope free.
4. **Sort.** Priority, then age, then id, as Symphony does.
5. **Dispatch while slots remain.** Slots are counted globally, per project, per account and per vendor.
6. **Publish events.** The UI and the notifier update from the event store.

Failed runs retry after `min(10 s × 2^(attempt − 1), 5 min)`; a clean exit gets a 1-second re-check in case the task still needs work. After the retry limit, the task becomes an incident.

**The planner** is one structured call (Claude `--json-schema` or Codex `outputSchema`) that returns questions and a task graph:

```json
{
  "questions": [{ "text": "Should guests be able to see order history?", "blocking": true }],
  "tasks": [{
    "key": "orders-auth",
    "title": "Require login for /api/orders",
    "doneWhen": "Anonymous requests get 401; tests cover both cases",
    "writeScope": ["src/api/orders/**", "tests/api/orders/**"],
    "role": "backend",
    "dependsOn": [],
    "size": "S"
  }]
}
```

Code then checks the plan: the graph must be acyclic, tasks with overlapping write scopes get an implicit dependency instead of running in parallel (DeepSeek's write-scope warnings), every task needs a testable done-when, and size L tasks are planned again.

**The router** scores each candidate (vendor, model, account): fit for the role, plus quota headroom, minus cost and recent failure rate. A reviewer must come from a different vendor than the author. Starting defaults, to tune with your own results rather than benchmarks:

| Work | First choice | Fallback |
| --- | --- | --- |
| Planning, unclear specs, architecture | Claude Code, top model, high effort | Codex, high reasoning |
| A clear implementation ticket | Whichever of Codex or Claude Code has more quota | The other |
| Code review | The vendor that did not write the code |  |
| UI work and browser QA | Claude Code with Chrome or Playwright | Codex with Playwright |
| Bulk mechanical changes | A Claude Code workflow (fan-out inside one run) or Codex | OpenCode on a cheap model |
| Summaries, chat replies, triage | The cheapest available option |  |

**Quota-aware scheduling**

- Track each account's 5-hour and weekly utilization from Claude's `rate_limit_event` and Codex's `account/rateLimits/updated`.
- Stop starting long runs on an account above a soft ceiling (80% to start), keeping the rest for your own interactive work.
- On a rejection, pause that account's queue until the reset time. Move not-yet-started tasks to another vendor only if their role allows it. Never retry in a tight loop.
- Cap concurrent runs per account (2 or 3 to start), and support quiet hours and a daily run budget.
- Show headroom per account in the dashboard and through a `/usage` chat command.

**Loops that keep work moving**

- **Continuation:** after a clean turn that misses the done-when, send a short continuation prompt in the same session (Symphony), up to a turn limit.
- **Verify and fix:** failing checks go back to the author with the logs, three rounds at most, then escalate.
- **Review:** findings go back to the author, then one re-review, two rounds at most.
- **Inbox:** for long-lived agents, a `Stop` hook that returns `block` with the queued messages keeps the agent working, guarded against infinite loops (Munder Difflin).

**Escalation comes in three kinds**

| Kind | Examples | Default if you don't answer |
| --- | --- | --- |
| Question | Unclear requirement, missing credential, design choice | Blocking: the task parks and other work continues. Non-blocking: the agent proceeds with its stated assumption, marked for review |
| Approval | Merge, first push of a branch, destructive command, new dependency, scope change, spend over budget | Nothing happens until you approve |
| Incident | Stall, crash, rule break, repeated failure, quota exhausted | The task pauses; you get one message with the evidence |

**The task packet** every run receives: goal, done-when, write scope, branch, the relevant files, your devflow rules, earlier answers, recent lessons, and links into the repo docs. Keep it short. The repo docs are the system of record, as OpenAI's [harness engineering](https://www.infoq.com/news/2026/02/openai-harness-engineering-codex) work and Anthropic's [long-running agents](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents) guidance both recommend: a feature list, a progress log, one feature at a time, and end-to-end tests before anything is marked done.

## Chat apps and notifications

**Make Telegram your operator console first: free bots, inline buttons, a topic per project, and no restrictions on AI bots. Add Slack or Discord for teams, and use WhatsApp only to bring client messages in.**

| Platform | Use it for | Library | Watch out for |
| --- | --- | --- | --- |
| Telegram | Your main console: tasks, questions, approvals, reports | grammY, or Vercel [Chat SDK](https://vercel.com/chat) | Long polling works behind home internet with no public URL |
| Slack | Team workspaces, one thread per task | Bolt for JS, or Chat SDK | Socket Mode avoids a public URL |
| Discord | Communities and side projects | discord.js, or Chat SDK | The bot needs the Message Content intent |
| WhatsApp | Client-message intake and short status notes | WhatsApp Cloud API (official) | Meta [banned general-purpose AI chatbots](https://respond.io/blog/whatsapp-general-purpose-chatbots-ban) on the Business API from Jan 15, 2026; bots for business tasks such as notifications and triage stay allowed. Unofficial WhatsApp Web libraries risk a banned number |
| Email | Daily digests; client reply drafts | Any SMTP or transactional email API |  |
| Phone push | Urgent alerts only | ntfy or Pushover |  |
| Claude Code [channels](https://code.claude.com/docs/en/channels.md) | Chatting with one long-running Claude session | Official Telegram, Discord and iMessage plugins | Research preview, Claude only, needs Bun. Good for a Main Claude session, not as your gateway |

Chat SDK covers Slack, Teams, Google Chat, Discord, Telegram, WhatsApp, GitHub and Linear behind one TypeScript API, which can save you writing four separate adapters.

**Commands**

| Command | What it does |
| --- | --- |
| `/new <task> #repo` | Create a task; the harness replies with an id and its questions |
| `/status` | Running tasks and what each agent is doing now |
| `/agents` | Roster with vendor, model, state and quota headroom |
| `/answer Q-12 <text>` | Answer a question (or tap a suggested answer) |
| `/approve A-7`, `/deny A-7` | Decide an approval |
| `/merge T-42` | Merge to staging after checks pass; `main` needs an explicit second step |
| `/stop T-42`, `/stop all` | Interrupt runs cleanly; the kill switch |
| `/logs T-42` | The last lines, plus a link to the live terminal |
| `/usage` | Quota per account and when each window resets |
| `/client` | Forward client messages to run the devflow-messages flow |

**Message types the harness sends**

- **Task accepted:** id, short plan, link to the task page.
- **Plan for approval:** buttons for Approve, Edit and Cancel.
- **Question:** suggested answers as buttons, or reply in text.
- **Progress digest:** batched every 15 to 30 minutes, never one message per event.
- **Done report:** summary, PR link, tests run, screenshots, quota used; buttons for Merge to staging, Request changes and Open.
- **Incident:** what failed, the evidence, and what the harness did about it.
- **Quota warning:** which account, how full, when it resets.

**Security**

- Only allowlisted user ids can command the bot; new chats pair with a one-time code, as OpenClaw and Claude channels do.
- Button presses carry signed callback data, so a forged press cannot approve anything. Approvals and merges need the owner.
- Inbound text is data, never instructions. Client messages especially, as your devflow-messages skill already states.
- Quiet hours (for example 23:00 to 08:00 IST) hold everything except incidents.

## Command Center UI

**Build a web Command Center with seven screens. The agent cards and the inbox matter most, because they replace watching terminals.** Munder Difflin proves the agent-card and live-terminal ideas; Vibe Kanban proves the board and diff review.

&#91;embedded content: wireframe · the Floor screen\]

The inbox is the screen's priority: anything that needs you sits there and in Telegram at the same time. Agent cards show state, task and current action without opening a transcript, and the terminal below follows whichever card you select.

| Screen | What it shows | What you can do there | Borrowed from |
| --- | --- | --- | --- |
| Floor (home) | One card per agent: name, vendor, model, state (working, needs you, idle, failed), current task, current action, context gauge, quota bar, crash strip | Open its terminal; pause, stop or reassign | Munder Difflin agent cards; Claude Code agent view states |
| Task board | Columns for Backlog, Clarifying, Ready, Running, Verifying, Review, Awaiting merge and Done, with a Blocked tag | Create, reprioritize, assign, open a task | Vibe Kanban |
| Task page | Spec, done-when, plan graph, every run attempt, live transcript, questions, diff, test results, screenshots, quota used | Answer, approve, comment inline on the diff, request changes, merge | Vibe Kanban diff comments; Symphony proof of work |
| Live terminal | The run as it happens, from the real terminal or the rendered event stream | Type into it, take over, hand back | Munder Difflin |
| Inbox | Questions, approvals, incidents and client messages in one queue, most urgent first | Answer in place; the same items appear in chat | Your `AgentQuestions.md` and `report.md` |
| Usage and accounts | Per account: 5-hour and weekly utilization, reset times, runs today. Per node: CLIs, versions, sign-in state | Set caps and quiet hours; pause an account | Paperclip budgets |
| Settings and roles | Projects, repos, agent profiles (role, vendor, model, permissions), schedules, integrations | Edit `role.md`-style profiles; hire an agent from a template | Munder Difflin hires |

An office view (avatars at desks, as in Munder Difflin) is fun and good for demos; build it last.

**Basics every screen needs**

- Live updates over one WebSocket, driven by the event store.
- Works on a phone as an installable web app, so you can approve from anywhere.
- Every chat message deep-links to its task, question or run.
- Search across tasks, runs and transcripts.
- Owner login plus invited members, each with their own worker node.
- Dark mode and keyboard shortcuts.
- An audit trail on every task: who asked, who approved, which agent did what.

## Browser and computer use

**Agents need a browser for two jobs: driving the app like a user, and debugging it. The harness needs a third: proof of work, meaning screenshots and short videos in every done report, captured outside the agent so they can't be faked.** Anthropic's [long-running agents study](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents) found browser end-to-end tests caught bugs that unit tests and curl checks missed.

| Layer | Tool | Use it for | Notes |
| --- | --- | --- | --- |
| Agent drives the app | Playwright CLI (`@playwright/cli`) | Click-through tests in a shell loop | The token-efficient default for coding agents, per [Steve Kinney's comparison](https://stevekinney.com/writing/driving-vs-debugging-the-browser) |
| Agent drives the app from an MCP host | Playwright MCP | Accessibility-tree element refs; Chromium, Firefox and WebKit | The only first-party option for Safari (WebKit) testing |
| Agent debugs | Chrome DevTools MCP | Core Web Vitals traces, Lighthouse audits, console, network, heap snapshots | Chrome only; has a `--slim` three-tool mode |
| Claude-specific | Claude Code with Chrome | Testing inside a real Chrome | Give agents their own Chrome profile, never your personal one |
| Harness | Headless Chromium pool (Playwright) | Screenshots, walkthrough videos and smoke checks of preview URLs | Runs outside the agent, as Symphony's proof of work |
| Desktop apps | Claude Code computer use | Native apps, rarely | Slow; build last |

**Dev servers per worktree.** The workspace manager gives each worktree its own port range, starts the dev server with a project script (an `init.sh`, as Anthropic's guidance suggests), exposes a local preview URL, and stops it during cleanup. Vibe Kanban's "branch, terminal and dev server per workspace" is the model.

**Rules**

- Web pages are untrusted input and can carry prompt injection. Agents may read pages freely; actions with side effects on real sites (submitting forms, purchases, posting) need your approval.
- Stress, load and attack tests run only against local or staging, as `/devflow-test` already requires.
- Agents can't see native browser alert dialogs well, so avoid them in flows you want agents to test.

## Isolation, safety and permissions

**Isolate every task in its own git worktree, add a container when the repo or task is untrusted, and enforce each devflow rule in code at three layers: the CLI's own permissions, the harness policy check, and GitHub.** A rule written only in a prompt is a request, not a boundary, as DeepSeek Harness's docs point out.

| Level | What it is | When to use it | Tools |
| --- | --- | --- | --- |
| Worktree | Own branch and directory per task, with the CLI's own sandbox on | Your own repos, everyday tasks | `git worktree`; Claude Code's sandboxed Bash; Codex `workspace-write` sandbox |
| Container | The worktree mounted into a container with a network allowlist | Client code, unknown repos, dependency installs | [Docker Sandboxes](https://docs.docker.com/ai/sandboxes) (`sbx` CLI, microVM isolation, agents including Claude Code, Codex, Copilot, Cursor, Gemini and OpenCode); devcontainers |
| Remote | A disposable cloud machine | Untrusted code, heavy load tests | Docker Sandboxes cloud, Daytona, Modal |

Check how each sandbox handles CLI sign-in before relying on it: a subscription login has to happen inside the sandbox, by its owner.

**Permission profiles** compile your `role.md` into each CLI's own controls, and the same rules feed the harness policy check:

```yaml
# profiles/backend-dev.yaml (compiled from role.md)
role: backend-dev
writeScope: ["src/api/**", "tests/api/**"]
allow: ["Read", "Edit", "Bash(npm test *)", "Bash(npm run lint *)", "Bash(git commit *)"]
deny: ["Bash(git push * main*)", "Bash(git push * staging*)", "Bash(git push --force*)", "Read(.env*)", "Bash(rm -rf *)"]
approvalRequired: [first-push, new-dependency, db-migration]
isolation: worktree      # worktree | container | remote
network: allowlist       # package registries and GitHub only
```

- **Claude Code:** `--permission-mode`, `--allowedTools` and deny rules from the profile; a `PreToolUse` HTTP hook asks the harness policy endpoint about risky calls; `--permission-prompts none` so nothing hangs.
- **Codex:** approval policy and sandbox per thread; approval requests arrive at the harness, which answers from the same policy.

**Git safety**

- Agents commit only on their own branch in their own worktree. The harness pushes (the first push of a branch needs your approval, per devflow) and merges through the merge queue.
- GitHub branch protection on `main` and `staging`, with required checks. No force-push, history rewrite or skipped hooks, ever.
- The merge queue rebases on the latest staging, re-runs checks and merges. A conflict goes back to the author agent with the details.

**Secrets**

- Agent processes start with a scrubbed environment and an explicit allowlist, as in DeepSeek Harness.
- Chat, GitHub and tracker tokens live only in the hub, in the OS keychain or a secrets manager. Agents get narrowly scoped repo access, or the harness performs pushes for them.
- `.env` files are deny-read for agents unless a task explicitly needs one.

**Prompt injection and runaway agents**

- Chat messages, client messages, issues, web pages and tool output are data. Risky actions need approval whatever the text says.
- The reviewer agent sees the diff and the task, not the conversation that produced them, so it doesn't inherit injected instructions.
- A circuit breaker pauses an agent after repeated denied actions or failures (Codex's auto-review has a similar denial limit); `/stop all` is the kill switch.
- Every tool call summary, approval and merge lands in the event store as the audit trail.
- Keep the dashboard on localhost or a private network such as Tailscale; never expose the hub to the internet without auth.

## Data model, state and event protocol

**Store everything as append-only events in SQLite and derive current state from them.** A crash, a restart or a "what happened at 3 a.m.?" question is then answered by replaying the log, the same principle as DeepSeek Harness's session log.

| Entity | Key fields | Devflow equivalent |
| --- | --- | --- |
| Project | id, name, repos, default branch, chat topic | `context.md` |
| Node | id, owner, host, CLIs (name, version, signed in), last seen |  |
| Account | id, node, vendor, plan, quota snapshot (window, utilization, reset time), caps |  |
| Agent profile | id, name, vendor, model, effort, role, permission profile, skills | `agents.md` row and `role.md` |
| Task | id (T-42), project, title, spec, done-when, priority, repeats, status, parent, depends on, write scope, assignee, branch | `tasks.md` entry |
| Run | id, task, attempt, adapter, account, session ref, worktree, state, start and end, tokens, cost estimate, result |  |
| Question | id (Q-12), task, run, text, blocking, status, answer, answered by | `AgentQuestions.md`, `AgentAnswers.md` |
| Approval | id (A-7), kind, payload, requested by, status, decided by |  |
| Incident | id (R-3), about, evidence, status, decision | `report.md` |
| Lesson | id, text, source, status | Lessons in `CLAUDE.md` |
| Artifact | id, run, kind (diff, test report, screenshot, video, PR), location |  |
| Event | seq, time, type, actor, project, task, run, payload | `progress.md`, rendered from events |

**Event envelope**

```ts
type HarnessEventRecord = {
  seq: number;                       // global and monotonic
  ts: string;                        // ISO-8601
  type: string;                      // e.g. 'task.planned', 'run.completed'
  actor: { kind: 'user' | 'agent' | 'harness'; id: string };
  projectId?: string; taskId?: string; runId?: string;
  commandId?: string;                // dedupes retried chat commands
  payload: unknown;                  // validated per type
};
```

Event families: `task.*` (created, planned, status changed), `question.*`, `approval.*`, `run.*` (dispatched, started, the normalized adapter events, completed, failed), `quota.updated`, `merge.*`, `incident.*`, `lesson.*`.

**Rules**

- Only the orchestrator writes task state. Workers and gateways send events or commands, never edits (Symphony's single authority).
- UI views fold events incrementally. The devflow markdown files are projections too, rendered and committed by the harness as the single writer.
- Every command carries an id, so a chat retry never creates a second task or a second merge.
- Raw transcripts stay where each CLI keeps them (Claude's session `.jsonl` files, Codex's `~/.codex/sessions`); the event store keeps references and summaries.
- If you let agents message each other, use a small typed envelope like Munder Difflin's: from, to, act (request, inform, query, done), subject, body and a hop count with a cap, so two agents can't loop forever.

## Recommended tech stack and repo layout

**Use one TypeScript monorepo.** The Codex SDK, the Claude Agent SDK, OpenCode, ACP, Chat SDK and Playwright all have official TypeScript SDKs, and DeepSeek Harness, OpenClaw, Paperclip and Munder Difflin are all built on Node.

| Layer | Choice | Notes |
| --- | --- | --- |
| Runtime | Node.js LTS, TypeScript, pnpm workspaces | node-pty needs a C/C++ build toolchain |
| Hub server | Hono or Fastify, plus WebSocket | One port, behind Tailscale |
| Storage | SQLite in WAL mode (better-sqlite3 with Drizzle) | Move to Postgres only when a team needs it |
| Validation | Zod schemas for events, commands and planner output |  |
| Processes | execa for CLI runs; node-pty for terminal sessions |  |
| Scheduling | The in-process tick loop, plus croner for recurring tasks |  |
| Git | `git` (worktrees) and `gh` (PRs, checks) |  |
| Chat | grammY for Telegram first; Chat SDK when adding platforms |  |
| UI | React with Vite, TanStack Query, xterm.js, Monaco diff editor, dnd-kit for the board, shadcn/ui | Pixi.js only for an office view |
| Browser | Playwright; Chrome DevTools MCP for agents |  |
| Packaging | Docker Compose for the hub; one `npx` command for nodes | A desktop app (Electron or Tauri) later |
| Observability | Structured logs (pino); OpenTelemetry later |  |

**Repo layout**

```
devflow-harness/
├── apps/
│   ├── hub/               # harnessd: API, orchestrator, scheduler, policy, notifier
│   ├── node/              # worker node agent (runs inside the hub for solo use)
│   ├── web/               # Command Center UI
│   └── cli/               # dfh new "...", dfh status, dfh attach T-42
├── packages/
│   ├── core/              # types, event store, state machine, projections
│   ├── adapters/
│   │   ├── claude-code/   # stream-json, HTTP hooks, background sessions
│   │   ├── codex/         # app-server JSON-RPC client
│   │   ├── opencode/      # HTTP and event-stream client
│   │   ├── acp/           # generic ACP client
│   │   └── pty/           # node-pty fallback for any CLI
│   ├── planner/           # prompts and JSON schemas for plan, route, review
│   ├── policy/            # devflow rules, permission profiles, approvals
│   ├── workspace/         # worktrees, ports, dev servers, cleanup
│   ├── mcp-harness/       # MCP server injected into every agent
│   ├── gateways/          # telegram, slack, discord, whatsapp, webhooks
│   ├── browser/           # Playwright pool, screenshots, videos
│   └── devflow/           # read and write tasks.md, agents.md, progress.md
├── profiles/              # permission profiles compiled from role.md
└── docs/                  # architecture notes, decisions, runbooks
```

Keep every package behind an interface and a registry (`adapters.register('codex', …)`, `gateways.register('telegram', …)`). That gives you DeepSeek's "everything is a plugin" without adopting its Cordis framework on day one.

**Per-repo config** lives in a `WORKFLOW.md` at the repo root, as in Symphony: YAML front matter for settings, a prompt template for the body.

```markdown
---
agents: { allowed: [claude-code, codex], maxConcurrent: 3 }
checks: ["npm run lint", "npm test"]
preview: { command: "npm run dev -- --port $PORT", url: "http://localhost:$PORT" }
protectedBranches: [main, staging]
---
You are working on {{ task.title }} in {{ project.name }}.
Done when: {{ task.doneWhen }}
Follow the devflow rules in CLAUDE.md and AGENTS.md.
```

## Build roadmap

**Ship in five phases, each ending at a gate you can demo from your phone. Phase 0 alone delivers the core loop: a Telegram message becomes a PR ready for your review.** Durations are estimates for one developer building with AI agents full-time.

&#91;embedded content: roadmap · 5 phases, 4 gates\]

Each diamond is a gate: the phase isn't done until you can show that result from your phone. Phase 0 is the one to start this week.

**What to ship first (Phase 0 checklist)**

- [ ] Hub skeleton: SQLite event store, task table, tick loop with one slot
- [ ] Claude Code adapter: `claude -p --output-format stream-json`, resume by session id, SIGINT stop, `rate_limit_event` parsing
- [ ] Workspace manager: create and clean worktrees and branches with devflow naming
- [ ] Harness MCP server with `ask_question` and `complete_task`
- [ ] Telegram bot: `/new`, `/status`, `/stop`, question buttons, a done message with the PR link
- [ ] Devflow harness mode: the env var, the task packet, `progress.md` written by the hub
- [ ] Protected-branch deny rules and GitHub branch protection on one test repo
- [ ] Gate demo: one Telegram message, one PR, one done message

## Risks, open questions and decisions for you

**The biggest risk is not technical: a vendor can change its terms or limits overnight.** Design so any vendor can be removed in a day, and keep your usage clearly ordinary and individual.

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| A vendor changes terms or blocks automation | Anthropic, Google and OpenAI all changed third-party rules in 2026 | Official binaries only; adapters you can switch off per vendor; watch each changelog |
| Quota runs out mid-task | Work stalls; your own interactive use suffers | Quota-aware scheduler, a reserve per account, cross-vendor fallback |
| An account gets flagged | Losing your main tool is worse than slow work | Concurrency caps, no round-the-clock hammering, never sharing an account |
| A CLI update breaks stream parsing | CLIs ship weekly | Pin versions per node, feature-detect, replay recorded streams in contract tests, update a canary node first |
| Parallel agents edit the same files | Merge conflicts and lost work | Write scopes, implicit dependencies, the merge queue, small tasks |
| Agents loop or burn quota | Silent cost and stalls | Turn and round caps, stall detection, a circuit breaker, hop caps on messages |
| Prompt injection through client messages, issues or web pages | An agent acts on text it should only read | Text is data; approvals for risky actions; the reviewer sees only the diff and task |
| Secrets leak into transcripts or commits | Credentials end up in git history | Scrubbed environment, deny-read on `.env`, a secret scan before every push |
| The hub is exposed to the internet | Anyone could command your agents | Localhost or Tailscale only, auth, signed approvals |
| Agents say "done" without real verification | Anthropic saw agents declare victory early | Testable done-when, harness-side checks and screenshots, cross-vendor review |
| Building too much before it pays off | A big harness that never ships | Phase gates; ship Phase 0 first and use it daily |

**Decisions for you**

- [ ] Is this a personal tool, a team tool, or a commercial product? The answer changes which Anthropic terms apply.
- [ ] Where does the hub run: your desktop, a mini PC, or a VPS?
- [ ] Telegram or Slack as the primary console?
- [ ] GitHub only, or GitLab and Bitbucket too?
- [ ] Is Gemini in scope, given Google's stance on third-party tools?
- [ ] Will you pay for a small API budget (DeepSeek or OpenAI) for planner and summary calls, or keep everything on subscriptions?
- [ ] Will you open-source the harness? That qualifies it for OpenAI's self-serve Sign in with ChatGPT path.
- [ ] Keep the name "DevFlow Harness"?

## Sources

Pages and repositories opened for this doc, as of Oct 26, 2026.

**Your workflow**

- [Thenn-Labs/devflow-skills](https://github.com/Thenn-Labs/devflow-skills): README, the three skills and the workspace templates

**Subscription terms**

- [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [The Next Web: Anthropic cuts OpenClaw from subscriptions (Apr 4, 2026)](https://thenextweb.com/news/anthropic-openclaw-claude-subscription-ban-cost/)
- [VentureBeat: Anthropic cracks down on third-party harnesses (Jan 2026)](https://venturebeat.com/technology/anthropic-cracks-down-on-unauthorized-claude-usage-by-third-party-harnesses)
- [WinBuzzer: Anthropic bans subscription OAuth in third-party apps (Feb 19, 2026)](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/)
- [bswen: Claude Code and third-party harness terms](https://docs.bswen.com/blog/2026-03-09-claude-code-sdk-third-party-harness/)
- [OpenAI Help Center: using your ChatGPT plan in other apps](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)
- [Sign in with ChatGPT for developers (DEV Community)](https://dev.to/hassann/sign-in-with-chatgpt-for-developers-the-oauth-flow-plan-usage-and-what-it-means-for-your-api-bill-48f7)
- [Connecting your ChatGPT subscription to your tools (yage.ai)](https://yage.ai/share/chatgpt-subscription-oauth-en-20261013.html)
- [OpenAI community: DevDay 2026 announcements](https://community.openai.com/t/devday-2026-announcements-and-developer-resources/1402006)
- [Simon Willison: OpenAI DevDay 2026 live blog](https://simonwillison.net/2026/Sep/29/openai-devday-2026-live-blog/)
- [MetricNexus: Google's OpenClaw and Antigravity bans](https://metricnexus.ai/blog/google-banning-openclaw-antigravity-users)

**Agent CLIs and protocols**

- [Claude Code: run programmatically](https://code.claude.com/docs/en/headless.md), [hooks](https://code.claude.com/docs/en/hooks.md), [channels](https://code.claude.com/docs/en/channels.md), [agent view](https://code.claude.com/docs/en/agent-view.md), [workflows](https://code.claude.com/docs/en/workflows.md), [mods](https://code.claude.com/docs/en/plugins/mods/overview.md)
- [ClaudeCode.Message.RateLimitEvent (Elixir SDK docs)](https://claude-code.hexdocs.pm/ClaudeCode.Message.RateLimitEvent.html)
- [openai/codex](https://github.com/openai/codex): app-server README and the TypeScript SDK
- [OpenCode server docs](https://opencode.ai/docs/server/)
- [Zed: the ACP Registry is live](https://zed.dev/blog/acp-registry)

**Harnesses and orchestrators**

- [DeepSeek Harness site](https://www.deepseek.com/en/harness/), [repository and architecture docs](https://github.com/deepseek-ai/deepseek-harness), [VentureBeat launch report](https://venturebeat.com/technology/deepseek-harness-launches-as-open-source-rival-to-claude-code-alongside-v4-pro-on-api-with-higher-prices), [DataCamp explainer](https://www.datacamp.com/blog/what-is-deepseek-harness)
- [openai/symphony](https://github.com/openai/symphony) and its [SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md)
- [Munder Difflin](https://github.com/chaitanyagiri/munder-difflin), [Mervin Praison's overview](https://mer.vin/news/munder-difflin-turns-coding-agents-into-a-self-running-office/), [EveryDev listing](https://www.everydev.ai/tools/munder-difflin/llms.txt)
- [Gas Town](https://github.com/steveyegge/gastown), [Paperclip](https://github.com/paperclipai/paperclip), [OpenClaw](https://github.com/openclaw/openclaw), [Hermes Agent](https://github.com/NousResearch/hermes-agent)
- [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) and its [shutdown notice](https://vibekanban.com/shutdown)

**Practices, chat, browser, sandboxes**

- [Anthropic: effective harnesses for long-running agents](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [InfoQ: OpenAI harness engineering](https://www.infoq.com/news/2026/02/openai-harness-engineering-codex)
- [Vercel Chat SDK](https://vercel.com/chat)
- [respond.io: WhatsApp general-purpose chatbot ban](https://respond.io/blog/whatsapp-general-purpose-chatbots-ban)
- [Steve Kinney: Playwright vs Chrome DevTools MCP](https://stevekinney.com/writing/driving-vs-debugging-the-browser)
- [Docker Sandboxes docs](https://docs.docker.com/ai/sandboxes)
