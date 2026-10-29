import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type {
  AdapterKind,
  AgentAdapter,
  DetectResult,
  HarnessEvent,
  QuotaSnapshot,
  RunHandle,
  RunSpec,
  Vendor,
} from '@hyde/core';

export const execFileAsync = promisify(execFile);

// Variables an agent run may inherit. Everything else is dropped, so hub secrets (chat
// tokens, ANTHROPIC_API_KEY or OPENAI_API_KEY, which would switch billing away from the
// subscription) never reach the agent. Added back explicitly through RunSpec.env.
const ENV_ALLOW = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|TERM|TZ|TMPDIR|LC_[A-Z_]+|XDG_[A-Z_]+|CODEX_HOME)$/;

export function scrubEnv(source: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ENV_ALLOW.test(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

/** Turns one CLI's JSONL output into normalized events. One parser per run. */
export interface LineParser {
  parseLine(line: string): HarnessEvent[];
  /** Events to emit after the process exits (a final completion or failure). */
  finish(exit: { code: number | null; signal: string | null }, interrupted: boolean): HarnessEvent[];
  /** Set when the run must be stopped early (e.g. the harness MCP server failed to connect). */
  abort?: string;
}

export interface Launch {
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Written to stdin, then stdin is closed. */
  stdin?: string;
}

/** Rewrites a launch, e.g. to run it inside a container (docs/plan.md "Isolation"). */
export type LaunchWrapper = (launch: Launch, spec: RunSpec) => Launch;

interface ActiveRun {
  child: ChildProcess;
  parser: LineParser;
  interrupted: boolean;
  aborted?: string;
}

/**
 * Base for adapters that drive a CLI as one process per turn, reading JSON lines from stdout.
 * Claude Code, Codex and OpenCode all work this way.
 */
export abstract class ProcessAdapter implements AgentAdapter {
  abstract readonly kind: AdapterKind;
  abstract readonly vendor: Vendor;
  abstract readonly structuredOutput: boolean;
  private readonly active = new Map<string, ActiveRun>();
  protected readonly wrap: LaunchWrapper | undefined;

  constructor(protected readonly bin: string, options: { wrap?: LaunchWrapper } = {}) {
    this.wrap = options.wrap;
  }

  abstract detect(): Promise<DetectResult>;
  protected abstract launch(spec: RunSpec, resume?: string): Launch;
  protected abstract parser(spec: RunSpec): LineParser;

  async quota(): Promise<QuotaSnapshot[]> {
    return [];
  }

  start(runId: string, spec: RunSpec): Promise<RunHandle> {
    return Promise.resolve(this.spawn(runId, spec, this.launch(spec)));
  }

  resume(runId: string, sessionRef: string, spec: RunSpec): Promise<RunHandle> {
    return Promise.resolve(this.spawn(runId, spec, this.launch(spec, sessionRef)));
  }

  send(): Promise<void> {
    // One process per turn; follow-ups go through resume().
    return Promise.reject(new Error(`${this.kind} adapter: use resume() for follow-up turns`));
  }

  async interrupt(handle: RunHandle): Promise<void> {
    const active = this.active.get(handle.runId);
    if (!active) return;
    active.interrupted = true;
    // SIGINT ends the turn cleanly; SIGTERM can exit without a result.
    active.child.kill('SIGINT');
  }

  async *events(handle: RunHandle): AsyncIterable<HarnessEvent> {
    const active = this.active.get(handle.runId);
    if (!active?.child.stdout) return;
    const lines = createInterface({ input: active.child.stdout, crlfDelay: Infinity });
    for await (const line of lines) {
      for (const event of active.parser.parseLine(line)) yield event;
      if (active.parser.abort && !active.aborted) {
        active.aborted = active.parser.abort;
        active.child.kill('SIGINT');
      }
    }
    const exit = await handle.exited;
    this.active.delete(handle.runId);
    if (active.aborted) {
      yield { type: 'run.failed', reason: 'crashed', detail: active.aborted };
      return;
    }
    for (const event of active.parser.finish(exit, active.interrupted)) yield event;
  }

  private spawn(runId: string, spec: RunSpec, base: Launch): RunHandle {
    const launch = this.wrap ? this.wrap(base, spec) : base;
    const child = spawn(launch.command, launch.args, {
      cwd: spec.cwd,
      env: scrubEnv(process.env, { ...spec.env, ...launch.env }),
      stdio: [launch.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (launch.stdin !== undefined) child.stdin?.end(launch.stdin);
    // stderr is drained so a chatty CLI can never block on a full pipe.
    child.stderr?.resume();
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', () => resolve({ code: null, signal: null }));
    });
    this.active.set(runId, { child, parser: this.parser(spec), interrupted: false });
    return { runId, pid: child.pid, exited };
  }
}

/** Shortens a tool input for display. */
export function summarize(input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  const pick = obj.command ?? obj.file_path ?? obj.filePath ?? obj.path ?? obj.notebook_path ?? obj.pattern ?? obj.url;
  const text = typeof pick === 'string' ? pick : Array.isArray(pick) ? pick.join(' ') : JSON.stringify(input);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/** Best-effort JSON parse of a model's final message (structured output fallback). */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced ? fenced[1]! : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/** Classifies an error message from any CLI. */
export function failureFromText(text: string): 'auth' | 'rate_limit' | 'crashed' {
  const t = text.toLowerCase();
  if (/(401|403|unauthori[sz]ed|not logged in|log ?in|authenticat|sign in)/.test(t)) return 'auth';
  if (/(429|rate.?limit|usage limit|quota|too many requests)/.test(t)) return 'rate_limit';
  return 'crashed';
}

// ------------------------------------------------------------ containers (docs/plan.md Phase 4)

export interface ContainerOptions {
  /** Image with the agent CLI installed. */
  image: string;
  /** Named volume holding the agent's home, where the owner signs in once inside the container. */
  homeVolume: string;
  /** Home directory inside the image. */
  home?: string;
  /** Defaults to `host`, so the agent can reach the hub API on 127.0.0.1 and the model API. */
  network?: string;
  /** Extra read-only mounts (e.g. the Hyde Code checkout that holds the MCP server). */
  readOnlyMounts?: string[];
  memory?: string;
  cpus?: string;
}

/**
 * Runs the CLI inside a container: the worktree (and any writable dirs) are bind-mounted at the
 * same paths, the agent's home is a named volume, and the hub's environment never enters.
 * The subscription login lives only in that volume, done by its owner (`docker run -it ... claude`).
 */
export function containerWrapper(options: ContainerOptions): LaunchWrapper {
  const home = options.home ?? '/home/agent';
  return (launch, spec) => {
    const mounts = [spec.cwd, spec.runDir, ...(spec.writableDirs ?? [])];
    const args = ['run', '--rm', '-i', '--init'];
    args.push('-v', `${options.homeVolume}:${home}`, '-e', `HOME=${home}`);
    for (const dir of [...new Set(mounts)]) args.push('-v', `${dir}:${dir}`);
    for (const dir of options.readOnlyMounts ?? []) args.push('-v', `${dir}:${dir}:ro`);
    args.push('-w', spec.cwd, '--network', options.network ?? 'host');
    if (options.memory) args.push('--memory', options.memory);
    if (options.cpus) args.push('--cpus', options.cpus);
    for (const [key, value] of Object.entries({ ...spec.env, ...launch.env })) args.push('-e', `${key}=${value}`);
    args.push(options.image, launch.command, ...launch.args);
    return { command: 'docker', args, ...(launch.stdin !== undefined && { stdin: launch.stdin }) };
  };
}
