import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore, replay, snapshot } from '@hyde/core';
import { afterEach, describe, expect, it } from 'vitest';
import { cursorLimit, inboxEntries, paint, render, width, type TuiState, type TuiView } from './tui-render.ts';

const harness = { kind: 'harness', id: 'hub' } as const;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(): TuiView {
  const dir = mkdtempSync(join(tmpdir(), 'hyde-tui-'));
  dirs.push(dir);
  const s = new EventStore(join(dir, 'events.db'));
  s.append({ type: 'task.created', actor: { kind: 'user', id: 'tg:1' }, taskId: 'T-1', payload: { taskId: 'T-1', projectId: 'demo', title: 'Add a very long feature title that will not fit in any column', spec: 'x', source: { kind: 'cli' } } });
  s.append({ type: 'run.dispatched', actor: harness, taskId: 'T-1', runId: 'run-1', payload: { runId: 'run-1', taskId: 'T-1', attempt: 1, adapter: 'claude-code', account: 'a', agent: 'claude-1', mode: 'start' } });
  s.append({ type: 'approval.requested', actor: harness, taskId: 'T-1', payload: { approvalId: 'A-1', taskId: 'T-1', kind: 'first-push', summary: 'Push feature/t-1' } });
  const events = s.list();
  s.close();
  const state = {
    ...snapshot(replay(events)),
    agents: [
      { name: 'claude-1', adapter: 'claude-code', enabled: true, account: 'a', node: 'local', vendor: 'anthropic', health: null },
      { name: 'codex-1', adapter: 'codex', enabled: true, account: 'b', node: 'local', vendor: 'openai', health: null },
    ],
    projects: [{ id: 'demo', baseBranch: 'staging' }],
    metrics: [],
  } as TuiState;
  return { state, feed: events, screen: 'office', cursor: 0, session: events, connected: true, tick: 0, color: false };
}

describe('terminal UI', () => {
  it('draws every screen exactly the size of the terminal', () => {
    const v = fixture();
    for (const screen of ['office', 'board', 'inbox', 'activity', 'usage'] as const) {
      for (const [cols, rows] of [[80, 24], [140, 40], [50, 15]] as const) {
        const lines = render({ ...v, screen }, cols, rows);
        expect(lines).toHaveLength(rows);
        for (const l of lines) expect(width(l)).toBe(cols);
      }
    }
  });

  it('shows who is working, what needs you, and the session', () => {
    const v = fixture();
    const office = render(v, 120, 30).join('\n');
    expect(office).toContain('3 Inbox (1)');
    expect(office).toContain('claude-1');
    expect(office).toContain('working');
    expect(office).toContain('$ claude-code · start · attempt 1');
    const inbox = render({ ...v, screen: 'inbox' }, 120, 30).join('\n');
    expect(inbox).toContain('APPROVAL');
    expect(inbox).toContain('a approve · d deny');
    expect(inboxEntries(v.state!)).toHaveLength(1);
    expect(cursorLimit(v)).toBe(2);
  });

  it('keeps colour codes out of width math', () => {
    const line = paint([{ text: 'hello', style: 'accent' }], 8, true);
    expect(line).toContain('\x1b[');
    expect(line.replace(/\x1b\[[0-9;]*m/g, '')).toBe('hello   ');
  });
});
