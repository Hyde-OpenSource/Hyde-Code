# Hyde Code

A self-hosted control plane that drives the official agent CLIs you already pay for (Claude Code,
Codex, OpenCode and any ACP agent such as Gemini CLI) and owns everything around them: tasks,
worktrees, planning, review, approvals, chat, a web dashboard and the devflow files.
The research and build plan is in [docs/plan.md](docs/plan.md).

**Nothing is compulsory.** `hyde setup` (or Settings in the dashboard) shows what is installed
and signed in on your machine and lets you pick which agents, stages and chat apps to use.

## How it stays inside the vendor terms

Hyde Code launches each vendor's unmodified CLI, signed in by its owner, on that owner's machine.
It never reads, copies or stores CLI credentials, never uses `claude --bare`, and starts every agent
with an allowlisted environment (no `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or chat tokens).

## Install

Requirements: Node.js 24+, git, `gh` (signed in) for PRs, and at least one agent CLI signed in
(Claude Code, Codex, OpenCode, …).

```bash
git clone https://github.com/Hyde-OpenSource/Hyde-Code.git && cd Hyde-Code
corepack enable pnpm
pnpm install
pnpm build             # the web office
pnpm install-cli       # puts `hyde` on your PATH (~/.local/bin)
```

## Use it like `claude` or `codex`

Open a terminal in any project folder and run:

```bash
hyde
```

- **First time in a folder**, Hyde asks whether you trust it, and tells you that using Hyde
  Code means accepting the [Terms](TERMS.md). If the folder is not a git repository it offers
  to run `git init`.
- **First time on this machine**, it asks which agents, stages and chat apps you want
  (nothing is compulsory).
- It registers the folder as a project, starts the hub in the background if needed, and opens
  the office in the terminal. Press `w` for the web office, `q` to leave (the hub keeps working).

Other commands, all from inside a project folder:

| Command | What it does |
|---|---|
| `hyde web` | Open the web office on this project |
| `hyde new "Add a footer"` | A task for this project |
| `hyde status` | What is running, what waits for you |
| `hyde answer Q-3 "yes"` · `approve A-2` · `deny A-2` · `merge T-4` · `stop T-4` | Same as in chat |
| `hyde projects` | Every project Hyde knows |
| `hyde forget` | Stop trusting this folder and remove the project |
| `hyde hub stop` · `start` · `restart` · `status` · `logs` | The background hub |
| `hyde setup` | Change agents, stages and chat apps |

Everything lives in `~/.hyde` (settings, tokens in `.env` with mode 0600, trusted folders,
history, worktrees). Set `HYDE_HOME` to use another place.

## Two ways to watch: web or terminal

Both read the same hub, so you can switch at any time and nothing is lost.

- **Web** (`hyde web`): a **Projects** sidebar like other agent apps (every folder, what runs there, what waits for you; *All projects* or one at a time; *+* adds a folder with the same trust question), and the office from [Munder Difflin](https://github.com/chaitanyagiri/munder-difflin)
  (MIT), ported in `apps/web/src/md`. Each agent is a person on the floor: at their desk
  with the monitor lit while working, wandering, on coffee breaks or errands when free,
  walking to the door when they need you. Hyde (the hub) is the boss at the corner desk.
  Envelopes fly for hand-offs, questions, reviews and PRs; the wall boards show the
  tasks. The right side is Hyde's Command Center (Tasks, Ask me, Activity) or the
  selected agent with its live session; the bottom strip has the agent cards and the
  dispatch box. Light and dark themes. The **Terminal** button shows how to switch.
- **Floor art**: the office map uses LimeZu's "Modern Interiors" tiles, which may not be
  redistributed, so Hyde Code ships simple stand-in tiles. If you own the pack
  ([limezu.itch.io/moderninteriors](https://limezu.itch.io/moderninteriors)), run
  `hyde tiles <unzipped folder>` once; it finds the three sheets the map needs (or
  pass `interiors.png=<file>` etc. by hand) and keeps them in `.hyde/` (gitignored).
- **Terminal** (`hyde`, or `hyde tui`): rooms, the team table with quota bars and the selected agent's
  live session. Keys: `1`–`5` screens (Office, Board, Inbox, Activity, Usage), `↑↓` pick,
  `enter` open, `a` approve or merge, `d` deny, `r` reply, `n` new task, `c` client message,
  `:` any slash command, `w` open the web office, `q` quit. Set `NO_COLOR=1` for plain text.

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

## Commands (chat, dashboard or `hyde <command>`)

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
| `apps/hub` | Config, orchestrator, router, planner, review, policy, merge queue, notifier, API, CLI, setup, terminal UI (`tui*.ts`) |
| `apps/web` | Web dashboard: the office (`src/md`, ported from Munder Difflin), Board, Inbox, Task, Usage, Audit, Settings |
| `apps/node` | Worker node for teammates' machines |
| `packages/core` | Contracts, event schemas, event store, projections, lifecycle, chat commands |
| `packages/adapters/*` | claude-code, codex, opencode, acp, command, and the shared process base |
| `packages/gateways/*` | telegram, slack, discord, whatsapp |
| `packages/workspace`, `policy`, `devflow`, `mcp-harness` | Git and hosts, rules, devflow files, agent tools |

## Credits
- Office UI, scene engine and design system: [Munder Difflin](https://github.com/chaitanyagiri/munder-difflin) by Chaitanya Giri (MIT).
- Office map: [shahar061/the-office](https://github.com/shahar061/the-office) (ISC).
- Fonts: Press Start 2P, Inter, JetBrains Mono (SIL OFL 1.1).
- Floor tiles, when you import your own copy: [Modern Interiors by LimeZu](https://limezu.itch.io/).
