import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessEvent } from '@hyde/core';
import { describe, expect, it } from 'vitest';
import { CommandAdapter } from './index.ts';

async function collect(adapter: CommandAdapter, prompt = 'hello') {
  const dir = mkdtempSync(join(tmpdir(), 'hyde-cmd-'));
  const handle = await adapter.start('run-1', { cwd: dir, runDir: dir, prompt });
  const events: HarnessEvent[] = [];
  for await (const e of adapter.events(handle)) events.push(e);
  rmSync(dir, { recursive: true, force: true });
  return events;
}

describe('CommandAdapter', () => {
  it('passes the prompt as an argument and completes on exit 0', async () => {
    const events = await collect(new CommandAdapter(['sh', '-c', 'echo "got: $0"', '{prompt}']));
    expect(events).toContainEqual({ type: 'text.delta', text: 'got: hello' });
    expect(events.at(-1)).toEqual({ type: 'run.completed', summary: 'got: hello' });
  });

  it('passes the prompt on stdin when there is no placeholder', async () => {
    const events = await collect(new CommandAdapter(['cat']), 'from stdin');
    expect(events.at(-1)).toEqual({ type: 'run.completed', summary: 'from stdin' });
  });

  it('fails on a non-zero exit', async () => {
    const events = await collect(new CommandAdapter(['sh', '-c', 'echo oops; exit 3']));
    expect(events.at(-1)).toMatchObject({ type: 'run.failed', reason: 'crashed', detail: expect.stringContaining('exit code 3') });
  });

  it('detects missing binaries', async () => {
    expect((await new CommandAdapter(['sh']).detect()).installed).toBe(true);
    expect((await new CommandAdapter(['no-such-cli-xyz']).detect()).installed).toBe(false);
  });
});
