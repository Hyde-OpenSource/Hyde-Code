import { vendorColor, type PageProps } from '../ui.tsx';

/** The office view (Munder Difflin's fun screen): one desk per agent. */
export function Office({ state }: PageProps) {
  return (
    <>
      <h1>Office</h1>
      <p className="sub">Who is at their desk, and what they are on.</p>
      <div className="office">
        {state.agents.map((a) => {
          const live = state.runs.find((r) => r.agent === a.name && r.state === 'running');
          const task = live && state.tasks.find((t) => t.id === live.taskId);
          return (
            <div className="desk" key={a.name}>
              <div className={`avatar ${live ? 'working' : ''}`} style={{ background: a.enabled ? vendorColor(a.vendor) : 'var(--muted)' }} aria-hidden="true">
                {a.name.slice(0, 1).toUpperCase()}
              </div>
              <strong>{a.name}</strong>
              <div className="meta">{a.adapter}</div>
              <div className="meta" style={{ minHeight: 40 }}>
                {!a.enabled ? 'off today' : task ? <a href={`#task/${task.id}`}>{task.id}: {task.title}</a> : 'free'}
              </div>
            </div>
          );
        })}
        <div className="desk">
          <div className="avatar" style={{ background: 'var(--text)' }} aria-hidden="true">
            H
          </div>
          <strong>hub</strong>
          <div className="meta">the main agent</div>
          <div className="meta">{state.tasks.filter((t) => !['done', 'cancelled'].includes(t.status)).length} tasks in play</div>
        </div>
      </div>
    </>
  );
}
