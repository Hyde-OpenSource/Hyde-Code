import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  changedFiles,
  commitAll,
  commitsAhead,
  createWorktree,
  git,
  hasRemote,
  pushBranch,
  removeWorktree,
} from './index.ts';

const exec = promisify(execFile);

export interface CommandResult {
  command: string;
  ok: boolean;
  output: string;
}

export interface PullRequest {
  base: string;
  head: string;
  title: string;
  body: string;
}

/**
 * Everything the orchestrator does to a machine's files and git. The hub's own machine uses
 * LocalHost; a teammate's worker node implements the same calls over its WebSocket.
 */
export interface HostOps {
  createWorktree(spec: { repo: string; worktreesRoot: string; taskId: string; branch: string; base: string }): Promise<string>;
  removeWorktree(repo: string, path: string): Promise<void>;
  /** The repo's shared .git dir; worktree commits write there, so sandboxes must allow it. */
  gitCommonDir(repo: string): Promise<string>;
  changedFiles(cwd: string, base: string): Promise<string[]>;
  commitAll(cwd: string, message: string): Promise<boolean>;
  commitsAhead(cwd: string, base: string): Promise<number>;
  hasRemote(repo: string): Promise<boolean>;
  pushBranch(cwd: string, branch: string): Promise<void>;
  /**
   * Fetches and merges origin/<base> into the task branch (no rebase, no force-push). On a conflict
   * the merge is left in progress for the author to resolve, unless `abortOnConflict`.
   */
  syncWithBase(cwd: string, base: string, abortOnConflict?: boolean): Promise<{ ok: true } | { ok: false; conflicts: string[] }>;
  abortMerge(cwd: string): Promise<void>;
  diff(cwd: string, base: string): Promise<string>;
  run(cwd: string, command: string, timeoutMs: number, env?: Record<string, string>): Promise<CommandResult>;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  openPullRequest(cwd: string, pr: PullRequest): Promise<string>;
  /** Merges the PR for this branch on GitHub; returns the merge commit when known. */
  mergePullRequest(cwd: string, branch: string, method: 'merge' | 'squash'): Promise<string | undefined>;
  headSha(cwd: string): Promise<string>;
}

export class LocalHost implements HostOps {
  createWorktree = createWorktree;
  removeWorktree = removeWorktree;
  changedFiles = changedFiles;
  commitAll = commitAll;
  commitsAhead = commitsAhead;
  hasRemote = hasRemote;
  pushBranch = pushBranch;

  async gitCommonDir(repo: string): Promise<string> {
    const dir = await git(repo, ['rev-parse', '--git-common-dir']);
    return isAbsolute(dir) ? dir : resolve(repo, dir);
  }

  async syncWithBase(cwd: string, base: string, abortOnConflict = false): Promise<{ ok: true } | { ok: false; conflicts: string[] }> {
    await git(cwd, ['fetch', 'origin', base]);
    try {
      await git(cwd, ['merge', '--no-edit', `origin/${base}`]);
      return { ok: true };
    } catch {
      const conflicts = (await git(cwd, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
      if (abortOnConflict || !conflicts.length) await this.abortMerge(cwd);
      return { ok: false, conflicts };
    }
  }

  async abortMerge(cwd: string): Promise<void> {
    await git(cwd, ['merge', '--abort']).catch(() => undefined);
  }

  async diff(cwd: string, base: string): Promise<string> {
    return git(cwd, ['diff', `${base}...HEAD`]);
  }

  async run(cwd: string, command: string, timeoutMs: number, env?: Record<string, string>): Promise<CommandResult> {
    try {
      const { stdout, stderr } = await exec('sh', ['-c', command], {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ...env },
      });
      return { command, ok: true, output: (stdout + stderr).slice(-4000) };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      return { command, ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message}`.slice(-4000) };
    }
  }

  async readFile(path: string): Promise<string | null> {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  }

  async writeFile(path: string, content: string): Promise<void> {
    writeFileSync(path, content);
  }

  async openPullRequest(cwd: string, pr: PullRequest): Promise<string> {
    // An existing PR for the branch is reused (e.g. after a hub restart mid-step).
    const existing = await exec('gh', ['pr', 'view', pr.head, '--json', 'url', '-q', '.url'], { cwd }).then(
      (r) => r.stdout.trim(),
      () => '',
    );
    if (existing) return existing;
    const { stdout } = await exec('gh', ['pr', 'create', '--base', pr.base, '--head', pr.head, '--title', pr.title, '--body', pr.body], { cwd });
    return stdout.trim().split('\n').at(-1)!;
  }

  async mergePullRequest(cwd: string, branch: string, method: 'merge' | 'squash'): Promise<string | undefined> {
    await exec('gh', ['pr', 'merge', branch, `--${method}`], { cwd });
    const { stdout } = await exec('gh', ['pr', 'view', branch, '--json', 'mergeCommit', '-q', '.mergeCommit.oid'], { cwd }).catch(() => ({ stdout: '' }));
    return stdout.trim() || undefined;
  }

  async headSha(cwd: string): Promise<string> {
    return git(cwd, ['rev-parse', 'HEAD']);
  }
}
