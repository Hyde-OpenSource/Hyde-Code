import { useEffect, useMemo, useRef, useState } from 'react';
import { agentActivity, sessionLine, type AgentActivity } from '@hyde/core/office';
import { ago, api, onHubEvent, type HubState } from '../api.ts';
import { OfficeScene } from '../office/OfficeScene.tsx';
import { QuotaBar, Status, vendorColor, type PageProps } from '../ui.tsx';
import { NeedsYou, inboxCount } from './Inbox.tsx';

const MOOD_LABEL: Record<AgentActivity['mood'], string> = {
  off: 'off',
  broken: 'needs setup',
  'needs-you': 'needs you',
  working: 'working',
  planning: 'planning',
  reviewing: 'reviewing',
  idle: 'free',
};

export function activities(state: HubState): AgentActivity[] {
  return state.agents.map((a) => agentActivity(state, a));
}

/** Home: the office floor, the team, what needs you, and the selected agent's live session. */
export function Office({ state, refresh, notify, feed }: PageProps) {
  const acts = useMemo(() => activities(state), [state]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<'needs' | 'team' | 'activity'>(() => (inboxCount(state) ? 'needs' : 'team'));
  const count = inboxCount(state);
  const working = acts.filter((a) => ['working', 'planning', 'reviewing'].includes(a.mood)).length;
  const active = state.tasks.filter((t) => !['done', 'cancelled'].includes(t.status)).length;

  return (
    <div className="office-page">
      <section className="office-main">
        <div className="panel scene-panel">
          <div className="panel-head">
            <span className="panel-title">The floor</span>
            <span className="meta">
              {working} at work · {active} tasks in play · {count ? <button className="linklike" onClick={() => setTab('needs')}>{count} waiting for you</button> : 'nothing waiting for you'}
            </span>
          </div>
          <OfficeScene
            state={state}
            activity={acts}
            selected={selected}
            onSelect={(name) => {
              setSelected(name);
              if (name) setTab('team');
            }}
            onInbox={() => setTab('needs')}
            inboxCount={count}
          />
        </div>
        <AssignBar state={state} refresh={refresh} notify={notify} agent={selected} />
        <Session state={state} agent={selected ?? acts.find((a) => ['working', 'planning', 'reviewing', 'needs-you'].includes(a.mood))?.name ?? null} pinned={Boolean(selected)} onClose={() => setSelected(null)} />
      </section>

      <aside className="panel side" aria-label="Team panel">
        <div className="tabs" role="tablist">
          {(
            [
              ['needs', `Needs you${count ? ` (${count})` : ''}`],
              ['team', 'Team'],
              ['activity', 'Activity'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={`tab ${tab === id ? 'on' : ''} ${id === 'needs' && count ? 'hot' : ''}`} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="side-body">
          {tab === 'needs' && <NeedsYou state={state} refresh={refresh} notify={notify} />}
          {tab === 'team' && <Team state={state} acts={acts} selected={selected} onSelect={setSelected} />}
          {tab === 'activity' &&
            (feed.length ? (
              <ol className="feed">
                {[...feed].reverse().map((l) => (
                  <li key={l.seq} className={`feed-${l.type.split('.')[0]}`}>
                    <span className="meta">{l.ts.slice(11, 16)}</span> {l.taskId ? <a href={`#task/${l.taskId}`}>{l.text}</a> : l.text}
                  </li>
                ))}
              </ol>
            ) : (
              <div className="empty">No activity yet.</div>
            ))}
        </div>
      </aside>
    </div>
  );
}

function Team({ state, acts, selected, onSelect }: { state: HubState; acts: AgentActivity[]; selected: string | null; onSelect: (n: string | null) => void }) {
  return (
    <div className="team">
      {state.agents.map((a) => {
        const act = acts.find((x) => x.name === a.name)!;
        const quotas = state.quotas.filter((q) => q.account === a.account);
        const max = Math.max(0, ...quotas.map((q) => q.utilization ?? 0));
        const m = state.metrics.find((x) => x.agent === a.name);
        return (
          <button key={a.name} className={`member ${selected === a.name ? 'on' : ''}`} onClick={() => onSelect(selected === a.name ? null : a.name)} aria-pressed={selected === a.name}>
            <span className="spread">
              <span className="row">
                <span className="swatch" style={{ background: vendorColor(a.vendor) }} />
                <strong>{a.name}</strong>
              </span>
              <span className={`badge mood-${act.mood}`}>{MOOD_LABEL[act.mood]}</span>
            </span>
            <span className="meta">
              {a.adapter}
              {a.model ? ` · ${a.model}` : ''}
              {a.node !== 'local' ? ` · ${a.node}` : ''}
              {m ? ` · ${m.tasksDone} merged · ${Math.round(m.successRate * 100)}% ok` : ''}
            </span>
            <span className="member-line mono">{act.taskId ? `${act.taskId} · ${act.line}` : act.line}</span>
            <span className="quota">
              <span className="meta">{quotas.length ? quotas.map((q) => `${q.window.replace('_', ' ')} ${Math.round((q.utilization ?? 0) * 100)}%`).join(' · ') : 'quota: no data yet'}</span>
              <QuotaBar value={max} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

function AssignBar({ state, refresh, notify, agent }: Pick<PageProps, 'state' | 'refresh' | 'notify'> & { agent: string | null }) {
  const [text, setText] = useState('');
  const [project, setProject] = useState(state.projects[0]?.id ?? '');
  const [pick, setPick] = useState('');
  const [client, setClient] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setPick(agent ?? ''), [agent]);

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const reply = await api.command(client ? { kind: 'client', text, project } : { kind: 'new', text, project, ...(pick && { agent: pick }) });
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
    <form
      className="panel assign"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="assign-text" className="sr-only">
        Describe the work
      </label>
      <input id="assign-text" placeholder={client ? 'Paste the client message…' : 'Give the team some work… e.g. "Add a dark mode toggle to settings"'} value={text} onChange={(e) => setText(e.target.value)} />
      <select aria-label="Project" value={project} onChange={(e) => setProject(e.target.value)}>
        {state.projects.map((p) => (
          <option key={p.id} value={p.id}>
            #{p.id}
          </option>
        ))}
      </select>
      <select aria-label="Agent" value={pick} onChange={(e) => setPick(e.target.value)} disabled={client}>
        <option value="">Hyde decides</option>
        {state.agents
          .filter((a) => a.enabled)
          .map((a) => (
            <option key={a.name} value={a.name}>
              @{a.name}
            </option>
          ))}
      </select>
      <label className="check">
        <input type="checkbox" checked={client} onChange={(e) => setClient(e.target.checked)} /> client message
      </label>
      <button className="btn primary" disabled={busy || !text.trim()}>
        {busy ? 'Sending…' : 'Assign'}
      </button>
    </form>
  );
}

type Line = { seq: number; kind: string; text: string };

/** The agent's session, printed the way its CLI would: tools, text, results. Read-only. */
function Session({ state, agent, pinned, onClose }: { state: HubState; agent: string | null; pinned: boolean; onClose: () => void }) {
  const run = agent ? [...state.runs].reverse().find((r) => r.agent === agent) : undefined;
  const task = run && state.tasks.find((t) => t.id === run.taskId);
  const [lines, setLines] = useState<Line[]>([]);
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (!task) return setLines([]);
    let alive = true;
    let timer: number | undefined;
    const load = () =>
      api.taskEvents(task.id).then(
        (events) => {
          if (!alive) return;
          const out: Line[] = [];
          for (const e of events) {
            if (e.runId && run && !state.runs.some((r) => r.id === e.runId && r.agent === agent)) continue;
            const l = sessionLine(e);
            if (l) out.push({ seq: e.seq, ...l });
          }
          setLines(out.slice(-400));
        },
        () => undefined,
      );
    void load();
    const off = onHubEvent((e) => {
      if (e.taskId !== task.id && e.payload?.taskId !== task.id) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 250);
    });
    return () => {
      alive = false;
      off();
      window.clearTimeout(timer);
    };
  }, [task?.id, agent]);

  useEffect(() => {
    if (stick.current && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [lines]);

  if (!agent) {
    return (
      <div className="panel terminal quiet">
        <div className="term-head">
          <span>session</span>
        </div>
        <div className="term-body">
          <div className="term-meta">Nobody is working right now. Click someone on the floor to see their last session.</div>
        </div>
      </div>
    );
  }
  return (
    <div className="panel terminal">
      <div className="term-head">
        <span>
          <strong>{agent}</strong>
          {task ? (
            <>
              {' '}
              — <a href={`#task/${task.id}`}>{task.id}</a> {task.title}
            </>
          ) : (
            ' — no sessions yet'
          )}
        </span>
        <span className="row">
          {run && (
            <span className="meta">
              {run.mode.replace('_', ' ')} · {run.state === 'running' ? `live, ${ago(run.startedTs)}` : `ended ${ago(run.endedTs ?? run.lastEventTs)}`}
            </span>
          )}
          {task && <Status status={task.status} />}
          {pinned && (
            <button className="btn small" onClick={onClose} aria-label="Close session">
              ✕
            </button>
          )}
        </span>
      </div>
      <div
        className="term-body"
        ref={body}
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {lines.length === 0 && <div className="term-meta">Waiting for output…</div>}
        {lines.map((l) => (
          <div key={l.seq} className={`term-${l.kind}`}>
            {l.text}
          </div>
        ))}
        {run?.state === 'running' && <span className="cursor" aria-hidden="true" />}
      </div>
    </div>
  );
}
