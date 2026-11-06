# Agent Questions

> Any agent may **append** a question here. The main agent answers it in `AgentAnswers.md` and then changes the status here to `ANSWERED`.
> Number questions in order: Q-001, Q-002, …
> Created: 2026-10-27

## Format

```markdown
## Q-000: <short title>
- **From:** <agent name> (<model>)
- **Date:** YYYY-MM-DD HH:MM
- **Related task:** T-xxx / none
- **Status:** OPEN
- **Question:** <the question>
- **What I already checked:** <files read, things tried>
- **Blocking?:** yes / no
```

## Questions
<!-- New questions below this line. -->

## Q-001: Codex model ids for "astra" (high) and "sol" (medium)
- **From:** agent-hyde-autonomy (Claude Opus 5.5, claude-opus-5-5)
- **Date:** 2026-11-05 21:10
- **Related task:** T-002
- **Status:** ANSWERED
- **Question:** "astra" and "sol" are Codex (OpenAI) models, not Claude or OpenCode. `~/.codex/config.toml` has `model = "gpt-6-astra"` (the owner's Codex default) and a model-availability notice for `"gpt-6.1-sol"`. But `codex debug models` (Codex 0.162.1, catalog fetched 2026-11-03) lists only `gpt-6-luna`, `gpt-5.6-terra`, `gpt-5.6-luna` (plus hidden `gpt-reserve`, `codex-auto-review`). May I use `gpt-6-astra` for Codex high, `gpt-6.1-sol` for Codex medium and `gpt-6-luna` for Codex low/trivial in the example config, the setup wizard and the docs? I have not run Codex (no Codex runs in my role), so I can't prove `gpt-6.1-sol` is usable on this account.
- **What I already checked:** `codex --help`, `codex debug models`, `~/.codex/models_cache.json`, `~/.codex/config.toml`, `opencode models` (no astra/sol there), `claude --help` (aliases fable, opus, sonnet; haiku works today).
- **Blocking?:** no. Until answered, Codex has no built-in tier table: a Codex profile without `tiers` uses its one model (the CLI default, gpt-6-astra) for every non-free tier, and nothing in code names astra or sol.

## Q-002: Which models count as "free"
- **From:** agent-hyde-autonomy (Claude Opus 5.5, claude-opus-5-5)
- **Date:** 2026-11-05 21:10
- **Related task:** T-002
- **Status:** ANSWERED
- **Question:** The hard rule is "planning, review and high-complexity coding never run on a free model". I treat a model as free when (a) its tier entry says `"free": true`, or (b) it is an OpenCode model in the `opencode/` provider (all ten `opencode models` lists today are free Zen models: beam-free, big-pickle, deepseek-v4.1-flash-free, …). `"free": false` on a tier overrides (b). Free models may only do trivial and low coding work and classification. Is that the right definition? Should big-pickle count as free (it has no `-free` suffix)?
- **What I already checked:** `opencode models`, `packages/adapters/opencode/src/index.ts` (detect() says "free models only" without a provider login), the owner's config (opencode-1 runs opencode/big-pickle).
- **Blocking?:** no, implemented as described.

## Q-003: Default tiers for Claude profiles that have only one `model`
- **From:** agent-hyde-autonomy (Claude Opus 5.5, claude-opus-5-5)
- **Date:** 2026-11-05 21:10
- **Related task:** T-002
- **Status:** ANSWERED
- **Question:** The owner's `claude-1` has `"model": "haiku"` and no tiers. To fix "a cheap model for every job" without editing `~/.hyde/config.json`, a claude-code profile without `tiers` gets the built-in table: high = opus (effort high), medium = sonnet (medium), low = haiku (low), trivial = haiku (low). Its old single `model` is then ignored, and a notice says so in `hyde agents`. Is that OK, or should the single `model` win until the owner adds `tiers` (in Settings or `hyde setup`)? And should the high tier be `opus` (owner's words) or the newer `fable` alias the Claude CLI also lists?
- **What I already checked:** `claude --help` (2.1.318: `--model` aliases fable/opus/sonnet; `--effort` low, medium, high, xhigh, max).
- **Blocking?:** no, implemented with the built-in table and `opus` for high.

## Q-004: Meaning of the "Hyde effort" setting and the default mode
- **From:** agent-hyde-autonomy (Claude Opus 5.5, claude-opus-5-5)
- **Date:** 2026-11-05 21:10
- **Related task:** T-002
- **Status:** ANSWERED
- **Question:** I implemented `routing.effort`: `saver` moves every tier's effort one step down, `max` one step up (low < medium < high < xhigh < max, clamped to what the CLI accepts), `balanced` keeps the tier's effort, `auto` acts like balanced but like saver for an account above 60% of its 5-hour window. It changes effort only, never the model (models follow complexity). Default mode `balanced`, default effort `balanced`. Mode names as in tasks.md: balanced, claude-only, free-first, assistant-plans. Are these meanings and defaults what the owner wants?
- **What I already checked:** tasks.md T-002 (4) and (3).
- **Blocking?:** no.

## Q-005: Fedora packages and Tauri crates for the Hyde AI Suite (T-013, T-014)
- **From:** agent-hyde-autonomy (Claude Opus 5.5, claude-opus-5-5)
- **Date:** 2026-11-06 15:20
- **Related task:** T-013, T-014
- **Status:** OPEN
- **Question:** (1) Please ask the owner to run `sudo dnf install webkit2gtk4.1-devel libsoup3-devel librsvg2-devel rpm-build` (checked with `rpm -q`: these four are missing; gtk3-devel is installed). Tauri 2 can't build its window without the first three, and the .rpm in T-014 needs rpm-build. (2) T-013 adds new dependencies: the Rust crates `tauri` and `tauri-build` (2.x), plus `tauri-cli` to build the bundle. I'll pick exact versions at least two weeks old and pin them. May I add them? No other new dependency is planned: the window loads the existing web dashboard and assistant UI from the local hub and desktop servers.
- **What I already checked:** `rpm -q` for the four packages; no Tauri tooling under ~/.cargo/bin.
- **Blocking?:** yes for building and running the Tauri window and the .rpm; I'll do the parts that don't need them first.

## Q-006: Secrets in branch names
- **From:** agent-hyde-autonomy (Claude Opus 5.5, claude-opus-5-5)
- **Date:** 2026-11-06 15:40
- **Related task:** T-010
- **Status:** OPEN
- **Question:** Task branches are named from the task title (`claude-1/feature/t-12-add-login-use-password-hunter2`), so anything secret typed into a request ends up in a git branch name, and on GitHub after the push. Should the hub drop words that look like secrets (or anything after "password", "token", "key") from the branch slug? Or should it name branches by id only (`claude-1/feature/t-12`)?
- **What I already checked:** `branchName` in packages/workspace; the export now hides the slug when the request had a secret.
- **Blocking?:** no.
