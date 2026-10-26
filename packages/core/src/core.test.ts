import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canTransition, EventStore, nextId, replay, retryDelayMs } from './index.ts';

const harness = { kind: 'harness', id: 'hub' } as const;
const dirs: string[] = [];

function store(): { store: EventStore; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hyde-core-'));
  dirs.push(dir);
  const path = join(dir, 'events.db');
  return { store: new EventStore(path), path };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('EventStore', () => {
  it('appends, lists and survives a reopen', () => {
    const { store: s, path } = store();
    s.append({
      type: 'task.created',
      actor: { kind: 'user', id: 'tg:1' },
      taskId: 'T-1',
      payload: { taskId: 'T-1', projectId: 'demo', title: 'Add login', spec: 'Add login', source: { kind: 'cli' } },
    });
    s.append({
      type: 'task.status_changed',
      actor: harness,
      taskId: 'T-1',
      payload: { taskId: 'T-1', from: 'backlog', to: 'ready' },
    });
    s.close();

    const reopened = new EventStore(path);
    const events = reopened.list();
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    const state = replay(events);
    expect(state.tasks.get('T-1')).toMatchObject({ status: 'ready', priority: 2, title: 'Add login' });
    expect(reopened.list({ afterSeq: 1 })).toHaveLength(1);
    reopened.close();
  });

  it('ignores a repeated commandId', () => {
    const { store: s } = store();
    const input = {
      type: 'question.answered' as const,
      actor: { kind: 'user' as const, id: 'tg:1' },
      commandId: 'tg:update:42',
      payload: { questionId: 'Q-1', answer: 'yes', by: 'tg:1' },
    };
    expect(s.append(input)).not.toBeNull();
    expect(s.append(input)).toBeNull();
    expect(s.list()).toHaveLength(1);
    s.close();
  });

  it('rejects an invalid payload', () => {
    const { store: s } = store();
    expect(() =>
      s.append({ type: 'task.pr_opened', actor: harness, payload: { taskId: 'T-1' } as never }),
    ).toThrow();
    s.close();
  });

  it('notifies subscribers', () => {
    const { store: s } = store();
    const seen: string[] = [];
    const off = s.subscribe((r) => seen.push(r.type));
    s.append({ type: 'task.pr_opened', actor: harness, payload: { taskId: 'T-1', url: 'https://x' } });
    off();
    s.append({ type: 'task.pr_opened', actor: harness, payload: { taskId: 'T-1', url: 'https://y' } });
    expect(seen).toEqual(['task.pr_opened']);
    s.close();
  });
});

describe('projection', () => {
  it('tracks runs, usage, session refs and ids', () => {
    const { store: s } = store();
    s.append({
      type: 'task.created',
      actor: harness,
      payload: { taskId: 'T-1', projectId: 'demo', title: 't', spec: 't', source: { kind: 'cli' } },
    });
    s.append({
      type: 'run.dispatched',
      actor: harness,
      payload: { runId: 'run-1', taskId: 'T-1', attempt: 1, adapter: 'claude-code', account: 'me', mode: 'start' },
    });
    s.append({
      type: 'run.event',
      actor: harness,
      payload: { runId: 'run-1', event: { type: 'run.started', sessionRef: 'sess-1', model: 'm' } },
    });
    s.append({
      type: 'run.event',
      actor: harness,
      payload: { runId: 'run-1', event: { type: 'usage', inputTokens: 10, outputTokens: 5, costUsd: 0.01 } },
    });
    s.append({ type: 'run.exited', actor: harness, payload: { runId: 'run-1', code: 0, signal: null } });
    const state = replay(s.list());
    expect(state.tasks.get('T-1')).toMatchObject({ sessionRef: 'sess-1', attempts: 1, runIds: ['run-1'] });
    expect(state.runs.get('run-1')).toMatchObject({ state: 'exited', inputTokens: 10, outputTokens: 5 });
    expect(nextId(state, 'T')).toBe('T-2');
    expect(nextId(state, 'run')).toBe('run-2');
    expect(nextId(state, 'Q')).toBe('Q-1');
    s.close();
  });
});

describe('lifecycle', () => {
  it('only allows listed transitions', () => {
    expect(canTransition('ready', 'running')).toBe(true);
    expect(canTransition('awaiting_merge', 'done')).toBe(true);
    expect(canTransition('ready', 'done')).toBe(false);
    expect(canTransition('done', 'running')).toBe(false);
  });

  it('backs off exponentially up to five minutes', () => {
    expect(retryDelayMs(1)).toBe(10_000);
    expect(retryDelayMs(2)).toBe(20_000);
    expect(retryDelayMs(10)).toBe(300_000);
  });
});
