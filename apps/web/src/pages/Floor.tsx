import { useState } from 'react';
import { ago, api } from '../api.ts';
import { QuotaBar, Status, vendorColor, type PageProps } from '../ui.tsx';
import { inboxCount } from './Inbox.tsx';

/** Home: one card per agent, and a box to start a task. */
export function Floor({ state, refresh, notify }: PageProps) {
  const [text, setText] = useState('');
  const [project, setProject] = useState(state.projects[0]?.id ?? '');
  const [agent, setAgent] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = inboxCount(state);

  const submit = async (kind: 'new' | 'client') => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const reply = await api.command(kind === 'new' ? { kind, text, project, ...(agent && { agent }) } : { kind, text, project });
      notify(reply.text);
      setText('');
      refresh();
    } catch (err) {
      notify(`Failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>Floor</h1>
      <p className="sub">
        {state.tasks.filter((t) => !['done', 'cancelled'].includes(t.status)).length} active tasks ·{' '}
        {pending ? <a href="#inbox">{pending} waiting for you</a> : 'nothing waiting for you'}
      </p>

      <form
        className="newtask"
        onSubmit={(e) => {
          e.preventDefault();
          void submit('new');
        }}
      >
        <input aria-label="New task" placeholder="Describe a task…" value={text} onChange={(e) => setText(e.target.value)} />
        <select aria-label="Project" value={project} onChange={(e) => setProject(e.target.value)}>
          {state.projects.map((p) => (
            <option key={p.id} value={p.id}>
              #{p.id}
            </option>
          ))}
        </select>
        <select aria-label="Agent" value={agent} onChange={(e) => setAgent(e.target.value)}>
          <option value="">Any agent</option>
          {state.agents.filter((a) => a.enabled).map((a) => (
            <option key={a.name} value={a.name}>
              @{a.name}
            </option>
          ))}
        </select>
        <button className="btn primary" disabled={busy || !text.trim()}>
          Start task
        </button>
      </form>

      <div className="grid">
        {state.agents.map((a) => {
          const runs = state.runs.filter((r) => r.agent === a.name);
          const live = runs.find((r) => r.state === 'running');
          const task = live ? state.tasks.find((t) => t.id === live.taskId) : undefined;
          const quotas = state.quotas.filter((q) => q.account === a.account);
          const max = Math.max(0, ...quotas.map((q) => q.utilization ?? 0));
          const failed = runs.slice(-5).filter((r) => r.failure && r.failure.reason !== 'cancelled').length;
          const unavailable = a.health && (!a.health.installed || !a.health.signedIn);
          const waiting = task && state.questions.some((q) => q.taskId === task.id && q.status === 'open');
          const stateLabel = !a.enabled ? 'disabled' : unavailable ? 'unavailable' : waiting ? 'needs you' : live ? 'working' : 'idle';
          return (
            <div className="card stack" key={a.name}>
              <h3>
                <span className="row">
                  <span className="dot on" style={{ background: vendorColor(a.vendor) }} />
                  {a.name}
                </span>
                <span className={`badge ${stateLabel === 'working' ? 'accent' : stateLabel === 'needs you' ? 'warn' : stateLabel === 'unavailable' ? 'bad' : ''}`}>{stateLabel}</span>
              </h3>
              <div className="meta">
                {a.adapter} · {a.vendor}
                {a.model ? ` · ${a.model}` : ''}
                {a.node !== 'local' ? ` · node ${a.node}` : ''}
              </div>
              {unavailable && <div className="meta">{a.health?.problem}</div>}
              {task ? (
                <div>
                  <a href={`#task/${task.id}`}>
                    {task.id}: {task.title}
                  </a>
                  <div className="meta mono">{live?.lastAction ?? 'starting…'}</div>
                  <div className="meta">
                    {live?.mode} · {live?.toolCalls} tool calls · started {ago(live?.startedTs)}
                  </div>
                </div>
              ) : (
                <div className="meta">{runs.length ? `Last run ${ago(runs.at(-1)?.lastEventTs)}` : 'No runs yet'}</div>
              )}
              <div>
                <div className="spread meta">
                  <span>Quota</span>
                  <span>{quotas.length ? quotas.map((q) => `${q.window.replace('_', ' ')} ${Math.round((q.utilization ?? 0) * 100)}%`).join(' · ') : 'no data yet'}</span>
                </div>
                <QuotaBar value={max} />
              </div>
              {failed > 0 && <div className="meta" style={{ color: 'var(--bad)' }}>{failed} of the last 5 runs failed</div>}
            </div>
          );
        })}
      </div>

      <h2>Recent tasks</h2>
      {state.tasks.length === 0 ? (
        <div className="empty">No tasks yet. Describe one above, or send /new to your bot.</div>
      ) : (
        <div className="card scroll">
          <table>
            <tbody>
              {[...state.tasks].reverse().slice(0, 8).map((t) => (
                <tr key={t.id}>
                  <td className="mono">{t.id}</td>
                  <td>
                    <a href={`#task/${t.id}`}>{t.title}</a>
                  </td>
                  <td>
                    <Status status={t.status} />
                  </td>
                  <td className="meta">{t.agent ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
