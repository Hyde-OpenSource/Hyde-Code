# Hyde AI desktop (`apps/desktop`)

The voice and desktop half of [Hyde AI](../../README.md). Run it with `hyde ai` or `hyde-ai`.

Control your Linux desktop **and your coding agents** in plain words. Hyde AI is the front
door of **HYDE AI**: it hands coding work to [Hyde Code](../../docs/HYDE_AI.md) (Claude Code, Codex,
OpenCode → reviewed PRs), and runs desktop commands itself. Hyde runs known commands instantly with a
deterministic rules engine, asks before anything that changes your system, and can hand
open-ended requests to a **free AI model** (OmniRoute, OpenRouter, Groq, Gemini or Ollama).
It also installs and launches **OpenCode** and **OmniRoute** for you.

```
hyde code add a dark mode toggle in gamify ias lms using codex
what is waiting for me
approve A 2
open chrome and vs code then set volume to 40
install omniroute
search for rust async tutorials
what time is it
```

## Install

```bash
pnpm desktop:install      # from the repo root: builds and installs ~/.local/bin/hyde-ai + app-menu launcher
# or: ./scripts/install.sh at the repo root to install Hyde Code and the desktop app together
hyde-ai                   # opens the Hyde AI window
```

Needs Rust ([rustup.rs](https://rustup.rs)). No sudo. `./scripts/uninstall.sh` removes it.
The command is `hyde-ai`; plain `hyde` belongs to Hyde Code and is never touched.

## Using it

| Where | What |
| --- | --- |
| **Hyde Code** | Assign a task (project, agent), answer agent questions, approve pushes, merge, stop or retry tasks, open the office. See [docs/HYDE_AI.md](../../docs/HYDE_AI.md). |
| **Assistant** | Type or speak (mic button, Chromium) a request. Steps joined with “and” run together, steps joined with “then” run in order. |
| **AI tools** | One-click install of OpenCode (`curl -fsSL https://opencode.ai/install \| bash`) and OmniRoute (`npm install -g omniroute`) with a live log; start them, open the OmniRoute dashboard. |
| **Apps** | Apps Hyde knows by name and whether they're installed. |
| **AI engine** | Pick a provider, paste a free key, load models, test, save. |

From a terminal:

```bash
hyde-ai run open spotify then volume 30     # one command, asks before risky steps
hyde-ai run --yes install opencode          # skip the confirmation prompt
hyde-ai install omniroute                   # install a tool with a live log
hyde-ai doctor                              # check apps, tools and the AI engine
hyde-ai ui --port 7900 --no-browser         # run the UI server only
```

## Free AI engines

| Provider | Key | Notes |
| --- | --- | --- |
| OmniRoute | none (local) | Install from **AI tools**, start it, add free providers in its dashboard at `http://localhost:20128`, then pick it in **AI engine**. |
| OpenRouter | [free key](https://openrouter.ai/keys) | Use models ending in `:free` (the “free only” filter does this). |
| Groq | [free key](https://console.groq.com/keys) | Fast Llama/Qwen models. |
| Google Gemini | [free key](https://aistudio.google.com/apikey) | `gemini-2.5-flash` on the free tier. |
| Ollama | none (local) | Fully offline once a model is pulled. |
| Custom | optional | Any OpenAI-compatible `/v1` endpoint. |

How the AI is used: when the rules don't match, the model either answers directly or
rewrites your request into one of Hyde's own commands. That rewrite is matched again by
the rules engine, so the AI can never run anything Hyde doesn't already define. AI-routed
plans that aren't plain L0 actions always ask first.

## Safety

* Every action has a risk level. **L0** (open app, search, volume) runs instantly,
  **L1** (close app, lock screen) runs when the match is confident, **L2/L3** (installs, anything sent to Hyde Code)
  always need your confirmation.
* Apps are started directly, never through a shell. Closing uses exact process names.
* The UI server listens on `127.0.0.1` only, checks the `Host` header, and needs a
  per-session token on every API call, so other websites can't drive it.
* Your API key lives in `~/.config/hyde-ai/config.toml` with `0600` permissions.

## Customizing commands

Add `.toml` files to `~/.config/hyde-ai/intents/` and/or override the app list with
`~/.config/hyde-ai/apps.toml`, then press **Reload commands** on the Apps page. See
[`data/`](data) for the built-in files. Pattern syntax:

| Pattern | Meaning |
| --- | --- |
| `word` | literal word |
| `{trigger}` | one of the intent's `triggers` |
| `{app}` / `{app+}` | one app / one or more apps joined by “and” |
| `{number}` | a number (“forty two” works too) |
| `{query*}` | the rest of the sentence |
| `{dir:up\|down}` | one of the listed words |
| `[...]` | optional |

## Project layout

```
crates/hyde-core    deterministic matcher, planner, binary pack format (no dependencies)
crates/hyde-pack    TOML → pack compiler (library + `hyde-pack` CLI)
crates/hyde-ai      the `hyde-ai` app: executor, AI engine, tool installer, Hyde Code bridge, local web UI
../../docs/HYDE_AI.md  how the desktop app and Hyde Code fit together, the API contract, the roadmap
data/               built-in intents and app catalogue (embedded into the binary)
```

Development (from the repo root): `pnpm desktop:test`, `pnpm desktop:lint`, `pnpm desktop -- ui`.

## License

MIT, like the rest of the repository.
