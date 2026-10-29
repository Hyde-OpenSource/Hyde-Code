import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ClaudeCodeAdapter } from '@hyde/adapter-claude-code';
import { CodexAdapter } from '@hyde/adapter-codex';
import { OpenCodeAdapter } from '@hyde/adapter-opencode';

const exec = promisify(execFile);

// What this machine has, so the owner can pick (docs/plan.md: nothing is compulsory).

export interface Detected {
  id: string;
  label: string;
  kind: 'agent' | 'tool';
  installed: boolean;
  signedIn: boolean;
  version?: string;
  account?: string;
  problem?: string;
  /** Agent profile to add when the owner enables it. */
  suggest?: { adapter: string; name: string; command?: string[]; vendor?: string; roles: string[]; model?: string };
  howTo?: string;
}

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await exec('sh', ['-c', 'command -v "$0"', bin]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function version(bin: string, args = ['--version']): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await exec(bin, args, { timeout: 10_000 });
    return (stdout || stderr).trim().split('\n').at(-1)?.slice(0, 40);
  } catch {
    return undefined;
  }
}

export async function detectAll(): Promise<Detected[]> {
  const [claude, codex, opencode] = await Promise.all([
    new ClaudeCodeAdapter().detect(),
    new CodexAdapter().detect(),
    new OpenCodeAdapter().detect(),
  ]);
  const out: Detected[] = [
    {
      id: 'claude-code',
      label: 'Claude Code',
      kind: 'agent',
      ...claude,
      suggest: { adapter: 'claude-code', name: 'claude-1', roles: ['plan', 'implement', 'review', 'ui'] },
      howTo: 'Install from code.claude.com, then run `claude` once and sign in with your subscription.',
    },
    {
      id: 'codex',
      label: 'Codex CLI',
      kind: 'agent',
      ...codex,
      suggest: { adapter: 'codex', name: 'codex-1', roles: ['implement', 'review', 'bulk'] },
      howTo: 'npm i -g @openai/codex, then `codex login` (Sign in with ChatGPT).',
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      kind: 'agent',
      ...opencode,
      suggest: { adapter: 'opencode', name: 'opencode-1', roles: ['implement', 'bulk', 'triage'], model: 'opencode/big-pickle' },
      howTo: 'npm i -g opencode-ai. Free models work without a login; `opencode auth login` adds providers.',
    },
  ];

  // ACP agents: present on PATH means usable; each signs in through its own official flow.
  const acp: { id: string; label: string; bin: string; command: string[]; vendor: string; howTo: string }[] = [
    { id: 'gemini', label: 'Gemini CLI (ACP)', bin: 'gemini', command: ['gemini', '--experimental-acp'], vendor: 'google', howTo: 'npm i -g @google/gemini-cli, then `gemini` and sign in. Google forbids its OAuth in third-party tools; Hyde only runs the official binary.' },
    { id: 'copilot', label: 'GitHub Copilot CLI (ACP)', bin: 'copilot', command: ['copilot', '--acp'], vendor: 'other', howTo: 'npm i -g @github/copilot, then `copilot` and /login.' },
    { id: 'qwen', label: 'Qwen Code (ACP)', bin: 'qwen', command: ['qwen', '--experimental-acp'], vendor: 'other', howTo: 'npm i -g @qwen-code/qwen-code.' },
  ];
  for (const a of acp) {
    const path = await which(a.bin);
    const v = path ? await version(a.bin) : undefined;
    out.push({
      id: a.id,
      label: a.label,
      kind: 'agent',
      installed: Boolean(path),
      signedIn: Boolean(path),
      ...(v && { version: v }),
      ...(!path && { problem: `${a.bin} not found on PATH` }),
      suggest: { adapter: 'acp', name: `${a.id}-1`, command: a.command, vendor: a.vendor, roles: ['implement', 'review'] },
      howTo: a.howTo,
    });
  }

  const gh = await which('gh');
  const ghAuth = gh ? await exec('gh', ['auth', 'status']).then(() => true, () => false) : false;
  out.push({
    id: 'gh',
    label: 'GitHub CLI',
    kind: 'tool',
    installed: Boolean(gh),
    signedIn: ghAuth,
    ...(!gh ? { problem: 'Needed to open and merge PRs' } : !ghAuth ? { problem: 'Run `gh auth login`' } : {}),
    howTo: 'https://cli.github.com, then `gh auth login`.',
  });
  const docker = await which('docker');
  out.push({
    id: 'docker',
    label: 'Docker (container isolation)',
    kind: 'tool',
    installed: Boolean(docker),
    signedIn: Boolean(docker),
    ...(!docker && { problem: 'Optional: only for isolation "container"' }),
  });
  const browsers = join(process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), '.cache', 'ms-playwright'));
  const chromium = existsSync(browsers) && readdirSync(browsers).some((d) => d.startsWith('chromium'));
  out.push({
    id: 'playwright',
    label: 'Playwright Chromium (browser verify)',
    kind: 'tool',
    installed: chromium,
    signedIn: chromium,
    ...(!chromium && { problem: 'Optional: run `pnpm --filter @hyde/hub exec playwright install chromium`' }),
  });
  return out;
}
