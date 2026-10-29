import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessEvent } from '@hyde/core';
import { describe, expect, it } from 'vitest';
import { bashPattern, buildArgs, buildConfig, OpenCodeParser } from './index.ts';

const fixtures = join(import.meta.dirname, 'fixtures');

describe('OpenCodeParser (recorded opencode 1.19.0 stream)', () => {
  it('maps a write, an MCP call and the final answer', () => {
    const p = new OpenCodeParser('opencode/big-pickle', false);
    const events = readFileSync(join(fixtures, 'write-and-mcp.jsonl'), 'utf8').split('\n').flatMap((l) => p.parseLine(l));
    events.push(...p.finish({ code: 0, signal: null }, false));
    expect(events[0]).toEqual({ type: 'run.started', sessionRef: 'ses_e7bd74696ffeaCt7D5dtrnazLC', model: 'opencode/big-pickle' });
    expect(events).toContainEqual({ type: 'file.changed', path: '/work/task/hello2.txt' });
    expect(events).toContainEqual({ type: 'tool.finished', tool: 'hyde_report_progress', summary: 'error' });
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', summary: expect.stringContaining('hello2.txt') });
  });

  it('reports errors, non-zero exits and cancellations', () => {
    const p = new OpenCodeParser('m', false);
    p.parseLine(JSON.stringify({ type: 'error', sessionID: 's', error: { data: { message: 'Rate limit exceeded' } } }));
    expect(p.finish({ code: 1, signal: null }, false)).toEqual([{ type: 'run.failed', reason: 'rate_limit', detail: 'Rate limit exceeded' }]);
    expect(new OpenCodeParser('m', false).finish({ code: 2, signal: null }, false)[0]).toMatchObject({ reason: 'crashed' });
    expect(new OpenCodeParser('m', false).finish({ code: null, signal: 'SIGINT' }, true)).toEqual([{ type: 'run.failed', reason: 'cancelled' }]);
  });

  it('treats a clean exit after a tool-only step as a finished turn (regression: false "no output" crashes)', () => {
    const p = new OpenCodeParser('m', false);
    p.parseLine(JSON.stringify({ type: 'step_finish', sessionID: 's', part: { reason: 'tool-calls', tokens: {} } }));
    expect(p.finish({ code: 0, signal: null }, false)).toEqual([{ type: 'run.completed', summary: '' }]);
  });

  it('parses structured answers', () => {
    const p = new OpenCodeParser('m', true);
    p.parseLine(JSON.stringify({ type: 'text', sessionID: 's', part: { text: '```json\n{"verdict":"approve"}\n```' } }));
    p.parseLine(JSON.stringify({ type: 'step_finish', sessionID: 's', part: { reason: 'stop', tokens: {} } }));
    expect(p.finish({ code: 0, signal: null }, false).at(-1)).toMatchObject({ structured: { verdict: 'approve' } });
  });
});

describe('config and args', () => {
  it('translates deny rules and the MCP server', () => {
    expect(bashPattern('Bash(git push:*)')).toBe('git push*');
    expect(bashPattern('Read(./.env)')).toBeNull();
    const config = buildConfig({
      cwd: '/w',
      runDir: '/r',
      prompt: 'x',
      packetFile: '/r/packet.md',
      deny: ['Bash(git push:*)', 'Bash(rm -rf:*)'],
      mcp: { command: 'node', args: ['main.ts'], env: { A: '1' } },
    });
    expect(config).toMatchObject({
      permission: { edit: 'allow', bash: { '*': 'allow', 'git push*': 'deny', 'rm -rf*': 'deny' } },
      instructions: ['/r/packet.md'],
      mcp: { hyde: { type: 'local', command: ['node', 'main.ts'], environment: { A: '1' }, enabled: true } },
    });
    expect(buildConfig({ cwd: '/w', runDir: '/r', prompt: 'x', readOnly: true })).toMatchObject({ permission: { edit: 'deny', bash: { '*': 'deny' } } });
  });

  it('asks for JSON when a schema is set and resumes sessions', () => {
    const args = buildArgs({ cwd: '/w', runDir: '/r', prompt: 'plan', model: 'opencode/big-pickle', jsonSchema: { type: 'object' } }, 'ses_1');
    expect(args.slice(0, 4)).toEqual(['run', '--format', 'json', '--pure']);
    expect(args).toEqual(expect.arrayContaining(['-m', 'opencode/big-pickle', '--session', 'ses_1']));
    expect(args.at(-1)).toContain('{"type":"object"}');
  });
});
