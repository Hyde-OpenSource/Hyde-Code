// The contract every agent CLI adapter implements (docs/plan.md, "How to drive each agent CLI").
// The orchestrator only ever sees this interface and the normalized HarnessEvent stream.

export type AdapterKind = 'claude-code' | 'codex' | 'opencode' | 'acp' | 'pty';

export interface DetectResult {
  installed: boolean;
  version?: string;
  signedIn: boolean;
  account?: string;
}

export interface RunSpec {
  /** Task worktree; the agent process runs here. */
  cwd: string;
  /** The user-turn prompt for this run (first turn, continuation or answer). */
  prompt: string;
  /** Path to the task packet, appended to the agent's system prompt. */
  packetFile?: string;
  /** Path to an MCP config file that exposes the harness tools. */
  mcpConfigFile?: string;
  model?: string;
  /** Tool patterns the agent may never use (compiled from the permission profile). */
  deny?: string[];
  /** Tool patterns the agent may use without a prompt. */
  allow?: string[];
  /** Extra environment variables, added after the environment is scrubbed. */
  env?: Record<string, string>;
}

export interface RunHandle {
  readonly runId: string;
  readonly pid: number | undefined;
  /** Settles when the agent process exits. */
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
}

export interface QuotaSnapshot {
  window: string;
  status: RateLimitStatus;
  utilization?: number;
  resetsAt?: number;
}

export type RateLimitStatus = 'allowed' | 'warning' | 'rejected';

export type RunFailureReason = 'auth' | 'rate_limit' | 'stalled' | 'crashed' | 'cancelled';

export type HarnessEvent =
  | { type: 'run.started'; sessionRef: string; model: string }
  | { type: 'text.delta'; text: string }
  | { type: 'tool.started' | 'tool.finished'; tool: string; summary: string }
  | { type: 'file.changed'; path: string }
  | { type: 'permission.requested'; requestId: string; action: string }
  | { type: 'question.asked'; questionId: string; text: string; blocking: boolean }
  | { type: 'rate_limit'; status: RateLimitStatus; window: string; resetsAt?: number; utilization?: number }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: 'run.completed'; summary: string; structured?: unknown }
  | { type: 'run.failed'; reason: RunFailureReason; detail?: string };

export interface AgentAdapter {
  readonly kind: AdapterKind;
  detect(): Promise<DetectResult>;
  start(runId: string, spec: RunSpec): Promise<RunHandle>;
  send(run: RunHandle, text: string): Promise<void>;
  interrupt(run: RunHandle): Promise<void>;
  resume(runId: string, sessionRef: string, spec: RunSpec): Promise<RunHandle>;
  events(run: RunHandle): AsyncIterable<HarnessEvent>;
  quota(account: string): Promise<QuotaSnapshot | null>;
}
