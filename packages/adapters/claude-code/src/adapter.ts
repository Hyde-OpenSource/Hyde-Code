import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileAsync, ProcessAdapter, type Launch, type LaunchWrapper, type LineParser } from '@hyde/adapter-common';
import type { DetectResult, RunSpec } from '@hyde/core';
import { StreamParser } from './parse.ts';

const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'mcp__hyde__ask_question', 'mcp__hyde__report_progress'];
const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'];

/** CLI arguments for one headless turn. Never `--bare`: bare mode skips the subscription login. */
export function buildArgs(spec: RunSpec, options: { resume?: string } = {}): string[] {
  const args = ['-p', spec.prompt, '--output-format', 'stream-json', '--verbose'];
  // dontAsk denies anything not allowed; acceptEdits also allows file edits in the worktree.
  args.push('--permission-mode', spec.readOnly ? 'dontAsk' : 'acceptEdits', '--permission-prompts', 'none');
  if (options.resume) args.push('--resume', options.resume);
  if (spec.model) args.push('--model', spec.model);
  if (spec.effort) args.push('--effort', spec.effort);
  if (spec.packetFile) args.push('--append-system-prompt-file', spec.packetFile);
  if (spec.mcp) args.push('--mcp-config', join(spec.runDir, 'claude-mcp.json'), '--strict-mcp-config');
  if (spec.jsonSchema) args.push('--json-schema', JSON.stringify(spec.jsonSchema));
  if (spec.policyHook) args.push('--settings', join(spec.runDir, 'claude-settings.json'));
  for (const dir of spec.writableDirs ?? []) args.push('--add-dir', dir);
  const allow = spec.readOnly ? READ_ONLY_TOOLS : (spec.allow ?? []);
  const deny = spec.readOnly ? [...WRITE_TOOLS, ...(spec.deny ?? [])] : (spec.deny ?? []);
  if (allow.length) args.push('--allowedTools', ...allow);
  if (deny.length) args.push('--disallowedTools', ...deny);
  return args;
}

/** Files the CLI reads, written next to the run (MCP config, policy hook settings). */
export function writeRunFiles(spec: RunSpec): void {
  if (spec.mcp) {
    writeFileSync(join(spec.runDir, 'claude-mcp.json'), JSON.stringify({ mcpServers: { hyde: spec.mcp } }), { mode: 0o600 });
  }
  if (spec.policyHook) {
    const hook = {
      type: 'http',
      url: spec.policyHook.url,
      headers: { Authorization: `Bearer ${spec.policyHook.token}` },
      timeout: 30,
    };
    writeFileSync(
      join(spec.runDir, 'claude-settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit', hooks: [hook] }] } }),
      { mode: 0o600 },
    );
  }
}

export class ClaudeCodeAdapter extends ProcessAdapter {
  readonly kind = 'claude-code' as const;
  readonly vendor = 'anthropic' as const;
  readonly structuredOutput = true;

  constructor(bin = 'claude', options: { wrap?: LaunchWrapper } = {}) {
    super(bin, options);
  }

  async detect(): Promise<DetectResult> {
    try {
      const { stdout: versionOut } = await execFileAsync(this.bin, ['--version']);
      const version = versionOut.trim().split(' ')[0];
      const { stdout } = await execFileAsync(this.bin, ['auth', 'status']);
      const status = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
      const signedIn = Boolean(status.loggedIn);
      return {
        installed: true,
        ...(version && { version }),
        signedIn,
        // Only the plan, never the email or tokens.
        account: [status.authMethod, status.subscriptionType].filter(Boolean).join(':'),
        ...(!signedIn && { problem: 'Run `claude` once and sign in with your subscription.' }),
      };
    } catch {
      return { installed: false, signedIn: false, problem: 'Install Claude Code: https://code.claude.com' };
    }
  }

  protected launch(spec: RunSpec, resume?: string): Launch {
    writeRunFiles(spec);
    return { command: this.bin, args: buildArgs(spec, resume ? { resume } : {}) };
  }

  protected parser(spec: RunSpec): LineParser {
    return new StreamParser(spec.mcp ? ['hyde'] : []);
  }
}
