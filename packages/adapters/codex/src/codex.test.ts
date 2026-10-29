import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessEvent } from '@hyde/core';
import { describe, expect, it } from 'vitest';
import { buildArgs, CodexParser, quotaFromRateLimits } from './index.ts';

const fixtures = join(import.meta.dirname, 'fixtures');
function parse(name: string, wantsJson = false): HarnessEvent[] {
  const p = new CodexParser('gpt-x', wantsJson);
  const events = readFileSync(join(fixtures, name), 'utf8').split('\n').flatMap((l) => p.parseLine(l));
  return [...events, ...p.finish({ code: 0, signal: null }, false)];
}

describe('CodexParser (recorded codex-cli 0.162.1 streams)', () => {
  it('maps a shell run', () => {
    const events = parse('shell.jsonl');
    expect(events[0]).toEqual({ type: 'run.started', sessionRef: '01a18425-a3e5-7653-bf33-e93ec1feef23', model: 'gpt-x' });
    expect(events).toContainEqual({ type: 'tool.started', tool: 'Bash', summary: `/bin/bash -lc "printf 'hi' > hello.txt"` });
    expect(events).toContainEqual({ type: 'tool.finished', tool: 'Bash', summary: 'ok' });
    expect(events).toContainEqual({ type: 'usage', inputTokens: 40780, outputTokens: 53 });
    expect(events.at(-1)).toEqual({ type: 'run.completed', summary: 'done' });
  });

  it('maps MCP tool calls', () => {
    const events = parse('mcp-call.jsonl');
    expect(events).toContainEqual({ type: 'tool.started', tool: 'mcp__hyde__report_progress', summary: '{"message":"probe"}' });
    expect(events).toContainEqual({ type: 'tool.finished', tool: 'mcp__hyde__report_progress', summary: 'error' });
  });

  it('maps file changes and parses a JSON final answer', () => {
    const events = parse('file-change.jsonl', true);
    expect(events).toContainEqual({ type: 'file.changed', path: '/work/task/notes.txt' });
    expect(events.at(-1)).toEqual({ type: 'run.completed', summary: '{"ok":true}', structured: { ok: true } });
  });

  it('classifies failures and missing results', () => {
    const p = new CodexParser('m', false);
    expect(p.parseLine(JSON.stringify({ type: 'turn.failed', error: { message: 'You have hit your usage limit' } }))).toEqual([
      { type: 'run.failed', reason: 'rate_limit', detail: 'You have hit your usage limit' },
    ]);
    const q = new CodexParser('m', false);
    q.parseLine(JSON.stringify({ type: 'error', message: '401 Unauthorized' }));
    expect(q.finish({ code: 1, signal: null }, false)).toEqual([{ type: 'run.failed', reason: 'auth', detail: '401 Unauthorized' }]);
    expect(new CodexParser('m', false).finish({ code: null, signal: 'SIGINT' }, true)).toEqual([{ type: 'run.failed', reason: 'cancelled' }]);
  });
});

describe('buildArgs', () => {
  it('builds an isolated, sandboxed, never-asking exec with the harness MCP server', () => {
    const args = buildArgs({
      cwd: '/w',
      runDir: '/r',
      prompt: 'do it',
      model: 'gpt-5',
      writableDirs: ['/repo/.git'],
      mcp: { command: '/usr/bin/node', args: ['--import', 'file:///x y/tsx.mjs', '/x y/main.ts'], env: { HYDE_RUN_TOKEN: 't' } },
    });
    expect(args.slice(0, 4)).toEqual(['exec', '--json', '--ignore-user-config', '--skip-git-repo-check']);
    expect(args).toEqual(
      expect.arrayContaining([
        'sandbox_mode="workspace-write"',
        'approval_policy="never"',
        'sandbox_workspace_write.writable_roots=["/repo/.git"]',
        'mcp_servers.hyde.args=["--import","file:///x y/tsx.mjs","/x y/main.ts"]',
        'mcp_servers.hyde.env={HYDE_RUN_TOKEN="t"}',
        'mcp_servers.hyde.default_tools_approval_mode="approve"',
      ]),
    );
    expect(args.at(-1)).toBe('do it');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('resumes a thread and makes review runs read-only with a schema', () => {
    const args = buildArgs({ cwd: '/w', runDir: '/r', prompt: 'review', readOnly: true, jsonSchema: {} }, 'thread-1');
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'thread-1']);
    expect(args).toEqual(expect.arrayContaining(['sandbox_mode="read-only"', '--output-schema', '/r/codex-schema.json']));
  });
});

describe('quotaFromRateLimits (recorded account/rateLimits/read)', () => {
  it('maps the 5-hour and weekly windows', () => {
    const result = {
      rateLimits: {
        primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: 1793234681 },
        secondary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: 1793798108 },
        rateLimitReachedType: null,
      },
    };
    expect(quotaFromRateLimits(result)).toEqual([
      { window: 'five_hour', utilization: 0.31, status: 'allowed', resetsAt: 1793234681 },
      { window: 'seven_day', utilization: 0.85, status: 'warning', resetsAt: 1793798108 },
    ]);
    expect(quotaFromRateLimits(null)).toEqual([]);
  });
});
