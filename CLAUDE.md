# CLAUDE.md

## Project: Hyde Code
Self-hosted harness that drives the official agent CLIs (see `docs/plan.md`, `context.md`, `README.md`).
- Run `pnpm test` and `pnpm typecheck` before every commit.
- All state changes go through `EventStore.append`; the orchestrator is the only writer of task state.
- Never use `claude --bare` and never pass subscription credentials anywhere; agent envs are allowlisted in `scrubEnv`.

<!-- devflow:start -->
## Workspace rules (devflow)

This project uses the devflow skills (`/devflow-setup`, `/devflow-messages`, `/devflow-test`). At the start of every session:
1. Ask the user: who are you, main session or child session? State your agent name and model.
2. Read `context.md`, the latest entries of `progress.md`, and (for agents) `agents.md`, `role.md`, `tasks.md`, `AgentAnswers.md`.

Short version of the rules:
- Never commit, push or merge to `main` / `staging` unless the user explicitly says so, and only after checking that both branches are set up properly.
- Every feature or fix gets its own branch.
- Never assume. Ask the user about anything unclear, as many questions as needed.
- Every change is logged in `progress.md` with what, why, files, and how it was verified.
- Remove temporary files and test data after use.
- Add a line to "Lessons learned" after every correction, bug pattern or hard-won fix.

## Lessons learned
<!-- One line per lesson: - YYYY-MM-DD: <rule to follow>. Keep short, merge duplicates. -->
- 2026-10-27: The repo path contains a space ("HYDE CODE"). Convert file URLs with `fileURLToPath`, never `URL.pathname`, and quote paths in shell.
- 2026-10-27: Verify agent-facing changes with a real `claude -p` run on a scratch repo; unit tests with fakes missed the broken MCP server launch.
- 2026-10-27: `pkill -f <pattern>` can match your own shell command. Find PIDs with an anchored `pgrep -f` and kill those.
- 2026-10-27: Pick dependency versions at least two weeks old and pin them exactly.
- 2026-10-29: Codex's workspace-write sandbox keeps .git read-only even with writable_roots; the harness commits for it.
- 2026-10-29: OpenAI structured outputs need strict schemas: every property required, additionalProperties false, use null for "absent".
- 2026-10-29: Cut and diff task branches against a fetched origin/<base>; local base branches go stale when PRs merge on GitHub.
- 2026-10-29: Watch quota before real test runs; the owner's Claude 5-hour window hit 99% during testing.
- 2026-10-29: Never name a scratch script after a stdlib module (pty.py shadowed `pty`); run scratch Python with -I.
- 2026-10-29: Check UI work with real screenshots (Playwright) at desktop and phone widths; overlapping name tags and an overflowing board only showed up there.
- 2026-10-29: An MIT repo can bundle assets under other licences (LICENSE-ASSETS): check art, maps and fonts separately before copying, and never vendor art whose licence forbids redistribution.

<!-- devflow:end -->
