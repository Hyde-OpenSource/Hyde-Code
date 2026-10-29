import { useEffect } from 'react';
import { agentActivity, openCount, shortPaths } from '@hyde/core/office';
import { onHubEvent, type HubState } from '../api.ts';
import type { AccentColorName } from '@/design/tokens';
import type { MessageAct } from '@/scene/office/MessageEnvelope';
import { WORKER_CAST, type OfficeCharacterName } from '@/scene/office/cast';
import { useStore, type Agent } from '@/store/store';

// Hyde hub state → the shapes the ported Munder Difflin office expects.
// Hyde (the hub) is the office's "god" agent; every configured agent is a worker.

export const GOD_ID = 'hyde';
let latest: HubState | null = null;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const VENDOR_ACCENT: Record<string, AccentColorName> = { anthropic: 'peach', openai: 'mint', google: 'sky' };

/** A stable look per agent name, spread across the cast. */
export function characterFor(name: string, taken: Set<string>): OfficeCharacterName {
  const start = hash(name) % WORKER_CAST.length;
  for (let i = 0; i < WORKER_CAST.length; i++) {
    const c = WORKER_CAST[(start + i) % WORKER_CAST.length]!;
    if (!taken.has(c)) return c;
  }
  return WORKER_CAST[start]!;
}

/** Recently finished (last 90 s) counts as "done" so the agent cheers once. */
const SUCCESS_MS = 90_000;

export function toAgents(s: HubState): Agent[] {
  const taken = new Set<string>();
  const workers: Agent[] = [];
  for (const a of s.agents) {
    const act = agentActivity(s, a);
    if (act.mood === 'off') continue;
    const character = characterFor(a.name, taken);
    taken.add(character);
    const run = [...s.runs].reverse().find((r) => r.agent === a.name);
    const task = act.taskId ? s.tasks.find((t) => t.id === act.taskId) : undefined;
    let status: Agent['status'] =
      act.mood === 'working' ? 'working' : act.mood === 'planning' || act.mood === 'reviewing' ? 'thinking' : act.mood === 'needs-you' ? 'blocked' : act.mood === 'broken' ? 'ghost' : 'idle';
    if (status === 'idle' && run?.state === 'exited' && !run.failure && run.endedTs && Date.now() - Date.parse(run.endedTs) < SUCCESS_MS) status = 'success';
    const action = act.mood === 'working' || act.mood === 'planning' || act.mood === 'reviewing' ? (run?.lastAction ?? act.line) : act.mood === 'broken' ? act.line : undefined;
    workers.push({
      id: a.name,
      name: a.name,
      status,
      action: action ? shortPaths(action).replace(/\s+/g, ' ').slice(0, 80) : undefined,
      lastPrompt: task ? `${task.id} ${task.title}` : undefined,
      carrying: action?.split(' ')[0],
      character,
      accent: VENDOR_ACCENT[a.vendor] ?? 'lilac',
    });
  }
  const waiting = openCount(s) + s.tasks.filter((t) => t.status === 'awaiting_merge' && t.prUrl && !t.children.length).length;
  const planning = s.tasks.some((t) => t.status === 'clarifying');
  const god: Agent = {
    id: GOD_ID,
    name: 'Hyde',
    isGod: true,
    character: 'boss',
    accent: 'lemon',
    status: waiting ? 'blocked' : planning ? 'thinking' : 'idle',
    action: waiting ? `${waiting} waiting for you` : planning ? 'planning a task' : undefined,
  };
  return [god, ...workers];
}

function sameAgents(a: Agent[], b: Agent[]): boolean {
  return a.length === b.length && a.every((x, i) => JSON.stringify(x) === JSON.stringify(b[i]));
}

/** Keeps the office store in step with the hub. */
export function useOfficeBridge(state: HubState): void {
  useEffect(() => {
    latest = state;
    const next = toAgents(state);
    const st = useStore.getState();
    if (!sameAgents(st.agents, next)) useStore.setState({ agents: next });
    // `success` must fall back to idle after a while even without new events.
    const t = window.setTimeout(() => {
      if (latest) {
        const again = toAgents(latest);
        if (!sameAgents(useStore.getState().agents, again)) useStore.setState({ agents: again });
      }
    }, SUCCESS_MS + 1000);
    return () => window.clearTimeout(t);
  }, [state]);
}

type BoardStatus = 'todo' | 'doing' | 'blocked' | 'done';

export function boardStatus(status: string): BoardStatus | null {
  if (['backlog', 'clarifying', 'ready'].includes(status)) return 'todo';
  if (['running', 'verifying', 'review', 'awaiting_merge'].includes(status)) return 'doing';
  if (['blocked', 'failed'].includes(status)) return 'blocked';
  if (status === 'done') return 'done';
  return null;
}

export interface HiveMessage {
  from: string;
  targets: string[];
  act: MessageAct;
  needsHuman: boolean;
}

/** Stand-in for Munder Difflin's preload bridge (`window.cth`). */
export const cth = {
  async hiveTasks() {
    const s = latest;
    if (!s) return { tasks: [] };
    const tasks = s.tasks
      .filter((t) => !t.children.length)
      .map((t) => ({ id: t.id, status: boardStatus(t.status), assignee: t.agent }))
      .filter((t) => t.status);
    return { tasks };
  },
  /** Open questions, approvals, merges and lessons: the ASK ME board's notes. */
  askCount(): number {
    const s = latest;
    if (!s) return 0;
    return openCount(s) + s.tasks.filter((t) => t.status === 'awaiting_merge' && t.prUrl && !t.children.length).length;
  },
  onHiveMessage(cb: (m: HiveMessage) => void): () => void {
    return onHubEvent((e) => {
      const s = latest;
      const p = e.payload ?? {};
      const owner = (taskId?: string) => (taskId && s?.tasks.find((t) => t.id === taskId)?.agent) || GOD_ID;
      switch (e.type) {
        case 'run.dispatched':
          return cb({ from: GOD_ID, targets: [p.agent], act: 'request', needsHuman: false });
        case 'question.asked':
          return cb({ from: owner(p.taskId), targets: ['human'], act: 'query', needsHuman: true });
        case 'approval.requested':
          return cb({ from: owner(p.taskId), targets: ['human'], act: 'propose', needsHuman: true });
        case 'question.answered':
          return cb({ from: 'human', targets: [GOD_ID], act: 'inform', needsHuman: false });
        case 'approval.decided':
          return cb({ from: 'human', targets: [GOD_ID], act: p.approved ? 'agree' : 'refuse', needsHuman: false });
        case 'task.review_finished':
          return cb({ from: p.reviewer, targets: [owner(p.taskId)], act: p.verdict === 'approve' ? 'agree' : 'refuse', needsHuman: false });
        case 'task.agent_completed':
          return cb({ from: owner(p.taskId), targets: [GOD_ID], act: 'done', needsHuman: false });
        case 'task.pr_opened':
          return cb({ from: GOD_ID, targets: ['human'], act: 'done', needsHuman: false });
      }
    });
  },
};
