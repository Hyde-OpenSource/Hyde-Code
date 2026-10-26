import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOOK_MARKER, isProtectedBranch, prePushHook } from '@hyde/policy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  branchName,
  changedFiles,
  commitAll,
  commitsAhead,
  createWorktree,
  currentBranch,
  git,
  hasRemote,
  installPrePushHook,
  pushBranch,
  removeWorktree,
  slugify,
} from './index.ts';

let root: string;
let repo: string;
const identity = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'hyde-ws-'));
  repo = join(root, 'repo');
  await git(root, ['init', '-q', '-b', 'main', repo]);
  await git(repo, ['config', 'user.name', 'Test']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(repo, 'README.md'), '# demo\n');
  await git(repo, ['add', '.']);
  await git(repo, [...identity, 'commit', '-q', '-m', 'init']);
  await git(repo, ['branch', 'staging']);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('naming', () => {
  it('slugifies and builds devflow branch names', () => {
    expect(slugify('Add Login page!! (v2)')).toBe('add-login-page-v2');
    expect(slugify('***')).toBe('task');
    expect(branchName('claude-1', 'feature', 'T-12', 'Add login')).toBe('claude-1/feature/t-12-add-login');
  });
});

describe('worktrees', () => {
  it('creates a worktree on its own branch, tracks changes, commits and removes it', async () => {
    const path = await createWorktree({
      repo,
      worktreesRoot: join(root, 'wt'),
      taskId: 'T-1',
      branch: 'claude-1/feature/t-1-hello',
      base: 'staging',
    });
    expect(await currentBranch(path)).toBe('claude-1/feature/t-1-hello');
    // Reusing returns the same path.
    expect(await createWorktree({ repo, worktreesRoot: join(root, 'wt'), taskId: 'T-1', branch: 'x', base: 'staging' })).toBe(path);

    writeFileSync(join(path, 'hello.txt'), 'hi\n');
    expect(await changedFiles(path, 'staging')).toEqual(['hello.txt']);
    expect(await commitAll(path, 'Add hello')).toBe(true);
    expect(await commitAll(path, 'nothing')).toBe(false);
    expect(await commitsAhead(path, 'staging')).toBe(1);
    expect(await changedFiles(path, 'staging')).toEqual(['hello.txt']);

    await removeWorktree(repo, path);
    expect(await git(repo, ['branch', '--list', 'claude-1/feature/t-1-hello'])).toContain('t-1-hello');
  });
});

describe('protected-branch hook', () => {
  it('refuses pushes to protected branches and allows feature branches', async () => {
    const remote = join(root, 'remote.git');
    await git(root, ['init', '-q', '--bare', remote]);
    await git(repo, ['remote', 'add', 'origin', remote]);
    expect(await hasRemote(repo)).toBe(true);

    expect(await installPrePushHook(repo, prePushHook(), HOOK_MARKER)).toBe('installed');
    expect(await installPrePushHook(repo, prePushHook(), HOOK_MARKER)).toBe('already-installed');

    await expect(git(repo, ['push', 'origin', 'main'])).rejects.toThrow(/protected branch/);
    await expect(git(repo, ['push', 'origin', 'HEAD:refs/heads/staging'])).rejects.toThrow(/protected branch/);

    await git(repo, ['switch', '-q', '-c', 'claude-1/feature/t-1-x']);
    await pushBranch(repo, 'claude-1/feature/t-1-x');
    expect(await git(remote, ['branch', '--list'])).toContain('claude-1/feature/t-1-x');
  });

  it('never overwrites an existing hook', async () => {
    writeFileSync(join(repo, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
    expect(await installPrePushHook(repo, prePushHook(), HOOK_MARKER)).toBe('skipped-existing-hook');
  });

  it('knows the protected names', () => {
    expect(isProtectedBranch('refs/heads/main')).toBe(true);
    expect(isProtectedBranch('staging')).toBe(true);
    expect(isProtectedBranch('claude-1/feature/main-page')).toBe(false);
  });
});
