# Hyde Code

A self-hosted control plane that drives the official agent CLIs you already pay for (Claude Code,
Codex, OpenCode and any ACP agent such as Gemini CLI) and owns everything around them: tasks,
worktrees, planning, review, approvals, chat, a web dashboard and the devflow files.
The research and build plan is in [docs/plan.md](docs/plan.md).

**Nothing is compulsory.** `pnpm hyde setup` (or Settings in the dashboard) shows what is installed
and signed in on your machine and lets you pick which agents, stages and chat apps to use.

## How it stays inside the vendor terms

Hyde Code launches each vendor's unmodified CLI, signed in by its owner, on that owner's machine.
It never reads, copies or stores CLI credentials, never uses `claude --bare`, and starts every agent
with an allowlisted environment (no `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or chat tokens).

## Setup

Requirements: Node.js 24+, git, `gh` (signed in) for PRs, and at least one agent CLI signed in.

```bash
corepack enable pnpm
pnpm install
pnpm hyde setup        # pick agents, project, stages, chat apps; writes hyde.config.json and .env
pnpm build             # the web dashboard
pnpm start             # the hub
pnpm hyde dashboard    # prints a one-time login link for http://127.0.0.1:7420
```

Optional: `pnpm --filter @hyde/hub exec playwright install chromium` for browser verification.

At startup the hub checks every agent's CLI and sign-in, and installs a pre-push hook in each project
that refuses pushes to `main`, `master`, `staging`, `production`, `prod` and `release` (it never
overwrites an existing hook). Also turn on GitHub branch protection.

## What a task goes through

1. **Intake**: `/new` from chat, the dashboard, the CLI, a schedule, or a client message (`/client`,
   WhatsApp) that you accept first. Client text is always treated as data, never as instructions.
2. **Plan** (optional): a planner asks questions and splits the work into subtasks with a done-when,
   a write scope and dependencies. Big plans wait for your approval.
3. **Route**: each subtask goes to the best agent by role, quota headroom and recent failures.
   New runs wait while an account is above its quota soft ceiling.
4. **Execute**: the agent works on `<agent>/feature/t-<n>-<slug>` in its own worktree, cut from the
   latest `origin/<base>`. It asks you through `ask_question`; your answer resumes the same session.
5. **Verify**: project checks, then (optional) a browser check with screenshots as proof of work.
6. **Review** (optional): an agent from a different vendor reviews only the diff; findings go back.
7. **Report**: a `progress.md` entry on the branch, then your approval for the first push and a PR.
8. **Merge**: `/merge T-n` merges the latest base into the branch (no rebase, no force-push),
   re-runs checks and merges the PR. `/promote` releases staging into main only after you confirm.

A policy hook checks Claude's tool calls (no pushes, merges, protected checkouts, `.env` reads or
edits outside the write scope; new dependencies need your approval) and pauses an agent after
repeated denials. Agents propose lessons; approved ones go into `CLAUDE.md` and `AGENTS.md`.

## Commands (chat, dashboard or `pnpm hyde <command>`)

`/new <task> #project @agent`, `/client <message>`, `/status`, `/agents`, `/usage`, `/logs T-3`,
`/stop T-3`, `/stop all`, `/retry T-3`, `/answer Q-2 <text>`, `/approve A-1`, `/deny A-1`,
`/approve L-1` (lessons), `/merge T-3`, `/promote #project`, `/projects`. Slack and Discord also
accept `hyde new …` and `!new …`.

## Chat apps, schedules and teammates

- **Telegram, Slack (Socket Mode), Discord**: enable in setup and put tokens in `.env`
  (see `.env.example`). Only allowlisted users can command the bot; buttons are HMAC-signed.
- **WhatsApp** (client intake only): point the Cloud API webhook at `/webhooks/whatsapp`.
- **Quiet hours and digests**: `notifications` in `hyde.config.json`.
- **Schedules**: `schedules: [{ "id", "cron", "project", "text" }]`.
- **Worker nodes**: a teammate runs `pnpm --filter @hyde/node start` with their own signed-in CLIs
  (settings in `apps/node/src/main.ts`); agents with `"node": "<id>"` run there.
- **Containers**: `"isolation": "container"` with `container.image` runs an agent in Docker; sign in
  once inside its home volume.
- **Plugins**: `plugins: ["./my-plugin.ts"]`, exporting `register({ adapters, gateways, config })`.

## Development

```bash
pnpm test        # vitest
pnpm typecheck   # tsc (hub, packages, web)
```

| Path | Contents |
|---|---|
| `apps/hub` | Config, orchestrator, router, planner, review, policy, merge queue, notifier, API, CLI, setup |
| `apps/web` | Dashboard: Floor, Inbox, Board, Task, Usage, Office, Audit, Settings |
| `apps/node` | Worker node for teammates' machines |
| `packages/core` | Contracts, event schemas, event store, projections, lifecycle, chat commands |
| `packages/adapters/*` | claude-code, codex, opencode, acp, command, and the shared process base |
| `packages/gateways/*` | telegram, slack, discord, whatsapp |
| `packages/workspace`, `policy`, `devflow`, `mcp-harness` | Git and hosts, rules, devflow files, agent tools |
