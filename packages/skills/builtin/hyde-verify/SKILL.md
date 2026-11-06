---
name: hyde-verify
description: Use before calling complete_task in a Hyde Code task. How to prove a change works and report it so the harness checks pass the first time.
---

# Verify and report a Hyde Code task

1. Re-read the task's **Done when** line in your task packet. Every part of it must be true.
2. Run the project's checks yourself (they are listed in the packet). Fix failures before you report.
3. If the change is visible in a browser, open it and look; describe what you saw.
4. Commit in small steps (unless the packet says the harness commits for you).
5. Call `complete_task` with:
   - `summary`: what changed and why, in two or three sentences;
   - `verified`: the exact commands you ran and their result (for example "`npm test`: 14 pass, 0 fail");
   - `filesChanged`: every file you changed.
6. If something is unclear, call `ask_question` instead of guessing, then end your turn.
