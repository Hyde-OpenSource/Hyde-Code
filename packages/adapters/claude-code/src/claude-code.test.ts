import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessEvent } from '@hyde/core';
import { describe, expect, it } from 'vitest';
import { buildArgs, ClaudeCodeAdapter, scrubEnv, StreamParser } from './index.ts';

const fixtures = join(import.meta.dirname, 'fixtures');

function parseFixture(name: string): HarnessEvent[] {
  const parser = new StreamParser();
  return readFileSync(join(fixtures, name), 'utf8').split('\n').flatMap((l) => parser.parseLine(l));
}

describe('StreamParser (recorded Claude Code 2.1.310 streams)', () => {
  it('maps a text-only run', () => {
    const events = parseFixture('text-only.jsonl');
    expect(events[0]).toEqual({ type: 'run.started', sessionRef: expect.any(String), model: 'claude-haiku-5-5' });
    expect(events).toContainEqual({ type: 'text.delta', text: 'pong' });
    expect(events).toContainEqual({ type: 'rate_limit', status: 'allowed', window: 'five_hour', resetsAt: 1793056200, utilization: 0.28 });
    expect(events).toContainEqual(expect.objectContaining({ type: 'usage', outputTokens: 4 }));
    expect(events.at(-1)).toEqual({ type: 'run.completed', summary: 'pong' });
  });

  it('maps tool calls and changed files', () => {
    const events = parseFixture('write-tool.jsonl');
    expect(events).toContainEqual({ type: 'tool.started', tool: 'Write', summary: '/work/task/hello.txt' });
    expect(events).toContainEqual({ type: 'file.changed', path: '/work/task/hello.txt' });
    expect(events).toContainEqual({ type: 'tool.finished', tool: 'Write', summary: 'ok' });
    expect(events.at(-1)).toEqual({ type: 'run.completed', summary: 'done' });
  });

  it('ignores junk and unknown lines', () => {
    const parser = new StreamParser();
    expect(parser.parseLine('not json')).toEqual([]);
    expect(parser.parseLine('{"type":"something_new"}')).toEqual([]);
    expect(parser.parseLine('')).toEqual([]);
  });

  it('classifies failures', () => {
    const parser = new StreamParser();
    const auth = parser.parseLine(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 401, result: 'Please run /login' }));
    expect(auth.at(-1)).toMatchObject({ type: 'run.failed', reason: 'auth' });
    const limit = parser.parseLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'limit' }));
    expect(limit.at(-1)).toMatchObject({ type: 'run.failed', reason: 'rate_limit' });
  });

  it('maps a rejected single-window rate limit', () => {
    const parser = new StreamParser();
    const events = parser.parseLine(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 5 } }));
    expect(events).toEqual([{ type: 'rate_limit', status: 'rejected', window: 'five_hour', resetsAt: 5 }]);
  });
});

describe('buildArgs', () => {
  it('builds a headless, unattended, never-bare command', () => {
    const args = buildArgs(
      { cwd: '/w', prompt: 'do it', packetFile: '/p.md', mcpConfigFile: '/m.json', deny: ['Bash(git push*)'], allow: ['mcp__hyde__*'] },
      { resume: 'sess-1' },
    );
    expect(args).not.toContain('--bare');
    expect(args.slice(0, 5)).toEqual(['-p', 'do it', '--output-format', 'stream-json', '--verbose']);
    expect(args).toEqual(expect.arrayContaining(['--permission-prompts', 'none', '--resume', 'sess-1', '--strict-mcp-config']));
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Bash(git push*)');
  });
});

describe('scrubEnv', () => {
  it('keeps the basics and drops secrets', () => {
    const env = scrubEnv({ PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'x', TELEGRAM_BOT_TOKEN: 'y', LC_ALL: 'C' }, { DEVFLOW_HARNESS: '1' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', LC_ALL: 'C', DEVFLOW_HARNESS: '1' });
  });
});

describe('ClaudeCodeAdapter process handling', () => {
  const adapter = new ClaudeCodeAdapter(join(fixtures, 'fake-claude.mjs'));

  it('streams events from the process without leaking secrets', async () => {
    process.env.HYDE_SECRET = 'should-not-leak';
    const handle = await adapter.start('run-1', {
      cwd: fixtures,
      prompt: 'hi',
      env: { FAKE_STREAM: join(fixtures, 'text-only.jsonl') },
    });
    delete process.env.HYDE_SECRET;
    const events: HarnessEvent[] = [];
    for await (const e of adapter.events(handle)) events.push(e);
    expect(events.at(-1)).toEqual({ type: 'run.completed', summary: 'pong' });
    expect(await handle.exited).toEqual({ code: 0, signal: null });
  });

  it('reports a cancelled run after SIGINT', async () => {
    const handle = await adapter.start('run-2', {
      cwd: fixtures,
      prompt: 'hi',
      env: { FAKE_STREAM: join(fixtures, 'text-only.jsonl'), FAKE_HANG: '1' },
    });
    const events: HarnessEvent[] = [];
    const done = (async () => {
      for await (const e of adapter.events(handle)) {
        events.push(e);
        if (e.type === 'run.started') await adapter.interrupt(handle);
      }
    })();
    await done;
    expect(events.at(-1)).toEqual({ type: 'run.failed', reason: 'cancelled' });
  });

  it('stops a run whose harness MCP server failed to connect (regression: path with a space)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hyde-mcp-'));
    const mcpConfigFile = join(dir, 'mcp.json');
    writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: { hyde: { command: 'x' } } }));
    const handle = await adapter.start('run-3', {
      cwd: fixtures,
      prompt: 'hi',
      mcpConfigFile,
      env: { FAKE_STREAM: join(fixtures, 'mcp-failed.jsonl'), FAKE_HANG: '1' },
    });
    const events: HarnessEvent[] = [];
    for await (const e of adapter.events(handle)) events.push(e);
    rmSync(dir, { recursive: true, force: true });
    expect(events.at(-1)).toEqual({ type: 'run.failed', reason: 'crashed', detail: 'MCP server(s) failed to connect: hyde' });
  });
});
