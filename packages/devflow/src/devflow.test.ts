import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskView } from '@hyde/core';
import { afterEach, describe, expect, it } from 'vitest';
import { addProgressEntry, buildTaskPacket, readLessons, type ProgressEntry } from './index.ts';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'hyde-devflow-'));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const entry: ProgressEntry = {
  date: '2026-10-27',
  title: 'T-1: Add login',
  agent: 'claude-1',
  model: 'claude-opus-5-5',
  branch: 'claude-1/feature/t-1-add-login',
  what: 'Added login',
  why: 'Telegram request',
  files: ['src/login.ts'],
  verified: 'npm test passed',
  followUps: '',
};

describe('progress.md', () => {
  it('inserts newest-first below the Log marker', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'progress.md'), '# Progress\n\n## Log\n<!-- New entries go directly below this line, newest first. -->\n\n### 2026-10-01: old\n');
    expect(addProgressEntry(dir, entry)).toBe(true);
    expect(addProgressEntry(dir, { ...entry, title: 'T-2: newer' })).toBe(true);
    const text = readFileSync(join(dir, 'progress.md'), 'utf8');
    expect(text.indexOf('T-2: newer')).toBeLessThan(text.indexOf('T-1: Add login'));
    expect(text.indexOf('T-1: Add login')).toBeLessThan(text.indexOf('2026-10-01: old'));
    expect(text).toContain('- **Open / follow-ups:** none');
  });

  it('appends when the marker is missing and skips repos without progress.md', () => {
    const dir = tmp();
    expect(addProgressEntry(dir, entry)).toBe(false);
    writeFileSync(join(dir, 'progress.md'), '# Progress');
    addProgressEntry(dir, entry);
    expect(readFileSync(join(dir, 'progress.md'), 'utf8')).toMatch(/^# Progress\n\n### 2026-10-27/);
  });
});

describe('packet and lessons', () => {
  it('builds a packet with rules, answers and lessons', () => {
    const task = { id: 'T-1', title: 'Add login', spec: 'Add a login page' } as TaskView;
    const packet = buildTaskPacket({
      task,
      agent: 'claude-1',
      model: 'default',
      branch: 'b',
      baseBranch: 'staging',
      projectName: 'demo',
      answers: [{ id: 'Q-1', text: 'OAuth?', answer: 'No', status: 'answered' } as never],
      lessons: ['- 2026-10-01: run tests first'],
    });
    expect(packet).toContain('T-1: Add login');
    expect(packet).toContain('Q-1: OAuth? → **No**');
    expect(packet).toContain('run tests first');
    expect(packet).toContain('complete_task');
  });

  it('reads lessons from CLAUDE.md', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# x\n## Lessons learned\n<!-- c -->\n- 2026-10-01: a\n- 2026-10-02: b\n\n## Other\n- 2026-10-03: outside the section\n');
    expect(readLessons(dir)).toEqual(['- 2026-10-01: a', '- 2026-10-02: b']);
    expect(readLessons(dir, 1)).toEqual(['- 2026-10-02: b']);
    expect(readLessons(tmp())).toEqual([]);
  });
});
