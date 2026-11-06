import { existsSync, readFileSync } from 'node:fs';
import type { QuotaSnapshot } from '@hyde/core';
import { afterEach, describe, expect, it } from 'vitest';
import { answer, doWork, makeHarness, type Harness, type Turn } from './test-helpers.ts';

let h: Harness;
afterEach(async () => h?.close());
const status = (id: string) => h.o.state.tasks.get(id)?.status;
const stopsEarly: Turn = async () => [{ type: 'run.completed', summary: 'I edited the file.' }];
const silent: Turn = async () => [{ type: 'run.failed', reason: 'crashed', detail: 'no output' }];
const plan = {
  complexity: 'low',
  complexityReason: 'small',
  questions: [],
  assumptions: [],
  tasks: [{ key: 'a', title: 'Add a hello file', spec: 'Write hello.txt', doneWhen: 'hello.txt exists with hi', writeScope: ['hello.txt'], role: 'implement', dependsOn: [], size: 'S', complexity: 'low' }],
};

describe('real-run failures (T-004)', () => {
  it('T-4: an agent that stops without complete_task is nudged once, then the task moves one tier up to another agent', async () => {
    // Before: start, continue, crash "no output", crash "no output", done: 4 runs and 2 backoff retries on OpenCode.
    h = await makeHarness({
      agents: [
        { name: 'opencode-1', vendor: 'other', turns: [stopsEarly, silent] },
        { name: 'claude-1', vendor: 'anthropic', turns: [doWork()] },
      ],
      config: {
        agents: [
          { name: 'opencode-1', adapter: 'claude-code', account: 'oc', model: 'opencode/big-pickle', tiers: { low: { model: 'opencode/big-pickle', free: true } }, roles: ['implement'] },
          { name: 'claude-1', adapter: 'claude-code', account: 'cl', roles: ['implement'] },
        ],
      },
    });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a .editorconfig at the repo root. Nothing else.' }));
    await h.until(() => h.o.state.approvals.has('A-1'), 'done on claude');
    const runs = [...h.o.state.runs.values()].map((r) => `${r.agent}:${r.mode}`);
    expect(runs).toEqual(['opencode-1:start', 'opencode-1:continue', 'claude-1:start']);
    const task = h.o.state.tasks.get('T-1')!;
    expect(task.complexity).toMatchObject({ level: 'medium', by: 'harness' });
    expect(task.leftAgents).toEqual(['opencode-1']);
    expect(task.agent).toBe('claude-1');
    expect(task.branch).toMatch(/^opencode-1\//); // same worktree and branch
    const calls = h.adapters['claude-1']!.calls;
    expect(calls[0]!.prompt).toContain('opencode-1 worked on this before you');
    expect(calls[0]!.spec).toMatchObject({ model: 'sonnet' });
    expect(h.adapters['opencode-1']!.calls[1]!.prompt).toContain('Do not end this turn without calling one of those two tools');
  });

  it('a pinned agent that keeps stopping goes to the owner instead of being moved', async () => {
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [stopsEarly, stopsEarly] }] });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file', agent: 'claude-1' }));
    await h.until(() => status('T-1') === 'failed', 'failed');
    expect([...h.o.state.incidents.values()][0]!.evidence).toMatch(/pinned to claude-1, so it was not moved/);
    expect(h.o.state.runs.size).toBe(2);
  });

  it('Codex out of quota for hours: its task moves to another agent that can do the tier; a reset within 30 min waits', async () => {
    const ask: Turn = async ({ runId, o }) => {
      await o.agentCall(runId, 'ask_question', { question: 'Greeting text?', blocking: true });
      return [{ type: 'run.completed', summary: 'waiting' }];
    };
    h = await makeHarness({
      agents: [
        { name: 'codex-1', vendor: 'openai', turns: [ask] },
        { name: 'claude-1', vendor: 'anthropic', turns: [doWork()] },
      ],
      config: {
        agents: [
          { name: 'codex-1', adapter: 'claude-code', account: 'codex', roles: ['implement'] },
          { name: 'claude-1', adapter: 'claude-code', account: 'claude', roles: ['ui'] },
        ],
      },
    });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file' }));
    await h.until(() => status('T-1') === 'blocked', 'question');
    expect(h.o.state.tasks.get('T-1')!.agent).toBe('codex-1');
    const store = h.store;
    const resetsSoon = Math.floor(h.clock.now / 1000) + 600;
    store.append({ type: 'quota.updated', actor: { kind: 'harness', id: 't' }, payload: { account: 'codex', window: 'five_hour', status: 'rejected', utilization: 1, resetsAt: resetsSoon } });
    await h.o.handle(h.inbound({ kind: 'answer', questionId: 'Q-1', text: 'hi' }));
    await h.until(() => Boolean(h.o.state.tasks.get('T-1')!.waiting), 'waiting notice');
    expect(h.o.state.tasks.get('T-1')!.waiting).toMatch(/codex-1: five_hour limit reached until .*; T-1 continues in its session then/);
    store.append({ type: 'quota.updated', actor: { kind: 'harness', id: 't' }, payload: { account: 'codex', window: 'seven_day', status: 'rejected', utilization: 1, resetsAt: resetsSoon + 3 * 86400 } });
    await h.until(() => h.o.state.approvals.has('A-1'), 'done on claude');
    expect(h.o.state.tasks.get('T-1')!.agent).toBe('claude-1');
    expect(h.store.list({ taskId: 'T-1' }).find((e) => e.type === 'task.reassigned')!.payload).toMatchObject({ from: 'codex-1', reason: expect.stringMatching(/seven_day limit reached until/) });
    expect(h.adapters['claude-1']!.calls[0]!.prompt).toContain('codex-1 worked on this before you');
  });

  it('T-2: a planner whose output does not parse is retried once on a different agent, and its raw output is kept', async () => {
    const garbage: Turn = async () => [{ type: 'run.failed', reason: 'crashed', detail: 'Invalid schema for response_format' }];
    h = await makeHarness({
      agents: [
        { name: 'codex-1', vendor: 'openai', turns: [garbage], roles: ['plan', 'implement'] },
        { name: 'claude-1', vendor: 'anthropic', turns: [answer(plan), doWork()], roles: ['plan', 'implement'] },
      ],
      config: { planner: { enabled: true }, maxConcurrentRuns: 1 },
    });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file' }));
    await h.until(() => h.o.state.runs.size === 1 && h.o.state.runs.get('run-1')!.state === 'exited', 'first plan');
    h.clock.now += 60_000; // past the retry backoff
    await h.until(() => h.o.state.tasks.get('T-1')!.planned, 'planned');
    const plans = [...h.o.state.runs.values()].filter((r) => r.mode === 'plan').map((r) => r.agent);
    expect(plans).toEqual(['codex-1', 'claude-1']);
    const art = [...h.o.state.artifacts.values()].find((a) => a.kind === 'log')!;
    expect(art.label).toMatch(/^planner output of run-1/);
    expect(existsSync(art.path)).toBe(true);
    expect(readFileSync(art.path, 'utf8')).toContain('Invalid schema for response_format');
  });

  it('keeps the reset time the CLI reported after a rate-limited run instead of guessing an hour', async () => {
    const limited: Turn = async () => [
      { type: 'rate_limit', status: 'rejected', window: 'five_hour', utilization: 1, resetsAt: Math.floor(h.clock.now / 1000) + 4 * 3600 },
      { type: 'run.failed', reason: 'rate_limit', detail: 'limit' },
    ];
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [limited] }] });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file' }));
    await h.until(() => h.o.state.runs.get('run-1')?.state === 'exited' && status('T-1') === 'ready', 'rate limited');
    const q = h.o.state.quotas.get('claude-1:five_hour')!;
    expect(q.resetsAt).toBe(Math.floor(h.clock.now / 1000) + 4 * 3600);
  });

  it('records a quota window only when it really changes (Codex resetsAt drifted every 5 minutes)', async () => {
    h = await makeHarness({ agents: [{ name: 'codex-1', vendor: 'openai', turns: [] }] });
    const adapter = h.adapters['codex-1']! as unknown as { quota: () => Promise<QuotaSnapshot[]> };
    let reset = 1796112139;
    adapter.quota = async () => [
      { window: 'primary_43200m', status: 'allowed', utilization: 0, resetsAt: (reset += 300) },
      { window: 'five_hour', status: 'allowed', utilization: 0.241, resetsAt: 1793253142 + (reset % 2) },
    ];
    for (let i = 0; i < 6; i++) {
      h.clock.now += 5 * 60_000 + 1;
      await h.o.tick();
    }
    const quota = h.store.list().filter((e) => e.type === 'quota.updated');
    expect(quota).toHaveLength(2);
  });
});
