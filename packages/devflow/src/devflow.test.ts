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
    const task = { id: 'T-1', title: 'Add login', spec: 'Add a login page', kind: 'client', writeScope: ['src/**'], doneWhen: 'login works' } as TaskView;
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
    expect(packet).toContain('CLIENT MESSAGE');
    expect(packet).toContain('**Done when:** login works');
    expect(packet).toContain('`src/**`');
    expect(packet).not.toMatch(/\n\n\n/);
  });

  it('reads lessons from CLAUDE.md', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# x\n## Lessons learned\n<!-- c -->\n- 2026-10-01: a\n- 2026-10-02: b\n\n## Other\n- 2026-10-03: outside the section\n');
    expect(readLessons(dir)).toEqual(['- 2026-10-01: a', '- 2026-10-02: b']);
    expect(readLessons(dir, 1)).toEqual(['- 2026-10-02: b']);
    expect(readLessons(tmp())).toEqual([]);
  });
});

describe('devflow projections', async () => {
  const { emptyState, apply } = await import('@hyde/core');
  const { renderTasks, renderAgents, renderQuestions, renderReports, writeLessons } = await import('./sync.ts');
  const h = { kind: 'harness', id: 'hub' } as const;
  let seq = 0;
  const state = emptyState();
  const add = (type: string, payload: Record<string, unknown>) =>
    apply(state, { seq: ++seq, ts: '2026-10-29T10:00:00.000Z', type, actor: h, payload } as never);
  add('task.created', { taskId: 'T-1', projectId: 'demo', title: 'Add login', spec: 'Add login', priority: 1, source: { kind: 'cli' }, kind: 'task', writeScope: ['src/**'], dependsOn: [] });
  add('task.status_changed', { taskId: 'T-1', from: 'backlog', to: 'ready', reason: 'go' });
  add('run.dispatched', { runId: 'run-1', taskId: 'T-1', attempt: 1, adapter: 'codex', account: 'a', agent: 'codex-1', node: 'local', mode: 'start' });
  add('question.asked', { questionId: 'Q-1', taskId: 'T-1', runId: 'run-1', text: 'OAuth?', blocking: true, options: [] });
  add('question.answered', { questionId: 'Q-1', answer: 'No', by: 'tg:1' });
  add('incident.raised', { incidentId: 'R-1', taskId: 'T-1', about: 'stalled', evidence: 'no events' });

  it('renders tasks, agents, questions, answers and reports in the devflow formats', () => {
    expect(renderTasks(state, 'demo')).toContain('## T-1: Add login\n- **Assigned to:** router');
    expect(renderTasks(state, 'demo')).toContain('- **Files / area:** src/**');
    expect(renderAgents(state, [{ name: 'codex-1', adapter: 'codex', enabled: true, roles: ['implement'], maxConcurrent: 1, account: 'a', node: 'local', isolation: 'worktree' }])).toContain('| codex-1 | default (codex) | child | implement | working |');
    const { questions, answers } = renderQuestions(state, 'demo');
    expect(questions).toContain('- **Status:** ANSWERED');
    expect(answers).toContain('- **Answer:** No');
    expect(renderReports(state, 'demo')).toContain('## R-1: stalled');
  });

  it('writes lessons into CLAUDE.md and mirrors them into AGENTS.md', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# CLAUDE.md\n\n## Lessons learned\n- 2026-10-01: old\n\n## Other\nx\n');
    expect(writeLessons(dir, ['- 2026-10-29: new one'])).toEqual(['CLAUDE.md', 'AGENTS.md']);
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('# CLAUDE.md\n\n## Lessons learned\n- 2026-10-01: old\n- 2026-10-29: new one\n\n## Other\nx\n');
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('# AGENTS\n\n## Lessons learned\n- 2026-10-29: new one\n');
    expect(writeLessons(dir, ['- 2026-10-29: new one'])).toEqual([]);
  });
});
