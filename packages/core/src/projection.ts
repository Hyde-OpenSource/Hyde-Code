import type { HarnessEventRecord, TaskStatus } from './events.ts';

// Current state, derived only from the event log. `apply` is pure: replaying the same
// events always yields the same state.

export interface TaskView {
  id: string;
  projectId: string;
  title: string;
  spec: string;
  priority: number;
  createdSeq: number;
  status: TaskStatus;
  blockedBy?: { kind: 'question' | 'approval' | 'incident' | 'quota'; id: string };
  source: { kind: string; chatId?: string };
  agent?: string;
  branch?: string;
  worktree?: string;
  baseBranch?: string;
  sessionRef?: string;
  runIds: string[];
  attempts: number;
  completion?: { runId: string; summary: string; verified: string; filesChanged: string[] };
  checks?: { ok: boolean; seq: number; results: { command: string; ok: boolean; output: string }[] };
  prUrl?: string;
}

export interface RunView {
  id: string;
  taskId: string;
  attempt: number;
  adapter: string;
  account: string;
  mode: 'start' | 'continue' | 'answer' | 'fix';
  dispatchedSeq: number;
  state: 'running' | 'exited';
  sessionRef?: string;
  model?: string;
  lastEventSeq: number;
  lastEventTs: string;
  lastAction?: string;
  failure?: { reason: string; detail?: string };
  exit?: { code: number | null; signal: string | null };
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface QuestionView {
  id: string;
  taskId: string;
  runId: string;
  text: string;
  blocking: boolean;
  options: string[];
  status: 'open' | 'answered';
  answer?: string;
  answeredSeq?: number;
  answeredBy?: string;
}

export interface ApprovalView {
  id: string;
  taskId: string;
  kind: string;
  summary: string;
  status: 'open' | 'approved' | 'denied';
  decidedBy?: string;
}

export interface IncidentView {
  id: string;
  taskId?: string;
  about: string;
  evidence: string;
}

export interface QuotaView {
  account: string;
  window: string;
  status: 'allowed' | 'warning' | 'rejected';
  utilization?: number;
  resetsAt?: number;
}

export interface HarnessState {
  lastSeq: number;
  tasks: Map<string, TaskView>;
  runs: Map<string, RunView>;
  questions: Map<string, QuestionView>;
  approvals: Map<string, ApprovalView>;
  incidents: Map<string, IncidentView>;
  /** Keyed by `${account}:${window}`. */
  quotas: Map<string, QuotaView>;
}

export function emptyState(): HarnessState {
  return {
    lastSeq: 0,
    tasks: new Map(),
    runs: new Map(),
    questions: new Map(),
    approvals: new Map(),
    incidents: new Map(),
    quotas: new Map(),
  };
}

export function replay(records: Iterable<HarnessEventRecord>, state = emptyState()): HarnessState {
  for (const record of records) apply(state, record);
  return state;
}

export function apply(state: HarnessState, record: HarnessEventRecord): HarnessState {
  state.lastSeq = record.seq;
  switch (record.type) {
    case 'task.created': {
      const p = record.payload;
      state.tasks.set(p.taskId, {
        id: p.taskId,
        projectId: p.projectId,
        title: p.title,
        spec: p.spec,
        priority: p.priority,
        createdSeq: record.seq,
        status: 'backlog',
        source: p.source,
        runIds: [],
        attempts: 0,
      });
      break;
    }
    case 'task.status_changed': {
      const task = state.tasks.get(record.payload.taskId);
      if (!task) break;
      task.status = record.payload.to;
      if (record.payload.blockedBy) task.blockedBy = record.payload.blockedBy;
      else delete task.blockedBy;
      break;
    }
    case 'task.workspace_assigned': {
      const task = state.tasks.get(record.payload.taskId);
      if (!task) break;
      Object.assign(task, {
        agent: record.payload.agent,
        branch: record.payload.branch,
        worktree: record.payload.worktree,
        baseBranch: record.payload.baseBranch,
      });
      break;
    }
    case 'task.agent_completed': {
      const task = state.tasks.get(record.payload.taskId);
      if (!task) break;
      const { runId, summary, verified, filesChanged } = record.payload;
      task.completion = { runId, summary, verified, filesChanged };
      break;
    }
    case 'task.checks_finished': {
      const task = state.tasks.get(record.payload.taskId);
      if (task) task.checks = { ok: record.payload.ok, seq: record.seq, results: record.payload.results };
      break;
    }
    case 'task.pr_opened': {
      const task = state.tasks.get(record.payload.taskId);
      if (task) task.prUrl = record.payload.url;
      break;
    }
    case 'run.dispatched': {
      const p = record.payload;
      state.runs.set(p.runId, {
        id: p.runId,
        taskId: p.taskId,
        attempt: p.attempt,
        adapter: p.adapter,
        account: p.account,
        mode: p.mode,
        dispatchedSeq: record.seq,
        state: 'running',
        lastEventSeq: record.seq,
        lastEventTs: record.ts,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      });
      const task = state.tasks.get(p.taskId);
      if (task) {
        task.runIds.push(p.runId);
        if (p.mode === 'start') task.attempts += 1;
      }
      break;
    }
    case 'run.event': {
      const run = state.runs.get(record.payload.runId);
      if (!run) break;
      run.lastEventSeq = record.seq;
      run.lastEventTs = record.ts;
      const event = record.payload.event;
      switch (event.type) {
        case 'run.started': {
          run.sessionRef = event.sessionRef;
          run.model = event.model;
          const task = state.tasks.get(run.taskId);
          if (task) task.sessionRef = event.sessionRef;
          break;
        }
        case 'tool.started':
          run.lastAction = `${event.tool}: ${event.summary}`;
          break;
        case 'usage':
          run.inputTokens += event.inputTokens;
          run.outputTokens += event.outputTokens;
          run.costUsd += event.costUsd ?? 0;
          break;
        case 'run.failed':
          run.failure = { reason: event.reason, ...(event.detail && { detail: event.detail }) };
          break;
      }
      break;
    }
    case 'run.exited': {
      const run = state.runs.get(record.payload.runId);
      if (!run) break;
      run.state = 'exited';
      run.exit = { code: record.payload.code, signal: record.payload.signal };
      break;
    }
    case 'question.asked': {
      const p = record.payload;
      state.questions.set(p.questionId, {
        id: p.questionId,
        taskId: p.taskId,
        runId: p.runId,
        text: p.text,
        blocking: p.blocking,
        options: p.options,
        status: 'open',
      });
      break;
    }
    case 'question.answered': {
      const q = state.questions.get(record.payload.questionId);
      if (!q) break;
      q.status = 'answered';
      q.answer = record.payload.answer;
      q.answeredSeq = record.seq;
      q.answeredBy = record.payload.by;
      break;
    }
    case 'approval.requested': {
      const p = record.payload;
      state.approvals.set(p.approvalId, {
        id: p.approvalId,
        taskId: p.taskId,
        kind: p.kind,
        summary: p.summary,
        status: 'open',
      });
      break;
    }
    case 'approval.decided': {
      const a = state.approvals.get(record.payload.approvalId);
      if (!a) break;
      a.status = record.payload.approved ? 'approved' : 'denied';
      a.decidedBy = record.payload.by;
      break;
    }
    case 'incident.raised': {
      const p = record.payload;
      state.incidents.set(p.incidentId, {
        id: p.incidentId,
        ...(p.taskId && { taskId: p.taskId }),
        about: p.about,
        evidence: p.evidence,
      });
      break;
    }
    case 'quota.updated': {
      const p = record.payload;
      state.quotas.set(`${p.account}:${p.window}`, { ...p });
      break;
    }
  }
  return state;
}

/** Next human-friendly id with a prefix: T-1, Q-1, A-1, R-1, run-1. */
export function nextId(state: HarnessState, prefix: 'T' | 'Q' | 'A' | 'R' | 'run'): string {
  const map =
    prefix === 'T'
      ? state.tasks
      : prefix === 'Q'
        ? state.questions
        : prefix === 'A'
          ? state.approvals
          : prefix === 'R'
            ? state.incidents
            : state.runs;
  let max = 0;
  for (const id of map.keys()) {
    const n = Number(id.slice(prefix.length + 1));
    if (n > max) max = n;
  }
  return `${prefix}-${max + 1}`;
}
