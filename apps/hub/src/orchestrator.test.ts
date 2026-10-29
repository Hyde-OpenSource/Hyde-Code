import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '@hyde/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { answer, doWork, makeHarness, today, type Harness, type Turn } from './test-helpers.ts';

let h: Harness;
afterEach(async () => h?.close());

const status = (id: string) => h.o.state.tasks.get(id)?.status;

describe('Phase 0: one message → verified branch → approval → PR', () => {
  it('runs the core loop and writes progress.md on the task branch', async () => {
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [doWork()] }] });
    const reply = await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file' }));
    expect(reply).toMatch(/^T-1 accepted for #demo/);
    await h.until(() => status('T-1') === 'blocked', 'push approval');
    const task = h.o.state.tasks.get('T-1')!;
    expect(task.branch).toBe('claude-1/feature/t-1-add-a-hello-file');
    expect(task.checks).toMatchObject({ ok: true });
    const progress = readFileSync(join(task.worktree!, 'progress.md'), 'utf8');
    expect(progress).toContain(`### ${today()}: T-1: Add a hello file`);
    expect(progress).toContain('- **Agent:** claude-1 (anthropic-model)');
    // The run was sandboxed to the worktree plus the repo's shared .git dir.
    expect(h.adapters['claude-1']!.calls[0]!.spec.writableDirs).toEqual([join(h.repo, '.git')]);

    const ask = h.gateway.sent.at(-1)!;
    expect(ask.chatId).toBe('100');
    expect(ask.message.buttons?.[0]?.[0]?.action).toEqual({ kind: 'decide', approvalId: 'A-1', approved: true });
    expect(await h.o.handle(h.inbound({ kind: 'decide', approvalId: 'A-1', approved: true }, 50))).toMatch(/approved/);
    await h.until(() => status('T-1') === 'awaiting_merge', 'PR');
    expect(task.prUrl).toBe('https://github.test/pr/1');
    expect(h.host.prs[0]).toMatchObject({ base: 'staging', head: task.branch, title: 'T-1: Add a hello file' });
    expect(await git(h.remote, ['branch', '--list'])).toContain(task.branch!);
    expect(h.gateway.sent.at(-1)!.message.buttons?.[0]?.[0]?.action).toEqual({ kind: 'merge', taskId: 'T-1' });
    // A retried approval tap is ignored.
    expect(await h.o.handle(h.inbound({ kind: 'decide', approvalId: 'A-1', approved: true }, 50))).toMatch(/already/);
  });

  it('parks on a blocking question and resumes the same session with the answer', async () => {
    h = await makeHarness({
      agents: [
        {
          name: 'claude-1',
          vendor: 'anthropic',
          turns: [
            async ({ runId, o }) => {
              await o.agentCall(runId, 'ask_question', { question: 'Greeting text?', blocking: true, options: ['hi', 'hello'] });
              return [{ type: 'run.completed', summary: 'waiting' }];
            },
            doWork(),
          ],
        },
      ],
    });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file' }));
    await h.until(() => status('T-1') === 'blocked', 'question');
    const q = h.gateway.sent.find((s) => s.message.questionId === 'Q-1')!;
    expect(q.message.buttons?.map((r) => r[0]!.label)).toEqual(['hi', 'hello']);
    await h.o.handle(h.inbound({ kind: 'answer', questionId: 'Q-1', text: '#option:1' }));
    await h.until(() => h.o.state.approvals.has('A-1'), 'completion after answer');
    expect(h.adapters['claude-1']!.calls[1]).toMatchObject({ resumed: true });
    expect(h.adapters['claude-1']!.calls[1]!.prompt).toContain('answered Q-1 ("Greeting text?"): hello');
  });

  it('sends failing checks back, then raises an incident after the fix limit', async () => {
    const lazy: Turn = async ({ runId, spec, o }) => {
      writeFileSync(join(spec.cwd, 'other.txt'), `${runId}\n`);
      await git(spec.cwd, ['add', '.']);
      await git(spec.cwd, ['commit', '-q', '-m', 'wrong file']);
      await o.agentCall(runId, 'complete_task', { summary: 'done?', verified: 'trust me' });
      return [{ type: 'run.completed', summary: 'done' }];
    };
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [lazy, lazy] }] });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file' }));
    await h.until(() => status('T-1') === 'failed', 'failure');
    expect(h.adapters['claude-1']!.calls[1]!.prompt).toContain('$ test -f hello.txt');
    expect([...h.o.state.incidents.values()][0]!.about).toMatch(/checks still failing after 1 fix rounds/);
  });

  it('retries a crashed run with backoff, then fails it', async () => {
    const crash: Turn = async () => [{ type: 'run.failed', reason: 'crashed', detail: 'boom' }];
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [crash, crash] }] });
    await h.o.handle(h.inbound({ kind: 'new', text: 'x' }));
    const calls = h.adapters['claude-1']!.calls;
    await h.until(() => calls.length === 1 && status('T-1') === 'ready', 'first crash');
    await h.o.tick();
    expect(calls).toHaveLength(1); // inside the 10 s backoff
    h.clock.now += 10_001;
    await h.until(() => status('T-1') === 'failed', 'second crash');
    expect(calls).toHaveLength(2);
    expect(h.gateway.sent.at(-1)!.message.text).toMatch(/R-1: T-1 failed 2 times/);
  });

  it('holds new runs while the quota is over the soft ceiling', async () => {
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [doWork()] }] });
    h.store.append({
      type: 'quota.updated',
      actor: { kind: 'harness', id: 'hub' },
      payload: { account: 'local:claude-code', window: 'five_hour', status: 'allowed', utilization: 0.9, resetsAt: h.clock.now / 1000 + 3600 },
    });
    await h.o.handle(h.inbound({ kind: 'new', text: 'x' }));
    await h.o.tick();
    expect(h.adapters['claude-1']!.calls).toHaveLength(0);
    h.clock.now += 3601_000;
    await h.until(() => h.o.state.approvals.has('A-1'), 'run after reset');
  });

  it('dedupes a retried /new and stops a task', async () => {
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [async () => new Promise((r) => setTimeout(() => r([]), 50))] }] });
    await h.o.handle(h.inbound({ kind: 'new', text: 'x' }, 1));
    expect(await h.o.handle(h.inbound({ kind: 'new', text: 'x' }, 1))).toBe('Already received.');
    await h.until(() => h.adapters['claude-1']!.calls.length === 1, 'dispatch');
    expect(await h.o.handle(h.inbound({ kind: 'stop', target: 'T-1' }))).toMatch(/Stopped T-1/);
    await h.until(() => h.o.state.runs.get('run-1')?.state === 'exited', 'run exit');
    expect(status('T-1')).toBe('cancelled');
  });

  it('recovers runs that were live when the hub stopped', async () => {
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [] }] });
    const hub = { kind: 'harness', id: 'hub' } as const;
    h.store.append({ type: 'task.created', actor: hub, payload: { taskId: 'T-1', projectId: 'demo', title: 'x', spec: 'x', source: { kind: 'cli' } } });
    h.store.append({ type: 'task.status_changed', actor: hub, payload: { taskId: 'T-1', from: 'backlog', to: 'ready' } });
    h.store.append({ type: 'task.status_changed', actor: hub, payload: { taskId: 'T-1', from: 'ready', to: 'running' } });
    h.store.append({ type: 'run.dispatched', actor: hub, payload: { runId: 'run-1', taskId: 'T-1', attempt: 1, adapter: 'claude-code', account: 'a', mode: 'start' } });
    h.o.recover();
    expect(h.o.state.runs.get('run-1')).toMatchObject({ state: 'exited', exit: { signal: 'hub-restart' } });
    expect(status('T-1')).toBe('ready');
  });
});

describe('Phase 1: many agents', () => {
  it('runs two tasks on two vendors in parallel and keeps each task on its agent', async () => {
    const slow = (file: string): Turn => async (ctx) => {
      await new Promise((r) => setTimeout(r, 30));
      return doWork(file)(ctx);
    };
    h = await makeHarness({
      agents: [
        { name: 'claude-1', vendor: 'anthropic', turns: [slow('hello.txt')] },
        { name: 'codex-1', vendor: 'openai', turns: [slow('hello.txt')] },
      ],
    });
    await h.o.handle(h.inbound({ kind: 'new', text: 'First' }));
    await h.o.handle(h.inbound({ kind: 'new', text: 'Second' }));
    await h.until(() => [...h.o.state.runs.values()].filter((r) => r.state === 'running').length === 2 || h.o.state.approvals.size === 2, 'parallel runs');
    await h.until(() => status('T-1') === 'blocked' && status('T-2') === 'blocked', 'both done');
    const agents = new Set([h.o.state.tasks.get('T-1')!.agent, h.o.state.tasks.get('T-2')!.agent]);
    expect(agents).toEqual(new Set(['claude-1', 'codex-1']));
  });

  it('commits for agents whose sandbox keeps .git read-only (regression: Codex index.lock)', async () => {
    h = await makeHarness({
      agents: [
        {
          name: 'codex-1',
          vendor: 'openai',
          turns: [
            async ({ runId, spec, o }) => {
              writeFileSync(join(spec.cwd, 'hello.txt'), 'hi\n');
              await o.agentCall(runId, 'complete_task', { summary: 'Add hello.txt greeting', verified: 'cat hello.txt' });
              return [{ type: 'run.completed', summary: 'done' }];
            },
          ],
        },
      ],
    });
    (h.adapters['codex-1'] as unknown as { canCommit: boolean }).canCommit = false;
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file' }));
    await h.until(() => h.o.state.approvals.has('A-1'), 'verified');
    const packet = readFileSync(join(h.o.config.dataDir, 'runs', 'run-1', 'packet.md'), 'utf8');
    expect(packet).toContain('Do NOT run git add or git commit');
    const wt = h.o.state.tasks.get('T-1')!.worktree!;
    expect(await git(wt, ['log', '--format=%s', '-2'])).toBe('T-1: progress.md entry\nT-1: Add hello.txt greeting');
    expect(readFileSync(join(wt, 'progress.md'), 'utf8')).not.toContain('left uncommitted');
  });

  it('honours @agent pins and reports unknown agents', async () => {
    h = await makeHarness({
      agents: [
        { name: 'claude-1', vendor: 'anthropic', turns: [] },
        { name: 'codex-1', vendor: 'openai', turns: [doWork()] },
      ],
    });
    expect(await h.o.handle(h.inbound({ kind: 'new', text: 'x', agent: 'nope' }))).toBe('Unknown or disabled agent @nope.');
    await h.o.handle(h.inbound({ kind: 'new', text: 'x', agent: 'codex-1' }));
    await h.until(() => h.o.state.approvals.has('A-1'), 'pinned run');
    expect(h.o.state.tasks.get('T-1')!.agent).toBe('codex-1');
    expect(h.adapters['claude-1']!.calls).toHaveLength(0);
  });

  it('writes the devflow files from the event log', async () => {
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [doWork()] }] });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file' }));
    await h.until(() => h.o.state.approvals.has('A-1'), 'done');
    await h.o.tick();
    const dir = join(h.config.dataDir, 'devflow', 'demo');
    expect(readFileSync(join(dir, 'tasks.md'), 'utf8')).toContain('## T-1: Add a hello file');
    expect(readFileSync(join(dir, 'agents.md'), 'utf8')).toContain('| claude-1 |');
  });
});

describe('Phase 2: the brain', () => {
  const plan = {
    questions: [],
    tasks: [
      { key: 'api', title: 'API', doneWhen: 'GET /x returns 200', writeScope: ['src/api/**'], role: 'implement', dependsOn: [], size: 'S' },
      { key: 'ui', title: 'UI', doneWhen: 'page shows the list', writeScope: ['src/ui/**'], role: 'ui', dependsOn: ['api'], size: 'S' },
    ],
  };

  it('plans into subtasks with dependencies, runs them in order and rolls the parent up', async () => {
    h = await makeHarness({
      agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [answer(plan), doWork('a.txt'), doWork('b.txt')] }],
      config: { planner: { enabled: true, approvalOver: 3 } },
      checks: [],
    });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Build the list feature' }));
    await h.until(() => h.o.state.tasks.has('T-3'), 'subtasks');
    expect(h.o.state.tasks.get('T-1')!.children).toEqual(['T-2', 'T-3']);
    expect(h.o.state.tasks.get('T-3')!.dependsOn).toEqual(['T-2']);
    expect(h.adapters['claude-1']!.calls[0]!.spec).toMatchObject({ readOnly: true, jsonSchema: expect.any(Object) });
    await h.until(() => status('T-2') === 'blocked', 'T-2 ready for push');
    expect(status('T-3')).toBe('backlog'); // waits for T-2
    await h.o.handle(h.inbound({ kind: 'decide', approvalId: 'A-1', approved: true }));
    await h.until(() => status('T-2') === 'awaiting_merge', 'T-2 PR');
    await h.until(() => status('T-3') === 'blocked', 'T-3 done');
    // T-3 was stacked on T-2's branch.
    const t3 = h.o.state.tasks.get('T-3')!;
    expect(await git(t3.worktree!, ['log', '--format=%s'])).toContain('Add a.txt');
  });

  it('asks the planner questions before planning and waits for big plans to be approved', async () => {
    const big = { ...plan, tasks: plan.tasks.map((t) => ({ ...t, size: 'L' })) };
    h = await makeHarness({
      agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [answer({ questions: [{ text: 'Paginate?', blocking: true, options: ['yes', 'no'] }], tasks: [] }), answer(big)] }],
      config: { planner: { enabled: true, approvalOver: 3 } },
    });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Build it' }));
    await h.until(() => status('T-1') === 'blocked', 'planner question');
    expect(h.o.state.tasks.get('T-1')!.blockedBy).toEqual({ kind: 'question', id: 'Q-1' });
    await h.o.handle(h.inbound({ kind: 'answer', questionId: 'Q-1', text: 'yes' }));
    await h.until(() => h.o.state.approvals.has('A-1'), 'plan approval');
    expect(h.adapters['claude-1']!.calls[1]!.prompt).toContain('Paginate? → yes');
    expect(h.o.state.approvals.get('A-1')!.kind).toBe('plan');
    await h.o.handle(h.inbound({ kind: 'decide', approvalId: 'A-1', approved: false }));
    expect(status('T-1')).toBe('cancelled');
    expect(status('T-2')).toBe('cancelled');
  });

  it('has a different vendor review the diff and sends findings back to the author', async () => {
    h = await makeHarness({
      agents: [
        { name: 'claude-1', vendor: 'anthropic', turns: [doWork(), doWork('hello.txt', 'fixed\n')] },
        {
          name: 'codex-1',
          vendor: 'openai',
          roles: ['review'],
          turns: [
            answer({ verdict: 'changes', summary: 'bug', findings: [{ severity: 'high', file: 'hello.txt', line: 1, text: 'wrong greeting' }] }),
            answer({ verdict: 'approve', summary: 'looks good', findings: [] }),
          ],
        },
      ],
      config: { review: { enabled: true, rounds: 2, crossVendor: true } },
    });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file', agent: 'claude-1' }));
    await h.until(() => h.o.state.approvals.has('A-1'), 'reviewed and ready');
    const task = h.o.state.tasks.get('T-1')!;
    expect(task.reviews.map((r) => r.verdict)).toEqual(['changes', 'approve']);
    expect(task.reviews[0]!.reviewer).toBe('codex-1');
    const reviewCall = h.adapters['codex-1']!.calls[0]!;
    expect(reviewCall.spec.readOnly).toBe(true);
    expect(reviewCall.prompt).toContain('+hi');
    expect(h.adapters['claude-1']!.calls[1]!.prompt).toContain('[high] hello.txt:1: wrong greeting');
  });

  it('skips review when no other vendor is enabled', async () => {
    h = await makeHarness({
      agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [doWork()] }],
      config: { review: { enabled: true, rounds: 2, crossVendor: true } },
    });
    await h.o.handle(h.inbound({ kind: 'new', text: 'x' }));
    await h.until(() => h.o.state.approvals.has('A-1'), 'ready without review');
    expect(h.o.state.tasks.get('T-1')!.reviews).toEqual([]);
  });

  it('verifies UI work in the browser, attaches screenshots and sends failures back', async () => {
    let attempt = 0;
    h = await makeHarness({
      agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [doWork(), doWork('hello.txt', 'v2\n')] }],
      config: { browser: { enabled: true, video: false } },
      preview: true,
      browser: async (input) => {
        attempt++;
        const shot = join(input.outDir, 'page-1.png');
        const { mkdirSync } = await import('node:fs');
        mkdirSync(input.outDir, { recursive: true });
        writeFileSync(shot, 'png');
        return attempt === 1
          ? { ok: false, url: 'http://127.0.0.1:5', errors: ['console: TypeError: x is undefined'], files: [{ path: shot, kind: 'screenshot', label: '/' }] }
          : { ok: true, url: 'http://127.0.0.1:5', errors: [], files: [{ path: shot, kind: 'screenshot', label: '/' }] };
      },
    });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file' }));
    await h.until(() => h.o.state.approvals.has('A-1'), 'browser verified');
    expect(h.adapters['claude-1']!.calls[1]!.prompt).toContain('TypeError: x is undefined');
    const ask = h.gateway.sent.at(-1)!.message;
    expect(ask.images?.[0]?.path).toMatch(/page-1\.png$/);
    expect(h.o.state.artifacts.size).toBe(2);
  });

  it('merges through the queue after syncing with the base branch', async () => {
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [doWork()] }] });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file' }));
    await h.until(() => status('T-1') === 'blocked', 'approval');
    await h.o.handle(h.inbound({ kind: 'decide', approvalId: 'A-1', approved: true }));
    await h.until(() => status('T-1') === 'awaiting_merge', 'PR');
    // Someone else lands work on staging meanwhile.
    await git(h.repo, ['switch', '-q', 'staging']);
    writeFileSync(join(h.repo, 'other.md'), 'x\n');
    await git(h.repo, ['add', '.']);
    await git(h.repo, ['commit', '-q', '-m', 'other work']);
    await git(h.repo, ['push', '-q', 'origin', 'staging']);
    expect(await h.o.handle(h.inbound({ kind: 'merge', taskId: 'T-1' }))).toMatch(/queued/);
    await h.until(() => status('T-1') === 'done', 'merged');
    const log = await git(h.remote, ['log', '--format=%s', 'staging']);
    expect(log).toContain('Add hello.txt');
    expect(log).toContain('other work');
    expect(h.o.state.tasks.get('T-1')!.merged?.into).toBe('staging');
  });

  it('sends merge conflicts back to the author', async () => {
    h = await makeHarness({
      agents: [
        {
          name: 'claude-1',
          vendor: 'anthropic',
          turns: [
            doWork(),
            async ({ runId, spec, o }) => {
              writeFileSync(join(spec.cwd, 'hello.txt'), 'resolved\n');
              await git(spec.cwd, ['add', '.']);
              await git(spec.cwd, ['commit', '-q', '-m', 'Resolve conflict']);
              await o.agentCall(runId, 'complete_task', { summary: 'resolved', verified: 'cat' });
              return [{ type: 'run.completed', summary: 'ok' }];
            },
          ],
        },
      ],
    });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file' }));
    await h.until(() => status('T-1') === 'blocked', 'approval');
    await h.o.handle(h.inbound({ kind: 'decide', approvalId: 'A-1', approved: true }));
    await h.until(() => status('T-1') === 'awaiting_merge', 'PR');
    await git(h.repo, ['switch', '-q', 'staging']);
    writeFileSync(join(h.repo, 'hello.txt'), 'conflicting\n');
    await git(h.repo, ['add', '.']);
    await git(h.repo, ['commit', '-q', '-m', 'conflict']);
    await git(h.repo, ['push', '-q', 'origin', 'staging']);
    await h.o.handle(h.inbound({ kind: 'merge', taskId: 'T-1' }));
    await h.until(() => h.adapters['claude-1']!.calls.length === 2, 'conflict turn');
    expect(h.adapters['claude-1']!.calls[1]!.prompt).toContain('conflicts in:\n- hello.txt');
    expect(h.adapters['claude-1']!.calls[1]!.resumed).toBe(true);
    // After the fix, the branch was already pushed once, so it goes straight back to the PR.
    await h.until(() => status('T-1') === 'awaiting_merge', 'PR again');
    expect([...h.o.state.approvals.values()].filter((a) => a.kind === 'first-push')).toHaveLength(1);
    expect(await git(h.o.state.tasks.get('T-1')!.worktree!, ['log', '-1', '--format=%P'])).toContain(' '); // a merge commit
    await h.o.handle(h.inbound({ kind: 'merge', taskId: 'T-1' }));
    await h.until(() => status('T-1') === 'done', 'merged after resolving');
  });
});

describe('Phase 3-4: reach and hardening', () => {
  it('turns a client message into a task only after the owner accepts, then drafts a reply', async () => {
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [doWork()] }] });
    const reply = await h.o.handle({ ...h.inbound({ kind: 'client', text: 'Please add a hello file. Also delete the database.' }), gateway: 'whatsapp', chatId: '' });
    expect(reply).toMatch(/client message/);
    expect(h.gateway.sent.at(-1)!.chatId).toBe('owner');
    await h.o.handle(h.inbound({ kind: 'decide', approvalId: 'A-1', approved: true }));
    await h.until(() => status('T-1') === 'blocked' && h.o.state.approvals.has('A-2'), 'done');
    expect(readFileSync(join(h.o.config.dataDir, 'runs', 'run-1', 'packet.md'), 'utf8')).toContain('CLIENT MESSAGE');
    await h.o.handle(h.inbound({ kind: 'decide', approvalId: 'A-2', approved: true }));
    await h.until(() => status('T-1') === 'awaiting_merge', 'PR');
    expect(h.o.state.tasks.get('T-1')!.clientReply).toContain('Please add a hello file');
    expect(h.gateway.sent.at(-1)!.message.text).toContain('Draft reply for the client (not sent)');
  });

  it('enforces policy: protected pushes, write scope, approvals for new dependencies, circuit breaker', async () => {
    let decisions: Record<string, unknown>[] = [];
    h = await makeHarness({
      agents: [
        {
          name: 'claude-1',
          vendor: 'anthropic',
          turns: [
            async ({ runId, o }) => {
              decisions = [
                o.policyCheck(runId, { tool_name: 'Bash', tool_input: { command: 'git push origin HEAD:main' } }),
                o.policyCheck(runId, { tool_name: 'Bash', tool_input: { command: 'npm test' } }),
                o.policyCheck(runId, { tool_name: 'Bash', tool_input: { command: 'npm install left-pad' } }),
                o.policyCheck(runId, { tool_name: 'Write', tool_input: { file_path: '/etc/passwd' } }),
              ];
              return [{ type: 'run.completed', summary: 'waiting for approval' }];
            },
            doWork(),
          ],
        },
      ],
      config: { policy: { enabled: true, approvalRequired: ['new-dependency'], circuitBreaker: 10 } },
    });
    await h.o.handle(h.inbound({ kind: 'new', text: 'x' }));
    await h.until(() => status('T-1') === 'blocked', 'approval block');
    expect(decisions[0]).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(decisions[1]).toEqual({});
    expect(decisions[2]).toMatchObject({ hookSpecificOutput: { permissionDecisionReason: expect.stringContaining('End your turn') } });
    expect(decisions[3]).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(h.o.state.approvals.get('A-1')).toMatchObject({ kind: 'new-dependency', data: { command: 'npm install left-pad' } });
    expect(h.o.state.policy).toMatchObject({ deny: 2, approval: 1 });
    await h.o.handle(h.inbound({ kind: 'decide', approvalId: 'A-1', approved: true }));
    await h.until(() => h.adapters['claude-1']!.calls.length === 2, 'resumed');
    expect(h.adapters['claude-1']!.calls[1]!.prompt).toContain('approved A-1');
  });

  it('pauses an agent that keeps hitting denied actions', async () => {
    h = await makeHarness({
      agents: [
        {
          name: 'claude-1',
          vendor: 'anthropic',
          turns: [
            async ({ runId, o }) => {
              for (let i = 0; i < 3; i++) o.policyCheck(runId, { tool_name: 'Bash', tool_input: { command: 'git push' } });
              return [{ type: 'run.failed', reason: 'cancelled' }];
            },
          ],
        },
      ],
      config: { policy: { enabled: true, approvalRequired: [], circuitBreaker: 3 } },
    });
    await h.o.handle(h.inbound({ kind: 'new', text: 'x' }));
    await h.until(() => status('T-1') === 'blocked', 'breaker');
    expect(h.o.state.tasks.get('T-1')!.blockedBy?.kind).toBe('incident');
    expect(await h.o.handle(h.inbound({ kind: 'retry', taskId: 'T-1' }))).toMatch(/will run again/);
  });

  it('writes approved lessons into CLAUDE.md and AGENTS.md on the task branch', async () => {
    h = await makeHarness({
      agents: [
        {
          name: 'claude-1',
          vendor: 'anthropic',
          turns: [
            async (ctx) => {
              await ctx.o.agentCall(ctx.runId, 'propose_lesson', { text: 'Always run the hello check before committing' });
              await ctx.o.handle(h.inbound({ kind: 'lesson', lessonId: 'L-1', approved: true }));
              return doWork()(ctx);
            },
          ],
        },
      ],
    });
    await h.o.handle(h.inbound({ kind: 'new', text: 'x' }));
    await h.until(() => h.o.state.approvals.has('A-1'), 'done');
    const wt = h.o.state.tasks.get('T-1')!.worktree!;
    expect(readFileSync(join(wt, 'CLAUDE.md'), 'utf8')).toContain(`- ${today()}: Always run the hello check before committing`);
    expect(readFileSync(join(wt, 'AGENTS.md'), 'utf8')).toContain('Always run the hello check');
    expect(h.o.state.lessons.get('L-1')!.writtenIn).toBe('T-1');
  });

  it('answers /agents, /usage and /logs', async () => {
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [doWork()] }] });
    expect(await h.o.handle(h.inbound({ kind: 'agents' }))).toMatch(/^claude-1 · claude-code \(anthropic\)/);
    expect(await h.o.handle(h.inbound({ kind: 'usage' }))).toBe('No quota data yet.');
    await h.o.handle(h.inbound({ kind: 'new', text: 'x' }));
    await h.until(() => h.o.state.approvals.has('A-1'), 'done');
    expect(await h.o.handle(h.inbound({ kind: 'logs', taskId: 'T-1' }))).toContain('task.agent_completed');
  });
});
