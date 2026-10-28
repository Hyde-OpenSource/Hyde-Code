import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  execFileAsync,
  failureFromText,
  parseJsonLoose,
  ProcessAdapter,
  scrubEnv,
  summarize,
  type Launch,
  type LaunchWrapper,
  type LineParser,
} from '@hyde/adapter-common';
import type { DetectResult, HarnessEvent, QuotaSnapshot, RunSpec } from '@hyde/core';

// Drives `codex exec --json` (docs/plan.md: "codex exec --json for one-shots"), signed in with
// the owner's ChatGPT plan. Quota comes from `codex app-server` (account/rateLimits/read).

/** A TOML string literal for `-c key=value` overrides. */
function toml(value: string): string {
  return JSON.stringify(value);
}

export function buildArgs(spec: RunSpec, resume?: string): string[] {
  const args = resume ? ['exec', 'resume', resume] : ['exec'];
  // --ignore-user-config keeps the owner's own MCP servers and settings out of harness runs;
  // auth still comes from CODEX_HOME.
  args.push('--json', '--ignore-user-config', '--skip-git-repo-check');
  args.push('-c', `sandbox_mode=${toml(spec.readOnly ? 'read-only' : 'workspace-write')}`);
  args.push('-c', 'approval_policy="never"');
  if (spec.writableDirs?.length && !spec.readOnly) {
    args.push('-c', `sandbox_workspace_write.writable_roots=[${spec.writableDirs.map(toml).join(',')}]`);
  }
  if (spec.model) args.push('-m', spec.model);
  if (spec.effort) args.push('-c', `model_reasoning_effort=${toml(spec.effort)}`);
  if (spec.packetFile) args.push('-c', `developer_instructions=${toml(readFileSync(spec.packetFile, 'utf8'))}`);
  if (spec.mcp) {
    args.push('-c', `mcp_servers.hyde.command=${toml(spec.mcp.command)}`);
    args.push('-c', `mcp_servers.hyde.args=[${spec.mcp.args.map(toml).join(',')}]`);
    const env = Object.entries(spec.mcp.env).map(([k, v]) => `${k}=${toml(v)}`);
    args.push('-c', `mcp_servers.hyde.env={${env.join(',')}}`);
    // Harness tools are safe by construction; without this Codex refuses them under "never".
    args.push('-c', 'mcp_servers.hyde.default_tools_approval_mode="approve"');
  }
  if (spec.jsonSchema) args.push('--output-schema', join(spec.runDir, 'codex-schema.json'));
  args.push(spec.prompt);
  return args;
}

export class CodexParser implements LineParser {
  private lastMessage = '';
  private lastError = '';
  private done = false;

  constructor(
    private readonly model: string,
    private readonly wantsJson: boolean,
  ) {}

  parseLine(line: string): HarnessEvent[] {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(line);
    } catch {
      return [];
    }
    const item = msg.item as Record<string, any> | undefined;
    switch (msg.type) {
      case 'thread.started':
        return [{ type: 'run.started', sessionRef: String(msg.thread_id), model: this.model }];
      case 'item.started':
        if (item?.type === 'command_execution') return [{ type: 'tool.started', tool: 'Bash', summary: summarize({ command: item.command }) }];
        if (item?.type === 'mcp_tool_call') {
          return [{ type: 'tool.started', tool: `mcp__${item.server}__${item.tool}`, summary: summarize(item.arguments) }];
        }
        if (item?.type === 'file_change') {
          return [{ type: 'tool.started', tool: 'Edit', summary: (item.changes ?? []).map((c: { path: string }) => c.path).join(', ') }];
        }
        return [];
      case 'item.completed':
        switch (item?.type) {
          case 'agent_message':
            this.lastMessage = String(item.text ?? '');
            return [{ type: 'text.delta', text: this.lastMessage }];
          case 'command_execution':
            return [{ type: 'tool.finished', tool: 'Bash', summary: item.exit_code === 0 ? 'ok' : `exit ${item.exit_code}` }];
          case 'mcp_tool_call':
            return [{ type: 'tool.finished', tool: `mcp__${item.server}__${item.tool}`, summary: item.status === 'completed' ? 'ok' : 'error' }];
          case 'file_change':
            return [
              ...(item.changes ?? []).map((c: { path: string }) => ({ type: 'file.changed' as const, path: c.path })),
              { type: 'tool.finished', tool: 'Edit', summary: item.status === 'completed' ? 'ok' : 'error' },
            ];
          case 'error':
            this.lastError = String(item.message ?? '');
            return [];
          default:
            return [];
        }
      case 'turn.completed': {
        this.done = true;
        const u = msg.usage ?? {};
        return [
          { type: 'usage', inputTokens: u.input_tokens ?? 0, outputTokens: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0) },
          {
            type: 'run.completed',
            summary: this.lastMessage,
            ...(this.wantsJson && { structured: parseJsonLoose(this.lastMessage) }),
          },
        ];
      }
      case 'turn.failed': {
        this.done = true;
        const detail = String(msg.error?.message ?? this.lastError ?? 'turn failed');
        return [{ type: 'run.failed', reason: failureFromText(detail), detail }];
      }
      case 'error':
        this.lastError = String(msg.message ?? '');
        return [];
      default:
        return [];
    }
  }

  finish(exit: { code: number | null; signal: string | null }, interrupted: boolean): HarnessEvent[] {
    if (this.done) return [];
    if (interrupted) return [{ type: 'run.failed', reason: 'cancelled' }];
    const detail = this.lastError || `exit code ${exit.code} signal ${exit.signal}`;
    return [{ type: 'run.failed', reason: failureFromText(detail), detail }];
  }
}

export class CodexAdapter extends ProcessAdapter {
  readonly kind = 'codex' as const;
  readonly vendor = 'openai' as const;
  readonly structuredOutput = true;

  constructor(bin = 'codex', options: { wrap?: LaunchWrapper } = {}) {
    super(bin, options);
  }

  async detect(): Promise<DetectResult> {
    try {
      const { stdout } = await execFileAsync(this.bin, ['--version']);
      const version = stdout.trim().split(' ').at(-1);
      const login = await execFileAsync(this.bin, ['login', 'status']).then(
        (r) => `${r.stdout}${r.stderr}`,
        (e: { stdout?: string; stderr?: string }) => `${e.stdout ?? ''}${e.stderr ?? ''}`,
      );
      const signedIn = /logged in/i.test(login) && !/not logged in/i.test(login);
      const viaChatGpt = /chatgpt/i.test(login);
      return {
        installed: true,
        ...(version && { version }),
        signedIn,
        account: viaChatGpt ? 'chatgpt' : 'api-key',
        ...(!signedIn && { problem: 'Run `codex login` and choose Sign in with ChatGPT.' }),
      };
    } catch {
      return { installed: false, signedIn: false, problem: 'Install Codex: npm i -g @openai/codex' };
    }
  }

  protected launch(spec: RunSpec, resume?: string): Launch {
    if (spec.jsonSchema) writeFileSync(join(spec.runDir, 'codex-schema.json'), JSON.stringify(spec.jsonSchema));
    return { command: this.bin, args: buildArgs(spec, resume) };
  }

  protected parser(spec: RunSpec): LineParser {
    return new CodexParser(spec.model ?? 'codex-default', Boolean(spec.jsonSchema));
  }

  /** Reads the ChatGPT plan's Codex windows through the app server (JSON-RPC over stdio). */
  async quota(): Promise<QuotaSnapshot[]> {
    const limits = await appServerRequest(this.bin, 'account/rateLimits/read').catch(() => null);
    return quotaFromRateLimits(limits);
  }
}

export function quotaFromRateLimits(result: unknown): QuotaSnapshot[] {
  const r = (result as { rateLimits?: Record<string, any> } | null)?.rateLimits;
  if (!r) return [];
  const out: QuotaSnapshot[] = [];
  for (const [key, w] of [['primary', r.primary], ['secondary', r.secondary]] as const) {
    if (!w) continue;
    const mins = Number(w.windowDurationMins);
    const window = mins === 300 ? 'five_hour' : mins === 10080 ? 'seven_day' : `${key}_${mins}m`;
    const utilization = Number(w.usedPercent) / 100;
    out.push({
      window,
      utilization,
      status: r.rateLimitReachedType || utilization >= 1 ? 'rejected' : utilization >= 0.8 ? 'warning' : 'allowed',
      ...(typeof w.resetsAt === 'number' && { resetsAt: w.resetsAt }),
    });
  }
  return out;
}

/** One request to `codex app-server`: initialize, call, exit. */
export function appServerRequest(bin: string, method: string, params?: unknown, timeoutMs = 15_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['app-server'], { env: scrubEnv(process.env), stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('codex app-server timed out'));
    }, timeoutMs);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id === 1) {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method, ...(params !== undefined && { params }) }) + '\n');
      } else if (msg.id === 2) {
        clearTimeout(timer);
        child.kill();
        if (msg.error) reject(new Error(msg.error.message ?? 'app-server error'));
        else resolve(msg.result);
      }
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'hyde', version: '0.0.0' } } }) + '\n',
    );
  });
}
