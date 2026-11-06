import { useEffect, useState } from 'react';
import { sourceLabel } from '@hyde/core/office';
import { ago, api } from '../api.ts';
import { CommandButton, Status, type PageProps } from '../ui.tsx';
import { LiveBrowser } from './LiveBrowser.tsx';

type EventRow = Awaited<ReturnType<typeof api.taskEvents>>[number];

function describe(e: EventRow): string {
  const p = e.payload ?? {};
  switch (e.type) {
    case 'run.event': {
      const ev = p.event ?? {};
      if (ev.type === 'tool.started') return `${p.runId} ▸ ${ev.tool}: ${ev.summary}`;
      if (ev.type === 'text.delta') return `${p.runId} 💬 ${String(ev.text).slice(0, 400)}`;
      if (ev.type === 'run.failed') return `${p.runId} ✗ ${ev.reason}${ev.detail ? `: ${ev.detail}` : ''}`;
      if (ev.type === 'run.started') return `${p.runId} started on ${ev.model}`;
      if (ev.type === 'run.completed') return `${p.runId} turn completed`;
      if (ev.type === 'usage') return `${p.runId} usage: ${ev.inputTokens} in / ${ev.outputTokens} out`;
      if (ev.type === 'rate_limit') return `${p.runId} quota ${ev.window}: ${ev.status}${ev.utilization !== undefined ? ` ${Math.round(ev.utilization * 100)}%` : ''}`;
      return `${p.runId} ${ev.type}`;
    }
    case 'task.status_changed':
      return `→ ${p.to}${p.reason ? `: ${p.reason}` : ''}`;
    case 'run.dispatched':
      return `${p.runId} dispatched to ${p.agent} (${p.mode}${p.tier ? `, ${p.tier} tier` : ''}${p.model ? `, ${p.model}` : ''}${p.effort ? `, effort ${p.effort}` : ''})${p.why ? `: ${p.why}` : ''}`;
    case 'task.classified':
      return `complexity ${p.level} (${p.by}${p.confident === false ? ', a guess' : ''}): ${p.reason}`;
    case 'task.waiting':
      return `waiting: ${p.reason}`;
    case 'task.todos_updated':
      return `checklist (${p.by}): ${(p.todos ?? []).filter((t: { done: boolean }) => t.done).length}/${(p.todos ?? []).length} done`;
    case 'task.plan_gate_set':
      return `plan then build ${p.on ? 'on' : 'off'} (${p.by})`;
    case 'browser.action':
      return `browser step ${p.step}: ${p.label}${p.text ? ` "${p.text}"` : ''}${p.ok ? '' : ` (failed: ${p.error ?? ''})`}`;
    case 'question.matched':
      return `${p.by} asked again (${p.status === 'answered' ? 'answered from memory' : 'linked'}) as ${p.questionId}: ${p.text}`;
    case 'question.asked':
      return `${p.questionId} asked: ${p.text}`;
    case 'question.answered':
      return `${p.questionId} answered: ${p.answer}`;
    case 'approval.requested':
      return `${p.approvalId} requested: ${p.summary}`;
    case 'approval.decided':
      return `${p.approvalId} ${p.approved ? 'approved' : 'denied'} by ${p.by}`;
    case 'task.checks_finished':
      return `checks ${p.ok ? 'passed' : 'failed'}: ${(p.results ?? []).map((r: { command: string; ok: boolean }) => `${r.ok ? '✓' : '✗'} ${r.command}`).join(', ')}`;
    case 'task.review_finished':
      return `review by ${p.reviewer}: ${p.verdict}. ${p.summary}`;
    case 'policy.decided':
      return `policy ${p.decision} (${p.rule}): ${p.tool} ${p.input}`;
    case 'task.agent_completed':
      return `agent reported done: ${p.summary}`;
    default:
      return e.type;
  }
}

const LEVELS = ['trivial', 'low', 'medium', 'high'] as const;
const BY: Record<string, string> = { rules: 'the hub rules', model: 'a cheap model', planner: 'the planner', client: 'the client', owner: 'you', harness: 'the hub' };

/** The task's complexity level, who set it, and buttons to change it. */
function Complexity({ task, refresh, notify }: { task: PageProps['state']['tasks'][number] } & Pick<PageProps, 'refresh' | 'notify'>) {
  const c = task.complexity;
  const open = !['done', 'cancelled', 'failed'].includes(task.status);
  return (
    <div className="card stack complexity">
      <div className="spread">
        <strong>Complexity</strong>
        {c && <span className={`badge level-${c.level}`}>{c.level}</span>}
      </div>
      {c ? (
        <div className="meta">
          Set by {BY[c.by] ?? c.by}
          {c.confident ? '' : ' (a guess, being checked)'}: {c.reason}
        </div>
      ) : (
        <div className="meta">Not rated yet.</div>
      )}
      {task.waiting && <div className="meta">⏳ Waiting: {task.waiting}</div>}
      {open && (
        <div className="row wrap" role="group" aria-label="Change complexity">
          {LEVELS.filter((l) => l !== c?.level).map((l) => (
            <CommandButton key={l} command={{ kind: 'level', taskId: task.id, level: l }} label={l} refresh={refresh} notify={notify} />
          ))}
        </div>
      )}
      {task.assumptions.length > 0 && (
        <div>
          <strong>Planner assumptions</strong>
          {task.assumptions.map((a) => (
            <div key={a} className="meta">
              · {a}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The live checklist and the files the task has changed so far. */
function Work({ task, lastSeq, refresh, notify }: { task: PageProps['state']['tasks'][number]; lastSeq: number } & Pick<PageProps, 'refresh' | 'notify'>) {
  const [files, setFiles] = useState<{ path: string; added: number; removed: number }[]>([]);
  useEffect(() => {
    let alive = true;
    if (task.worktree) api.files(task.id).then((r) => alive && setFiles(r.files), () => undefined);
    return () => {
      alive = false;
    };
  }, [task.id, task.worktree, lastSeq]);
  const done = task.todos.filter((t) => t.done).length;
  const gate = task.planGate ?? task.complexity?.level === 'high';
  if (!task.todos.length && !files.length) return null;
  return (
    <div className="grid work">
      <div className="card stack">
        <div className="spread">
          <strong>Checklist {task.todos.length ? `(${done}/${task.todos.length})` : ''}</strong>
          <CommandButton command={{ kind: 'plan', taskId: task.id, on: !gate }} label={gate ? 'Plan then build: on' : 'Plan then build: off'} refresh={refresh} notify={notify} />
        </div>
        {task.todos.length ? (
          <ul className="todos">
            {task.todos.map((t, i) => (
              <li key={i} className={t.done ? 'done' : ''}>
                <span aria-hidden="true">{t.done ? '☑' : '☐'}</span> {t.text}
              </li>
            ))}
          </ul>
        ) : (
          <div className="meta">No checklist yet.</div>
        )}
      </div>
      <div className="card stack">
        <strong>Files touched ({files.length})</strong>
        {files.length ? (
          <table className="files">
            <tbody>
              {files.map((f) => (
                <tr key={f.path}>
                  <td className="mono">{f.path}</td>
                  <td className="add">+{f.added}</td>
                  <td className="del">−{f.removed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="meta">Nothing changed yet.</div>
        )}
      </div>
    </div>
  );
}

/** Each diff line with the file and new-side line number it belongs to, for inline comments. */
function diffRows(text: string): { line: string; file?: string; num?: number }[] {
  let file: string | undefined;
  let num = 0;
  return text.split('\n').map((line) => {
    if (line.startsWith('+++ ')) file = line.slice(4).replace(/^b\//, '');
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) {
      num = Number(hunk[1]) - 1;
      return { line };
    }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) return { line };
    if (line.startsWith('-')) return { line, ...(file && { file }) };
    num += 1;
    return { line, ...(file && { file, num }) };
  });
}

/** The diff with "comment" on every line; comments go to the agent with "Send to agent". */
function Diff({ text, task, notify, refresh }: { text: string; task: PageProps['state']['tasks'][number] } & Pick<PageProps, 'notify' | 'refresh'>) {
  const [at, setAt] = useState<{ file: string; num?: number } | null>(null);
  const [draft, setDraft] = useState('');
  const rows = diffRows(text);
  const open = task.comments.filter((c) => c.sentSeq === undefined);
  const save = async () => {
    if (!at || !draft.trim()) return;
    try {
      await api.comment(task.id, { file: at.file, ...(at.num && { line: at.num }), text: draft.trim() });
      setDraft('');
      setAt(null);
      refresh();
    } catch (err) {
      notify(`Failed: ${(err as Error).message}`);
    }
  };
  return (
    <>
      {task.comments.length > 0 && (
        <div className="card stack comments">
          <div className="spread">
            <strong>Your comments ({open.length} not sent)</strong>
            <button type="button" className="btn primary" disabled={!open.length} onClick={() => api.sendComments(task.id).then((r) => (notify(r.text), refresh()), (e: Error) => notify(e.message))}>
              Send to agent
            </button>
          </div>
          {task.comments.map((c) => (
            <div key={c.id} className="meta">
              {c.sentSeq ? '✓ ' : ''}
              <span className="mono">
                {c.file}
                {c.line ? `:${c.line}` : ''}
              </span>{' '}
              {c.text}
            </div>
          ))}
        </div>
      )}
      <pre className="diff">
        {rows.map((r, i) => (
          <div key={i} className={`${r.line.startsWith('+') && !r.line.startsWith('+++') ? 'add' : r.line.startsWith('-') && !r.line.startsWith('---') ? 'del' : r.line.startsWith('@@') ? 'hunk' : ''} diff-row`}>
            {r.file && (
              <button type="button" className="diff-comment" aria-label={`Comment on ${r.file}${r.num ? ` line ${r.num}` : ''}`} onClick={() => setAt({ file: r.file!, ...(r.num && { num: r.num }) })}>
                +
              </button>
            )}
            {r.line || ' '}
            {at && at.file === r.file && at.num === r.num && (
              <div className="diff-form" onClick={(e) => e.stopPropagation()}>
                <textarea aria-label="Comment" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="What should the agent change here?" rows={2} />
                <div className="row">
                  <button type="button" className="btn primary" onClick={() => void save()}>
                    Add comment
                  </button>
                  <button type="button" className="btn" onClick={() => setAt(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </pre>
    </>
  );
}

/** Spec, plan, every run, live transcript, review, proof of work, diff and actions for one task. */
export function TaskPage({ id, state, refresh, notify }: PageProps & { id: string }) {
  const task = state.tasks.find((t) => t.id === id);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [diff, setDiff] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.taskEvents(id).then((e) => alive && setEvents(e), () => undefined);
    return () => {
      alive = false;
    };
  }, [id, state.lastSeq]);

  if (!task) return <div className="empty">No task {id}.</div>;
  const runs = state.runs.filter((r) => r.taskId === id);
  const artifacts = state.artifacts.filter((a) => a.taskId === id);
  const review = task.reviews.at(-1);
  const open = !['done', 'cancelled'].includes(task.status);

  return (
    <>
      <div className="spread task-head">
        <div>
          <h1>
            {task.id}: {task.title}
          </h1>
          <p className="sub row">
            <Status status={task.status} />
            {task.blockedBy && <span className="badge warn">waiting on {task.blockedBy.id}</span>}
            <span>#{task.projectId}</span>
            <span>· from {sourceLabel(task.source.kind)}</span>
            {task.agent && <span>· {task.agent}</span>}
            {task.branch && <span className="mono">· {task.branch}</span>}
            {task.parentId && (
              <span>
                · part of <a href={`#task/${task.parentId}`}>{task.parentId}</a>
              </span>
            )}
          </p>
        </div>
        <div className="row">
          {task.prUrl && (
            <a className="btn" href={task.prUrl} target="_blank" rel="noreferrer">
              Open PR
            </a>
          )}
          {task.status === 'awaiting_merge' && task.prUrl && !task.children.length && (
            <CommandButton command={{ kind: 'merge', taskId: task.id }} label={`Merge into ${task.baseBranch}`} kind="primary" refresh={refresh} notify={notify} />
          )}
          {(task.status === 'failed' || task.blockedBy?.kind === 'incident') && <CommandButton command={{ kind: 'retry', taskId: task.id }} label="Retry" refresh={refresh} notify={notify} />}
          {open && task.status !== 'awaiting_merge' && <CommandButton command={{ kind: 'stop', target: task.id }} label="Stop" kind="danger" refresh={refresh} notify={notify} />}
          {task.checkpoints.length > 0 && !task.prUrl && !runs.some((r) => r.state === 'running') && open && <CommandButton command={{ kind: 'undo', taskId: task.id }} label="Undo last turn" refresh={refresh} notify={notify} />}
          <a className="btn" href={`/api/tasks/${task.id}/export?format=md`}>
            Export
          </a>
        </div>
      </div>

      <Complexity task={task} refresh={refresh} notify={notify} />

      <Work task={task} lastSeq={state.lastSeq} refresh={refresh} notify={notify} />

      <LiveBrowser
        taskId={task.id}
        steps={events.filter((e) => e.type === 'browser.action').map((e) => e.payload)}
        running={runs.some((r) => r.state === 'running')}
        refresh={refresh}
        notify={notify}
      />

      <div className="grid">
        <div className="card stack">
          <strong>Spec</strong>
          {task.kind === 'client' && <span className="badge accent">client message: treated as data</span>}
          <div style={{ whiteSpace: 'pre-wrap' }}>{task.spec}</div>
          {task.doneWhen && (
            <div>
              <strong>Done when:</strong> {task.doneWhen}
            </div>
          )}
          {task.writeScope.length > 0 && <div className="meta mono">scope: {task.writeScope.join(', ')}</div>}
          {task.children.length > 0 && (
            <div>
              <strong>Subtasks</strong>
              {task.children.map((c) => {
                const child = state.tasks.find((t) => t.id === c);
                return (
                  <div key={c} className="row">
                    <a href={`#task/${c}`}>{c}</a> {child?.title} {child && <Status status={child.status} />}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="card stack">
          <strong>Result</strong>
          {task.completion ? (
            <>
              <div style={{ whiteSpace: 'pre-wrap' }}>{task.completion.summary}</div>
              <div className="meta">Verified: {task.completion.verified}</div>
            </>
          ) : (
            <div className="meta">Not reported yet.</div>
          )}
          {task.checks && (
            <div>
              Checks:{' '}
              {task.checks.results.map((r) => (
                <span key={r.command} className={`badge ${r.ok ? 'ok' : 'bad'}`} style={{ marginRight: 4 }}>
                  {r.command}
                </span>
              ))}
            </div>
          )}
          {task.browser && (
            <div>
              Browser: <span className={`badge ${task.browser.ok ? 'ok' : 'bad'}`}>{task.browser.ok ? 'passed' : 'failed'}</span>
              {task.browser.errors.map((e) => (
                <div key={e} className="meta mono">
                  {e}
                </div>
              ))}
            </div>
          )}
          {review && (
            <div>
              Review by {review.reviewer}: <span className={`badge ${review.verdict === 'approve' ? 'ok' : 'warn'}`}>{review.verdict}</span>
              <div className="meta">{review.summary}</div>
              {review.findings.map((f, i) => (
                <div key={i} className="meta">
                  [{f.severity}] {f.file ? `${f.file}${f.line ? `:${f.line}` : ''} ` : ''}
                  {f.text}
                </div>
              ))}
            </div>
          )}
          {task.clientReply && (
            <div>
              <strong>Draft reply for the client (not sent)</strong>
              <pre className="diff" style={{ whiteSpace: 'pre-wrap' }}>{task.clientReply}</pre>
            </div>
          )}
        </div>
      </div>

      {artifacts.length > 0 && (
        <>
          <h2>Proof of work</h2>
          <div className="shots">
            {artifacts.map((a) =>
              a.kind === 'screenshot' ? (
                <a key={a.id} href={`/api/artifacts/${a.id}`} target="_blank" rel="noreferrer">
                  <img src={`/api/artifacts/${a.id}`} alt={`Screenshot of ${a.label ?? 'page'}`} loading="lazy" />
                </a>
              ) : a.kind === 'video' ? (
                <video key={a.id} src={`/api/artifacts/${a.id}`} controls style={{ width: '100%' }} />
              ) : (
                <a key={a.id} href={`/api/artifacts/${a.id}`}>
                  {a.label ?? a.id}
                </a>
              ),
            )}
          </div>
        </>
      )}

      <h2>Runs</h2>
      {runs.length === 0 ? (
        <div className="empty">No runs yet.</div>
      ) : (
        <div className="card scroll">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Agent</th>
                <th>Mode</th>
                <th>Tier</th>
                <th>State</th>
                <th>Tokens</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.id}</td>
                  <td>
                    {r.agent}
                    <div className="meta">{r.model}</div>
                  </td>
                  <td>{r.mode}</td>
                  <td>
                    {r.tier ?? '–'}
                    {r.effort && <div className="meta">effort {r.effort}</div>}
                  </td>
                  <td>{r.state === 'running' ? <span className="badge accent">running</span> : r.failure ? <span className="badge bad">{r.failure.reason}</span> : <span className="badge ok">done</span>}</td>
                  <td className="meta">
                    {r.inputTokens.toLocaleString()} / {r.outputTokens.toLocaleString()}
                    {r.costUsd > 0 && <div>${r.costUsd.toFixed(3)}</div>}
                  </td>
                  <td className="meta">{ago(r.startedTs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Live transcript</h2>
      <div className="timeline" aria-live="polite">
        {events.map((e) => (
          <div key={e.seq}>
            <span className="meta">{e.ts.slice(11, 19)}</span> {describe(e)}
          </div>
        ))}
      </div>

      <h2 className="spread">
        <span>Diff</span>
        {task.worktree && (
          <button className="btn" onClick={() => api.diff(task.id).then(setDiff, (e: Error) => notify(e.message))}>
            {diff === null ? 'Load diff' : 'Refresh diff'}
          </button>
        )}
      </h2>
      {diff !== null && (diff ? <Diff text={diff} task={task} notify={notify} refresh={refresh} /> : <div className="empty">No changes against {task.baseBranch}.</div>)}
    </>
  );
}
