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
