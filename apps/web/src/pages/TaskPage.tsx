import { useEffect, useState } from 'react';
import { ago, api } from '../api.ts';
import { CommandButton, Status, type PageProps } from '../ui.tsx';

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
      return `${p.runId} dispatched to ${p.agent} (${p.mode})`;
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

function Diff({ text }: { text: string }) {
  return (
    <pre className="diff">
      {text.split('\n').map((line, i) => (
        <div key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : ''}>
          {line || ' '}
        </div>
      ))}
    </pre>
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
      <div className="spread">
        <div>
          <h1>
            {task.id}: {task.title}
          </h1>
          <p className="sub row">
            <Status status={task.status} />
            {task.blockedBy && <span className="badge warn">waiting on {task.blockedBy.id}</span>}
            <span>#{task.projectId}</span>
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
        </div>
      </div>

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
                  <td>{r.state === 'running' ? <span className="badge accent">running</span> : r.failure ? <span className="badge bad">{r.failure.reason}</span> : <span className="badge ok">done</span>}</td>
                  <td className="meta">
                    {r.inputTokens.toLocaleString()} / {r.outputTokens.toLocaleString()}
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
      {diff !== null && (diff ? <Diff text={diff} /> : <div className="empty">No changes against {task.baseBranch}.</div>)}
    </>
  );
}
