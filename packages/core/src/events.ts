import { z } from 'zod';

// Every state change in the harness is one of these events. Current state is a fold over
// the log (see projection.ts), so a crash or restart is recovered by replaying it.

export const TASK_STATUSES = [
  'backlog',
  'clarifying',
  'ready',
  'running',
  'verifying',
  'review',
  'awaiting_merge',
  'done',
  'blocked',
  'failed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

const harnessEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run.started'), sessionRef: z.string(), model: z.string() }),
  z.object({ type: z.literal('text.delta'), text: z.string() }),
  z.object({ type: z.enum(['tool.started', 'tool.finished']), tool: z.string(), summary: z.string() }),
  z.object({ type: z.literal('file.changed'), path: z.string() }),
  z.object({ type: z.literal('permission.requested'), requestId: z.string(), action: z.string() }),
  z.object({ type: z.literal('question.asked'), questionId: z.string(), text: z.string(), blocking: z.boolean() }),
  z.object({
    type: z.literal('rate_limit'),
    status: z.enum(['allowed', 'warning', 'rejected']),
    window: z.string(),
    resetsAt: z.number().optional(),
    utilization: z.number().optional(),
  }),
  z.object({
    type: z.literal('usage'),
    inputTokens: z.number(),
    outputTokens: z.number(),
    costUsd: z.number().optional(),
  }),
  z.object({ type: z.literal('run.completed'), summary: z.string(), structured: z.unknown().optional() }),
  z.object({
    type: z.literal('run.failed'),
    reason: z.enum(['auth', 'rate_limit', 'stalled', 'crashed', 'cancelled']),
    detail: z.string().optional(),
  }),
]);

export const SOURCE_KINDS = ['telegram', 'slack', 'discord', 'whatsapp', 'web', 'cli', 'api', 'schedule', 'planner'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
const source = z.object({ kind: z.enum(SOURCE_KINDS), chatId: z.string().optional() });

export const RUN_MODES = ['start', 'continue', 'answer', 'fix', 'plan', 'review', 'review_fix', 'conflict', 'browser_fix'] as const;
export type RunMode = (typeof RUN_MODES)[number];

export const APPROVAL_KINDS = ['first-push', 'merge', 'promote', 'plan', 'destructive', 'new-dependency', 'scope-change', 'client-intake'] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

const finding = z.object({
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  file: z.string().optional(),
  line: z.number().int().optional(),
  text: z.string(),
});
export type ReviewFinding = z.output<typeof finding>;

export const eventPayloads = {
  'task.created': z.object({
    taskId: z.string(),
    projectId: z.string(),
    title: z.string(),
    spec: z.string(),
    priority: z.number().int().default(2),
    source,
    /** 'client' marks text from a client: data to work from, never instructions. */
    kind: z.enum(['task', 'client']).default('task'),
    parentId: z.string().optional(),
    doneWhen: z.string().optional(),
    writeScope: z.array(z.string()).default([]),
    role: z.string().optional(),
    dependsOn: z.array(z.string()).default([]),
    size: z.enum(['S', 'M', 'L']).optional(),
    /** Pin to one agent profile by name; otherwise the router picks. */
    agent: z.string().optional(),
  }),
  'task.status_changed': z.object({
    taskId: z.string(),
    from: z.enum(TASK_STATUSES),
    to: z.enum(TASK_STATUSES),
    reason: z.string().optional(),
    blockedBy: z.object({ kind: z.enum(['question', 'approval', 'incident', 'quota']), id: z.string() }).optional(),
  }),
  'task.planned': z.object({
    taskId: z.string(),
    runId: z.string(),
    children: z.array(z.string()),
    /** Set when the plan kept the task whole (one subtask): its fields are merged into the task. */
    doneWhen: z.string().optional(),
    writeScope: z.array(z.string()).default([]),
    role: z.string().optional(),
    size: z.enum(['S', 'M', 'L']).optional(),
  }),
  'task.workspace_assigned': z.object({
    taskId: z.string(),
    agent: z.string(),
    branch: z.string(),
    worktree: z.string(),
    baseBranch: z.string(),
    node: z.string().default('local'),
  }),
  'task.agent_completed': z.object({
    taskId: z.string(),
    runId: z.string(),
    summary: z.string(),
    verified: z.string(),
    filesChanged: z.array(z.string()).default([]),
    followUps: z.string().optional(),
  }),
  'task.checks_finished': z.object({
    taskId: z.string(),
    ok: z.boolean(),
    results: z.array(z.object({ command: z.string(), ok: z.boolean(), output: z.string() })),
  }),
  'task.browser_checked': z.object({
    taskId: z.string(),
    ok: z.boolean(),
    url: z.string(),
    errors: z.array(z.string()).default([]),
    artifactIds: z.array(z.string()).default([]),
  }),
  'task.review_finished': z.object({
    taskId: z.string(),
    runId: z.string(),
    reviewer: z.string(),
    verdict: z.enum(['approve', 'changes']),
    summary: z.string(),
    findings: z.array(finding).default([]),
  }),
  'task.pr_opened': z.object({ taskId: z.string(), url: z.string() }),
  'task.merged': z.object({ taskId: z.string(), into: z.string(), sha: z.string().optional() }),
  'task.client_reply_drafted': z.object({ taskId: z.string(), draft: z.string() }),
  'agent.progress': z.object({ taskId: z.string(), runId: z.string(), message: z.string() }),
  'run.dispatched': z.object({
    runId: z.string(),
    taskId: z.string(),
    attempt: z.number().int(),
    adapter: z.string(),
    account: z.string(),
    agent: z.string().default('claude-1'),
    node: z.string().default('local'),
    mode: z.enum(RUN_MODES),
  }),
  'run.event': z.object({ runId: z.string(), event: harnessEvent }),
  'run.exited': z.object({ runId: z.string(), code: z.number().nullable(), signal: z.string().nullable() }),
  'question.asked': z.object({
    questionId: z.string(),
    taskId: z.string(),
    runId: z.string(),
    text: z.string(),
    blocking: z.boolean(),
    options: z.array(z.string()).default([]),
  }),
  'question.answered': z.object({ questionId: z.string(), answer: z.string(), by: z.string() }),
  'approval.requested': z.object({
    approvalId: z.string(),
    taskId: z.string(),
    kind: z.enum(APPROVAL_KINDS),
    summary: z.string(),
    /** Machine-readable details, e.g. the policy rule and command that needed approval. */
    data: z.record(z.string(), z.unknown()).optional(),
  }),
  'approval.decided': z.object({ approvalId: z.string(), approved: z.boolean(), by: z.string() }),
  'incident.raised': z.object({
    incidentId: z.string(),
    taskId: z.string().optional(),
    about: z.string(),
    evidence: z.string(),
  }),
  'quota.updated': z.object({
    account: z.string(),
    window: z.string(),
    status: z.enum(['allowed', 'warning', 'rejected']),
    utilization: z.number().optional(),
    resetsAt: z.number().optional(),
  }),
  'artifact.saved': z.object({
    artifactId: z.string(),
    taskId: z.string(),
    runId: z.string().optional(),
    kind: z.enum(['screenshot', 'video', 'diff', 'test-report', 'log']),
    path: z.string(),
    label: z.string().optional(),
  }),
  'policy.decided': z.object({
    runId: z.string(),
    tool: z.string(),
    input: z.string(),
    decision: z.enum(['allow', 'deny', 'approval']),
    rule: z.string(),
  }),
  'lesson.proposed': z.object({ lessonId: z.string(), taskId: z.string().optional(), text: z.string(), by: z.string() }),
  'lesson.decided': z.object({ lessonId: z.string(), approved: z.boolean(), by: z.string() }),
  'lesson.written': z.object({ lessonId: z.string(), taskId: z.string() }),
  'node.connected': z.object({
    nodeId: z.string(),
    owner: z.string(),
    host: z.string(),
    clis: z.array(z.object({ kind: z.string(), installed: z.boolean(), version: z.string().optional(), signedIn: z.boolean() })),
  }),
  'node.disconnected': z.object({ nodeId: z.string() }),
} as const;

export type EventType = keyof typeof eventPayloads;
export type EventPayload<T extends EventType> = z.output<(typeof eventPayloads)[T]>;
export type EventPayloadInput<T extends EventType> = z.input<(typeof eventPayloads)[T]>;

export type Actor = { kind: 'user' | 'agent' | 'harness'; id: string };

export type HarnessEventRecord<T extends EventType = EventType> = {
  [K in T]: {
    seq: number;
    ts: string;
    type: K;
    actor: Actor;
    projectId?: string;
    taskId?: string;
    runId?: string;
    /** Dedupes retried commands (e.g. a chat message delivered twice). */
    commandId?: string;
    payload: EventPayload<K>;
  };
}[T];

export function parsePayload<T extends EventType>(type: T, payload: unknown): EventPayload<T> {
  const schema = eventPayloads[type];
  if (!schema) throw new Error(`Unknown event type: ${type}`);
  return schema.parse(payload) as EventPayload<T>;
}
