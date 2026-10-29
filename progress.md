# Progress

> Every change to this project is recorded here, newest first. Append only, and never delete entries.
> Created: 2026-10-27

## How to write an entry

```markdown
### YYYY-MM-DD: <short title>
- **Agent:** <name> (<model>)
- **Branch:** <branch>
- **What:** <what changed>
- **Why:** <reason / request it came from>
- **Files:** <paths>
- **Verified:** <how it was tested, result>
- **Open / follow-ups:** <anything left, or "none">
```

## Log
<!-- New entries go directly below this line, newest first. -->
### 2026-10-29: `hyde` command, trusted folders and terms, projects in the GUI
- **Agent:** main (Claude Opus 5.5, claude-opus-5-5)
- **Branch:** feature/md-office
- **What:** Hyde now works like `claude`/`codex`: `pnpm install-cli` puts a `hyde` launcher on the PATH (symlink in ~/.local/bin to apps/hub/bin/hyde). Running `hyde` in a folder: first time, a boxed "Do you trust the files in this folder?" prompt that also says using Hyde Code means accepting the Terms (arrow-key menu); offers `git init` + empty first commit for non-repos; first run on the machine runs setup; registers the folder as a project (id, name, base/release branch, checks guessed); starts the hub in the background if needed (log ~/.hyde/hub.log, pid file); opens the terminal office scoped to that project (`p` toggles all projects, `w` opens the web office on it). New subcommands: web, tui, projects, forget, hub start|stop|restart|status|logs; `hyde new` defaults to the folder's project. Everything moved to a per-user home (~/.hyde: config.json, .env 0600, trust.json with folders + accepted terms version, data/); HYDE_HOME overrides. Hub: GET/POST/DELETE /api/projects (adding requires trust and records it), protected-branch hook installed for projects added at runtime, login link can open a project. Web: Projects sidebar (All projects + each folder with path, branch, running and waiting counts; add with the same trust/terms dialog; remove), every page filtered by the chosen project, phone-width project picker. Added a draft TERMS.md (version 2026-10-29).
- **Why:** Owner asked for a `hyde` command that starts in the current folder, asks to trust new folders and states the terms, and a GUI that shows the projects like Codex/Claude apps.
- **Files:** apps/hub/bin/hyde, scripts/install-cli.mjs, package.json; apps/hub/src/cli.ts (rewritten), home.ts, projects.ts, prompt.ts, projects.test.ts, config.ts, main.ts, setup.ts, http.ts, tui.ts, tui-render.ts, orchestrator.ts, package.json; apps/web/src/Projects.tsx, main.tsx, api.ts, ui.tsx, pages/Office.tsx, Board.tsx, Inbox.tsx, styles.css; TERMS.md; README.md
- **Verified:** `pnpm test` 134 passing (new: trust/terms record, project ids, add/remove project in a temp git repo), `pnpm typecheck` clean. Drove the real `hyde` in a pseudo-terminal on a fresh non-git folder: trust + terms prompt, git init prompt, project added, hub started in the background, terminal office opened on that project; second run went straight in; `hyde status` / `hyde projects` worked; `hyde forget` removed it. Playwright screenshots of the sidebar with two projects and the add dialog, no console errors. Moved this machine's config, .env, history and Telegram pairing into ~/.hyde (old repo copies left in place, gitignored). Removed the demo folder and the trust record made during the test, so the owner accepts the terms themselves.
- **Open / follow-ups:** TERMS.md is a draft for the owner (ideally a lawyer) to review; bump TERMS_VERSION when it changes. The repo-root hyde.config.json and .env are no longer used and can be deleted by the owner.

### 2026-10-29: Port Munder Difflin's office UI into the web dashboard
- **Agent:** main (Claude Opus 5.5, claude-opus-5-5)
- **Branch:** feature/md-office
- **What:** Replaced the hand-drawn canvas office with Munder Difflin's own office (MIT): its Pixi.js scene engine (tile map, BFS walking, camera, characters, thought bubbles, envelopes, coffee breaks, errands, cork task boards, ASK ME board, desk monitors), design tokens and fonts, and its PixelPanel/PixelButton/PixelBadge/Icon/AgentCard/SpritePortrait components, under `apps/web/src/md`. Hyde Code changes: `bridge.ts` feeds hub state into the office (Hyde is the boss; envelopes on dispatch, questions, approvals, reviews and PRs); a tiny zustand-style store and an English i18n stand-in; an original generic cast and rewritten cafeteria lines instead of the TV characters; Brooklyn 99 theme and cigar errand removed; the clock opens Usage. The office page now uses their layout: floor, Command Center (Tasks / Ask me / Activity) or the selected agent with its live session, and a bottom strip of agent cards plus a dispatch box. Every page restyled on their tokens, with a light/dark toggle. LimeZu tiles are not shipped (their licence forbids redistribution): new `pnpm hyde tiles <folder>` imports the owner's copy into `.hyde/assets/limezu/` (matched by hash, or by hand with a size check), `/api/tiles` serves it to the logged-in dashboard, and `fallbackTiles.ts` paints stand-ins with the same layout when it is missing. Credits in README, `src/md/README.md` and on the floor when real tiles load. Added pixi.js 8.21.0 (pinned, published 2026-09-17), approved by the owner.
- **Why:** Owner asked to use Munder Difflin's UI components (open source) and make the office look like theirs; owner chose: own LimeZu copy loaded locally, generic coworkers, add pixi.js.
- **Files:** apps/web/src/md/** (new), apps/web/src/pages/Office.tsx, main.tsx, styles.css, vite.config.ts, tsconfig.json, package.json; apps/web/src/office/* (removed); apps/hub/src/tiles.ts, tiles.test.ts, http.ts, cli.ts; README.md; pnpm-lock.yaml
- **Verified:** `pnpm test` 132 passing, `pnpm typecheck` clean (the web tsconfig turns off noUncheckedIndexedAccess and verbatimModuleSyntax so the upstream files compile unchanged; hub and packages keep them). Playwright screenshots of the office (light, dark, 390 px phone), task page; no console errors. Live demo task T-6 on OpenCode: the agent walked to its desk, the monitor lit, the thought bubble showed its tool calls, idle agents walked over to Hyde with suck-up lines, ASK ME showed the planner's questions; answered them from the CLI, stopped T-6 at its push approval (no PR) and removed its worktree.
- **Open / follow-ups:** The floor only looks exactly like Munder Difflin's once the owner imports LimeZu "Modern Interiors"; whether the pack's files match the map's three sheets byte for byte is unverified (the importer falls back to picking files by hand). Local demo branches for T-5 and T-6 are kept.

### 2026-10-29: Office UI redesign (web) and a terminal UI
- **Agent:** main (Claude Opus 5.5, claude-opus-5-5)
- **Branch:** feature/office-ui
- **What:** Replaced the plain dashboard with a pixel-art office, drawn in code on a canvas (no new dependencies or bought tiles): Hyde's corner office, open-plan desks, a war room (whiteboard for planning, table for review), kitchen, server room and "your desk". Agents are little people who walk to where their work is; monitors show code, a question mark or an error; envelopes fly on dispatch, questions, approvals, reviews and PRs; sparkles on merge. Home page = floor + assign bar + live session terminal for the selected agent + side panel (Needs you / Team / Activity). New dark "night shift" theme for every page. Added `pnpm hyde tui`: the same office in the terminal (rooms, team table with quota bars, live session, board, inbox with approve/deny/reply/merge, activity, usage), live over SSE; `w` opens the web office and the web has a Terminal button. Shared, pure office logic (`agentActivity`, `describeEvent`, `sessionLine`, `openItems`, worktree path shortening) lives in `packages/core/src/office.ts` for both UIs. New `/api/feed` route for the activity feed.
- **Why:** Owner said the UI was too plain and asked for an office like Munder Difflin's, plus a terminal UI with the option to switch.
- **Files:** packages/core/src/office.ts, office.test.ts, index.ts, package.json; apps/hub/src/tui.ts, tui-render.ts, tui.test.ts, cli.ts, http.ts; apps/web/src/office/scene.ts, office/OfficeScene.tsx, main.tsx, api.ts, ui.tsx, styles.css, pages/Office.tsx, Inbox.tsx, TaskPage.tsx (Floor.tsx removed); apps/web/index.html; README.md
- **Verified:** `pnpm test` 131 passing (new tests for agent placement, feed lines, path shortening, TUI frame size at 3 terminal sizes, colour-safe widths); `pnpm typecheck` clean. Screenshots with Playwright at 1440, 1280 and 390 px of Office, Board, Task and Settings, no console errors. Ran a real demo task (T-5, OpenCode free model, pinned): the office showed it planning at the whiteboard, then typing at its desk with the live session streaming, the question Q-7 on your desk, Claude reviewing. Stopped T-5 before its push (no PR) and removed its worktree. Ran the real TUI in a pseudo-terminal: it connected live, switched screens with keys and exited cleanly.
- **Open / follow-ups:** The local branch opencode-1/feature/t-5-… from the demo is kept (branch deletion needs the owner). Telegram pairing waits for the owner (`/pair` code is printed at hub start).

### 2026-10-29: Real end-to-end runs on Hyde-Code; fixes for Codex, OpenAI schemas, stale base, OpenCode
- **Agent:** main (Claude Opus 5.5, claude-opus-5-5)
- **Branch:** feature/roadmap-phases-1-4
- **What:** (1) The harness commits for agents whose sandbox keeps .git read-only (Codex), before checks and review, and tells them not to commit. (2) Plan and review JSON schemas made OpenAI strict-mode valid (every property required, nullable file/line). (3) Task branches are cut from, and diffed against, a freshly fetched origin/<base> instead of the local base branch. (4) OpenCode turns that end on a tool step are no longer reported as "no output" crashes. (5) Questions and approvals of cancelled tasks are hidden from status and the inbox. README and .env.example rewritten for all phases.
- **Why:** Found by real runs against Hyde-Code (the owner chose it as the test repo).
- **Files:** apps/hub/src/{orchestrator,planner,review}.ts, packages/adapters/{codex,opencode}/src/index.ts, packages/core/src/adapter.ts, packages/devflow/src/index.ts, apps/web/src/pages/Inbox.tsx, tests, README.md, .env.example
- **Verified:** 124 tests, typecheck clean, regression tests for each fix. Real runs: T-3 planned and written by Codex, reviewed by Claude (approve), PR #4 opened into staging; T-4 planned and written by OpenCode (free model), reviewed by Claude with the diff, PR #5 opened into staging. Neither was merged.
- **Open / follow-ups:** Telegram/Slack/Discord/WhatsApp still untested live (no tokens). Merge queue and /promote only tested against a local bare remote. PRs #4 and #5 wait for the owner.

### 2026-10-29: Roadmap phases 1-4, dashboard and setup wizard
- **Agent:** main (Claude Opus 5.5, claude-opus-5-5)
- **Branch:** feature/roadmap-phases-1-4
- **What:** Codex, OpenCode, ACP and command adapters; agent pool and router; quota scheduling; planner, cross-vendor review, browser verify, merge queue, /promote; Slack, Discord and WhatsApp intake; notifier (digests, quiet hours); schedules; worker nodes; policy hook; lessons; metrics and audit; plugins; container wrapper; React dashboard (Floor, Inbox, Board, Task, Usage, Office, Audit, Settings); `pnpm hyde setup` wizard (nothing compulsory).
- **Why:** Owner asked to build all of docs/plan.md Phases 0-4 tonight, with every tool optional and picked by the user.
- **Files:** apps/hub/**, apps/node/**, apps/web/**, packages/**
- **Verified:** 120 tests pass and typecheck is clean. Real runs: Claude planner returned structured output with questions; Codex planned and wrote docs/GLOSSARY.md; Claude HTTP PreToolUse hook honoured a deny; dashboard loaded live in Chrome.
- **Open / follow-ups:** BUG: Codex's sandbox could not write the worktree's git metadata (.git/worktrees/T-2/index.lock read-only), so Codex can't commit yet; writable_roots override needs fixing. Planner ran twice on Codex (first output unparsed). Telegram/Slack/Discord/WhatsApp untested live (no tokens). No PRs opened yet. Claude 5-hour quota hit 99% during testing.

### 2026-10-27: GitHub remote, branch protection, devflow harness mode
- **Agent:** main (Claude Opus 5.5, claude-opus-5-5)
- **Branch:** feature/phase0-core
- **What:** Added origin https://github.com/Hyde-OpenSource/Hyde-Code (public) and pushed main, staging and feature/phase0-core. Turned on branch protection for main and staging (PR required, applies to admins, no force-push or deletion). In the devflow-skills clone, added a "Harness mode" section (`DEVFLOW_HARNESS=1`: skip the session question, ask through `ask_question`, harness is the single writer of shared files, no pushes) on branch feature/harness-mode (dce05d0) and pushed that branch to Thenn-Labs/devflow-skills.
- **Why:** Owner gave the repo URL and approved the push, the protection and the skills change (plan section "Small changes to make in devflow-skills for harness mode").
- **Files:** context.md, progress.md; in devflow-skills: skills/devflow-setup/SKILL.md, skills/devflow-messages/SKILL.md, skills/devflow-test/SKILL.md
- **Verified:** `git branch -vv` shows all three branches tracking origin and in sync. The GitHub API protection response for both branches showed enforce_admins on, force-push and deletion off, 0 required approvals. Scanned all commits for secrets before pushing; none found.
- **Open / follow-ups:** No PR opened or merged yet. A test repo for the gate demo and a Telegram bot token are still needed.

### 2026-10-27: Phase 0 core: hub, Claude Code adapter, worktrees, MCP tools, Telegram
- **Agent:** main (Claude Opus 5.5, claude-opus-5-5)
- **Branch:** feature/phase0-core
- **What:** Built the Phase 0 loop from docs/plan.md as a pnpm TypeScript monorepo: append-only SQLite event store, projections and a task state machine (`packages/core`); Claude Code adapter that parses stream-json, scrubs the env, stops with SIGINT, resumes by session and stops early if the hyde MCP server fails to connect (`packages/adapters/claude-code`); worktree and branch handling plus a protected-branch pre-push hook (`packages/workspace`, `packages/policy`); task packet and progress.md writer (`packages/devflow`); MCP server with ask_question, report_progress and complete_task (`packages/mcp-harness`); Telegram gateway with an allowlist, /pair codes and HMAC-signed buttons (`packages/gateways/telegram`); hub with the orchestrator tick loop, quota-aware dispatch, retries with backoff, continuation and fix rounds, push approval, gh PR creation, a localhost HTTP API and a CLI (`apps/hub`).
- **Why:** Owner asked to build the plan in docs/plan.md, starting with Phase 0 (personal tool, Telegram console, hub on this desktop, name "Hyde Code").
- **Files:** package.json, pnpm-workspace.yaml, tsconfig.json, vitest.config.ts, .gitignore, .env.example, hyde.config.example.json, README.md, apps/hub/**, packages/**
- **Verified:** `pnpm test` gives 45 tests passing; `pnpm typecheck` is clean. Ran a real end to end on a scratch repo with Claude Code 2.1.310 (haiku): CLI `/new` → worktree → Claude wrote and committed hello.txt and called complete_task → check passed → progress.md entry committed → A-1 approval → branch pushed to a local bare remote. `gh pr create` failed there as expected (not a GitHub remote), and pushing to main and staging from the worktree was refused by the hook. That run found a real bug (MCP server path broke on the space in "HYDE CODE"), now fixed with regression tests. Scratch repos and their Claude session files were deleted afterwards.
- **Open / follow-ups:** Gate demo with a real Telegram bot and a GitHub test repo (needs a bot token and repo URLs); GitHub branch protection on the test repo; harness-mode changes in the devflow skills (asked the owner); progress digests; Phase 1+ (planner, Codex adapter, web UI).

### 2026-10-27: Workspace setup and plan import
- **Agent:** main (Claude Opus 5.5, claude-opus-5-5)
- **Branch:** feature/phase0-core
- **What:** Ran git init (main) with an empty root commit and created staging; added the devflow workspace files (CLAUDE.md, context.md, progress.md, agents.md, AgentQuestions.md, AgentAnswers.md, role.md, tasks.md, report.md); moved the plan into docs/plan.md, with the .pdf/.docx exports gitignored.
- **Why:** /devflow-setup in a new project. Owner chose "git init plus staging" and "move .md into docs/".
- **Files:** CLAUDE.md, context.md, progress.md, agents.md, AgentQuestions.md, AgentAnswers.md, role.md, tasks.md, report.md, docs/plan.md
- **Verified:** `git branch -a` shows main and staging at 4ebbcf3; the bootstrap script reported every file as created.
- **Open / follow-ups:** No remote yet (owner will give URLs).



## History (rebuilt from earlier records)
<!-- Filled from git log / older notes at setup time. Leave empty if there was no history. -->
