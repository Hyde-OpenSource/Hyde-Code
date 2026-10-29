import { ago } from '../api.ts';
import type { PageProps } from '../ui.tsx';

const COLUMNS: [string, string[]][] = [
  ['Backlog', ['backlog']],
  ['Clarifying', ['clarifying']],
  ['Ready', ['ready']],
  ['Running', ['running']],
  ['Verifying', ['verifying']],
  ['Review', ['review']],
  ['Awaiting merge', ['awaiting_merge']],
  ['Done', ['done']],
];

/** Task board (Vibe Kanban's pattern), with blocked and failed tasks tagged in their column. */
export function Board({ scoped: state }: PageProps) {
  const visible = state.tasks.filter((t) => t.status !== 'cancelled');
  const placed = (t: (typeof visible)[number]) => {
    if (t.status === 'blocked') return t.statusHistory.at(-1)?.from ?? 'running';
    if (t.status === 'failed') return t.statusHistory.at(-1)?.from ?? 'running';
    return t.status;
  };
  return (
    <>
      <h1>Board</h1>
      <p className="sub">Blocked and failed tasks stay in the column they stopped in, tagged.</p>
      <div className="board">
        {COLUMNS.map(([title, statuses]) => {
          const tasks = visible.filter((t) => statuses.includes(placed(t)));
          return (
            <section className="column" key={title} aria-label={title}>
              <h4>
                {title} <span>{tasks.length}</span>
              </h4>
              {tasks.map((t) => (
                <a className="task" key={t.id} href={`#task/${t.id}`}>
                  <div className="spread">
                    <span className="mono">{t.id}</span>
                    {t.status === 'blocked' && <span className="badge warn">blocked {t.blockedBy?.id ?? ''}</span>}
                    {t.status === 'failed' && <span className="badge bad">failed</span>}
                    {t.kind === 'client' && <span className="badge accent">client</span>}
                  </div>
                  <div>{t.title}</div>
                  <div className="meta">
                    {t.agent ?? t.pinnedAgent ?? 'unassigned'} · {ago(t.statusHistory.at(-1)?.ts ?? t.createdTs)}
                    {t.children.length ? ` · ${t.children.length} subtasks` : ''}
                    {t.parentId ? ` · part of ${t.parentId}` : ''}
                  </div>
                </a>
              ))}
            </section>
          );
        })}
      </div>
    </>
  );
}
