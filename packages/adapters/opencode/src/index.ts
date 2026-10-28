import {
  execFileAsync,
  failureFromText,
  parseJsonLoose,
  ProcessAdapter,
  summarize,
  type Launch,
  type LaunchWrapper,
  type LineParser,
} from '@hyde/adapter-common';
import type { DetectResult, HarnessEvent, RunSpec } from '@hyde/core';

// Drives `opencode run --format json` (open source, bring-your-own-provider). The harness
// config (MCP server, permissions, task packet) goes in through OPENCODE_CONFIG_CONTENT, so the
// owner's own opencode.json is untouched.

const FILE_TOOLS = new Set(['write', 'edit', 'patch', 'multiedit']);

/** `Bash(git push:*)` → `git push*`, for OpenCode's bash permission patterns. */
export function bashPattern(rule: string): string | null {
  const m = /^Bash\((.*)\)$/.exec(rule);
  if (!m) return null;
  return m[1]!.replace(/:\*$/, '*').replace(/ \*$/, '*');
}

export function buildConfig(spec: RunSpec): Record<string, unknown> {
  const bash: Record<string, string> = { '*': spec.readOnly ? 'deny' : 'allow' };
  for (const rule of spec.deny ?? []) {
    const pattern = bashPattern(rule);
    if (pattern) bash[pattern] = 'deny';
  }
  return {
    $schema: 'https://opencode.ai/config.json',
    permission: { edit: spec.readOnly ? 'deny' : 'allow', bash, webfetch: 'allow' },
    ...(spec.packetFile && { instructions: [spec.packetFile] }),
    ...(spec.mcp && {
      mcp: {
        hyde: { type: 'local', command: [spec.mcp.command, ...spec.mcp.args], environment: spec.mcp.env, enabled: true },
      },
    }),
  };
}

export function buildPrompt(spec: RunSpec): string {
  if (!spec.jsonSchema) return spec.prompt;
  return `${spec.prompt}\n\nYour final message must be only a JSON object that matches this JSON Schema, with no other text:\n${JSON.stringify(spec.jsonSchema)}`;
}

export function buildArgs(spec: RunSpec, resume?: string): string[] {
  const args = ['run', '--format', 'json', '--pure'];
  if (spec.model) args.push('-m', spec.model);
  if (spec.effort) args.push('--variant', spec.effort);
  if (resume) args.push('--session', resume);
  args.push(buildPrompt(spec));
  return args;
}

export class OpenCodeParser implements LineParser {
  private lastText = '';
  private stopped = false;
  private error = '';
  private started = false;

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
    const out: HarnessEvent[] = [];
    if (!this.started && msg.sessionID) {
      this.started = true;
      out.push({ type: 'run.started', sessionRef: String(msg.sessionID), model: this.model });
    }
    const part = msg.part ?? {};
    switch (msg.type) {
      case 'text':
        if (part.text) {
          this.lastText = String(part.text);
          out.push({ type: 'text.delta', text: this.lastText });
        }
        break;
      case 'tool_use': {
        const tool = String(part.tool ?? 'tool');
        const input = part.state?.input ?? {};
        out.push({ type: 'tool.started', tool, summary: summarize(input) });
        const path = input.filePath ?? input.path;
        if (FILE_TOOLS.has(tool) && typeof path === 'string') out.push({ type: 'file.changed', path });
        out.push({ type: 'tool.finished', tool, summary: part.state?.status === 'completed' ? 'ok' : 'error' });
        break;
      }
      case 'step_finish': {
        const t = part.tokens ?? {};
        out.push({
          type: 'usage',
          inputTokens: (t.input ?? 0) + (t.cache?.read ?? 0),
          outputTokens: (t.output ?? 0) + (t.reasoning ?? 0),
          ...(typeof part.cost === 'number' && { costUsd: part.cost }),
        });
        if (part.reason === 'stop') this.stopped = true;
        break;
      }
      case 'error':
        this.error = String(msg.error?.data?.message ?? msg.error?.message ?? msg.error ?? 'error');
        break;
    }
    return out;
  }

  finish(exit: { code: number | null; signal: string | null }, interrupted: boolean): HarnessEvent[] {
    if (interrupted) return [{ type: 'run.failed', reason: 'cancelled' }];
    if (this.error || exit.code !== 0) {
      const detail = this.error || `exit code ${exit.code} signal ${exit.signal}`;
      return [{ type: 'run.failed', reason: failureFromText(detail), detail }];
    }
    if (!this.stopped && !this.lastText) return [{ type: 'run.failed', reason: 'crashed', detail: 'no output' }];
    return [
      {
        type: 'run.completed',
        summary: this.lastText,
        ...(this.wantsJson && { structured: parseJsonLoose(this.lastText) }),
      },
    ];
  }
}

export class OpenCodeAdapter extends ProcessAdapter {
  readonly kind = 'opencode' as const;
  readonly vendor = 'other' as const;
  readonly structuredOutput = false;

  constructor(bin = 'opencode', options: { wrap?: LaunchWrapper } = {}) {
    super(bin, options);
  }

  async detect(): Promise<DetectResult> {
    try {
      const { stdout } = await execFileAsync(this.bin, ['--version']);
      const version = stdout.trim().split('\n').at(-1);
      // Free OpenCode Zen models work without any login; other providers need `opencode auth login`.
      const { stdout: auth } = await execFileAsync(this.bin, ['auth', 'list']).catch(() => ({ stdout: '' }));
      const creds = /(\d+) credentials?/.exec(auth.replace(/\x1b\[[0-9;]*m/g, ''));
      const count = creds ? Number(creds[1]) : 0;
      return {
        installed: true,
        ...(version && { version }),
        signedIn: true,
        account: count ? `${count} provider login(s)` : 'free models only',
      };
    } catch {
      return { installed: false, signedIn: false, problem: 'Install OpenCode: npm i -g opencode-ai' };
    }
  }

  protected launch(spec: RunSpec, resume?: string): Launch {
    return {
      command: this.bin,
      args: buildArgs(spec, resume),
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(buildConfig(spec)) },
    };
  }

  protected parser(spec: RunSpec): LineParser {
    return new OpenCodeParser(spec.model ?? 'opencode-default', Boolean(spec.jsonSchema));
  }
}
