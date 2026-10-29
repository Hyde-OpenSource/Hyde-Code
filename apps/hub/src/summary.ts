import { TERMINAL_STATUSES, type HarnessState, type TaskStatus } from '@hyde/core';
import { accountQuota, type AgentPool } from './agents.ts';
import type { HubConfig } from './config.ts';

// GET /api/summary: a small answer to "what's going on and what needs me", for voice and chat
// clients. /api/state returns the whole history; this stays the same size as work piles up.

export type NeedsYou =
  | { kind: 'question'; id: string; taskId: string; taskTitle: string; projectId: string; text: string; options: string[]; blocking: boolean }
  | { kind: 'approval'; id: string; taskId?: string; taskTitle?: string; projectId?: string; approvalKind: string; summary: string }
  | { kind: 'merge'; taskId: string; taskTitle: string; projectId: string; prUrl: string };

export interface AgentHeadroom {
  name: string;
  adapter: string;
  model?: string;
  usable: boolean;
  /** Highest utilization across the account's open windows, 0..1. */
  utilization: number;
  percent: number;
  /** At or above the hub's soft ceiling: new runs on this agent wait. */
  nearCeiling: boolean;
  /** A window is exhausted, e.g. "five_hour limit reached". */
  blocked?: string;
  /** When the fullest window resets (unix seconds), if known. */
  resetsAt?: number;
}

export interface Summary {
  lastSeq: number;
  counts: {
    tasks: Partial<Record<TaskStatus, number>>;
    active: number;
    runningRuns: number;
    questions: number;
    approvals: number;
    merges: number;
    needsYou: number;
  };
  needsYou: NeedsYou[];
  agents: AgentHeadroom[];
  quotaSoftCeiling: number;
}

export function buildSummary(state: HarnessState, config: HubConfig, pool: AgentPool, now: number, projectId?: string): Summary {
  const tasks = [...state.tasks.values()].filter((t) => !projectId || t.projectId === projectId);
  const live = new Map(tasks.filter((t) => !TERMINAL_STATUSES.includes(t.status)).map((t) => [t.id, t]));
  const byStatus: Partial<Record<TaskStatus, number>> = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;

  const questions: NeedsYou[] = [...state.questions.values()]
    .filter((q) => q.status === 'open' && live.has(q.taskId))
    .map((q) => {
      const t = live.get(q.taskId)!;
      return { kind: 'question', id: q.id, taskId: q.taskId, taskTitle: t.title, projectId: t.projectId, text: q.text, options: q.options ?? [], blocking: q.blocking };
    });
  const approvals: NeedsYou[] = [...state.approvals.values()]
    .filter((a) => a.status === 'open' && (a.taskId ? live.has(a.taskId) : !projectId))
    .map((a) => {
      const t = a.taskId ? live.get(a.taskId) : undefined;
      return { kind: 'approval', id: a.id, ...(t && { taskId: t.id, taskTitle: t.title, projectId: t.projectId }), approvalKind: a.kind, summary: a.summary };
    });
  const merges: NeedsYou[] = [...live.values()]
    .filter((t) => t.status === 'awaiting_merge' && t.prUrl && !t.children.length)
    .map((t) => ({ kind: 'merge', taskId: t.id, taskTitle: t.title, projectId: t.projectId, prUrl: t.prUrl! }));
  const needsYou = [...questions, ...approvals, ...merges];

  const agents = pool.profiles().map((p): AgentHeadroom => {
    const q = accountQuota(state, p.account, now);
    const fullest = [...state.quotas.values()]
      .filter((w) => w.account === p.account && !(w.resetsAt && w.resetsAt * 1000 < now))
      .sort((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0))[0];
    return {
      name: p.name,
      adapter: p.adapter,
      ...(p.model && { model: p.model }),
      usable: pool.usable(p.name),
      utilization: q.max,
      percent: Math.round(q.max * 100),
      nearCeiling: q.max >= config.quotaSoftCeiling,
      ...(q.blocked && { blocked: q.blocked }),
      ...(fullest?.resetsAt && { resetsAt: fullest.resetsAt }),
    };
  });

  return {
    lastSeq: state.lastSeq,
    counts: {
      tasks: byStatus,
      active: live.size,
      runningRuns: [...state.runs.values()].filter((r) => r.state === 'running' && (!projectId || live.has(r.taskId))).length,
      questions: questions.length,
      approvals: approvals.length,
      merges: merges.length,
      needsYou: needsYou.length,
    },
    needsYou,
    agents,
    quotaSoftCeiling: config.quotaSoftCeiling,
  };
}
