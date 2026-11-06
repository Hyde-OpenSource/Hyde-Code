# CLAUDE.md

## Project: Hyde AI (Hyde Code hub + desktop assistant)
One repo, two parts (see `README.md`, `docs/HYDE_AI.md`, `docs/plan.md`, `context.md`):
the Hyde Code hub (TypeScript: `apps/hub`, `apps/web`, `apps/node`, `packages/*`, CLI `hyde`) and the
Hyde AI desktop assistant (Rust: `apps/desktop`, binary `hyde-ai`, also `hyde ai`).
- Run `pnpm test` and `pnpm typecheck` before every commit; also `pnpm desktop:test` and `pnpm desktop:lint` when `apps/desktop` changes.
- The desktop app talks to the hub only through the contract in `docs/HYDE_AI.md` §3; change both sides together and update that section.
- `hyde` is the hub CLI and `hyde-ai` is the desktop binary; no installer may overwrite the other's command.
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
- 2026-10-29: tsx's dynamic-import transform fails to parse a file that starts with a shebang; launch TS entry files through a wrapper script instead of `#!` lines.
- 2026-10-29: Never accept terms or trust prompts on the owner's behalf; remove any trust records created while testing.
- 2026-10-30: Two installers both wrote `~/.local/bin/hyde`; give every binary a distinct name and never overwrite a file you didn't create.
- 2026-10-30: Test the desktop ↔ hub bridge against a mock hub with a scratch `HYDE_HOME`; the real hub dispatches queued tasks and spends agent quota.
- 2026-10-30: Desktop commands in tests act on the real desktop (opening apps, volume); test with plan-only checks or harmless intents.

<!-- devflow:end -->
- 2026-11-06: Run a real end-to-end test before calling routing work done; a rules bug and a review-tier gap only showed up on real tasks.
- 2026-11-06: After a rate limit, keep the known reset time; never overwrite it with a guess.
- 2026-11-06: Claim the hub port before any side effect (event store, hooks, chat polling).
- 2026-11-06: Playwright MCP saves screenshots into the session's working copy; move them out at once and delete `.playwright-mcp` afterwards.
- 2026-11-06: Pass hints to the desktop command matcher alongside the text; it normalises text, so markers inside it are lost.
- 2026-11-06: Adding a field with a zod `.default()` to an event payload is not enough: old events in the log never had it. The store reads every event through the current schema; test new hubs against an old ~/.hyde event log.
