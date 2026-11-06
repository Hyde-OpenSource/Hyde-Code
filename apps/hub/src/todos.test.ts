import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '@hyde/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { answer, doWork, makeHarness, type Harness, type Turn } from './test-helpers.ts';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});
const plan = (complexity: string) => ({
  complexity, complexityReason: 'x', questions: [], assumptions: [],
  tasks: [{ key: 'a', title: 'Add a hello file', spec: 'Write hello.txt', doneWhen: 'hello.txt exists with hi', writeScope: [], role: 'implement', dependsOn: [], size: 'S', complexity, skills: [], steps: ['Write hello.txt', 'Run the checks'] }],
});

describe('todos, plan then build, files touched', () => {
  it('seeds the checklist from the plan, lets the agent tick it, and shows it in the packet and /todos', async () => {
    let packet = '';
    const work: Turn = async (ctx) => {
      packet = readFileSync(ctx.spec.packetFile!, 'utf8');
      await ctx.o.agentCall(ctx.runId, 'update_todos', { todos: [{ text: 'Write hello.txt', done: true }, { text: 'Run the checks', done: false }] });
      const files = await ctx.o.filesTouched('T-1');
      expect(files).toEqual([]);
      writeFileSync(join(ctx.spec.cwd, 'extra.txt'), 'a\nb\n');
      expect(await ctx.o.filesTouched('T-1')).toEqual([]); // untracked files aren't in git diff yet
      await git(ctx.spec.cwd, ['add', 'extra.txt']);
      expect(await ctx.o.filesTouched('T-1')).toEqual([{ path: 'extra.txt', added: 2, removed: 0 }]);
      return doWork()(ctx);
    };
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [answer(plan('low')), work] }], config: { planner: { enabled: true } } });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file' }));
    await h.until(() => h!.o.state.approvals.has('A-1'), 'done');
    expect(packet).toContain('## Checklist (from the plan; keep it updated with update_todos)\n- [ ] Write hello.txt\n- [ ] Run the checks');
    expect(h.o.state.tasks.get('T-1')!.todos).toEqual([{ text: 'Write hello.txt', done: true }, { text: 'Run the checks', done: false }]);
    expect(await h.o.handle(h.inbound({ kind: 'todos', taskId: 'T-1' }))).toBe('T-1 checklist (1/2):\n☑ Write hello.txt\n☐ Run the checks');
    expect(await h.o.agentCall('run-2', 'update_todos', { todos: [] }).catch((e: Error) => e.message)).toMatch(/non-empty/);
  });

  it('asks the owner to approve the plan before building high work, unless /plan off', async () => {
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [answer(plan('high')), doWork()] }], config: { planner: { enabled: true } } });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file' }));
    await h.until(() => h!.o.state.approvals.get('A-1')?.kind === 'plan', 'plan gate');
    const shown = await h.o.handle(h.inbound({ kind: 'plan', taskId: 'T-1' }));
    expect(shown).toContain('1. Write hello.txt');
    expect(shown).toContain('A-1: /approve A-1 to build');
    expect(h.adapters['claude-1']!.calls).toHaveLength(1); // nothing built yet
    await h.o.handle(h.inbound({ kind: 'decide', approvalId: 'A-1', approved: true }));
    await h.until(() => h!.o.state.approvals.has('A-2'), 'built');
  });

  it('skips the gate when the owner turns it off', async () => {
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [answer(plan('high')), doWork()] }], config: { planner: { enabled: true } } });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file' }));
    expect(await h.o.handle(h.inbound({ kind: 'plan', taskId: 'T-1', on: false }))).toBe('T-1: plan then build is off.');
    await h.until(() => h!.o.state.approvals.has('A-1'), 'done');
    expect(h.o.state.approvals.get('A-1')!.kind).toBe('first-push');
  });
});
