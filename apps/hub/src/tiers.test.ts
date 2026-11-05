import { afterEach, describe, expect, it } from 'vitest';
import { answer, doWork, makeHarness, type Harness } from './test-helpers.ts';

let h: Harness;
afterEach(async () => h?.close());

const status = (id: string) => h.o.state.tasks.get(id)?.status;
const plan = (extra: object = {}) => ({
  complexity: 'high',
  complexityReason: 'touches the auth flow',
  questions: [],
  assumptions: [],
  tasks: [{ key: 'a', title: 'Add a hello file', spec: 'Write hello.txt', doneWhen: 'hello.txt exists with hi', writeScope: ['hello.txt'], role: 'implement', dependsOn: [], size: 'S', complexity: 'high' }],
  ...extra,
});

describe('complexity tiers in the orchestrator', () => {
  it('classifies by rules, lets the planner correct it, and runs on that tier with model and effort recorded', async () => {
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [answer(plan()), doWork()] }], config: { planner: { enabled: true } } });
    const reply = await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file' }));
    expect(reply).toMatch(/Complexity: medium: feature or fix/);
    await h.until(() => h.o.state.approvals.has('A-1'), 'done');
    const task = h.o.state.tasks.get('T-1')!;
    expect(task.complexityHistory.map((c) => `${c.by}:${c.level}`)).toEqual(['rules:medium', 'planner:high']);
    const calls = h.adapters['claude-1']!.calls;
    // Plan on the strong tier (medium task → high tier), code on the planner's level.
    expect(calls[0]!.spec).toMatchObject({ model: 'opus', effort: 'high', readOnly: true });
    expect(calls[1]!.spec).toMatchObject({ model: 'opus', effort: 'high' });
    const runs = [...h.o.state.runs.values()];
    expect(runs.map((r) => `${r.mode}:${r.tier}:${r.requestedModel}:${r.effort}`)).toEqual(['plan:high:opus:high', 'start:high:opus:high']);
    expect(runs[1]!.why).toMatch(/high coding; mode balanced/);
  });

  it('skips the planner for trivial work and gives cheap tiers short step-by-step instructions', async () => {
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [doWork()] }], config: { planner: { enabled: true } } });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Fix the typo in hello.txt' }));
    await h.until(() => h.o.state.approvals.has('A-1'), 'done');
    const task = h.o.state.tasks.get('T-1')!;
    expect(task.statusHistory[0]!.reason).toBe('trivial: no planning needed');
    const call = h.adapters['claude-1']!.calls[0]!;
    expect(call.spec).toMatchObject({ model: 'haiku', effort: 'low' });
    const { readFileSync } = await import('node:fs');
    const packet = readFileSync(call.spec.packetFile!, 'utf8');
    expect(packet).toContain('## Steps (small task: keep it small)');
    expect(packet).toContain('Never ask whether this is a main or child session');
    expect(packet).toContain('`test -f hello.txt`');
  });

  it('asks a cheap model when the rules are unsure and nobody plans', async () => {
    h = await makeHarness({
      agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [answer({ complexity: 'low', reason: 'one small file' }), doWork()] }],
      config: { routing: { classifier: true } },
    });
    await h.o.handle(h.inbound({ kind: 'new', text: 'hello thing please' }));
    await h.until(() => h.o.state.approvals.has('A-1'), 'done');
    const task = h.o.state.tasks.get('T-1')!;
    expect(task.complexity).toMatchObject({ level: 'low', by: 'model', reason: 'claude-1: one small file' });
    const [classify, start] = h.adapters['claude-1']!.calls;
    expect(classify!.spec).toMatchObject({ readOnly: true, model: 'haiku' });
    expect(classify!.spec.jsonSchema).toMatchObject({ required: ['complexity', 'reason'] });
    expect(start!.spec).toMatchObject({ model: 'haiku', effort: 'low' });
    expect([...h.o.state.runs.values()][0]!.mode).toBe('classify');
  });

  it('lets the owner override the level; the next run uses the new tier', async () => {
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [doWork()] }] });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Fix the typo in hello.txt' }));
    expect(await h.o.handle(h.inbound({ kind: 'level', taskId: 'T-1', level: 'high' }))).toBe('T-1 is now high (was trivial). Its next run uses the high tier.');
    await h.until(() => h.o.state.approvals.has('A-1'), 'done');
    expect(h.adapters['claude-1']!.calls[0]!.spec).toMatchObject({ model: 'opus', effort: 'high' });
    expect(h.o.state.tasks.get('T-1')!.complexity).toMatchObject({ by: 'owner', reason: 'set by tg:1 (was trivial)' });
  });

  it('asks only blocking questions up to the cap and shows the rest as assumptions', async () => {
    const q = (text: string, blocking: boolean) => ({ text, blocking, options: [] });
    h = await makeHarness({
      agents: [
        {
          name: 'claude-1',
          vendor: 'anthropic',
          turns: [
            answer(plan({ questions: [q('Which file name?', false), q('Which provider?', true), q('Which region?', true)], assumptions: ['Plain text, no header'] })),
            answer(plan()),
            doWork(),
          ],
        },
      ],
      config: { planner: { enabled: true, maxQuestions: 1 } },
    });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file' }));
    await h.until(() => status('T-1') === 'blocked', 'planner question');
    expect([...h.o.state.questions.values()].map((x) => x.text)).toEqual(['Which provider?']);
    await h.o.handle(h.inbound({ kind: 'answer', questionId: 'Q-1', text: 'Acme' }));
    await h.until(() => h.o.state.approvals.has('A-1'), 'done');
    // The re-plan saw the answer, and the old question is listed as answered, not to be asked again.
    expect(h.adapters['claude-1']!.calls[1]!.prompt).toContain('Which provider? → Acme');
    expect(h.adapters['claude-1']!.calls[1]!.prompt).toContain('do not ask these again');
    const firstPlanAssumptions = h.store.list({ taskId: 'T-1' }).filter((e) => e.type === 'task.planned');
    expect(firstPlanAssumptions).toHaveLength(1);
    // The first plan's assumptions (and the question over the cap) were shown with its question.
    const shown = h.gateway.sent.filter((s) => s.message.text.startsWith('📝 T-1 planned without asking'));
    expect(shown).toHaveLength(1);
    expect(shown[0]!.message.text).toContain('Over the question limit, decide sensibly: Which region?');
  });

  it('records assumptions on the task and sends them to the owner', async () => {
    h = await makeHarness({
      agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [answer(plan({ questions: [{ text: 'Exact wording?', blocking: false, options: [] }], assumptions: ['Plain text'] })), doWork()] }],
      config: { planner: { enabled: true } },
    });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file' }));
    await h.until(() => h.o.state.approvals.has('A-1'), 'done');
    expect(h.o.state.tasks.get('T-1')!.assumptions).toEqual(['Plain text', 'Left to the agent (not blocking): Exact wording?']);
    expect(h.o.state.questions.size).toBe(0);
    expect(h.gateway.sent.some((s) => s.message.text.startsWith('📝 T-1 planned without asking'))).toBe(true);
  });
});
