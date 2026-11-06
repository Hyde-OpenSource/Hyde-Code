import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRawConfig } from './config.ts';
import { isTrusted, readTrust, TERMS_VERSION, termsAccepted, trustFolder, untrustFolder } from './home.ts';
import { addProject, projectId, removeProject } from './projects.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'hyde-proj-'));
  dirs.push(d);
  return d;
}
function repo(path: string): string {
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: path });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: path });
  return path;
}

describe('trust', () => {
  it('records the folder and the terms version, and forgets on request', () => {
    const home = tmp();
    const folder = tmp();
    expect(isTrusted(folder, home)).toBe(false);
    trustFolder(folder, home);
    expect(isTrusted(folder, home)).toBe(true);
    expect(termsAccepted(home)).toBe(true);
    expect(readTrust(home).terms?.version).toBe(TERMS_VERSION);
    untrustFolder(folder, home);
    expect(isTrusted(folder, home)).toBe(false);
  });
});

describe('projects', () => {
  it('gives unique ids and adds a folder once', async () => {
    expect(projectId('/x/My App', [])).toBe('my-app');
    expect(projectId('/y/my-app', ['my-app'])).toBe('my-app-2');

    const root = tmp();
    const a = repo(join(root, 'alpha'));
    const b = repo(join(root, 'beta'));
    writeFileSync(join(b, 'package.json'), JSON.stringify({ name: 'beta-web', scripts: { test: 'vitest' } }));
    writeFileSync(join(b, 'pnpm-lock.yaml'), '');
    const file = join(root, 'config.json');
    writeFileSync(file, JSON.stringify({ agents: [{ name: 'claude-1', adapter: 'claude-code' }], projects: [{ id: 'alpha', path: a }] }));

    const first = await addProject(file, b);
    expect(first.added).toBe(true);
    expect(first.project).toMatchObject({ id: 'beta', name: 'beta-web', baseBranch: 'main', checks: ['pnpm test'] });
    expect((await addProject(file, b)).added).toBe(false);
    expect(readRawConfig(file).projects?.map((p) => p.id)).toEqual(['alpha', 'beta']);

    removeProject(file, 'beta');
    expect(readRawConfig(file).projects?.map((p) => p.id)).toEqual(['alpha']);
    expect(() => removeProject(file, 'alpha')).toThrow(/at least one/);
    await expect(addProject(file, join(root, 'nope'))).rejects.toThrow(/does not exist/);
  });
});
