import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { PageProps } from '../ui.tsx';

/** Audit trail: who asked, who approved, which agent did what (newest first). */
export function Audit({ state }: PageProps) {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.audit>>>([]);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    api.audit().then(setRows, () => undefined);
  }, [state.lastSeq]);
  const shown = rows.filter((r) => !filter || `${r.type} ${r.actor.id} ${r.taskId ?? ''}`.toLowerCase().includes(filter.toLowerCase())).reverse();
  return (
    <>
      <h1>Audit</h1>
      <p className="sub">Every decision in the event log. Policy decisions: {state.policy.allow} allowed, {state.policy.deny} denied, {state.policy.approval} sent for approval.</p>
      <label htmlFor="audit-filter">Filter</label>
      <input id="audit-filter" placeholder="e.g. approval, tg:, T-3" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 360, marginBottom: 12 }} />
      <div className="card scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Time</th>
              <th>Event</th>
              <th>Actor</th>
              <th>Task</th>
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, 300).map((r) => (
              <tr key={r.seq}>
                <td className="meta">{r.seq}</td>
                <td className="meta">{new Date(r.ts).toLocaleString()}</td>
                <td className="mono">{r.type}</td>
                <td>
                  <span className={`badge ${r.actor.kind === 'user' ? 'accent' : r.actor.kind === 'agent' ? 'ok' : ''}`}>{r.actor.kind}</span> {r.actor.id}
                </td>
                <td>{r.taskId && <a href={`#task/${r.taskId}`}>{r.taskId}</a>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
