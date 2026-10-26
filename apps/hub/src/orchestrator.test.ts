import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EventStore,
  type AgentAdapter,
  type HarnessEvent,
  type OutboundMessage,
  type RunHandle,
  type RunSpec,
} from '@hyde/core';
import { git } from '@hyde/workspace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HubConfig } from './config.ts';
import { Orchestrator } from './orchestrator.ts';

type Turn = (ctx: { runId: string; spec: RunSpec; resumed: boolean; o: Orchestrator }) => Promise<HarnessEvent[]>;

/** An adapter that plays scripted turns instead of launching a CLI. */
class ScriptedAdapter implements AgentAdapter {
  readonly kind = 'claude-code' as const;
  readonly calls: { runId: string; prompt: string; resumed: boolean }[] = [];
  private readonly pending = new Map<string, { spec: RunSpec; resumed: boolean; resolve: (v: { code: number; signal: null }) => void }>();
  orchestrator!: Orchestrator;

  constructor(private readonly turns: Turn[]) {}
  detect() {
    return Promise.resolve({ installed: true, signedIn: true });
  }
  start(runId: string, spec: RunSpec) {
    return Promise.resolve(this.handle(runId, spec, false));
  }
  resume(runId: string, _session: string, spec: RunSpec) {
    return Promise.resolve(this.handle(runId, spec, true));
  }
  send() {
    return Promise.resolve();
  }
  interrupt() {
    return Promise.resolve();
  }
  quota() {
    return Promise.resolve(null);
  }
  async *events(h: RunHandle): AsyncIterable<HarnessEvent> {
    const p = this.pending.get(h.runId)!;
    const turn = this.turns.shift();
    if (!turn) throw new Error('no scripted turn left');
    try {
      yield { type: 'run.started', sessionRef: 'sess-1', model: 'test-model' };
      for (const e of await turn({ runId: h.runId, spec: p.spec, resumed: p.resumed, o: this.orchestrator })) yield e;
    } finally {
      p.resolve({ code: 0, signal: null });
    }
  }
  private handle(runId: string, spec: RunSpec, resumed: boolean): RunHandle {
    this.calls.push({ runId, prompt: spec.prompt, resumed });
    let resolve!: (v: { code: number; signal: null }) => void;
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => (resolve = r));
    this.pending.set(runId, { spec, resumed, resolve });
    return { runId, pid: 1, exited };
  }
}

let root: string;
let repo: string;
let remote: string;
let store: EventStore;
let sent: { chatId: string | undefined; message: OutboundMessage }[];
let clock: number;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'hyde-hub-'));
  repo = join(root, 'repo');
  remote = join(root, 'remote.git');
  await git(root, ['init', '-q', '-b', 'main', repo]);
  await git(repo, ['config', 'user.name', 'Test']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  writeFileSync(
    join(repo, 'progress.md'),
    '# Progress\n\n## Log\n<!-- New entries go directly below this line, newest first. -->\n',
  );
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  await git(repo, ['branch', 'staging']);
  await git(root, ['init', '-q', '--bare', remote]);
  await git(repo, ['remote', 'add', 'origin', remote]);
  store = new EventStore(join(root, 'events.db'));
  sent = [];
  clock = Date.parse('2026-10-27T10:00:00Z');
});

afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function config(overrides: Partial<HubConfig> = {}): HubConfig {
  return {
    dataDir: join(root, 'data'),
    configDir: root,
    port: 0,
    agent: { name: 'claude-1' },
    maxConcurrentRuns: 1,
    quotaSoftCeiling: 0.8,
    stallTimeoutMinutes: 15,
    maxAttempts: 2,
    maxContinuations: 1,
    maxFixRounds: 1,
    checkTimeoutMinutes: 1,
    callbackSecret: 's',
    projects: [{ id: 'demo', path: repo, baseBranch: 'staging', checks: ['test -f hello.txt'] }],
    ...overrides,
  };
}

function setup(turns: Turn[], overrides: Partial<HubConfig> = {}) {
  const adapter = new ScriptedAdapter(turns);
  const prs: { base: string; head: string; title: string }[] = [];
  const o = new Orchestrator({
    config: config(overrides),
    store,
    adapter,
    hubUrl: 'http://127.0.0.1:0',
    notify: async (chatId, message) => void sent.push({ chatId, message }),
    openPullRequest: async (_cwd, pr) => {
      prs.push(pr);
      return 'https://github.com/me/demo/pull/1';
    },
    log: () => {},
    now: () => clock,
  });
  adapter.orchestrator = o;
  return { o, adapter, prs };
}

async function until(o: Orchestrator, check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await o.tick();
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}: ${o.statusText()}`);
}

const inbound = (text: string, n: number) => ({ userId: 'tg:1', chatId: '100', commandId: `tg:${n}` });

/** A turn that writes hello.txt, commits it and reports done. */
const doTheWork: Turn = async ({ runId, spec, o }) => {
  writeFileSync(join(spec.cwd, 'hello.txt'), 'hi\n');
  await git(spec.cwd, ['add', 'hello.txt']);
  await git(spec.cwd, ['commit', '-q', '-m', 'Add hello.txt']);
  await o.agentCall(runId, 'complete_task', { summary: 'Added hello.txt', verified: 'cat hello.txt', filesChanged: ['hello.txt'] });
  return [{ type: 'run.completed', summary: 'done' }];
};

describe('Orchestrator: the Phase 0 loop', () => {
  it('turns one message into a verified branch, a push approval and a PR', async () => {
    const { o, adapter, prs } = setup([doTheWork]);
    const reply = await o.handle({ command: { kind: 'new', text: 'Add a hello file' }, ...inbound('', 1) });
    expect(reply).toMatch(/^T-1 accepted for #demo/);

    await until(o, () => o.state.tasks.get('T-1')?.status === 'blocked', 'push approval');
    const task = o.state.tasks.get('T-1')!;
    expect(task.branch).toBe('claude-1/feature/t-1-add-a-hello-file');
    expect(task.checks).toMatchObject({ ok: true });
    expect(adapter.calls[0]!.prompt).toContain('Start task T-1');

    // progress.md entry written and committed by the harness on the task branch.
    const progress = readFileSync(join(task.worktree!, 'progress.md'), 'utf8');
    expect(progress).toContain('### 2026-10-27: T-1: Add a hello file');
    expect(progress).toContain('- **Files:** hello.txt');
    expect(await git(task.worktree!, ['status', '--porcelain'])).toBe('');

    const ask = sent.at(-1)!;
    expect(ask.chatId).toBe('100');
    expect(ask.message.text).toContain('A-1: push');
    expect(ask.message.buttons?.[0]?.[0]?.action).toEqual({ kind: 'decide', approvalId: 'A-1', approved: true });

    expect(await o.handle({ command: { kind: 'decide', approvalId: 'A-1', approved: true }, ...inbound('', 2) })).toMatch(/approved/);
    await until(o, () => o.state.tasks.get('T-1')?.status === 'awaiting_merge', 'PR');
    expect(task.prUrl).toBe('https://github.com/me/demo/pull/1');
    expect(prs[0]).toMatchObject({ base: 'staging', head: task.branch, title: 'T-1: Add a hello file' });
    expect(await git(remote, ['branch', '--list'])).toContain(task.branch!);
    expect(await git(remote, ['branch', '--list', 'main'])).toBe('');
    expect(sent.at(-1)!.message.text).toContain('PR: https://github.com/me/demo/pull/1');

    // A retried approval tap is ignored.
    expect(await o.handle({ command: { kind: 'decide', approvalId: 'A-1', approved: true }, ...inbound('', 2) })).toMatch(/already/);
  });

  it('parks on a blocking question and resumes the same session with the answer', async () => {
    const { o, adapter } = setup([
      async ({ runId, o }) => {
        await o.agentCall(runId, 'ask_question', { question: 'Greeting text?', blocking: true, options: ['hi', 'hello'] });
        return [{ type: 'run.completed', summary: 'waiting' }];
      },
      doTheWork,
    ]);
    await o.handle({ command: { kind: 'new', text: 'Add a hello file' }, ...inbound('', 1) });
    await until(o, () => o.state.tasks.get('T-1')?.status === 'blocked', 'question');
    expect(o.state.tasks.get('T-1')!.blockedBy).toEqual({ kind: 'question', id: 'Q-1' });
    const q = sent.find((s) => s.message.questionId === 'Q-1')!;
    expect(q.message.buttons?.map((r) => r[0]!.label)).toEqual(['hi', 'hello']);

    await o.handle({ command: { kind: 'answer', questionId: 'Q-1', text: '#option:1' }, ...inbound('', 2) });
    await until(o, () => o.state.approvals.has('A-1'), 'completion after answer');
    expect(adapter.calls[1]).toMatchObject({ resumed: true });
    expect(adapter.calls[1]!.prompt).toContain('answered Q-1 ("Greeting text?"): hello');
  });

  it('sends failing checks back to the agent, then raises an incident after the fix limit', async () => {
    const lazy: Turn = async ({ runId, spec, o }) => {
      writeFileSync(join(spec.cwd, 'other.txt'), `${runId}\n`);
      await git(spec.cwd, ['add', '.']);
      await git(spec.cwd, ['commit', '-q', '-m', 'wrong file']);
      await o.agentCall(runId, 'complete_task', { summary: 'done?', verified: 'trust me' });
      return [{ type: 'run.completed', summary: 'done' }];
    };
    const { o, adapter } = setup([lazy, lazy]);
    await o.handle({ command: { kind: 'new', text: 'Add a hello file' }, ...inbound('', 1) });
    await until(o, () => o.state.tasks.get('T-1')?.status === 'failed', 'failure');
    expect(adapter.calls[1]!.prompt).toContain('$ test -f hello.txt');
    expect([...o.state.incidents.values()][0]!.about).toMatch(/checks still failing after 1 fix rounds/);
  });

  it('retries a crashed run with backoff, then fails it', async () => {
    const crash: Turn = async () => [{ type: 'run.failed', reason: 'crashed', detail: 'boom' }];
    const { o, adapter } = setup([crash, crash]);
    await o.handle({ command: { kind: 'new', text: 'x' }, ...inbound('', 1) });
    await until(o, () => adapter.calls.length === 1 && o.state.tasks.get('T-1')?.status === 'ready', 'first crash');
    await o.tick();
    expect(adapter.calls).toHaveLength(1); // still inside the 10 s backoff
    clock += 10_001;
    await until(o, () => o.state.tasks.get('T-1')?.status === 'failed', 'second crash');
    expect(adapter.calls).toHaveLength(2);
    expect(sent.at(-1)!.message.text).toMatch(/R-1: T-1 failed 2 times/);
  });

  it('nudges a run that stops without complete_task, within the limit', async () => {
    const idle: Turn = async () => [{ type: 'run.completed', summary: 'thinking' }];
    const { o, adapter } = setup([idle, idle]);
    await o.handle({ command: { kind: 'new', text: 'x' }, ...inbound('', 1) });
    await until(o, () => adapter.calls.length === 1 && o.state.tasks.get('T-1')?.status === 'ready', 'first turn');
    clock += 2000;
    await until(o, () => o.state.tasks.get('T-1')?.status === 'failed', 'continuation limit');
    expect(adapter.calls[1]!.prompt).toMatch(/^Continue the task/);
  });

  it('holds new runs while the quota is over the soft ceiling', async () => {
    const { o, adapter } = setup([doTheWork]);
    store.append({
      type: 'quota.updated',
      actor: { kind: 'harness', id: 'hub' },
      payload: { account: 'default', window: 'five_hour', status: 'allowed', utilization: 0.9, resetsAt: clock / 1000 + 3600 },
    });
    expect(await o.handle({ command: { kind: 'new', text: 'x' }, ...inbound('', 1) })).toMatch(/Waiting: five_hour at 90%/);
    await o.tick();
    expect(adapter.calls).toHaveLength(0);
    clock += 3601_000; // window resets
    await until(o, () => o.state.approvals.has('A-1'), 'run after reset');
    expect(adapter.calls).toHaveLength(1);
  });

  it('dedupes a retried /new and can stop a task', async () => {
    const { o, adapter } = setup([async () => new Promise<HarnessEvent[]>((r) => setTimeout(() => r([]), 50))]);
    await o.handle({ command: { kind: 'new', text: 'x' }, ...inbound('', 1) });
    expect(await o.handle({ command: { kind: 'new', text: 'x' }, ...inbound('', 1) })).toBe('Already received.');
    expect(o.state.tasks.size).toBe(1);
    await until(o, () => adapter.calls.length === 1, 'dispatch');
    expect(await o.handle({ command: { kind: 'stop', target: 'T-1' }, ...inbound('', 2) })).toMatch(/Stopped T-1/);
    expect(o.state.tasks.get('T-1')!.status).toBe('cancelled');
    await until(o, () => o.state.runs.get('run-1')?.state === 'exited', 'run exit');
    expect(o.state.tasks.get('T-1')!.status).toBe('cancelled');
  });

  it('recovers runs that were live when the hub stopped', () => {
    const h = { kind: 'harness', id: 'hub' } as const;
    store.append({ type: 'task.created', actor: h, payload: { taskId: 'T-1', projectId: 'demo', title: 'x', spec: 'x', source: { kind: 'cli' } } });
    store.append({ type: 'task.status_changed', actor: h, payload: { taskId: 'T-1', from: 'backlog', to: 'ready' } });
    store.append({ type: 'task.status_changed', actor: h, payload: { taskId: 'T-1', from: 'ready', to: 'running' } });
    store.append({ type: 'run.dispatched', actor: h, payload: { runId: 'run-1', taskId: 'T-1', attempt: 1, adapter: 'claude-code', account: 'default', mode: 'start' } });
    const { o } = setup([]);
    o.recover();
    expect(o.state.runs.get('run-1')).toMatchObject({ state: 'exited', exit: { signal: 'hub-restart' } });
    expect(o.state.tasks.get('T-1')!.status).toBe('ready');
  });
});
