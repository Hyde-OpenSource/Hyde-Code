import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { similarity, SAME_TASK_THRESHOLD, PROJECT_THRESHOLD } from './questions.ts';
import { answer, doWork, makeHarness, type Harness, type Turn } from './test-helpers.ts';

// Real questions from the owner's event log (2026-10-28..29), used as regression fixtures.
const REAL = {
  q1: 'The devflow workspace files number entries from zero (tasks.md uses T-000, AgentQuestions.md uses Q-000 and Q-001, report.md uses R-000), but the harness nextId() starts at 1 (T-1, Q-1, run-1). Should the glossary describe both numbering schemes, or only the harness ids?',
  q2: 'What exactly is an artifact (art-n)? The code stores artifact.saved records with kind screenshot, log, diff, test report, video or PR (docs/plan.md lists diff, test report, screenshot, video, PR). Confirm the one-line meaning to use.',
  q3: 'Are ids unique per project or across the whole harness? nextId() counts within one HarnessState, so the glossary needs to say which scope applies.',
  q4: 'Should the glossary also say that commands accept ids case-insensitively (e.g. /approve l-2 becomes L-2)? Commands.ts uppercases lesson ids, so this is only true for some prefixes.',
  q5: "Should docs/GLOSSARY.md be linked from README.md or docs/plan.md? The request says 'Nothing else', so this is left out of the task unless you say otherwise.",
  q8: 'Which three rooms should docs/ROOMS.md list? The repo has no existing room names or office-UI terminology to derive them from.',
  q9: 'Is this docs-only, or should the rooms also be wired into the office UI later? I will assume docs-only and not touch any UI code.',
  q10: 'What should "remaining" cover for this pass? I found these open items: live chat gateways untested (no tokens), no CI or required checks, no secret scan before push, TERMS.md is a draft, LimeZu tile import unverified, and merge/promote only tested against a local remote. Which scope do you want?',
  q11: 'What should "simple Telegram" look like? Today the owner must paste a token, then send /pair <code> with a generated pairing code.',
  q12: 'Do you have a Telegram bot token (from @BotFather) we may use to verify the flow live, and are you willing to create a fresh test bot?',
  q13: 'For CI, may I add a GitHub Actions workflow, and should I also enable required status checks on main/staging (a GitHub settings change via gh)?',
  q14: 'For live end-to-end verification, which agent may I use so we do not burn your Claude quota?',
};
const T1 = [REAL.q1, REAL.q2, REAL.q3, REAL.q4, REAL.q5];
const T7 = [REAL.q10, REAL.q11, REAL.q12, REAL.q13, REAL.q14];

describe('question similarity', () => {
  it('matches rewordings of the same question', () => {
    expect(similarity(REAL.q8, 'What three rooms should ROOMS.md list?')).toBeGreaterThanOrEqual(SAME_TASK_THRESHOLD);
    expect(similarity(REAL.q14, 'Which agent should I use for the live end-to-end verification?')).toBeGreaterThanOrEqual(PROJECT_THRESHOLD);
    expect(similarity('Which database should I use for the cache?', 'Which database should we use for the cache?')).toBe(1);
    expect(similarity(REAL.q12, 'Do you have a Telegram bot token from BotFather to verify the flow live?')).toBeGreaterThanOrEqual(PROJECT_THRESHOLD);
  });

  it('keeps different questions apart', () => {
    const all = [...T1, REAL.q8, REAL.q9, ...T7];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) expect(similarity(all[i]!, all[j]!), `${i} vs ${j}`).toBeLessThan(SAME_TASK_THRESHOLD);
    }
    expect(similarity('Which provider?', 'Which region?')).toBe(0);
    expect(similarity('Should I add tests?', 'Should I skip tests?')).toBeLessThan(SAME_TASK_THRESHOLD);
  });
});

let h: Harness;
afterEach(async () => h?.close());
const status = (id: string) => h.o.state.tasks.get(id)?.status;
const q = (text: string, blocking: boolean, options: string[] = []) => ({ text, blocking, options });
const plan = (questions: ReturnType<typeof q>[] = []) => ({
  complexity: 'low',
  complexityReason: 'one docs file',
  questions,
  assumptions: [],
  tasks: [{ key: 'a', title: 'Add a hello file', spec: 'Write hello.txt', doneWhen: 'hello.txt exists with hi', writeScope: ['hello.txt'], role: 'implement', dependsOn: [], size: 'S', complexity: 'low' }],
});
const ask = (question: string, blocking = true): Turn => async ({ runId, o }) => {
  const reply = await o.agentCall(runId, 'ask_question', { question, blocking });
  return [{ type: 'run.completed', summary: reply }];
};

describe('no repeated questions (regressions from the real event log)', () => {
  it('T-1: five non-blocking glossary questions become assumptions, and the resubmitted task (T-2) asks nothing', async () => {
    h = await makeHarness({
      agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [answer(plan(T1.map((t) => q(t, false)))), doWork(), answer(plan(T1.map((t) => q(t, true)))), doWork()] }],
      config: { planner: { enabled: true } },
    });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add docs/GLOSSARY.md that explains the ids Hyde Code uses. Nothing else.' }));
    await h.until(() => h.o.state.approvals.has('A-1'), 'T-1 done');
    expect(h.o.state.questions.size).toBe(0);
    expect(h.o.state.tasks.get('T-1')!.assumptions).toHaveLength(5);
    // Same request again, this time the planner marks them blocking: still only the cap (3) is asked.
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add docs/GLOSSARY.md that explains the ids Hyde Code uses. Nothing else.' }));
    await h.until(() => status('T-2') === 'blocked', 'T-2 questions');
    expect(h.o.state.questions.size).toBe(3);
  });

  it('T-6: a re-plan that rewords an answered question (Q-8) does not ask it again', async () => {
    h = await makeHarness({
      agents: [
        {
          name: 'claude-1',
          vendor: 'anthropic',
          turns: [answer(plan([q(REAL.q8, true), q(REAL.q9, false)])), answer(plan([q('What three rooms should ROOMS.md list?', true)])), doWork()],
        },
      ],
      config: { planner: { enabled: true } },
    });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Demo for the office UI: create docs/ROOMS.md listing three rooms of the office in one line each. Keep it tiny.' }));
    await h.until(() => status('T-1') === 'blocked', 'Q-1');
    expect([...h.o.state.questions.values()].map((x) => x.text)).toEqual([REAL.q8]); // Q-9 became an assumption
    await h.o.handle(h.inbound({ kind: 'answer', questionId: 'Q-1', text: 'Use generic placeholders' }));
    await h.until(() => h.o.state.approvals.has('A-1'), 'done');
    expect(h.o.state.questions.size).toBe(1);
    const q1 = h.o.state.questions.get('Q-1')!;
    expect(q1.matches).toMatchObject([{ taskId: 'T-1', text: 'What three rooms should ROOMS.md list?' }]);
    expect(h.o.state.tasks.get('T-1')!.assumptions).toContain(`Answered before as Q-1: ${REAL.q8} → Use generic placeholders`);
    const packet = readFileSync(h.adapters['claude-1']!.calls[2]!.spec.packetFile!, 'utf8');
    expect(packet).toContain('Use generic placeholders');
  });

  it('T-7: only the blocking questions are asked (Q-10, Q-11), and the re-plan does not ask Q-10 again', async () => {
    const blocking = new Set([REAL.q10, REAL.q11]);
    h = await makeHarness({
      agents: [
        {
          name: 'claude-1',
          vendor: 'anthropic',
          turns: [
            answer(plan(T7.map((t) => q(t, blocking.has(t))))),
            answer(plan([q(REAL.q10, true)])), // the re-plan asks Q-10 again
            doWork(),
          ],
        },
      ],
      config: { planner: { enabled: true }, maxConcurrentRuns: 1 },
    });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Check what is remaining in Hyde and complete it. Make the Telegram integration simple.' }));
    await h.until(() => status('T-1') === 'blocked', 'questions');
    expect([...h.o.state.questions.values()].map((x) => x.text)).toEqual([REAL.q10, REAL.q11]);
    expect(h.o.state.tasks.get('T-1')!.status).toBe('blocked');
    await h.o.handle(h.inbound({ kind: 'answer', questionId: 'Q-1', text: 'Telegram integration only' }));
    expect(status('T-1')).toBe('blocked'); // still waiting for Q-2
    await h.o.handle(h.inbound({ kind: 'answer', questionId: 'Q-2', text: 'Paste the token once' }));
    await h.until(() => h.o.state.approvals.has('A-1'), 'T-1 done');
    expect(h.o.state.questions.size).toBe(2);
    expect(h.o.state.questions.get('Q-1')!.matches).toHaveLength(1);
    // Q-12..Q-14 were sent to the owner as assumptions with the first plan, not as questions.
    const shown = h.gateway.sent.find((m) => m.message.text.startsWith('📝 T-1'))!.message.text;
    for (const t of [REAL.q12, REAL.q13, REAL.q14]) expect(shown).toContain(t);
    expect(h.o.state.tasks.get('T-1')!.assumptions).toContain(`Answered before as Q-1: ${REAL.q10} → Telegram integration only`);
  });

  it('a later task in the project gets the earlier answer (Q-14) at once and as a standing decision', async () => {
    let reply = '';
    h = await makeHarness({
      agents: [
        {
          name: 'claude-1',
          vendor: 'anthropic',
          turns: [
            ask(REAL.q14),
            doWork(),
            async ({ runId, o, spec }) => {
              reply = await o.agentCall(runId, 'ask_question', { question: 'Which agent should I use for the live end-to-end verification?', blocking: true });
              return doWork()({ runId, o, spec, resumed: false });
            },
          ],
        },
      ],
      config: { maxConcurrentRuns: 1 },
    });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file' }));
    await h.until(() => status('T-1') === 'blocked', 'Q-1');
    await h.o.handle(h.inbound({ kind: 'answer', questionId: 'Q-1', text: 'Claude (I accept the quota use)' }));
    await h.until(() => h.o.state.approvals.has('A-1'), 'T-1 done');
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a second file' }));
    await h.until(() => h.o.state.approvals.has('A-2'), 'T-2 done');
    expect(reply).toMatch(/^The owner already answered this as Q-1 on T-1: .* → Claude \(I accept the quota use\)/);
    expect(h.o.state.questions.size).toBe(1);
    const packet = readFileSync(h.adapters['claude-1']!.calls[2]!.spec.packetFile!, 'utf8');
    expect(packet).toContain('## Standing decisions in this project');
    expect(packet).toContain('Claude (I accept the quota use)');
  });

  it('two different agents asking the same thing share one question and both get the answer', async () => {
    h = await makeHarness({
      agents: [
        { name: 'claude-1', vendor: 'anthropic', turns: [ask('Which database should I use for the cache?'), doWork()], roles: ['implement'] },
        { name: 'codex-1', vendor: 'openai', turns: [ask('Which database should we use for the cache?'), doWork()], roles: ['implement'] },
      ],
      config: { maxConcurrentRuns: 2 },
    });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a cache layer', agent: 'claude-1' }));
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add cache metrics', agent: 'codex-1' }));
    await h.until(() => status('T-1') === 'blocked' && status('T-2') === 'blocked', 'both blocked');
    expect(h.o.state.questions.size).toBe(1);
    expect(h.o.state.tasks.get('T-2')!.blockedBy).toEqual({ kind: 'question', id: 'Q-1' });
    const notices = h.gateway.sent.filter((s) => s.message.questionId);
    expect(notices).toHaveLength(1);
    expect(await h.o.handle(h.inbound({ kind: 'answer', questionId: 'Q-1', text: 'Redis' }))).toBe('Q-1 answered: Redis (also sent to T-2, which asked the same)');
    await h.until(() => h.o.state.approvals.has('A-1') && h.o.state.approvals.has('A-2'), 'both done');
    const resumed = [...h.adapters['claude-1']!.calls, ...h.adapters['codex-1']!.calls].filter((c) => c.resumed);
    expect(resumed).toHaveLength(2);
    for (const c of resumed) expect(c.prompt).toContain('The owner answered Q-1 ("Which database should I use for the cache?"): Redis');
  });

  it('returns an earlier answer at once when an agent asks again in a later run', async () => {
    let second = '';
    h = await makeHarness({
      agents: [
        {
          name: 'claude-1',
          vendor: 'anthropic',
          turns: [
            ask('Greeting text?'),
            async ({ runId, o, spec }) => {
              second = await o.agentCall(runId, 'ask_question', { question: 'What greeting text should I use?', blocking: true });
              return doWork()({ runId, o, spec, resumed: true });
            },
          ],
        },
      ],
    });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file' }));
    await h.until(() => status('T-1') === 'blocked', 'Q-1');
    await h.o.handle(h.inbound({ kind: 'answer', questionId: 'Q-1', text: 'hi' }));
    await h.until(() => h.o.state.approvals.has('A-1'), 'done');
    expect(second).toBe('The owner already answered this as Q-1: "Greeting text?" → hi\nUse that answer and continue. Do not ask it again.');
    expect(h.o.state.questions.size).toBe(1);
  });
});

describe('harness mode in every run', () => {
  it('sets DEVFLOW_HARNESS and says "never ask main or child" to planner, coder, classifier and reviewer', async () => {
    h = await makeHarness({
      agents: [
        { name: 'claude-1', vendor: 'anthropic', turns: [answer({ complexity: 'low', reason: 'small' }), answer(plan()), doWork()] },
        { name: 'codex-1', vendor: 'openai', turns: [answer({ verdict: 'approve', summary: 'fine', findings: [] })], roles: ['review'] },
      ],
      config: { planner: { enabled: true }, review: { enabled: true }, routing: { classifier: true } },
    });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file' }));
    await h.until(() => h.o.state.approvals.has('A-1'), 'done');
    const calls = [...h.adapters['claude-1']!.calls, ...h.adapters['codex-1']!.calls];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) {
      expect(c.spec.env).toMatchObject({ DEVFLOW_HARNESS: '1' });
      const text = c.spec.packetFile ? readFileSync(c.spec.packetFile, 'utf8') : c.prompt;
      expect(text).toMatch(/never ask whether this is a main or child session/i);
    }
  });
});
