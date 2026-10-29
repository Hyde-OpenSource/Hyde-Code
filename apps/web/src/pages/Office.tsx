import { useEffect, useMemo, useRef, useState } from 'react';
import { agentActivity, sessionLine, type AgentActivity } from '@hyde/core/office';
import { ago, api, onHubEvent, type FeedLine, type HubState } from '../api.ts';
import { AgentCard } from '@/components/AgentCard';
import { Icon } from '@/components/Icon';
import { PixelBadge } from '@/components/PixelBadge';
import { PixelButton } from '@/components/PixelButton';
import { PixelPanel } from '@/components/PixelPanel';
import { GOD_ID, boardStatus, toAgents, useOfficeBridge } from '@/bridge';
import { OfficeFloor } from '@/scene/office/OfficeFloor';
import { useStore, type CommandCenterTab } from '@/store/store';
import { QuotaBar, type PageProps } from '../ui.tsx';
import { NeedsYou, inboxCount } from './Inbox.tsx';

// The office, laid out like Munder Difflin: the floor on the left, the selected agent
// (or Hyde's Command Center) on the right, the team strip along the bottom.

export function Office({ state, scoped, project, refresh, notify, feed }: PageProps) {
  useOfficeBridge(state);
  const selectedId = useStore((s) => s.selectedId);
  const tilesLicensed = useStore((s) => s.tilesLicensed);
  const agents = useMemo(() => toAgents(state), [state]);
  const selected = selectedId && selectedId !== GOD_ID ? state.agents.find((a) => a.name === selectedId) : undefined;

  return (
    <div className="md-office">
      <div className="md-main">
        <div className="md-floor">
          <OfficeFloor />
          <div className="md-credit">
            {tilesLicensed ? (
              <>
                Tiles: <a href="https://limezu.itch.io/" target="_blank" rel="noreferrer">Modern Interiors by LimeZu</a>
              </>
            ) : (
              <>Simple tiles. Add your LimeZu copy with <code>hyde tiles &lt;folder&gt;</code> for the full art.</>
            )}
          </div>
        </div>
        <aside className="md-side">
          {selected ? (
            <AgentDetail state={state} name={selected.name} refresh={refresh} notify={notify} />
          ) : (
            <CommandCenter state={scoped} refresh={refresh} notify={notify} feed={feed} project={project ? state.projects.find((p) => p.id === project) : undefined} />
          )}
        </aside>
      </div>
      <TeamStrip state={state} agents={agents} selectedId={selectedId} refresh={refresh} notify={notify} project={project} />
    </div>
  );
}

/** The bottom dock: one card per agent (Hyde first), then the dispatch box. */
function TeamStrip({ state, agents, selectedId, refresh, notify, project }: Pick<PageProps, 'state' | 'refresh' | 'notify' | 'project'> & { agents: ReturnType<typeof toAgents>; selectedId: string | null }) {
  const select = useStore((s) => s.select);
  const waiting = inboxCount(state);
  return (
    <div className="md-strip">
      <div className="md-cards cth-tabbar">
        {agents.map((a) => {
          const cfg = state.agents.find((x) => x.name === a.id);
          const quotas = cfg ? state.quotas.filter((q) => q.account === cfg.account) : [];
          const max = Math.max(0, ...quotas.map((q) => q.utilization ?? 0));
          const doing = state.tasks.filter((t) => t.agent === a.id && ['running', 'verifying', 'review'].includes(t.status));
          return (
            <AgentCard
              key={a.id}
              name={a.name}
              character={a.character}
              accent={a.accent}
              status={a.status}
              project={a.isGod ? `${state.tasks.filter((t) => !['done', 'cancelled'].includes(t.status)).length} tasks in play` : `${cfg?.adapter ?? ''}${cfg?.model ? ` · ${cfg.model}` : ''}`}
              action={a.action}
              progress={Math.round(max * 8)}
              selected={selectedId === a.id}
              isGod={a.isGod}
              note={a.isGod ? (waiting ? `${waiting} waiting for you` : 'nothing waiting for you') : undefined}
              doingCount={doing.length}
              onTaskNoteClick={() => {
                if (doing[0]) window.location.hash = `task/${doing[0].id}`;
              }}
              onClick={() => select(selectedId === a.id ? null : a.id)}
            />
          );
        })}
      </div>
      <Dispatch key={project ?? 'all'} state={state} refresh={refresh} notify={notify} agent={selectedId && selectedId !== GOD_ID ? selectedId : ''} project={project} />
    </div>
  );
}

function Dispatch({ state, refresh, notify, agent, project: picked }: Pick<PageProps, 'state' | 'refresh' | 'notify'> & { agent: string; project: string | null }) {
  const [text, setText] = useState('');
  const [project, setProject] = useState(picked ?? state.projects[0]?.id ?? '');
  const [client, setClient] = useState(false);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const reply = await api.command(client ? { kind: 'client', text, project } : { kind: 'new', text, project, ...(agent && { agent }) });
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
      className="md-dispatch"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <div className="md-label">{client ? 'CLIENT MESSAGE' : agent ? `DISPATCH TO ${agent.toUpperCase()}` : 'DISPATCH TO HYDE'}</div>
      <textarea
        className="cth-input"
        aria-label="Describe the work"
        placeholder={client ? 'Paste what the client said…' : 'Describe a task. Hyde plans it and picks the agent.'}
        value={text}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
        }}
      />
      <div className="md-row">
        <select aria-label="Project" value={project} onChange={(e) => setProject(e.target.value)}>
          {state.projects.map((p) => (
            <option key={p.id} value={p.id}>
              #{p.id}
            </option>
          ))}
        </select>
        <label className="md-check">
          <input type="checkbox" checked={client} onChange={(e) => setClient(e.target.checked)} /> client
        </label>
        <PixelButton variant="primary" size="sm" disabled={busy || !text.trim()} onClick={() => void send()}>
          <Icon name="arrow-right" /> {busy ? 'sending' : 'send'}
        </PixelButton>
      </div>
    </form>
  );
}

const TABS: [CommandCenterTab, string][] = [
  ['tasks', 'TASKS'],
  ['human', 'ASK ME'],
  ['activity', 'ACTIVITY'],
];

/** Hyde's Command Center: the task board, what needs you, and the activity log. */
function CommandCenter({ state, refresh, notify, feed, project }: Pick<PageProps, 'state' | 'refresh' | 'notify'> & { feed: FeedLine[]; project?: { id: string; name: string; path: string } }) {
  const tab = useStore((s) => s.commandCenterTab);
  const waiting = inboxCount(state);
  useEffect(() => {
    // Open on ASK ME the first time something is waiting in this browser session.
    try {
      if (waiting && tab === 'tasks' && !sessionStorage.getItem('hyde.cc.seen')) {
        sessionStorage.setItem('hyde.cc.seen', '1');
        useStore.setState({ commandCenterTab: 'human' });
      }
    } catch {
      // storage blocked: keep the current tab
    }
  }, [waiting]);
  return (
    <PixelPanel variant="default" noPadding style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="md-panel-title">
        <span title={project?.path}>{project ? project.name.toUpperCase() : 'COMMAND CENTER'}</span>
        <PixelBadge status={waiting ? 'blocked' : 'idle'} label={waiting ? `${waiting} for you` : 'all clear'} />
      </div>
      <div className="md-tabs cth-tabbar" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => useStore.setState({ commandCenterTab: id })}>
            {label}
            {id === 'human' && waiting > 0 && <span className="md-count">{waiting}</span>}
          </button>
        ))}
      </div>
      <div className="md-tab-body">
        {tab === 'tasks' && <Kanban state={state} />}
        {tab === 'human' && <NeedsYou state={state} refresh={refresh} notify={notify} />}
        {tab === 'activity' &&
          (feed.length ? (
            <ol className="md-feed">
              {[...feed].reverse().map((l) => (
                <li key={l.seq} className={`feed-${l.type.split('.')[0]}`}>
                  <span className="md-time">{l.ts.slice(11, 16)}</span> {l.taskId ? <a href={`#task/${l.taskId}`}>{l.text}</a> : l.text}
                </li>
              ))}
            </ol>
          ) : (
            <div className="empty">No activity yet.</div>
          ))}
      </div>
    </PixelPanel>
  );
}

const COLUMNS: { key: 'todo' | 'doing' | 'blocked' | 'done'; label: string; accent: string }[] = [
  { key: 'todo', label: 'TODO', accent: 'var(--cth-sky)' },
  { key: 'doing', label: 'DOING', accent: 'var(--cth-lemon)' },
  { key: 'blocked', label: 'BLOCKED', accent: 'var(--cth-coral)' },
  { key: 'done', label: 'DONE', accent: 'var(--cth-mint)' },
];

function Kanban({ state }: { state: HubState }) {
  const tasks = state.tasks.filter((t) => !t.children.length);
  return (
    <div className="md-kanban">
      {COLUMNS.map((c) => {
        const list = tasks.filter((t) => boardStatus(t.status) === c.key).reverse();
        return (
          <section key={c.key} className="md-col">
            <h4 style={{ boxShadow: `inset 0 3px 0 ${c.accent}` }}>
              {c.label} <span>{list.length}</span>
            </h4>
            {list.slice(0, 30).map((t) => (
              <a key={t.id} className="md-card" href={`#task/${t.id}`}>
                <span className="md-card-id">{t.id}</span>
                <span className="md-card-title">{t.title}</span>
                <span className="md-card-meta">
                  {t.agent ?? 'unassigned'} · {t.status.replace('_', ' ')}
                </span>
              </a>
            ))}
            {!list.length && <div className="md-col-empty">—</div>}
          </section>
        );
      })}
    </div>
  );
}

/** The selected agent: identity, quota, live session and quick actions. */
function AgentDetail({ state, name, refresh, notify }: Pick<PageProps, 'state' | 'refresh' | 'notify'> & { name: string }) {
  const cfg = state.agents.find((a) => a.name === name)!;
  const act: AgentActivity = agentActivity(state, cfg);
  const quotas = state.quotas.filter((q) => q.account === cfg.account);
  const m = state.metrics.find((x) => x.agent === name);
  const run = [...state.runs].reverse().find((r) => r.agent === name);
  const task = run && state.tasks.find((t) => t.id === run.taskId);
  const me = toAgents(state).find((a) => a.id === name);
  const accent = me?.accent ?? 'lilac';
  const stop = async () => {
    if (!task) return;
    try {
      notify((await api.command({ kind: 'stop', target: task.id })).text);
      refresh();
    } catch (err) {
      notify(`Failed: ${(err as Error).message}`);
    }
  };
  return (
    <PixelPanel variant="default" noPadding style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="md-panel-title" style={{ background: `var(--cth-${accent}-light)` }}>
        <span>{name.toUpperCase()}</span>
        <span className="md-row">
          <PixelBadge status={me?.status ?? 'idle'} />
          <button className="md-x" aria-label="Close" onClick={() => useStore.getState().select(null)}>
            <Icon name="x" />
          </button>
        </span>
      </div>
      <div className="md-detail">
        <div className="md-kv">
          <span>{cfg.adapter}</span>
          {cfg.model && <span>{cfg.model}</span>}
          <span>{cfg.account}</span>
          {cfg.node !== 'local' && <span>node {cfg.node}</span>}
          {m && (
            <span>
              {m.tasksDone} merged · {Math.round(m.successRate * 100)}% ok
            </span>
          )}
        </div>
        <div className="md-now">
          {act.taskId ? <a href={`#task/${act.taskId}`}>{act.taskId}</a> : null} {act.line}
        </div>
        {quotas.map((q) => (
          <div key={q.window} className="md-quota">
            <span>
              {q.window.replace('_', ' ')} {Math.round((q.utilization ?? 0) * 100)}%
            </span>
            <QuotaBar value={q.utilization ?? 0} />
          </div>
        ))}
        {task && (
          <div className="md-row">
            <PixelButton variant="secondary" size="sm" onClick={() => (window.location.hash = `task/${task.id}`)}>
              <Icon name="ledger" /> open {task.id}
            </PixelButton>
            {run?.state === 'running' && (
              <PixelButton variant="destructive" size="sm" onClick={() => void stop()}>
                <Icon name="pause" /> stop
              </PixelButton>
            )}
          </div>
        )}
      </div>
      <Session state={state} agent={name} />
    </PixelPanel>
  );
}

type Line = { seq: number; kind: string; text: string };

/** The agent's session, printed the way its CLI would. Read-only. */
function Session({ state, agent }: { state: HubState; agent: string }) {
  const run = [...state.runs].reverse().find((r) => r.agent === agent);
  const task = run && state.tasks.find((t) => t.id === run.taskId);
  const [lines, setLines] = useState<Line[]>([]);
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    if (!task) {
      setLines([]);
      return;
    }
    let alive = true;
    let timer: number | undefined;
    const load = () =>
      api.taskEvents(task.id).then(
        (events) => {
          if (!alive) return;
          const out: Line[] = [];
          for (const e of events) {
            if (e.runId && !state.runs.some((r) => r.id === e.runId && r.agent === agent)) continue;
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

  return (
    <div className="md-term">
      <div className="md-term-head">
        <span>
          <Icon name="terminal" /> {task ? `${task.id} · ${run?.mode.replace('_', ' ')}` : 'session'}
        </span>
        <span>{run ? (run.state === 'running' ? `live · ${ago(run.startedTs)}` : `ended ${ago(run.endedTs ?? run.lastEventTs)}`) : ''}</span>
      </div>
      <div
        className="md-term-body"
        ref={body}
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {!task && <div className="term-meta">No sessions yet.</div>}
        {task && !lines.length && <div className="term-meta">Waiting for output…</div>}
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
