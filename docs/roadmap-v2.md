# Hyde AI roadmap v2: what a full coding harness needs

> Written by main on 2026-11-05 after reading the source of OpenCode (MIT), Codex CLI (Apache-2.0), Cline (Apache-2.0), OpenHands (MIT) and Vibe Kanban (Apache-2.0). We copy ideas, not code. If code ever gets copied, check the licence of that folder first (see the Lessons learned in CLAUDE.md).
> Phase 1 (T-001..T-006 in tasks.md) covers model tiers, modes, question dedupe and reliability. This file is phase 2 (T-007..T-012).

## 1. What other harnesses have, and where Hyde stands

| Feature | Seen in | Hyde today | Plan |
|---|---|---|---|
| Skills (SKILL.md with name + description front matter, loaded when relevant) | OpenCode `skills.mdx` and `skill` tool, Codex `codex-rs/skills` (discovery, mentions, selection), Cline "Rules and Skills", OpenHands `features/skills` | Only the devflow skills, through each CLI's own setup | T-007 |
| Live browser with cursor, clicks and highlights | Cline `BrowserSessionRow` (screenshot per step with the mouse position drawn on it), OpenCode `plugin-browser` (tabs, snapshot, click, console, network, traces, Lighthouse) plus an overlay for picking and commenting on elements, Vibe Kanban preview browser, OpenHands browser tab | Screenshots after the work is done (`apps/hub/src/browser.ts`), no live view | T-008 |
| Live activity feed: tool calls, file edits with diffs, terminal, todo list | All of them; Codex TUI, OpenCode session UI | Office monitor and session lines (`packages/core/src/office.ts`) | T-009 |
| Plan mode / build mode, a visible todo checklist | OpenCode agents `plan`/`build`, Cline Plan and Act | Planner run, no checklist the owner can see | T-009 |
| Diff review with inline comments sent back to the agent | Vibe Kanban, OpenHands diff viewer | Cross-vendor review, no owner comments | T-010 |
| Checkpoints and undo per turn | OpenCode snapshots, Cline checkpoints | Git branch only | T-010 |
| Custom commands and task templates | OpenCode `commands.mdx`, Codex slash commands | Chat commands only | T-010 |
| Detailed permission rules (allow / ask / deny per tool and pattern), auto-approval by a reviewer model | OpenCode `permissions.mdx` and `policies.mdx`, Codex `execpolicy` and `guardian-context` | Policy engine plus allow rules per command prefix | T-011 |
| Memory: project decisions and rules files (AGENTS.md / CLAUDE.md) managed in one place | Codex `memories`, OpenCode `rules.mdx` | Lessons (L-n) | T-011 (builds on T-003's question memory) |
| A preview dev server per worktree, device emulation | Vibe Kanban `preview-proxy` | The browser check starts a server, only for the check | T-008 |
| Agent-to-agent messages | Codex `message-board`, Munder Difflin mailboxes | None (only through the hub) | T-011 |
| GitHub / GitLab issues as task sources, a headless CI mode | OpenCode `github.mdx`/`gitlab.mdx`, Cline headless CLI, Symphony | CLI, web, chat, Hyde AI | T-011 |
| Chat apps (Telegram and others), scheduled agents | Cline, Hermes | Telegram, Slack, Discord, WhatsApp, schedules | T-012 updates Telegram |
| Sharing and exporting a session, replaying it | OpenCode share, Codex rollout trace | Event log, no export | T-010 |

## 2. Skills (T-007)
- **One format:** the shared SKILL.md standard: a folder with `SKILL.md` (YAML front matter: `name`, `description`), plus optional scripts and references. Claude Code, Codex and OpenCode all read it, so one skill works for every agent.
- **Where skills come from:** built-in (devflow-setup, devflow-test, browser, and the new skills below), user (`~/.hyde/skills`), project (`<repo>/.hyde/skills`), and folders the owner imports or links (for example the devflow-skills clone). Precedence: project > user > built-in.
- **Getting skills to each agent:** per run, the hub copies or links the chosen skills into the worktree where that CLI looks for them. Check the real paths for each CLI version before writing code: Claude `.claude/skills/`, Codex `.agents/skills/` or `~/.codex/skills`, OpenCode `.opencode/skill/`. Nothing in the owner's home skill folders changes.
- **Choosing skills:** the planner (T-002) names the skills each task needs; the owner can add or remove skills on a task. The task packet lists the skills by name and says when to use each one.
- **Skills from experience:** after a task, a proposed lesson can become a proposed skill (`propose_skill` MCP tool). The owner approves it in the Inbox or on Telegram before it is saved (Hermes's idea, with the owner in control).
- **UI:** a Skills page (list, source, which agents get it, enable/disable, view SKILL.md, import a folder or git URL). Importing a git URL shows the licence and every file, and is never run before the owner approves it.
- **Safety:** skills are files we hand to agents, so imported skills are untrusted until approved, and scripts in skills follow the normal permission rules.

## 3. Live browser feed (T-008)
The goal: watch, as it happens, what an agent does in the browser. An arrow cursor moves to each click with a ripple, the element is boxed, typed text shows up, and a step list says "click 'Sign in'". Codex and Cline show browser work this way.
- **Hyde owns the browser:** a `hyde-browser` MCP server (wrapping Playwright with its own Chromium profile, never the owner's) is given to every run that needs a browser. The agent drives it through tools (open, navigate, snapshot, click, fill, press, scroll, screenshot, console, network). Each call goes through the hub, so the hub knows every action, its target element box and its coordinates.
- **Live frames:** CDP `Page.startScreencast` sends JPEG frames (about 5-10 fps, scaled) as `browser.frame` messages on a separate live channel (not the event log, which only stores actions and keyframes). The dashboard shows them over SSE or WebSocket.
- **Overlay drawn by the dashboard** (not burned into the frames): an animated arrow cursor gliding to the next action, a click ripple, a highlight box on the target element, a caption with the action and the typed text (passwords masked), and a step timeline you can scrub, with a keyframe per step.
- **Controls:** pause the agent, take over (owner clicks or types in the live view and the agent is told), resume, stop. Device presets (desktop, phone).
- **Recording:** every browser session is saved as a video plus a GIF of its keyframes, attached to the task as proof of work, next to the existing browser check.
- **Preview per worktree:** the dev server stays up while the task runs, at a local preview URL with a free port per worktree. It stops on cleanup.
- **Where it shows:** task page (big view), office (the agent's monitor shows a thumbnail; click to open it), TUI (step list only), Telegram (T-012).
- **Rules:** web pages are untrusted input. Form submits, purchases and posts on non-local sites need approval. URL allowlist per project. Stress and attack tests only on local or staging.

## 4. Live activity feed, plan/build and todos (T-009)
- One timeline per task across all its runs: thinking summaries, tool calls, shell commands with output (collapsible), file edits as small diffs, MCP calls, questions, the model and tier used, tokens and cost per step.
- A `update_todos` MCP tool: agents keep a checklist (the plan steps) that the owner sees live, with done ticks. The planner seeds it.
- A plan mode: a read-only run that ends in a plan the owner can approve or edit before the build run (optional per task; on by default for `high` complexity).
- "Files touched" list with +/− counts, live.

## 5. Review, checkpoints, commands, sharing (T-010)
- Diff viewer in the dashboard with inline comments. "Send to agent" starts a `review_fix` turn with those comments.
- A checkpoint after every agent turn (a lightweight git commit or a stash ref on the task branch). Undo a turn from the UI or Telegram.
- Task templates and custom commands (`.hyde/commands/*.md` with front matter and `$ARGUMENTS`), shared by CLI, web, Telegram and Hyde AI.
- Export a task's session as Markdown or HTML (secrets redacted). Replay a task from its event log.

## 6. Permissions, memory, teams, issue sources (T-011)
- Permission rules per project and agent: `allow | ask | deny` by tool and glob pattern (shell commands, paths, URLs), compiled into each CLI's native settings. An optional "auto-reviewer": a strong-tier model checks risky actions first and asks the owner only when unsure.
- Project memory: standing decisions (from answered questions, T-003), lessons and rules files in one place, shown and editable in the UI, injected into every packet.
- Agent-to-agent notes through the hub (a typed message with a hop cap). For example, the reviewer asks the author a question without bothering the owner.
- GitHub issues (label `hyde`) and GitLab issues as task sources; a headless `hyde run --ci` for GitHub Actions.

## 7. Telegram bot update (T-012)
- **Simpler pairing** (from T-7 Q-11): paste the BotFather token once in setup or Settings. Hyde checks it and shows a `t.me/<bot>?start=<code>` link that pairs on `/start`.
- **One live message per task:** the status message is edited as the task moves (complexity, agent, model, tier, todo progress), instead of a new message per event. Digests stay for quiet hours.
- **Browser on Telegram:** `/live T-n` sends the latest browser frame with the cursor and step caption drawn on it, edited every few seconds while you watch (stops after a timeout). The GIF of the session comes at the end.
- **New commands and buttons:** `/mode` (balanced, claude-only, free-first, assistant-plans), `/effort` (saver, balanced, max, auto), `/tier T-n high` (override complexity), `/skills` (list, enable, approve proposed skills), `/plan T-n` (see and approve the plan), `/diff T-n` (a short diff summary plus a link to the dashboard), `/undo T-n`, `/todos T-n`, `/memory`.
- **Questions:** duplicates are merged (T-003). One message lists everything still open for a task, with buttons. Answering one question answers the merged copies.
- **Voice notes:** forwarded to Hyde AI's intake if the desktop assistant is running, otherwise refused with a hint.
- Keep the allowlist, pairing and HMAC-signed buttons. Every new command goes through the same orchestrator command path (the only writer of state).

## 8. Order and dependencies
T-007 skills and T-008 browser are mostly new packages (`packages/skills`, `packages/browser-live`) with small hooks into the orchestrator. T-009 builds on T-008's live channel. T-010 and T-011 come next, and T-012 last, since it shows everything above. Each task ends with a real run on a scratch repo and Playwright screenshots (desktop and phone) for UI work.
