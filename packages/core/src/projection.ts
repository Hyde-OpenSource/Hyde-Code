import type { ApprovalKind, HarnessEventRecord, ReviewFinding, RunMode, SourceKind, TaskStatus } from './events.ts';

// Current state, derived only from the event log. `apply` is pure: replaying the same
// events always yields the same state.

export interface TaskView {
  id: string;
  projectId: string;
  title: string;
  spec: string;
  priority: number;
  kind: 'task' | 'client';
  createdSeq: number;
  createdTs: string;
  status: TaskStatus;
  blockedBy?: { kind: 'question' | 'approval' | 'incident' | 'quota'; id: string };
  source: { kind: SourceKind; chatId?: string };
  parentId?: string;
  children: string[];
  planned: boolean;
  doneWhen?: string;
  writeScope: string[];
  role?: string;
  dependsOn: string[];
  size?: 'S' | 'M' | 'L';
  /** Agent profile pinned at creation (optional). */
  pinnedAgent?: string;
  /** Agent profile that owns the worktree. */
  agent?: string;
  node?: string;
  branch?: string;
  worktree?: string;
  baseBranch?: string;
  sessionRef?: string;
  runIds: string[];
  attempts: number;
  completion?: { runId: string; seq: number; summary: string; verified: string; filesChanged: string[]; followUps?: string };
  checks?: { ok: boolean; seq: number; results: { command: string; ok: boolean; output: string }[] };
  browser?: { ok: boolean; seq: number; url: string; errors: string[]; artifactIds: string[] };
  reviews: { runId: string; seq: number; reviewer: string; verdict: 'approve' | 'changes'; summary: string; findings: ReviewFinding[] }[];
  prUrl?: string;
  merged?: { into: string; sha?: string };
  clientReply?: string;
  artifactIds: string[];
  statusHistory: { seq: number; ts: string; from: TaskStatus; to: TaskStatus; reason?: string }[];
}

export interface RunView {
  id: string;
  taskId: string;
  attempt: number;
  adapter: string;
  account: string;
  agent: string;
  node: string;
  mode: RunMode;
  dispatchedSeq: number;
  startedTs: string;
  state: 'running' | 'exited';
  sessionRef?: string;
  model?: string;
  lastEventSeq: number;
  lastEventTs: string;
  lastAction?: string;
  lastText?: string;
  summary?: string;
  structured?: unknown;
  failure?: { reason: string; detail?: string };
  exit?: { code: number | null; signal: string | null };
  endedTs?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  toolCalls: number;
  filesChanged: string[];
}

export interface QuestionView {
  id: string;
  taskId: string;
  runId: string;
  text: string;
  blocking: boolean;
  options: string[];
  status: 'open' | 'answered';
  askedTs: string;
  answer?: string;
  answeredSeq?: number;
  answeredBy?: string;
}

export interface ApprovalView {
  id: string;
  taskId: string;
  kind: ApprovalKind;
  summary: string;
  data?: Record<string, unknown>;
  status: 'open' | 'approved' | 'denied';
  requestedTs: string;
  decidedSeq?: number;
  decidedBy?: string;
}

export interface IncidentView {
  id: string;
  taskId?: string;
  about: string;
  evidence: string;
  ts: string;
}

export interface QuotaView {
  account: string;
  window: string;
  status: 'allowed' | 'warning' | 'rejected';
  utilization?: number;
  resetsAt?: number;
  ts: string;
}

export interface ArtifactView {
  id: string;
  taskId: string;
  runId?: string;
  kind: string;
  path: string;
  label?: string;
}

export interface LessonView {
  id: string;
  taskId?: string;
  text: string;
  by: string;
  status: 'proposed' | 'approved' | 'rejected';
  /** Task branch the lesson was committed on (CLAUDE.md and AGENTS.md). */
  writtenIn?: string;
}

export interface NodeView {
  id: string;
  owner: string;
  host: string;
  online: boolean;
  clis: { kind: string; installed: boolean; version?: string; signedIn: boolean }[];
  lastSeen: string;
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
  artifacts: Map<string, ArtifactView>;
  lessons: Map<string, LessonView>;
  nodes: Map<string, NodeView>;
  policy: { allow: number; deny: number; approval: number };
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
    artifacts: new Map(),
    lessons: new Map(),
    nodes: new Map(),
    policy: { allow: 0, deny: 0, approval: 0 },
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
        kind: p.kind,
        createdSeq: record.seq,
        createdTs: record.ts,
        status: 'backlog',
        source: p.source,
        children: [],
        planned: false,
        writeScope: p.writeScope,
        dependsOn: p.dependsOn,
        runIds: [],
        attempts: 0,
        reviews: [],
        artifactIds: [],
        statusHistory: [],
        ...(p.parentId && { parentId: p.parentId }),
        ...(p.doneWhen && { doneWhen: p.doneWhen }),
        ...(p.role && { role: p.role }),
        ...(p.size && { size: p.size }),
        ...(p.agent && { pinnedAgent: p.agent }),
      });
      if (p.parentId) state.tasks.get(p.parentId)?.children.push(p.taskId);
      break;
    }
    case 'task.status_changed': {
      const task = state.tasks.get(record.payload.taskId);
      if (!task) break;
      const { from, to, reason } = record.payload;
      task.status = to;
      task.statusHistory.push({ seq: record.seq, ts: record.ts, from, to, ...(reason && { reason }) });
      if (record.payload.blockedBy) task.blockedBy = record.payload.blockedBy;
      else delete task.blockedBy;
      break;
    }
    case 'task.planned': {
      const task = state.tasks.get(record.payload.taskId);
      if (!task) break;
      const p = record.payload;
      task.planned = true;
      if (p.doneWhen) task.doneWhen = p.doneWhen;
      if (p.writeScope.length) task.writeScope = p.writeScope;
      if (p.role) task.role = p.role;
      if (p.size) task.size = p.size;
      break;
    }
    case 'task.workspace_assigned': {
      const task = state.tasks.get(record.payload.taskId);
      if (!task) break;
      const p = record.payload;
      Object.assign(task, { agent: p.agent, branch: p.branch, worktree: p.worktree, baseBranch: p.baseBranch, node: p.node });
      break;
    }
    case 'task.agent_completed': {
      const task = state.tasks.get(record.payload.taskId);
      if (!task) break;
      const { runId, summary, verified, filesChanged, followUps } = record.payload;
      task.completion = { runId, seq: record.seq, summary, verified, filesChanged, ...(followUps && { followUps }) };
      break;
    }
    case 'task.checks_finished': {
      const task = state.tasks.get(record.payload.taskId);
      if (task) task.checks = { ok: record.payload.ok, seq: record.seq, results: record.payload.results };
      break;
    }
    case 'task.browser_checked': {
      const task = state.tasks.get(record.payload.taskId);
      if (!task) break;
      const { ok, url, errors, artifactIds } = record.payload;
      task.browser = { ok, seq: record.seq, url, errors, artifactIds };
      break;
    }
    case 'task.review_finished': {
      const task = state.tasks.get(record.payload.taskId);
      if (!task) break;
      const { runId, reviewer, verdict, summary, findings } = record.payload;
      task.reviews.push({ runId, seq: record.seq, reviewer, verdict, summary, findings });
      break;
    }
    case 'task.pr_opened': {
      const task = state.tasks.get(record.payload.taskId);
      if (task) task.prUrl = record.payload.url;
      break;
    }
    case 'task.merged': {
      const task = state.tasks.get(record.payload.taskId);
      if (task) task.merged = { into: record.payload.into, ...(record.payload.sha && { sha: record.payload.sha }) };
      break;
    }
    case 'task.client_reply_drafted': {
      const task = state.tasks.get(record.payload.taskId);
      if (task) task.clientReply = record.payload.draft;
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
        agent: p.agent,
        node: p.node,
        mode: p.mode,
        dispatchedSeq: record.seq,
        startedTs: record.ts,
        state: 'running',
        lastEventSeq: record.seq,
        lastEventTs: record.ts,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        toolCalls: 0,
        filesChanged: [],
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
          // Planner and reviewer sessions are separate from the author's session.
          if (task && !['plan', 'review'].includes(run.mode)) task.sessionRef = event.sessionRef;
          break;
        }
        case 'text.delta':
          run.lastText = event.text;
          break;
        case 'tool.started':
          run.toolCalls += 1;
          run.lastAction = `${event.tool}: ${event.summary}`;
          break;
        case 'file.changed':
          if (!run.filesChanged.includes(event.path)) run.filesChanged.push(event.path);
          break;
        case 'usage':
          run.inputTokens += event.inputTokens;
          run.outputTokens += event.outputTokens;
          run.costUsd += event.costUsd ?? 0;
          break;
        case 'run.completed':
          run.summary = event.summary;
          if (event.structured !== undefined) run.structured = event.structured;
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
      run.endedTs = record.ts;
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
        askedTs: record.ts,
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
        requestedTs: record.ts,
        ...(p.data && { data: p.data }),
      });
      break;
    }
    case 'approval.decided': {
      const a = state.approvals.get(record.payload.approvalId);
      if (!a) break;
      a.status = record.payload.approved ? 'approved' : 'denied';
      a.decidedSeq = record.seq;
      a.decidedBy = record.payload.by;
      break;
    }
    case 'incident.raised': {
      const p = record.payload;
      state.incidents.set(p.incidentId, {
        id: p.incidentId,
        about: p.about,
        evidence: p.evidence,
        ts: record.ts,
        ...(p.taskId && { taskId: p.taskId }),
      });
      break;
    }
    case 'quota.updated': {
      const p = record.payload;
      state.quotas.set(`${p.account}:${p.window}`, { ...p, ts: record.ts });
      break;
    }
    case 'artifact.saved': {
      const p = record.payload;
      state.artifacts.set(p.artifactId, {
        id: p.artifactId,
        taskId: p.taskId,
        kind: p.kind,
        path: p.path,
        ...(p.runId && { runId: p.runId }),
        ...(p.label && { label: p.label }),
      });
      state.tasks.get(p.taskId)?.artifactIds.push(p.artifactId);
      break;
    }
    case 'policy.decided':
      state.policy[record.payload.decision] += 1;
      break;
    case 'lesson.proposed': {
      const p = record.payload;
      state.lessons.set(p.lessonId, {
        id: p.lessonId,
        text: p.text,
        by: p.by,
        status: 'proposed',
        ...(p.taskId && { taskId: p.taskId }),
      });
      break;
    }
    case 'lesson.decided': {
      const l = state.lessons.get(record.payload.lessonId);
      if (l) l.status = record.payload.approved ? 'approved' : 'rejected';
      break;
    }
    case 'lesson.written': {
      const l = state.lessons.get(record.payload.lessonId);
      if (l) l.writtenIn = record.payload.taskId;
      break;
    }
    case 'node.connected': {
      const p = record.payload;
      state.nodes.set(p.nodeId, { id: p.nodeId, owner: p.owner, host: p.host, clis: p.clis, online: true, lastSeen: record.ts });
      break;
    }
    case 'node.disconnected': {
      const n = state.nodes.get(record.payload.nodeId);
      if (n) {
        n.online = false;
        n.lastSeen = record.ts;
      }
      break;
    }
  }
  return state;
}

const ID_MAPS = {
  T: 'tasks',
  Q: 'questions',
  A: 'approvals',
  R: 'incidents',
  run: 'runs',
  art: 'artifacts',
  L: 'lessons',
} as const;

/** Next human-friendly id with a prefix: T-1, Q-1, A-1, R-1, run-1, art-1, L-1. */
export function nextId(state: HarnessState, prefix: keyof typeof ID_MAPS): string {
  const map = state[ID_MAPS[prefix]] as Map<string, unknown>;
  let max = 0;
  for (const id of map.keys()) {
    const n = Number(id.slice(prefix.length + 1));
    if (n > max) max = n;
  }
  return `${prefix}-${max + 1}`;
}

/** Serializable snapshot of the state for the dashboard and the API. */
export function snapshot(state: HarnessState) {
  return {
    lastSeq: state.lastSeq,
    tasks: [...state.tasks.values()],
    runs: [...state.runs.values()],
    questions: [...state.questions.values()],
    approvals: [...state.approvals.values()],
    incidents: [...state.incidents.values()],
    quotas: [...state.quotas.values()],
    artifacts: [...state.artifacts.values()],
    lessons: [...state.lessons.values()],
    nodes: [...state.nodes.values()],
    policy: state.policy,
  };
}
export type StateSnapshot = ReturnType<typeof snapshot>;
