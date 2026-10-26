# Hyde Code

A self-hosted control plane that drives the official agent CLIs you already pay for (Claude Code first)
and owns everything around them: tasks, worktrees, approvals, chat and the devflow files.
The full research and build plan is in [docs/plan.md](docs/plan.md).

**Status: Phase 0.** One Telegram (or CLI) message becomes one Claude Code run in its own git worktree,
verified by the project's checks, logged in `progress.md`, and pushed as a PR only after you tap approve.

## How it stays inside the vendor terms

Hyde Code launches the unmodified `claude` binary, signed in with your own subscription, on your own
machine. It never reads, copies or stores your Claude credentials, never uses `--bare`, and strips
`ANTHROPIC_API_KEY` and every other secret from the agent's environment.

## Setup

Requirements: Node.js 24+, git, `claude` (signed in), and `gh` (signed in) for opening PRs.

```bash
corepack enable pnpm
pnpm install
cp hyde.config.example.json hyde.config.json   # set your repo path, base branch and checks
cp .env.example .env                           # optional: Telegram bot token
pnpm start
```

At startup the hub checks that Claude Code is signed in and installs a pre-push hook in each project
that refuses pushes to `main`, `master`, `staging`, `production`, `prod` and `release`. It never
overwrites an existing hook; if you already have one, it warns you. Also turn on GitHub branch protection.

### Telegram

1. Create a bot with @BotFather and put its token in `.env` as `TELEGRAM_BOT_TOKEN`.
2. Either list your user id in `TELEGRAM_ALLOWED_USER_IDS`, or start the hub and send the bot the
   `/pair <code>` it prints. Everyone else is refused.

### Commands (Telegram or `pnpm hyde <command>`)

| Command | What it does |
|---|---|
| `/new <task> #project` | Create a task (`#project` optional with one project) |
| `/status` | Active tasks, open questions, quota |
| `/projects` | Registered projects |
| `/stop T-3`, `/stop all` | Interrupt runs cleanly (SIGINT) and cancel |
| `/answer Q-2 <text>` | Answer a question (or tap a button, or reply to the question) |
| `/approve A-1`, `/deny A-1` | Decide an approval |

## The task loop

1. `/new` creates a task. The hub cuts `claude-1/feature/t-<n>-<slug>` from the base branch into
   `.hyde/worktrees/<project>/T-<n>`.
2. Claude Code runs headless (`claude -p --output-format stream-json`) in that worktree with a task
   packet, deny rules (no push, merge, rebase, `rm -rf`, `.env` reads) and the `hyde` MCP server
   (`ask_question`, `report_progress`, `complete_task`).
3. A blocking question parks the task; your answer resumes the same Claude session.
4. On `complete_task` the hub runs the project's checks. Failures go back to the agent (up to
   `maxFixRounds`). When they pass, it writes a `progress.md` entry, commits it on the task branch and asks
   you to approve the first push.
5. On approval it pushes the branch and opens a PR into the base branch. Merging stays with you.

Every step is an event in `.hyde/events.db` (append-only SQLite), so a restart replays to the same state.
Runs are quota-aware: new runs wait while the 5-hour or weekly window is above `quotaSoftCeiling`.

## Development

```bash
pnpm test        # vitest
pnpm typecheck   # tsc
```

| Path | Contents |
|---|---|
| `apps/hub` | `harnessd`: config, orchestrator (state machine + tick loop), HTTP API, CLI |
| `packages/core` | Adapter contract, event schemas, event store, projections, lifecycle |
| `packages/adapters/claude-code` | stream-json parser, CLI arguments, process handling |
| `packages/workspace` | Worktrees, branch naming, git helpers, pre-push hook install |
| `packages/policy` | Protected branches, permission profile, pre-push hook |
| `packages/devflow` | Task packet, `progress.md` entries, lessons |
| `packages/mcp-harness` | The MCP server injected into every agent |
| `packages/gateways/telegram` | grammY bot, command parsing, signed buttons, pairing |
