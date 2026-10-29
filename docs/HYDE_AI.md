# Hyde AI — how the desktop assistant and Hyde Code work together

Hyde AI is one repository with two programs that each do one job well:

| | **Desktop assistant** (`apps/desktop`, `hyde ai` / `hyde-ai`) | **Hyde Code** (`apps/hub`, `apps/web`, `packages/*`, `hyde`) |
|---|---|---|
| Job | Understands what you say or type on the desktop | Runs coding agents and owns everything around them |
| Language | Rust, one 2.6 MB binary | TypeScript hub on Node 24 |
| UI | App window on `127.0.0.1:7878` | Office on `127.0.0.1:7420`, terminal UI, chat apps |
| Does | Apps, volume, web, installs OpenCode/OmniRoute, free AI engine, **turns coding requests into Hyde Code tasks** | Plans, picks Claude Code / Codex / OpenCode, worktrees, checks, review, approvals, PRs, merges |
| Never does | Run a coding agent, touch a repo, push | Listen to the desktop, open apps |

```
 you ── voice / text ──▶ Hyde AI ──▶ rules engine ──▶ desktop action
                            │              ▲
                            │ no match     │ rewritten command (re-checked by rules)
                            ▼              │
                        free AI engine ────┘
                            │
                coding request: "hyde code <task> in <project> using <agent>"
                            ▼
                 Hyde Code hub  POST /api/commands  "/new <task> #<project> @<agent>"
                            ▼
              planner → agent in worktree → checks → review → A-n approval → PR → /merge
                            │
     questions & approvals come back to Hyde AI's "Hyde Code" tab (and chat apps)
```

## 1. Set up (once)

```bash
./scripts/install.sh       # from the repo root: Hyde Code (`hyde`) and the desktop app (`hyde-ai`)
cd ~/some/project && hyde  # trust the folder, pick agents, start the hub
hyde ai                    # open the assistant (also "Hyde AI" in the app menu)
```

`hyde` is the hub CLI; `hyde ai` (or `hyde-ai`) is the desktop app. Neither installer touches the
other's command. To install one part only: `pnpm install-cli` or `pnpm desktop:install`.

Hyde AI finds the hub by itself: it reads `$HYDE_HOME` (default `~/.hyde`) → `config.json`
(`port`, `dataDir`) → `<dataDir>/owner-token`. If the hub is stopped, Hyde AI starts it with
`hyde hub start` the moment you give it a coding request.

## 2. Assign and follow work

Say it in the Assistant (mic button or keyboard) or use the **Hyde Code** tab.

| You say | What happens in Hyde Code |
|---|---|
| `hyde code add a dark mode toggle in gamify ias lms` | `/new add a dark mode toggle #gamify-ias-lms` (asks you to confirm first) |
| `ask hyde code to fix the login bug using codex` | `/new fix the login bug #<default> @codex-1` |
| `what is waiting for me` · `hyde code status` | Summary: running, questions, approvals, ready to merge |
| `answer Q 3 keep integers` | `/answer Q-3 keep integers` |
| `approve A 2` · `deny A 2` | `/approve A-2` · `/deny A-2` |
| `merge T 4` · `stop T 4` · `stop all` · `retry T 4` | `/merge T-4` · `/stop T-4` · `/stop all` · `/retry T-4` |
| `open hyde code` · `start hyde code` | Opens the office (logged in) · starts the hub |
| anything vague, with the AI engine on | The AI writes a precise task and routes it as `hyde code …` |

**Project** comes from, in order: the words at the end ("… in *project name*", "… for the
*site* project"), the default (★ in the Hyde Code tab), or the only project. **Agent** comes
from "… using codex / with opencode / via claude", or Hyde Code's router picks the best one.

Every request that reaches Hyde Code shows a plan card first (risk L2), so nothing is sent by
a mis-heard word. Approvals and merges still go through Hyde Code's own gates.

### Writing tasks the agents do well

Hyde Code's planner turns your words into a spec, so give it what a developer needs:

1. **The change**: "Add a dark mode toggle to the settings page".
2. **Done when**: "Done when the choice survives a reload and both themes pass the checks".
3. **Limits**: "Only touch `src/settings/`", "no new dependencies".
4. **Who**: "using codex" for bulk edits, Claude for UI and planning, OpenCode for cheap triage
   (match the `roles` in `~/.hyde/config.json`).

One task per request. Ask for a plan when the work is big ("plan and split …"); Hyde Code
waits for your approval when a plan has more than `planner.approvalOver` subtasks.

## 3. Contract between the two (keep it stable)

Hyde AI uses only these Hyde Code hub endpoints (`apps/hub/src/http.ts`):

| Call | Auth | Used for |
|---|---|---|
| `GET /api/health` | none | Is the hub up |
| `GET /api/state` | `Bearer <owner-token>` | `projects[{id,name}]`, `agents[{name,adapter,model,roles,health}]`, `tasks[{id,projectId,title,status,agent,prUrl,blockedBy}]`, `questions[{id,taskId,text,options,blocking,status}]`, `approvals[{id,taskId,kind,summary,status}]` |
| `POST /api/commands {"text"}` | same | `/new`, `/answer`, `/approve`, `/deny`, `/merge`, `/stop`, `/retry`; reply `{"text"}` (Hyde AI reads `T-<n>` from it) |
| `GET /login?token=&project=` | token | Opens the office for the user |
| `hyde hub start` (CLI) | — | Starts the hub |

The desktop app's own API only lets the UI send `/approve /deny /merge /stop /retry /answer` to the
hub; config changes, `/promote` and project trust stay inside Hyde Code.

Tests that pin this contract: `pnpm desktop:test` (`hydecode::tests`, golden phrases in
`agent::tests`). A mock hub for manual checks lives in the session notes; never test against
the real hub with real tasks unless you mean to spend agent quota.

## 4. Roadmap

### For Hyde Code (`apps/hub`)

**P0: make the integration robust**
1. `POST /api/tasks {project, text, agent?, source}` → `{id, status}`. Today Hyde AI parses
   `T-<n>` out of a reply string.
2. `GET /api/health` → `{ok, version, apiVersion}`, so clients can warn on mismatch.
3. Write `~/.hyde/hub.json` (`url`, `pid`, `version`) when the hub starts. Clients then follow
   `HYDE_CONFIG`/port changes without re-reading config.
4. A scoped **client token** (`clients/hyde-ai.token`) that can create tasks, answer, approve
   and read state but can't change config or trust folders. That lets Hyde AI stop using the owner token.
5. A `hyde-ai` source kind on tasks (`source.kind`), shown in the office and audit log.

**P1: better voice and chat flow**
6. `GET /api/summary`: counts plus the "needs you" list. Voice status then doesn't need the full,
   ever-growing `/api/state`.
7. Typed decisions: `POST /api/questions/:id/answer`, `POST /api/approvals/:id {decision}`.
8. Document the SSE `/api/events` event names. Hyde AI will then show desktop notifications
   (`notify-send`) when a question or approval opens.
9. Accept a project **name** (not only the id) in `#tag`, case- and space-insensitive.
10. Tasks that arrive from voice (`source: hyde-ai`) always go through the planner's clarify step.

**P2**
11. Quota headroom in `/api/summary`, so Hyde AI can say "Claude is at 92%, use codex?" before
    assigning.
12. ~~`hyde ai` subcommand that launches `hyde-ai`~~ — done when the projects were merged.

### For the desktop app (`apps/desktop`)
- Desktop notifications for new questions and approvals (after P1-8).
- Switch to `/api/tasks` and the client token once Hyde Code ships them; keep the current
  path as a fallback.
- Push-to-talk global shortcut, and offline speech-to-text (Vosk/whisper.cpp) instead of the
  browser's speech API.
- OmniRoute → OpenCode wiring: write OmniRoute as a provider into `~/.config/opencode/opencode.json`.
