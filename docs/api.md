# Hub client API

The API that local apps (Hyde AI, scripts) use to drive the hub. **API version 1.** Breaking
changes bump `apiVersion` in `GET /api/health`, so clients can warn on a mismatch. Code:
`apps/hub/src/http.ts`, `summary.ts`, `clients.ts`; tests: `client-api.test.ts`.

The hub listens on `127.0.0.1` only.

## Finding the hub

1. Read `$HYDE_HOME/hub.json` (default `~/.hyde/hub.json`). The running hub writes it on start
   and removes it on a clean stop:
   ```json
   { "url": "http://127.0.0.1:7420", "pid": 12345, "version": "0.0.0", "apiVersion": 1,
     "dataDir": "/home/you/.hyde/data", "startedAt": "2026-10-30T00:00:00.000Z" }
   ```
   If the file is missing, or `pid` is not alive, the hub is not running (a crash can leave a
   stale file). Start it with `hyde hub start`.
2. Fallback: `$HYDE_HOME/config.json` gives `port` and `dataDir`.

## Auth

Send `Authorization: Bearer <token>`.

| Token | File | Can |
|---|---|---|
| Owner | `<dataDir>/owner-token` | Everything, including config, projects and trust, `/promote`, lessons, dashboard login. |
| Client `hyde-ai` | `<dataDir>/clients/hyde-ai.token` | Read: `/api/state`, `/api/summary`, `/api/events`, `/api/feed`, `/api/tasks/:id/events`, `/api/tasks/:id/diff`. Write: `POST /api/tasks`, answer questions, approve or deny (not `promote` approvals), and the chat commands `/new /answer /approve /deny /stop /retry /merge /status /agents /usage /projects /logs /help`. |

The client token is created (0600) when the hub starts. To rotate it, delete the file and run
`hyde hub restart`. Anything a client may not do returns **401** (route not open to clients) or
**403** (command or approval kind not open to clients).

Tasks, answers and decisions made with the client token are recorded with actor
`client:hyde-ai` and task source `hyde-ai`, shown in the office, board, task page and audit log.

## Errors

Error bodies are `{"error": "<text for people>", "code": "<machine code>"}`. Codes:
`invalid` (400, bad body), `project` / `agent` (400, unknown or ambiguous project, unknown or
disabled agent), `duplicate` (409, same `requestId`), `not_found` (404), `closed` (409, already
answered or decided), `forbidden` (403).

## Endpoints

### `GET /api/health` (no auth)
`{"ok": true, "version": "0.0.0", "apiVersion": 1}`

### `POST /api/tasks`
```json
{ "text": "add a dark mode toggle", "project": "Gamify IAS LMS", "agent": "codex-1", "requestId": "voice-8f1c" }
```
- `text` (required). `project`: id or name, matched ignoring case, spaces, `-`, `_` and `.`;
  optional when there is one project. `agent`: pins the task to that agent. `requestId`:
  optional; a repeat with the same id creates nothing and returns 409 `duplicate`.
- `source`: owner token only, one of `api` (default), `cli`, `hyde-ai`. A client token always
  records its own name.
- **201** `{"id": "T-12", "status": "clarifying", "projectId": "gamify-ias-lms", "title": "...", "text": "<chat reply>"}`

Tasks from `hyde-ai` always go through the planner's clarify step when some usable agent has the
`plan` role, even with the planner switched off; otherwise they start normally and `text` says so.

### `POST /api/questions/:id/answer`
`{"text": "use the existing toggle"}` or `{"option": 0}` (index into the question's `options`).
**200** `{"id": "Q-3", "status": "answered", "answer": "...", "text": "<chat reply>"}`

### `POST /api/approvals/:id`
`{"decision": "approve"}` or `{"decision": "deny"}`.
**200** `{"id": "A-2", "status": "approved", "text": "<chat reply>"}`

### `GET /api/summary[?project=<id or name>]`
Small, bounded answer to "what's going on and what needs me":
```json
{
  "version": "0.0.0", "apiVersion": 1, "lastSeq": 812,
  "counts": { "tasks": { "running": 1, "blocked": 1, "done": 9 }, "active": 2, "runningRuns": 1,
              "questions": 1, "approvals": 0, "merges": 1, "needsYou": 2 },
  "needsYou": [
    { "kind": "question", "id": "Q-3", "taskId": "T-12", "taskTitle": "...", "projectId": "app",
      "text": "Paginate?", "options": ["yes", "no"], "blocking": true },
    { "kind": "approval", "id": "A-2", "taskId": "T-11", "taskTitle": "...", "projectId": "app",
      "approvalKind": "first-push", "summary": "..." },
    { "kind": "merge", "taskId": "T-9", "taskTitle": "...", "projectId": "app", "prUrl": "https://github.com/..." }
  ],
  "agents": [
    { "name": "claude-1", "adapter": "claude-code", "model": "sonnet", "usable": true,
      "utilization": 0.92, "percent": 92, "nearCeiling": true, "resetsAt": 1793412000 }
  ],
  "quotaSoftCeiling": 0.8
}
```
Questions and approvals of finished or cancelled tasks are left out. `nearCeiling` means new runs
on that agent wait; `blocked` (e.g. `"five_hour limit reached"`) means a window is used up.
`resetsAt` is unix seconds for the fullest window, when known.

### `GET /api/state`
The full state (every task, run, question, approval, …) plus `agents`, `projects`, `metrics`
and `stages`. It grows with history; prefer `/api/summary` for status checks.

### `POST /api/commands`
`{"text": "/merge T-4"}` → `{"text": "<chat reply>"}`. Same commands as chat (see `/help`).
Prefer the typed endpoints above; replies are for people and may change wording.

### `GET /api/events[?after=<seq>]` (server-sent events)
Every new event in the log, in order. Each message has no `event:` name (so `EventSource.onmessage`
gets it), `id: <seq>`, and `data:` a JSON record:
```json
{ "seq": 813, "ts": "2026-10-30T00:01:02.000Z", "type": "question.asked", "actor": { "kind": "agent", "id": "claude-1" },
  "taskId": "T-12", "runId": "R-40", "payload": { "questionId": "Q-3", "taskId": "T-12", "runId": "R-40",
  "text": "Paginate?", "blocking": true, "options": ["yes", "no"] } }
```
Without `after`, the stream starts from now; with `after=<seq>`, or the `Last-Event-ID` header a
reconnecting `EventSource` sends, it first replays everything after that seq. Every 15 s of quiet it sends
`event: ping` with empty data.

Record `type`s useful for notifications (payload fields in `packages/core/src/events.ts`):

| type | payload |
|---|---|
| `task.created` | `taskId, projectId, title, spec, kind, source{kind}, agent?` |
| `task.status_changed` | `taskId, from, to, reason?, blockedBy?{kind,id}` |
| `task.pr_opened` | `taskId, url` |
| `task.merged` | `taskId, into, sha?` |
| `question.asked` | `questionId, taskId, runId, text, blocking, options[]` |
| `question.answered` | `questionId, answer, by` |
| `approval.requested` | `approvalId, taskId, kind, summary` |
| `approval.decided` | `approvalId, approved, by` |
| `incident.raised` | `incidentId, taskId?, about, evidence` |
| `quota.updated` | `account, window, status, utilization?, resetsAt?` |

Other types (`run.event`, `run.dispatched`, `agent.progress`, …) are frequent; skip what you
don't use.

### `GET /login?token=<owner token>&project=<id>`
Opens the web office. Owner token only.
