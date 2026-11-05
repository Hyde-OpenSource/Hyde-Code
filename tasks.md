# Tasks

> The **main agent** creates and assigns tasks. An assigned agent may update only the **Status** and **Notes** of its own tasks.
> Agents must check this file every time they come online.
> Created: 2026-10-27

## Format

```markdown
## T-000: <short title>
- **Assigned to:** <agent name>
- **Assigned by / date:** <main agent> on YYYY-MM-DD
- **Priority:** high / medium / low
- **Repeats:** once / daily / weekly
- **Files / area:** <paths this agent may change for this task>
- **Branch:** <branch name>
- **Status:** TODO | IN PROGRESS | BLOCKED (Q-xxx) | REVIEW | DONE
- **Done when:** <clear finish condition>
- **Notes:** <agent's updates, newest first>
```

## Active tasks
<!-- New tasks below this line. -->

## T-001: Merge the client API branch into the combined repo
- **Assigned to:** agent-hyde-autonomy
- **Assigned by / date:** main on 2026-11-05
- **Repeats:** once
- **Branch:** agent-hyde-autonomy/feature/smart-routing
- **Status:** DONE
- **Priority:** high
- **Files / area:** whole repo (merge only)
- **Done when:** `agent-hydeai-api/feature/hyde-ai-api` (commit 24509e2, hub client API v1, docs/api.md) is merged into this branch; conflicts in README.md, progress.md and anything else are resolved keeping both sides; the desktop app (apps/desktop/crates/hyde-ai/src/hydecode.rs) still talks to the merged hub; `pnpm test`, `pnpm typecheck` and the desktop tests (`pnpm desktop:test`) pass.
- **Notes:**
  - 2026-11-05: Merged 24509e2 (commit 877b0b5); only agents.md conflicted (kept both). Tests 149, typecheck clean, desktop 18 tests.

## T-002: Complexity tiers, modes and effort levels for every job
- **Assigned to:** agent-hyde-autonomy
- **Assigned by / date:** main on 2026-11-05
- **Repeats:** once
- **Branch:** agent-hyde-autonomy/feature/smart-routing
- **Status:** DONE
- **Priority:** high
- **Files / area:** apps/hub/src/{agents,planner,orchestrator,config,setup,review}.ts, packages/core/**, packages/adapters/**, apps/web (Settings), hyde.config.example.json, docs
- **Done when:** (1) Every task gets a complexity level `trivial | low | medium | high` before it runs. A cheap step decides it: rules first (size of the request, files touched, words like rename/typo/bump), then a cheap or free model (OpenCode free model, Haiku, or the desktop assistant's free API) only when the rules can't decide. The level and why are stored as events and shown in the task page. The owner can override it on the task. (2) Each agent profile gets a model per tier instead of one model, for example claude-code: high=opus, medium=sonnet, low=haiku; codex and opencode tiers filled from their real model lists (`codex` model ids, `opencode models`). The owner mentioned "astra" (high) and "sol" (medium) as models: find out whether these exist in any installed CLI; if not, ask main in AgentQuestions.md, and never invent model ids. (3) Effort: a per-tier effort level passed to the CLI (`claude --effort <level>`, codex `-c model_reasoning_effort=...`), plus a hub-wide "Hyde effort" setting (saver / balanced / max / auto) that moves every tier up or down. (4) Modes the owner can pick in setup and Settings: `balanced` (strong model plans and reviews, code by complexity: the default), `claude-only` (Claude models by complexity, no other vendors), `free-first` (free/cheap models for trivial and low, Claude for the rest), `assistant-plans` (the desktop assistant's AI turns requests into tasks, the CLIs code). (5) Hard rules in every mode: planning, review and high-complexity coding never run on a free model; when the right tier is quota-blocked the task waits (or the owner is asked once) instead of silently dropping to a weaker model; every downgrade or upgrade is an event with a reason. (6) The planner prompt and task packet are written for the chosen model (short, clear instructions with the exact files, done-when and checks), so cheap models get tighter instructions. Unit tests for the classifier, the router per mode and tier, and the effort flags; a real `claude -p` run shows the right `--model`/`--effort` per tier.
- **Notes:**
  - 2026-11-06: DONE: real per-tier runs in T-006 (haiku/low, sonnet/medium, opus/high in the run records).
  - 2026-11-05: Code, unit and orchestrator tests done (173 tests). Real per-tier hub runs come with T-006. Questions Q-001..Q-004 open (non-blocking).

## T-003: Stop repeated questions across agents
- **Assigned to:** agent-hyde-autonomy
- **Assigned by / date:** main on 2026-11-05
- **Repeats:** once
- **Branch:** agent-hyde-autonomy/feature/smart-routing
- **Status:** DONE
- **Priority:** high
- **Files / area:** apps/hub/src/{orchestrator,planner}.ts, packages/mcp-harness/**, packages/devflow/**, packages/core/**, apps/web (Inbox), apps/desktop (questions)
- **Done when:** (1) A question memory per task and per project: before `ask_question` (any agent: Claude, Codex, OpenCode, ACP) or a planner question is recorded, the hub compares it with the open and answered questions (normalised text plus a cheap similarity check). An answered match returns the earlier answer to the agent at once; an open match links to the existing Q-n instead of creating a new one. (2) Every run (planner, re-plan, implement, continue, review, fix, conflict) gets all answered questions for its task, plus the project's standing decisions, in its packet, whichever agent runs it. (3) The planner asks only what blocks the work. Small choices become stated assumptions the owner can see and change, not questions, with a cap on questions per plan (configurable). A re-plan after answers must not ask again what was answered. (4) Agents in harness mode never ask the devflow "main or child session?" question: check this for every adapter (DEVFLOW_HARNESS env and the task packet). (5) Regression tests built from the real duplicates in the owner's event log (T-1 Q-1..Q-5, T-6 Q-8/Q-9, T-7 Q-10..Q-14) and a test where two different agents ask the same thing.
- **Notes:**
  - 2026-11-05: Question memory, planner cap/assumptions, harness-mode lines, regression tests from the real event log. Word-based matching (not semantic).

## T-004: Fix what fails in real runs
- **Assigned to:** agent-hyde-autonomy
- **Assigned by / date:** main on 2026-11-05
- **Repeats:** once
- **Branch:** agent-hyde-autonomy/feature/smart-routing
- **Status:** DONE
- **Priority:** high
- **Files / area:** apps/hub/**, packages/adapters/**
- **Done when:** Each item has a regression test or a real-run check: (1) OpenCode turns that end without `complete_task` are retried 3-4 times today (T-4 runs 9-12). Limit this, nudge the agent once with a clear "call complete_task or ask_question" message, then move the task to a stronger tier or ask the owner. (2) When Codex is quota-blocked (it hit its 5-hour and 7-day limits almost daily), its tasks go to another agent that can do that tier, or wait with a clear notice. (3) The planner failed twice on Codex with unparsed output (T-2). Retry once on a different agent, and keep the raw output as an artifact. (4) `hyde`/`pnpm start` crashed with EADDRINUSE when a hub was already running on 7420. Detect the running hub and say so instead of a stack trace. (5) Go through ~/.hyde/hub.log and the event log (read-only) for any other repeating failure and list what you found in progress.md.
- **Notes:**
  - 2026-11-05: All five items done with regression tests; port claim checked live with two scratch hubs. Findings list in progress.md.

## T-005: Hyde AI assistant as the front desk
- **Assigned to:** agent-hyde-autonomy
- **Assigned by / date:** main on 2026-11-05
- **Repeats:** once
- **Branch:** agent-hyde-autonomy/feature/smart-routing
- **Status:** DONE
- **Priority:** medium
- **Files / area:** apps/desktop/**, apps/hub/src/http.ts, docs/HYDE_AI.md, docs/api.md
- **Done when:** The desktop assistant sends requests to the hub with the tier/mode information (it can suggest a complexity level; the hub's rules have the final say). Its own free/cheap model is used only to understand the request and route it, never to write the coding instructions in `balanced` mode. It shows the complexity, the chosen agent and model, and open questions without duplicates. The hub API version is bumped and docs/api.md updated for any API change.
- **Notes:**
  - 2026-11-05: API v2; desktop routes only (no instruction writing) except in assistant-plans; level hint; Hyde Code tab shows level, agent, model, waits and one card per question. Live-checked against a scratch v2 hub. Screenshots come with T-006.

## T-006: End-to-end proof and docs
- **Assigned to:** agent-hyde-autonomy
- **Assigned by / date:** main on 2026-11-05
- **Repeats:** once
- **Branch:** agent-hyde-autonomy/feature/smart-routing
- **Status:** DONE
- **Priority:** medium
- **Files / area:** README.md, docs/**, context.md (sections 3, 4, 9, 12), progress.md
- **Done when:** On a scratch git repo (never the owner's real projects), with a scratch HYDE_HOME, three real tasks run through the hub: a trivial one (rename) on the cheap tier, a medium one on Sonnet, a high one planned and coded on Opus, each with the right `--model`/`--effort` in the run record, no repeated questions, and a review on the strong tier. Watch quota and pause at 80% of the 5-hour window. README and docs explain tiers, modes and effort. progress.md has one entry per task with what, why, files and how it was verified. Scratch repos, homes and Claude session files from the tests are deleted.
- **Notes:**
  - 2026-11-06: DONE: 5 real tasks on the scratch hub; fixes and docs in progress.md (2026-11-06).



## T-007: Skills for every agent
- **Assigned to:** agent-hyde-autonomy
- **Assigned by / date:** main on 2026-11-05
- **Repeats:** once
- **Branch:** agent-hyde-autonomy/feature/smart-routing
- **Status:** DONE (git URL import not built)
- **Priority:** medium
- **Files / area:** packages/skills (new), apps/hub/**, packages/mcp-harness/**, packages/devflow/**, apps/web (Skills page)
- **Done when:** docs/roadmap-v2.md section 2 is built: SKILL.md discovery from built-in, user and project folders; per-run delivery into each CLI's real skill folder (paths checked against the installed CLI versions); planner picks skills per task; propose_skill tool with owner approval; Skills page; tests and a real run showing a Claude and an OpenCode run each using a project skill.
- **Notes:**
  - 2026-11-06: Skills package, delivery per CLI, planner choice, propose_skill with approval, Skills page. Real Claude and OpenCode runs each used a project skill. Not built: importing from a git URL.

## T-008: Live browser feed with cursor and click overlay
- **Assigned to:** agent-hyde-autonomy
- **Assigned by / date:** main on 2026-11-05
- **Repeats:** once
- **Branch:** agent-hyde-autonomy/feature/smart-routing
- **Status:** TODO (start after T-006)
- **Priority:** medium
- **Files / area:** packages/browser-live (new), apps/hub/src/browser.ts, http.ts, orchestrator.ts, apps/web (task page, office)
- **Done when:** docs/roadmap-v2.md section 3 is built: hyde-browser MCP server, CDP screencast frames on a live channel, an overlay drawn in the dashboard (arrow cursor, ripple, element box, caption, step timeline), pause/take over/stop, recordings saved as artifacts, preview server per worktree, approval for side effects on non-local sites. Verified with a real agent run on a scratch web app plus Playwright screenshots at 1440 and 390 px.
- **Notes:**
  - 2026-11-06 (agent-hyde-autonomy, stopped before starting: Claude 5-hour window at 68%, T-007 just committed as bcdcdd4). Exact next step: create `packages/browser-live` with a stdio MCP server `hyde-browser` (Playwright 1.x, the one `apps/hub/src/browser.ts` already uses, own Chromium profile) whose tools POST every action to a new hub route `/api/agent/browser` (same per-run token as mcp-harness). Then add it to the run's MCP config next to `hyde` in `orchestrator.dispatch`, and stream `Page.startScreencast` frames on a separate SSE route (`/api/tasks/:id/live`), not the event log. Real runs can use OpenCode's free model to save Claude quota.

## T-009: Live activity timeline, todos and plan mode
- **Assigned to:** agent-hyde-autonomy
- **Assigned by / date:** main on 2026-11-05
- **Repeats:** once
- **Branch:** agent-hyde-autonomy/feature/smart-routing
- **Status:** TODO (start after T-006)
- **Priority:** medium
- **Files / area:** apps/hub/**, packages/mcp-harness/**, packages/core/**, apps/web, apps/hub/src/tui*.ts
- **Done when:** docs/roadmap-v2.md section 4 is built: one timeline per task (tool calls, commands, diffs, model/tier, tokens/cost), update_todos MCP tool shown live, optional plan-then-build with owner approval (default on for high complexity), files-touched list. Tests and screenshots.
- **Notes:**

## T-010: Diff comments, checkpoints, commands, export
- **Assigned to:** agent-hyde-autonomy
- **Assigned by / date:** main on 2026-11-05
- **Repeats:** once
- **Branch:** agent-hyde-autonomy/feature/smart-routing
- **Status:** TODO (start after T-006)
- **Priority:** medium
- **Files / area:** apps/hub/**, packages/workspace/**, apps/web
- **Done when:** docs/roadmap-v2.md section 5 is built and tested: inline diff comments start a review_fix turn, a checkpoint per turn with undo, .hyde/commands templates shared by every intake, session export with secrets redacted.
- **Notes:**

## T-011: Permissions, project memory, agent notes, issue sources
- **Assigned to:** agent-hyde-autonomy
- **Assigned by / date:** main on 2026-11-05
- **Repeats:** once
- **Branch:** agent-hyde-autonomy/feature/smart-routing
- **Status:** TODO (start after T-006)
- **Priority:** medium
- **Files / area:** apps/hub/**, packages/policy/**, packages/adapters/**, apps/web
- **Done when:** docs/roadmap-v2.md section 6 is built and tested. GitHub issue intake is tested only against a scratch repo the owner approves (ask main first). The auto-reviewer runs only on a strong tier.
- **Notes:**

## T-012: Telegram bot update
- **Assigned to:** agent-hyde-autonomy
- **Assigned by / date:** main on 2026-11-05
- **Repeats:** once
- **Branch:** agent-hyde-autonomy/feature/smart-routing
- **Status:** TODO (start after T-006)
- **Priority:** medium
- **Files / area:** packages/gateways/telegram/**, packages/core (commands), apps/hub/**
- **Done when:** docs/roadmap-v2.md section 7 is built: token-once pairing with a t.me start link, one edited live message per task, /live with cursor-annotated frames, /mode /effort /tier /skills /plan /diff /undo /todos /memory, merged duplicate questions. Unit tests with grammY fakes; a live test only if the owner gives a test bot token (ask main).
- **Notes:**

## Done
<!-- Move finished tasks here. -->
