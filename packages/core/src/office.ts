import type { StateSnapshot } from './projection.ts';

// What each agent is doing, in words a person reads at a glance. Shared by the web office and the
// terminal UI so both show the same thing. Pure: no Node or browser APIs.

export type Mood = 'off' | 'broken' | 'needs-you' | 'working' | 'planning' | 'reviewing' | 'idle';
/** Where the agent stands in the office. */
export type Spot = 'desk' | 'whiteboard' | 'review' | 'coffee' | 'away';

export interface OfficeAgent {
  name: string;
  enabled: boolean;
  health: { installed: boolean; signedIn: boolean; problem?: string } | null;
}

export interface AgentActivity {
  name: string;
  mood: Mood;
  spot: Spot;
  /** Short line for a speech bubble or a table cell. */
  line: string;
  taskId?: string;
  taskTitle?: string;
  runId?: string;
  mode?: string;
  startedTs?: string;
}

type State = Pick<StateSnapshot, 'tasks' | 'runs' | 'questions' | 'approvals' | 'lessons'>;

const TERMINAL = ['done', 'cancelled'];

export function agentActivity(state: State, agent: OfficeAgent): AgentActivity {
  const base = { name: agent.name };
  if (!agent.enabled) return { ...base, mood: 'off', spot: 'away', line: 'Off today' };
  if (agent.health && (!agent.health.installed || !agent.health.signedIn)) {
    return { ...base, mood: 'broken', spot: 'desk', line: agent.health.problem ?? (agent.health.installed ? 'Not signed in' : 'Not installed') };
  }
  const run = [...state.runs].reverse().find((r) => r.agent === agent.name && r.state === 'running');
  const task = run ? state.tasks.find((t) => t.id === run.taskId) : undefined;
  if (run && task) {
    const info = { taskId: task.id, taskTitle: task.title, runId: run.id, mode: run.mode, startedTs: run.startedTs };
    const waiting = state.questions.some((q) => q.taskId === task.id && q.status === 'open' && q.blocking);
    if (waiting) return { ...base, ...info, mood: 'needs-you', spot: 'desk', line: `Waiting for your answer on ${task.id}` };
    if (run.mode === 'plan') return { ...base, ...info, mood: 'planning', spot: 'whiteboard', line: `Planning ${task.id}` };
    if (run.mode === 'review') return { ...base, ...info, mood: 'reviewing', spot: 'review', line: `Reviewing ${task.id}` };
    return { ...base, ...info, mood: 'working', spot: 'desk', line: run.lastAction ?? `Starting ${task.id}` };
  }
  // Idle, but an open question or approval on a task it owns still needs the owner.
  const owned = state.tasks.find((t) => t.agent === agent.name && !TERMINAL.includes(t.status) && t.status === 'blocked');
  if (owned) return { ...base, mood: 'needs-you', spot: 'desk', taskId: owned.id, taskTitle: owned.title, line: `${owned.id} is waiting on you` };
  return { ...base, mood: 'idle', spot: 'coffee', line: 'Free for work' };
}

/** Open questions, approvals and lessons whose task is still in play. */
export function openItems(state: State) {
  const live = (taskId: string | undefined) => !taskId || !TERMINAL.includes(state.tasks.find((t) => t.id === taskId)?.status ?? 'done');
  return {
    questions: state.questions.filter((q) => q.status === 'open' && live(q.taskId)),
    approvals: state.approvals.filter((a) => a.status === 'open' && live(a.taskId)),
    lessons: state.lessons.filter((l) => l.status === 'proposed'),
  };
}

export function openCount(state: State): number {
  const o = openItems(state);
  return o.questions.length + o.approvals.length + o.lessons.length;
}

export interface FeedEvent {
  seq: number;
  ts: string;
  type: string;
  actor: { kind: string; id: string };
  taskId?: string;
  runId?: string;
  payload?: any;
}

/** One line for the activity feed, or null for events too small to show (text deltas, pings). */
export function describeEvent(e: FeedEvent): string | null {
  const p = e.payload ?? {};
  const t = p.taskId ?? e.taskId ?? '';
  switch (e.type) {
    case 'task.created':
      return `${t} created: ${p.title}`;
    case 'task.planned':
      return p.children?.length > 1 ? `${t} split into ${p.children.length} tasks` : `${t} planned`;
    case 'run.dispatched':
      return `${p.agent} picked up ${t} (${String(p.mode).replace('_', ' ')})`;
    case 'question.asked':
      return `${t} asks: ${p.text}`;
    case 'question.answered':
      return `${p.questionId} answered by ${p.by}`;
    case 'approval.requested':
      return `${t} needs approval: ${p.summary}`;
    case 'approval.decided':
      return `${p.approvalId} ${p.approved ? 'approved' : 'denied'} by ${p.by}`;
    case 'task.checks_finished':
      return `${t} checks ${p.ok ? 'passed' : 'failed'}`;
    case 'task.browser_checked':
      return `${t} browser check ${p.ok ? 'passed' : 'failed'}`;
    case 'task.review_finished':
      return `${p.reviewer} ${p.verdict === 'approve' ? 'approved' : 'asked for changes on'} ${t}`;
    case 'task.pr_opened':
      return `${t} opened a pull request`;
    case 'task.merged':
      return `${t} merged into ${p.into}`;
    case 'task.status_changed':
      return ['done', 'failed', 'blocked'].includes(p.to) ? `${t} is ${p.to}${p.reason ? `: ${p.reason}` : ''}` : null;
    case 'incident.raised':
      return `Incident${t ? ` on ${t}` : ''}: ${p.about}`;
    case 'lesson.proposed':
      return `${p.by} proposes a lesson: ${p.text}`;
    case 'agent.progress':
      return `${t}: ${p.message}`;
    case 'node.connected':
      return `Worker ${p.nodeId} connected from ${p.host}`;
    case 'node.disconnected':
      return `Worker ${p.nodeId} disconnected`;
    case 'run.event': {
      const ev = p.event ?? {};
      if (ev.type === 'run.failed') return `Run ${p.runId} failed: ${ev.reason}`;
      return null;
    }
    default:
      return null;
  }
}

/** Worktree paths are long and the same for every line of a task: show them relative. */
export function shortPaths(text: string): string {
  // Paths may contain spaces (the repo lives in "HYDE CODE"), so match up to the worktree marker.
  return text.replace(/(^|[\s"'=])["']?\/[^"'\n]*?\/\.hyde\/worktrees\/[^/\s"']+\/[^/\s"']+["']?(?=\/|[\s"']|$)/g, '$1.');
}

/** One terminal line for a run's own event, as the agent's session would print it. */
export function sessionLine(e: FeedEvent): { kind: 'tool' | 'text' | 'ok' | 'bad' | 'meta'; text: string } | null {
  const line = rawSessionLine(e);
  return line && { ...line, text: shortPaths(line.text) };
}

function rawSessionLine(e: FeedEvent): { kind: 'tool' | 'text' | 'ok' | 'bad' | 'meta'; text: string } | null {
  if (e.type === 'run.dispatched') return { kind: 'meta', text: `$ ${e.payload?.adapter} · ${e.payload?.mode} · attempt ${e.payload?.attempt}` };
  if (e.type === 'agent.progress') return { kind: 'meta', text: `» ${e.payload?.message}` };
  if (e.type !== 'run.event') return null;
  const ev = e.payload?.event ?? {};
  switch (ev.type) {
    case 'run.started':
      return { kind: 'meta', text: `session ${String(ev.sessionRef).slice(0, 12)} · ${ev.model}` };
    case 'text.delta':
      return ev.text?.trim() ? { kind: 'text', text: ev.text.trim() } : null;
    case 'tool.started':
      return { kind: 'tool', text: `▸ ${ev.tool} ${ev.summary ?? ''}`.trim() };
    case 'file.changed':
      return { kind: 'tool', text: `✎ ${ev.path}` };
    case 'question.asked':
      return { kind: 'meta', text: `? ${ev.text}` };
    case 'run.completed':
      return { kind: 'ok', text: `✓ ${ev.summary}` };
    case 'run.failed':
      return { kind: 'bad', text: `✗ ${ev.reason}${ev.detail ? `: ${ev.detail}` : ''}` };
    default:
      return null;
  }
}
