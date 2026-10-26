import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { AgentAdapter, DetectResult, HarnessEvent, QuotaSnapshot, RunHandle, RunSpec } from '@hyde/core';
import { StreamParser } from './parse.ts';

const run = promisify(execFile);

// Variables a Claude run may inherit. Everything else is dropped, so hub secrets (chat
// tokens, ANTHROPIC_API_KEY, which would switch billing away from the subscription) never
// reach the agent. Added back explicitly through RunSpec.env when a task needs them.
const ENV_ALLOW = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|TERM|TZ|TMPDIR|LC_[A-Z_]+|XDG_[A-Z_]+)$/;

export function scrubEnv(source: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ENV_ALLOW.test(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

export interface ClaudeArgsOptions {
  resume?: string;
}

/** CLI arguments for one headless turn. Never `--bare`: bare mode skips the subscription login. */
export function buildArgs(spec: RunSpec, options: ClaudeArgsOptions = {}): string[] {
  const args = ['-p', spec.prompt, '--output-format', 'stream-json', '--verbose'];
  args.push('--permission-mode', 'acceptEdits', '--permission-prompts', 'none');
  if (options.resume) args.push('--resume', options.resume);
  if (spec.model) args.push('--model', spec.model);
  if (spec.packetFile) args.push('--append-system-prompt-file', spec.packetFile);
  if (spec.mcpConfigFile) args.push('--mcp-config', spec.mcpConfigFile, '--strict-mcp-config');
  if (spec.allow?.length) args.push('--allowedTools', ...spec.allow);
  if (spec.deny?.length) args.push('--disallowedTools', ...spec.deny);
  return args;
}

interface ActiveRun {
  child: ChildProcess;
  interrupted: boolean;
  /** Servers from the run's MCP config; the run is stopped if one fails to connect. */
  requiredMcp: string[];
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly kind = 'claude-code' as const;
  private readonly active = new Map<string, ActiveRun>();

  constructor(private readonly bin = 'claude') {}

  async detect(): Promise<DetectResult> {
    try {
      const { stdout: versionOut } = await run(this.bin, ['--version']);
      const version = versionOut.trim().split(' ')[0];
      const { stdout } = await run(this.bin, ['auth', 'status']);
      const status = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
      return {
        installed: true,
        ...(version && { version }),
        signedIn: Boolean(status.loggedIn),
        // Only the plan, never the email or tokens.
        account: [status.authMethod, status.subscriptionType].filter(Boolean).join(':'),
      };
    } catch {
      return { installed: false, signedIn: false };
    }
  }

  start(runId: string, spec: RunSpec): Promise<RunHandle> {
    return Promise.resolve(this.spawn(runId, spec, buildArgs(spec)));
  }

  resume(runId: string, sessionRef: string, spec: RunSpec): Promise<RunHandle> {
    return Promise.resolve(this.spawn(runId, spec, buildArgs(spec, { resume: sessionRef })));
  }

  send(): Promise<void> {
    // Headless turns are one process each; follow-ups go through resume().
    return Promise.reject(new Error('claude-code adapter: use resume() for follow-up turns'));
  }

  async interrupt(handle: RunHandle): Promise<void> {
    const active = this.active.get(handle.runId);
    if (!active) return;
    active.interrupted = true;
    // SIGINT ends the turn cleanly; SIGTERM exits 143 without a result.
    active.child.kill('SIGINT');
  }

  async *events(handle: RunHandle): AsyncIterable<HarnessEvent> {
    const active = this.active.get(handle.runId);
    if (!active?.child.stdout) return;
    const parser = new StreamParser();
    const lines = createInterface({ input: active.child.stdout, crlfDelay: Infinity });
    let mcpFailure: string | undefined;
    for await (const line of lines) {
      for (const event of parser.parseLine(line)) {
        yield event;
        // Without the harness MCP server the agent can't ask or report done; stop early
        // instead of letting it work blind.
        if (event.type === 'run.started' && !mcpFailure) {
          const missing = parser.failedMcpServers.filter((name) => active.requiredMcp.includes(name));
          if (missing.length) {
            mcpFailure = `MCP server(s) failed to connect: ${missing.join(', ')}`;
            active.child.kill('SIGINT');
          }
        }
      }
    }
    const exit = await handle.exited;
    this.active.delete(handle.runId);
    if (mcpFailure) {
      yield { type: 'run.failed', reason: 'crashed', detail: mcpFailure };
    } else if (!parser.sawResult) {
      yield active.interrupted
        ? { type: 'run.failed', reason: 'cancelled' }
        : { type: 'run.failed', reason: 'crashed', detail: `exit code ${exit.code} signal ${exit.signal}` };
    }
  }

  async quota(): Promise<QuotaSnapshot | null> {
    // Claude reports quota only inside a run (rate_limit_event); the hub keeps the latest.
    return null;
  }

  private spawn(runId: string, spec: RunSpec, args: string[]): RunHandle {
    const child = spawn(this.bin, args, {
      cwd: spec.cwd,
      env: scrubEnv(process.env, spec.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // stderr is drained so a chatty CLI can never block on a full pipe.
    child.stderr?.resume();
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', () => resolve({ code: null, signal: null }));
    });
    this.active.set(runId, { child, interrupted: false, requiredMcp: mcpServerNames(spec.mcpConfigFile) });
    return { runId, pid: child.pid, exited };
  }
}

function mcpServerNames(file: string | undefined): string[] {
  if (!file) return [];
  try {
    return Object.keys(JSON.parse(readFileSync(file, 'utf8')).mcpServers ?? {});
  } catch {
    return [];
  }
}
