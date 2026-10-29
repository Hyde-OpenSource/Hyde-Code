import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessEvent, RunSpec } from '@hyde/core';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpAdapter, permissionDenied } from './index.ts';

const agent = join(import.meta.dirname, 'fixtures', 'fake-acp-agent.mjs');
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

async function run(spec: Partial<RunSpec>, env: Record<string, string> = {}): Promise<{ events: HarnessEvent[]; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'hyde-acp-'));
  dirs.push(dir);
  const adapter = new AcpAdapter({ command: [process.execPath, agent] });
  const handle = await adapter.start('run-1', { cwd: dir, runDir: dir, prompt: 'go', env, ...spec });
  const events: HarnessEvent[] = [];
  for await (const e of adapter.events(handle)) events.push(e);
  return { events, dir };
}

describe('AcpAdapter (against a fake ACP agent)', () => {
  it('runs a session: permission, client file write, message, completion', async () => {
    const { events, dir } = await run({});
    expect(events[0]).toEqual({ type: 'run.started', sessionRef: 'acp-sess-1', model: 'acp-agent' });
    expect(events).toContainEqual({ type: 'tool.started', tool: 'execute', summary: 'npm test' });
    expect(events).toContainEqual({ type: 'file.changed', path: join(dir, 'acp.txt') });
    expect(readFileSync(join(dir, 'acp.txt'), 'utf8')).toBe('from acp\n');
    expect(events.at(-1)).toEqual({ type: 'run.completed', summary: 'allowed=true write=ok' });
  });

  it('rejects denied commands and writes in read-only runs', async () => {
    const { events, dir } = await run({ readOnly: true, jsonSchema: { type: 'object' } }, { FAKE_ACP_COMMAND: 'git push origin main' });
    expect(events.some((e) => e.type === 'permission.requested')).toBe(true);
    expect(existsSync(join(dir, 'acp.txt'))).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'run.completed', summary: '{"verdict":"approve"}', structured: { verdict: 'approve' } });
  });

  it('decides permissions from deny rules', () => {
    const spec = { cwd: '/w', runDir: '/r', prompt: '', deny: ['Bash(git push:*)'] };
    expect(permissionDenied(spec, { title: 'git push origin main', kind: 'execute' })).toBe('denied by Bash(git push:*)');
    expect(permissionDenied(spec, { title: 'npm test', kind: 'execute' })).toBeNull();
    expect(permissionDenied({ ...spec, readOnly: true }, { title: 'x', kind: 'edit' })).toMatch(/read-only/);
  });

  it('reports a missing binary in detect()', async () => {
    expect(await new AcpAdapter({ command: ['definitely-not-installed-xyz'] }).detect()).toMatchObject({ installed: false });
  });
});
