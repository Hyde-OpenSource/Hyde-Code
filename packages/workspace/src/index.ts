import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, max).replace(/-+$/, '') || 'task';
}

export type BranchType = 'feature' | 'fix' | 'chore';

/** Devflow branch naming for multi-agent work: `<agent>/<type>/<task>-<slug>`. */
export function branchName(agent: string, type: BranchType, taskId: string, title: string): string {
  return `${slugify(agent, 30)}/${type}/${taskId.toLowerCase()}-${slugify(title)}`;
}

export interface WorktreeSpec {
  repo: string;
  worktreesRoot: string;
  taskId: string;
  branch: string;
  base: string;
}

/** Creates (or reuses) the task's worktree on its own branch, cut from `base`. */
export async function createWorktree(spec: WorktreeSpec): Promise<string> {
  const path = join(spec.worktreesRoot, spec.taskId);
  if (existsSync(join(path, '.git'))) return path;
  mkdirSync(spec.worktreesRoot, { recursive: true });
  const branchExists = await git(spec.repo, ['branch', '--list', spec.branch]);
  const args = branchExists
    ? ['worktree', 'add', path, spec.branch]
    : ['worktree', 'add', '-b', spec.branch, path, spec.base];
  await git(spec.repo, args);
  return path;
}

/** Removes a worktree. Refuses (git's own check) if it has uncommitted changes. The branch is kept. */
export async function removeWorktree(repo: string, path: string): Promise<void> {
  await git(repo, ['worktree', 'remove', path]);
}

export async function hasRemote(repo: string, name = 'origin'): Promise<boolean> {
  const remotes = await git(repo, ['remote']);
  return remotes.split('\n').includes(name);
}

export async function currentBranch(cwd: string): Promise<string> {
  return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

/** Files changed on this branch since it left `base`, plus anything uncommitted. */
export async function changedFiles(cwd: string, base: string): Promise<string[]> {
  const committed = await git(cwd, ['diff', '--name-only', `${base}...HEAD`]);
  const pending = await git(cwd, ['status', '--porcelain']);
  const files = new Set(committed.split('\n').filter(Boolean));
  for (const line of pending.split('\n').filter(Boolean)) files.add(line.slice(3));
  return [...files].sort();
}

export async function commitsAhead(cwd: string, base: string): Promise<number> {
  return Number(await git(cwd, ['rev-list', '--count', `${base}..HEAD`]));
}

export async function isClean(cwd: string): Promise<boolean> {
  return (await git(cwd, ['status', '--porcelain'])) === '';
}

/** Commits every pending change in the worktree. Returns false when there was nothing to commit. */
export async function commitAll(cwd: string, message: string): Promise<boolean> {
  if (await isClean(cwd)) return false;
  await git(cwd, ['add', '-A']);
  await git(cwd, ['commit', '-m', message]);
  return true;
}

export async function pushBranch(cwd: string, branch: string): Promise<void> {
  await git(cwd, ['push', '-u', 'origin', `${branch}:${branch}`]);
}

async function hooksDir(repo: string): Promise<string> {
  const configured = await git(repo, ['config', '--get', 'core.hooksPath']).catch(() => '');
  if (configured) return isAbsolute(configured) ? configured : resolve(repo, configured);
  const common = await git(repo, ['rev-parse', '--git-common-dir']);
  return join(isAbsolute(common) ? common : resolve(repo, common), 'hooks');
}

export type HookInstallResult = 'installed' | 'already-installed' | 'skipped-existing-hook';

/**
 * Installs the protected-branch pre-push hook. Never overwrites a hook the user already has;
 * in that case it reports `skipped-existing-hook` and the caller should tell the owner.
 */
export async function installPrePushHook(repo: string, script: string, marker: string): Promise<HookInstallResult> {
  const path = join(await hooksDir(repo), 'pre-push');
  if (existsSync(path)) {
    return readFileSync(path, 'utf8').includes(marker) ? 'already-installed' : 'skipped-existing-hook';
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return 'installed';
}
