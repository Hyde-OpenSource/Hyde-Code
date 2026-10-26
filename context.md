# Project Context

> Full context of this project. Kept up to date by the main agent. Anything not known yet is marked `UNKNOWN: ask user`.
> Created: 2026-10-27

## 1. What this project is
- **Name:** Hyde Code (the plan's working name was "DevFlow Harness"; the owner chose Hyde Code on 2026-10-27)
- **Purpose / problem it solves:** A self-hosted control plane that drives the official agent CLIs (Claude Code first, Codex next) and owns tasks, worktrees, approvals, chat, UI and memory. "Send a task, get a reviewed PR back." The full plan is in `docs/plan.md`.
- **Who uses it:** The owner only. **Personal tool** (decided 2026-10-27), so it runs the owner's own signed-in CLIs on the owner's own machine.
- **Client / owner:** Tirth (GitHub `Tirth1107`), GamifyIAS Management.

## 2. Tech stack
- **Language/runtime:** TypeScript on Node.js 24 (tested on 24.21.0), run with `tsx` (no build step); `tsc --noEmit` for type checks.
- **Monorepo:** pnpm 12 workspaces (enabled through corepack).
- **Backend:** Hono with `@hono/node-server` (hub API on 127.0.0.1).
- **Database:** SQLite through Node's built-in `node:sqlite` (WAL), as an append-only event log. The plan said better-sqlite3 + Drizzle; we used `node:sqlite` to avoid a native build. Revisit if we need migrations.
- **Chat:** grammY (Telegram, long polling).
- **Agent tools:** `@modelcontextprotocol/sdk` stdio server.
- **Validation:** zod 4.
- **Tests:** vitest 5.
- **Hosting / deployment:** the owner's Fedora desktop (decided 2026-10-27). Hub and worker node run as one process.
- **Other services:** GitHub through the `gh` CLI (PRs). Claude Code CLI 2.1.310 on a Pro plan.

## 3. Architecture
- `apps/hub/src/main.ts` checks Claude sign-in, installs the protected-branch pre-push hook in each project, opens the event store, starts the HTTP API, the Telegram gateway and the orchestrator tick loop.
- **Orchestrator** (`apps/hub/src/orchestrator.ts`) is the only writer of task state. Every change is an event (`packages/core/src/events.ts`); the current state is a pure fold (`projection.ts`). Tick: reconcile stalls, then dispatch ready tasks within concurrency and quota limits.
- **Task flow (Phase 0):** `/new` → ready → running (worktree + Claude run) → [blocked on question → ready → running (resume, same session)] → verifying (checks) → [ready → running (fix turn)] → blocked on approval A-n (first push) → awaiting_merge (PR opened). Merge is out of scope for Phase 0.
- **Agent ↔ hub:** every run gets `.hyde/runs/<run>/mcp.json` that launches `packages/mcp-harness/src/main.ts` with a per-run bearer token; tool calls POST to `/api/agent/<tool>`. The token works only while the run is live.
- **Claude adapter** spawns `claude -p ... --output-format stream-json --verbose --permission-mode acceptEdits --permission-prompts none --strict-mcp-config` with a scrubbed env (allowlist), stops with SIGINT, resumes with `--resume <session>`, and stops a run early if the `hyde` MCP server failed to connect.

## 4. Folder map
- `docs/plan.md`: research and build plan (source of truth for the roadmap). The `.pdf`/`.docx` exports stay local (gitignored).
- `apps/hub/`: hub app (config, orchestrator, HTTP API, CLI).
- `packages/core/`: adapter contract, events, store, projections, lifecycle, chat types.
- `packages/adapters/claude-code/`: Claude Code adapter; `src/fixtures/` has sanitized recorded streams from CLI 2.1.310 and a fake `claude` binary for tests.
- `packages/workspace/`, `packages/policy/`, `packages/devflow/`, `packages/mcp-harness/`, `packages/gateways/telegram/`: see README.
- `.hyde/` (gitignored, runtime): `events.db`, `worktrees/`, `runs/`, `owner-token`, `callback-secret`, `telegram-paired.json`.

## 5. How to run, build, test
- **Install:** `corepack enable pnpm && pnpm install`
- **Configure:** `cp hyde.config.example.json hyde.config.json` (gitignored) and `cp .env.example .env`
- **Run locally:** `pnpm start` (or `pnpm dev` for watch mode)
- **CLI:** `pnpm hyde new "..." #project`, `pnpm hyde status`, `pnpm hyde approve A-1`, …
- **Build:** none (tsx runs TypeScript directly)
- **Test:** `pnpm test`
- **Lint / format:** `pnpm typecheck` (no linter configured yet)

## 6. Environments & branches
| Environment | Branch | URL | Set up properly? |
|---|---|---|---|
| Local | feature branches | 127.0.0.1:7420 (hub API) | yes |
| Staging | `staging` | none | local only, no remote yet |
| Production | `main` | none | local only, no remote yet |

`main` and `staging` were created on 2026-10-27 from an empty root commit (`4ebbcf3`). **No git remote yet**; the owner will provide URLs later.

## 7. Environment variables (names only, never values)
| Name | Used for | Where set |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram bot | `.env` |
| `TELEGRAM_ALLOWED_USER_IDS` | Allowlisted Telegram user ids | `.env` |
| `HYDE_CALLBACK_SECRET` | Signing button callback data (optional) | `.env` |
| `HYDE_CONFIG` | Path to hyde.config.json (optional) | shell |
| `DEVFLOW_HARNESS`, `HYDE_AGENT_NAME`, `HYDE_TASK_ID` | Set by the hub in every agent process | hub |
| `HYDE_HUB_URL`, `HYDE_RUN_TOKEN` | Set by the hub for the MCP server | hub (run mcp.json) |
| `HYDE_ALLOW_PROTECTED_PUSH` | Bypasses the pre-push guard; reserved for the future merge gate | not set |

## 8. Conventions
- ESM TypeScript, imports with `.ts` extensions, packages export `./src/index.ts`.
- Exact dependency versions, at least two weeks old when added.
- Every state change goes through `EventStore.append` with a zod-validated payload; nothing edits state directly.
- Devflow branch naming for agents: `<agent>/<type>/<task>-<slug>`.
- Tests sit next to the code (`*.test.ts`) and use temp git repos rather than mocks for git behaviour.

## 9. Known issues / risks
- `gh pr create` is untested against a real GitHub repo (no remote yet). The push path is tested against a local bare remote.
- Agent allow rules are per command prefix; compound shell commands (`a && b`) are denied under `--permission-prompts none`. That's safe, and agents retry with separate commands.
- Progress notes (`report_progress`) are sent immediately, not batched into digests.
- Claude Code CLI ships weekly; stream format changes are caught by the fixture tests only after re-recording.

## 10. Glossary
- **Hub / harnessd:** the hub process. **Run:** one CLI turn. **Task packet:** the markdown appended to the agent's system prompt.
- **T-n / Q-n / A-n / R-n:** task, question, approval and incident ids.

## 11. Open questions for the user
- GitHub remote URL for this repo, and a test repo for the Phase 0 gate demo (owner: "I'll give URLs later").
- Telegram bot token and the owner's Telegram user id (or use `/pair`).
- Should the devflow skills themselves (`~/.claude/skills`, `Thenn-Labs/devflow-skills`) get the plan's "harness mode" changes (skip Step 1 when `DEVFLOW_HARNESS=1`; use `ask_question` instead of `AskUserQuestion`)?
