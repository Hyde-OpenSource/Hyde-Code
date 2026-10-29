import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentActivity, describeEvent, EventStore, openCount, replay, sessionLine, shortPaths, snapshot } from './index.ts';

const harness = { kind: 'harness', id: 'hub' } as const;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** T-1 being built by claude-1, T-2 being planned by codex-1, with an open question on T-1. */
function officeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hyde-office-'));
  dirs.push(dir);
  const s = new EventStore(join(dir, 'events.db'));
  for (const [id, title] of [['T-1', 'Add login'], ['T-2', 'Add search']] as const) {
    s.append({ type: 'task.created', actor: { kind: 'user', id: 'tg:1' }, taskId: id, payload: { taskId: id, projectId: 'demo', title, spec: title, source: { kind: 'cli' } } });
  }
  s.append({ type: 'run.dispatched', actor: harness, taskId: 'T-1', runId: 'run-1', payload: { runId: 'run-1', taskId: 'T-1', attempt: 1, adapter: 'claude-code', account: 'a', agent: 'claude-1', mode: 'start' } });
  s.append({ type: 'run.event', actor: harness, taskId: 'T-1', runId: 'run-1', payload: { runId: 'run-1', event: { type: 'tool.started', tool: 'Edit', summary: '/home/x/.hyde/worktrees/demo/T-1/src/login.ts' } } });
  s.append({ type: 'run.dispatched', actor: harness, taskId: 'T-2', runId: 'run-2', payload: { runId: 'run-2', taskId: 'T-2', attempt: 1, adapter: 'codex', account: 'b', agent: 'codex-1', mode: 'plan' } });
  const events = s.list();
  const state = snapshot(replay(events));
  s.close();
  return { state, events };
}

const agent = (name: string, extra: Partial<{ enabled: boolean; health: { installed: boolean; signedIn: boolean; problem?: string } | null }> = {}) => ({ name, enabled: true, health: null, ...extra });

describe('agentActivity', () => {
  it('puts each agent where its work is', () => {
    const { state } = officeFixture();
    expect(agentActivity(state, agent('claude-1'))).toMatchObject({ mood: 'working', spot: 'desk', taskId: 'T-1' });
    expect(agentActivity(state, agent('codex-1'))).toMatchObject({ mood: 'planning', spot: 'whiteboard', taskId: 'T-2' });
    expect(agentActivity(state, agent('opencode-1'))).toMatchObject({ mood: 'idle', spot: 'coffee' });
    expect(agentActivity(state, agent('gemini-1', { enabled: false }))).toMatchObject({ mood: 'off', spot: 'away' });
    expect(agentActivity(state, agent('x', { health: { installed: true, signedIn: false } }))).toMatchObject({ mood: 'broken', line: 'Not signed in' });
  });

  it('shows an agent blocked on a question as needing you', () => {
    const { state } = officeFixture();
    state.questions.push({ id: 'Q-1', taskId: 'T-1', runId: 'run-1', text: 'Which provider?', blocking: true, options: [], status: 'open', askedTs: '' });
    expect(agentActivity(state, agent('claude-1'))).toMatchObject({ mood: 'needs-you', taskId: 'T-1' });
    expect(openCount(state)).toBe(1);
    state.tasks[0]!.status = 'cancelled';
    expect(openCount(state)).toBe(0);
  });
});

describe('feed and session lines', () => {
  it('describes the events people care about and skips the noise', () => {
    const { events } = officeFixture();
    const lines = events.map(describeEvent).filter(Boolean);
    expect(lines).toEqual(['T-1 created: Add login', 'T-2 created: Add search', 'claude-1 picked up T-1 (start)', 'codex-1 picked up T-2 (plan)']);
  });

  it('prints tools like a terminal with worktree paths made relative', () => {
    const { events } = officeFixture();
    expect(events.map(sessionLine).filter(Boolean)).toContainEqual({ kind: 'tool', text: '▸ Edit ./src/login.ts' });
    expect(shortPaths('cd "/a/HYDE CODE/.hyde/worktrees/p/T-9" && ls')).toBe('cd . && ls');
    expect(shortPaths('cat src/a.ts')).toBe('cat src/a.ts');
  });
});
