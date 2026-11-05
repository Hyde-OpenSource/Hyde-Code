# Roles

> Edited by the **main agent only**. Every role must list its permissions.
> An agent without a row here may only read files and ask questions.
> Created: 2026-10-27

## Default permissions (apply to everyone unless a row says otherwise)
- **Allowed:** read any project file, create its own branch, edit files listed in its role, run local tests, write to `AgentQuestions.md`, `report.md`, `progress.md`, its own row in `agents.md`, and the status of its own tasks in `tasks.md`.
- **Not allowed:** push or merge to `main` / `staging`, force-push, delete branches, change other agents' files or tasks, edit `role.md`, change secrets or environment config, deploy, or run stress tests against anything other than local/staging.

## Roles

| Agent | Role | Responsibilities | Allowed (files / actions) | Not allowed | Assigned by / date |
|---|---|---|---|---|---|
| agent-hyde-autonomy | Autonomy and routing engineer (Claude only) | Merge the client API branch in; build complexity tiers and modes, question dedupe, reliability fixes, desktop assistant wiring (T-001..T-006) | apps/hub/**, apps/desktop/**, apps/web/**, packages/**, docs/**, README.md, hyde.config.example.json, context.md (sections 3, 4, 9, 12 only), progress.md, tasks.md (own tasks' Status/Notes), its own agents.md row; create scratch repos under its scratchpad; real `claude -p` test runs on scratch repos (any model, pause at 80% of the 5-hour window); local git merge of agent-hydeai-api/feature/hyde-ai-api into its own branch | push anything, open PRs, touch main/staging, edit ~/.hyde/config.json or ~/.config/hyde-ai, accept terms or trust prompts, add dependencies without asking, run tasks on the owner's real projects | main on 2026-11-05 |

## Role changes
<!-- - YYYY-MM-DD: <agent>: <what changed and why> -->
- 2026-11-05: agent-hyde-autonomy: role created for the autonomy and model-routing work (owner request).
