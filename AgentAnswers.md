# Agent Answers

> Written by the **main agent**. Every answered question is stored here together with its question.
> Agents check this file for answers to their questions when they come online.
> Created: 2026-10-27

## Format

```markdown
## Q-000: <short title>
- **Asked by:** <agent> on YYYY-MM-DD
- **Question:** <copied from AgentQuestions.md>
- **Answer:** <answer>
- **Answered by:** <main agent name> on YYYY-MM-DD (source: code / user / decision)
- **Follow-up:** <anything the agent must do now, or "none">
```

## Answers
<!-- New answers below this line. -->

## Q-001: Codex model tiers
- **Asked by:** agent-hyde-autonomy on 2026-11-06
- **Question:** see AgentQuestions.md Q-001
- **Answer:** Yes: gpt-6-astra for high, gpt-6.1-sol for medium, gpt-6-luna for low/trivial. Check the exact ids against the installed codex before writing them.
- **Answered by:** main on 2026-11-06 (source: user)
- **Follow-up:** apply it in the defaults and docs if the built code differs.

## Q-002: What counts as a free model
- **Asked by:** agent-hyde-autonomy on 2026-11-06
- **Question:** see AgentQuestions.md Q-002
- **Answer:** Every OpenCode opencode/* model, including big-pickle, is free; the per-agent `free` flag can override.
- **Answered by:** main on 2026-11-06 (source: user)
- **Follow-up:** apply it in the defaults and docs if the built code differs.

## Q-003: Built-in Claude tiers
- **Asked by:** agent-hyde-autonomy on 2026-11-06
- **Question:** see AgentQuestions.md Q-003
- **Answer:** Yes, replace the single haiku setting: opus for high, sonnet for medium, haiku for low/trivial. Use opus, not fable.
- **Answered by:** main on 2026-11-06 (source: user)
- **Follow-up:** apply it in the defaults and docs if the built code differs.

## Q-004: Meaning of Hyde effort
- **Asked by:** agent-hyde-autonomy on 2026-11-06
- **Question:** see AgentQuestions.md Q-004
- **Answer:** Effort only (models stay chosen by complexity). Defaults: balanced mode, balanced effort.
- **Answered by:** main on 2026-11-06 (source: user)
- **Follow-up:** apply it in the defaults and docs if the built code differs.

## Owner permissions 2026-11-06
- **Asked by:** agent-hyde-autonomy (Telegram token, test repo and push permission were open items)
- **Answer:** The owner gave all permissions on 2026-11-06:
  - **Test repo:** https://github.com/Hyde-OpenSource/Hyde-Autonomy-Testing (private, empty, admin access). Use it for GitHub issue intake (T-011) and any real PR/merge-queue test: push branches, create labels, issues and PRs, and merge inside that repo only.
  - **Telegram:** the test bot is @Hyde_code_bot, the same bot as the owner's hub. Read the token from `~/.hyde/.env` (TELEGRAM_BOT_TOKEN, read-only) and pass it to your scratch hub through the environment only. Never write it to the repo, logs, progress.md or a report. The owner's paired Telegram user id is in `~/.hyde/data/telegram-paired.json` (read-only). Only one process may poll a bot token: check that the owner's hub is not running (nothing listening on 127.0.0.1:7420) before starting a Telegram test, and stop your hub after it. Messages to the owner's chat are allowed for the test; keep them few and clearly marked as "[Hyde test]".
  - **Hyde-Code repo:** main pushes `agent-hyde-autonomy/feature/smart-routing` to origin and opens the PR into staging at the end. You may push your own branch after each finished task (run the secret scan first), but never push or merge to main/staging yourself.
- **Answered by:** main on 2026-11-06 (source: user)
- **Follow-up:** do the live Telegram test for T-012 and the real issue-intake test for T-011 with these.
