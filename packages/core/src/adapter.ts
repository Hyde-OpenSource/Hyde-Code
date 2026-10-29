// The contract every agent CLI adapter implements (docs/plan.md, "How to drive each agent CLI").
// The orchestrator only ever sees this interface and the normalized HarnessEvent stream.

export type AdapterKind = 'claude-code' | 'codex' | 'opencode' | 'acp' | 'command' | (string & {});

/** The vendor behind an adapter; cross-vendor review needs a different one. */
export type Vendor = 'anthropic' | 'openai' | 'google' | 'other';

export interface DetectResult {
  installed: boolean;
  version?: string;
  signedIn: boolean;
  account?: string;
  /** Why the CLI can't be used, in words the owner can act on. */
  problem?: string;
}

export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface RunSpec {
  /** Task worktree (or repo, for read-only runs); the agent process runs here. */
  cwd: string;
  /** The user-turn prompt for this run (first turn, continuation or answer). */
  prompt: string;
  /** Path to the task packet, appended to the agent's system prompt. */
  packetFile?: string;
  /** The harness MCP server for this run. */
  mcp?: McpServerSpec;
  model?: string;
  /** Reasoning effort, where the CLI supports it. */
  effort?: 'low' | 'medium' | 'high';
  /** Tool patterns the agent may never use (compiled from the permission profile). */
  deny?: string[];
  /** Tool patterns the agent may use without a prompt. */
  allow?: string[];
  /** Planner and reviewer runs: no edits, no shell writes. */
  readOnly?: boolean;
  /** JSON Schema the final answer must follow (structured output). */
  jsonSchema?: object;
  /** Directories outside cwd the agent must be able to write (e.g. the repo's .git for worktree commits). */
  writableDirs?: string[];
  /** Pre-tool-use policy endpoint, for CLIs that support HTTP hooks. */
  policyHook?: { url: string; token: string };
  /** Extra environment variables, added after the environment is scrubbed. */
  env?: Record<string, string>;
  /** Directory for per-run files the adapter writes (configs, schemas). */
  runDir: string;
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
  readonly vendor: Vendor;
  /** Whether the CLI can return output that follows a JSON Schema. */
  readonly structuredOutput: boolean;
  /**
   * False when the CLI's sandbox keeps .git read-only (Codex workspace-write): the agent leaves
   * changes uncommitted and the harness commits them with the agent's summary.
   */
  readonly canCommit?: boolean;
  detect(): Promise<DetectResult>;
  start(runId: string, spec: RunSpec): Promise<RunHandle>;
  send(run: RunHandle, text: string): Promise<void>;
  interrupt(run: RunHandle): Promise<void>;
  resume(runId: string, sessionRef: string, spec: RunSpec): Promise<RunHandle>;
  events(run: RunHandle): AsyncIterable<HarnessEvent>;
  /** Current quota windows, if the CLI can report them outside a run. */
  quota(): Promise<QuotaSnapshot[]>;
}

/** A configured agent: one CLI, one model, one account (docs/plan.md "Agent profile"). */
export interface AgentProfile {
  name: string;
  adapter: AdapterKind;
  enabled: boolean;
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  /** Roles this agent is good at; the router prefers matches. */
  roles: string[];
  /** Concurrent runs for this agent's account. */
  maxConcurrent: number;
  /** Account key for quota tracking; agents sharing a login share one. */
  account: string;
  /** Node that runs this agent ('local' for the hub machine). */
  node: string;
  /** Run inside a container instead of directly on the host. */
  isolation: 'worktree' | 'container';
  /** For acp/command adapters: the command line to launch. */
  command?: string[];
}

/** A tiny plugin registry: adapters.register('codex', …), gateways.register('telegram', …). */
export class Registry<T> {
  private readonly items = new Map<string, T>();

  constructor(private readonly what: string) {}

  register(name: string, item: T): this {
    if (this.items.has(name)) throw new Error(`${this.what} "${name}" is already registered`);
    this.items.set(name, item);
    return this;
  }

  get(name: string): T {
    const item = this.items.get(name);
    if (!item) throw new Error(`No ${this.what} named "${name}". Registered: ${[...this.items.keys()].join(', ') || 'none'}`);
    return item;
  }

  has(name: string): boolean {
    return this.items.has(name);
  }

  entries(): [string, T][] {
    return [...this.items.entries()];
  }
}
