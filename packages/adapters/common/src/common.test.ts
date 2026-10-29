import { describe, expect, it } from 'vitest';
import { containerWrapper, failureFromText, parseJsonLoose, scrubEnv, summarize } from './index.ts';

describe('helpers', () => {
  it('scrubs the environment to an allowlist', () => {
    expect(scrubEnv({ PATH: '/bin', OPENAI_API_KEY: 'x', SLACK_BOT_TOKEN: 'y', CODEX_HOME: '/c' }, { A: '1' })).toEqual({ PATH: '/bin', CODEX_HOME: '/c', A: '1' });
  });

  it('parses JSON answers loosely', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('Here:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseJsonLoose('The plan is {"a":3} done')).toEqual({ a: 3 });
    expect(parseJsonLoose('no json')).toBeUndefined();
  });

  it('classifies failure text', () => {
    expect(failureFromText('Error: 401 Unauthorized')).toBe('auth');
    expect(failureFromText('Too Many Requests')).toBe('rate_limit');
    expect(failureFromText('segfault')).toBe('crashed');
  });

  it('summarizes tool inputs', () => {
    expect(summarize({ command: 'ls -la' })).toBe('ls -la');
    expect(summarize({ filePath: '/a/b.ts' })).toBe('/a/b.ts');
    expect(summarize({ x: 'y'.repeat(200) }).length).toBe(120);
  });
});

describe('containerWrapper', () => {
  it('mounts the worktree at the same path and keeps hub env out', () => {
    const wrap = containerWrapper({ image: 'hyde/claude:latest', homeVolume: 'hyde-claude-1-home', readOnlyMounts: ['/hyde'], memory: '4g' });
    const launch = wrap(
      { command: 'claude', args: ['-p', 'hi'], env: { A: '1' } },
      { cwd: '/w/T-1', runDir: '/d/runs/run-1', prompt: 'hi', writableDirs: ['/repo/.git'], env: { HYDE_TASK_ID: 'T-1' } },
    );
    expect(launch.command).toBe('docker');
    expect(launch.args).toEqual([
      'run', '--rm', '-i', '--init',
      '-v', 'hyde-claude-1-home:/home/agent', '-e', 'HOME=/home/agent',
      '-v', '/w/T-1:/w/T-1', '-v', '/d/runs/run-1:/d/runs/run-1', '-v', '/repo/.git:/repo/.git',
      '-v', '/hyde:/hyde:ro',
      '-w', '/w/T-1', '--network', 'host', '--memory', '4g',
      '-e', 'HYDE_TASK_ID=T-1', '-e', 'A=1',
      'hyde/claude:latest', 'claude', '-p', 'hi',
    ]);
  });
});
