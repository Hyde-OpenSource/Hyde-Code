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
