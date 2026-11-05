import { apply, classifyByRules, effortShift, emptyState, isFreeModel, jobLevel, shiftEffort, tierFor, type HarnessState } from '@hyde/core';
import { describe, expect, it } from 'vitest';
import { route, tierTable, type AgentPool } from './agents.ts';
import type { HubConfig } from './config.ts';

// The owner's real requests from the event log (T-1, T-4..T-7), plus typical small and big ones.
const REAL = {
  glossary: 'Add docs/GLOSSARY.md that explains the ids Hyde Code uses (T-n tasks, Q-n questions, A-n approvals, R-n incidents, L-n lessons, run-n runs, art-n artifacts), one short line each. Nothing else.',
  editorconfig: 'Add a .editorconfig at the repo root: utf-8, LF line endings, final newline, trim trailing whitespace, 2-space indent for all files. Nothing else.',
  office: "Create docs/OFFICE.md with three short bullet points naming the rooms of the Hyde Code office (Hyde's office, war room, kitchen). Demo task for the UI, keep it tiny.",
  rooms: 'Demo for the office UI: create docs/ROOMS.md listing three rooms of the office in one line each. Keep it tiny.',
  remaining: 'Check what is remaining in Hyde and lets complete this thing we want this to be too good one of the best code harness. make the telegram integration simple\n',
};

describe('complexity rules', () => {
  it('places the owner’s real requests', () => {
    expect(classifyByRules(REAL.glossary)).toMatchObject({ level: 'low', confident: true });
    expect(classifyByRules(REAL.editorconfig)).toMatchObject({ level: 'low', confident: true });
    expect(classifyByRules(REAL.office)).toMatchObject({ level: 'low', confident: true });
    expect(classifyByRules(REAL.rooms)).toMatchObject({ level: 'low', confident: true });
    expect(classifyByRules(REAL.remaining)).toMatchObject({ level: 'high', confident: true });
  });

  it('spots trivial edits, features and risky work', () => {
    expect(classifyByRules('Rename getUser to fetchUser in src/api.ts')).toMatchObject({ level: 'trivial', confident: true });
    expect(classifyByRules('Fix the typo in the footer')).toMatchObject({ level: 'trivial', confident: true });
    expect(classifyByRules('Change the title of the settings page to "Preferences"')).toMatchObject({ level: 'trivial' });
    expect(classifyByRules('Add a dark mode toggle to the settings page')).toMatchObject({ level: 'medium', confident: true });
    expect(classifyByRules('Migrate the database schema to the new user model')).toMatchObject({ level: 'high', confident: true });
    expect(classifyByRules('Add authentication with magic links')).toMatchObject({ level: 'high' });
    // From the T-006 real run: a README mention must not make a code feature "low".
    expect(classifyByRules('Add an in-memory TodoStore class in src/todos.js with add, complete, remove and list, plus tests for every method in test/todos.test.js, and a short usage section in README.md')).toMatchObject({ level: 'medium' });
    expect(classifyByRules('Build it', { size: 'L' })).toMatchObject({ level: 'high', confident: true });
  });

  it('says when it is only guessing', () => {
    expect(classifyByRules('x')).toMatchObject({ confident: false });
    expect(classifyByRules('hmm the thing is weird')).toMatchObject({ confident: false });
    expect(classifyByRules('Rename the production config key')).toMatchObject({ level: 'medium', confident: false });
    expect(classifyByRules('word '.repeat(200)).level).toBe('high');
  });
});

describe('tiers and effort', () => {
  it('plans and reviews one tier up and never uses a weaker tier than asked', () => {
    expect(jobLevel('plan', 'trivial')).toBe('medium');
    expect(jobLevel('plan', 'medium')).toBe('high');
    expect(jobLevel('review', 'low')).toBe('medium');
    expect(jobLevel('review', 'high')).toBe('high');
    expect(jobLevel('review', 'medium')).toBe('high');
    expect(jobLevel('code', undefined)).toBe('medium');
    expect(tierFor({ high: { model: 'opus' }, medium: { model: 'sonnet' } }, 'trivial')).toEqual({ level: 'medium', spec: { model: 'sonnet' } });
    expect(tierFor({ low: { model: 'haiku' } }, 'high')).toBeUndefined();
  });

  it('gives claude-code opus/sonnet/haiku by default and keeps one model elsewhere', () => {
    expect(tierTable({ adapter: 'claude-code', model: 'haiku' }).high).toEqual({ model: 'opus', effort: 'high' });
    expect(tierTable({ adapter: 'codex', model: 'gpt-x', effort: 'medium' })).toEqual({
      trivial: { model: 'gpt-x', effort: 'medium' },
      low: { model: 'gpt-x', effort: 'medium' },
      medium: { model: 'gpt-x', effort: 'medium' },
      high: { model: 'gpt-x', effort: 'medium' },
    });
    expect(tierTable({ adapter: 'claude-code', tiers: { high: { model: 'fable' } } })).toEqual({ high: { model: 'fable' } });
  });

  it('moves effort with the hyde effort setting, clamped per CLI', () => {
    expect(shiftEffort('medium', effortShift('saver', 0))).toBe('low');
    expect(shiftEffort('low', effortShift('saver', 0))).toBe('low');
    expect(shiftEffort('high', effortShift('max', 0))).toBe('xhigh');
    expect(shiftEffort('high', effortShift('max', 0), 'high')).toBe('high');
    expect(effortShift('auto', 0.3)).toBe(0);
    expect(effortShift('auto', 0.7)).toBe(-1);
    expect(effortShift('balanced', 0.99)).toBe(0);
  });

  it('treats OpenCode Zen models as free unless the tier says otherwise', () => {
    expect(isFreeModel('opencode', 'opencode/big-pickle')).toBe(true);
    expect(isFreeModel('opencode', 'anthropic/claude-x')).toBe(false);
    expect(isFreeModel('opencode', 'opencode/big-pickle', false)).toBe(false);
    expect(isFreeModel('claude-code', 'haiku')).toBe(false);
  });
});

describe('router by mode and tier', () => {
  type P = HubConfig['agents'][number];
  const base = { enabled: true, maxConcurrent: 1, node: 'local', isolation: 'worktree' as const };
  const claude: P = { ...base, name: 'claude-1', adapter: 'claude-code', model: 'haiku', roles: ['plan', 'implement', 'review', 'ui'], account: 'acc-claude' };
  const codex: P = { ...base, name: 'codex-1', adapter: 'codex', roles: ['implement', 'review', 'bulk'], account: 'acc-codex' };
  const opencode: P = { ...base, name: 'opencode-1', adapter: 'opencode', model: 'opencode/big-pickle', roles: ['implement', 'bulk', 'triage'], account: 'acc-oc' };
  const vendors: Record<string, string> = { 'claude-1': 'anthropic', 'codex-1': 'openai', 'opencode-1': 'other' };
  const poolOf = (profiles: P[]) =>
    ({ profiles: () => profiles, profile: (n: string) => profiles.find((p) => p.name === n), usable: () => true, vendor: (n: string) => vendors[n] }) as unknown as AgentPool;
  const configOf = (mode: string, effort = 'balanced') =>
    ({ quotaSoftCeiling: 0.8, review: { crossVendor: true }, routing: { mode, effort, classifier: true } }) as unknown as HubConfig;
  const project = { id: 'demo', path: '/x', baseBranch: 'staging', releaseBranch: 'main', checks: [] };
  const taskAt = (level: string, extra: object = {}) =>
    ({ id: 'T-1', dependsOn: [], writeScope: [], complexity: { level, by: 'rules', reason: '', confident: true, seq: 1 }, ...extra }) as never;
  const all = poolOf([claude, codex, opencode]);
  const go = (level: string, mode: 'start' | 'plan' | 'review' = 'start', routing = 'balanced', state: HarnessState = emptyState(), extra = {}) =>
    route({ task: taskAt(level, extra), mode, project, state, pool: all, config: configOf(routing), now: 0, ...(mode === 'review' && { author: 'claude-1' }) });

  it('balanced: trivial code on the free model, medium on sonnet, high on opus, plans on opus', () => {
    expect(go('trivial')).toMatchObject({ agent: 'opencode-1', model: 'opencode/big-pickle', free: true });
    expect(go('medium')).toMatchObject({ agent: 'claude-1', tier: 'medium', model: 'sonnet', effort: 'medium' });
    expect(go('high')).toMatchObject({ agent: 'claude-1', tier: 'high', model: 'opus', effort: 'high' });
    expect(go('medium', 'plan')).toMatchObject({ agent: 'claude-1', model: 'opus' });
    expect(go('low', 'plan')).toMatchObject({ agent: 'claude-1', model: 'sonnet' });
    // Review: a different vendor that has the review role, never the free model.
    expect(go('high', 'review')).toMatchObject({ agent: 'codex-1' });
  });

  it('claude-only: no other vendors, and Claude may review its own work in a fresh session', () => {
    expect(go('trivial', 'start', 'claude-only')).toMatchObject({ agent: 'claude-1', model: 'haiku', effort: 'low' });
    expect(go('high', 'review', 'claude-only')).toMatchObject({ agent: 'claude-1', model: 'opus' });
  });

  it('free-first: free models for trivial and low, Claude for the rest', () => {
    expect(go('low', 'start', 'free-first')).toMatchObject({ agent: 'opencode-1' });
    expect(go('medium', 'start', 'free-first')).toMatchObject({ agent: 'claude-1', model: 'sonnet' });
    expect(go('high', 'start', 'free-first')).toMatchObject({ agent: 'claude-1', model: 'opus' });
  });

  it('never plans, reviews or codes high work on a free model', () => {
    const freeOnly = poolOf([{ ...opencode, roles: ['plan', 'implement', 'review'] }]);
    const config = configOf('balanced');
    expect(route({ task: taskAt('high'), mode: 'start', project, state: emptyState(), pool: freeOnly, config, now: 0 })).toMatchObject({ none: expect.stringMatching(/free model/) });
    expect(route({ task: taskAt('low'), mode: 'plan', project, state: emptyState(), pool: freeOnly, config, now: 0 })).toMatchObject({ none: expect.any(String) });
    expect(route({ task: taskAt('low'), mode: 'start', project, state: emptyState(), pool: freeOnly, config, now: 0 })).toMatchObject({ agent: 'opencode-1' });
  });

  it('waits instead of dropping to a weaker model when the right tier is out of quota (T-7)', () => {
    const state = emptyState();
    apply(state, { seq: 1, ts: '', type: 'quota.updated', actor: { kind: 'harness', id: 'h' }, payload: { account: 'acc-claude', window: 'five_hour', status: 'allowed', utilization: 0.9 } });
    // T-7 was planned by OpenCode's free model when Claude was over the soft ceiling. Now it waits.
    expect(go('high', 'plan', 'balanced', state)).toMatchObject({ wait: expect.stringMatching(/claude-1: quota at 90%/) });
    // High coding may go to Codex (same strength, not free); free-first keeps it on Claude and waits.
    expect(go('high', 'start', 'balanced', state)).toMatchObject({ agent: 'codex-1' });
    expect(go('high', 'start', 'free-first', state)).toMatchObject({ wait: expect.any(String) });
  });

  it('upgrades to a stronger tier when an agent has no entry for the level, and says so', () => {
    const tiered = poolOf([{ ...claude, tiers: { high: { model: 'opus', effort: 'high' }, medium: { model: 'sonnet', effort: 'medium' } } }]);
    const r = route({ task: taskAt('trivial'), mode: 'start', project, state: emptyState(), pool: tiered, config: configOf('balanced'), now: 0 });
    expect(r).toMatchObject({ agent: 'claude-1', tier: 'medium', model: 'sonnet', why: expect.stringMatching(/upgraded to claude-1's medium tier/) });
  });

  it('applies the hyde effort setting and records it in why', () => {
    const r = route({ task: taskAt('high'), mode: 'start', project, state: emptyState(), pool: poolOf([claude]), config: configOf('balanced', 'max'), now: 0 });
    expect(r).toMatchObject({ model: 'opus', effort: 'xhigh', why: expect.stringMatching(/effort high → xhigh/) });
    const saver = route({ task: taskAt('medium'), mode: 'start', project, state: emptyState(), pool: poolOf([claude]), config: configOf('balanced', 'saver'), now: 0 });
    expect(saver).toMatchObject({ model: 'sonnet', effort: 'low' });
  });

  it('plans a task the rules could not place on the strong tier', () => {
    const unsure = { complexity: { level: 'medium', by: 'rules', reason: '', confident: false, seq: 1 } };
    expect(go('medium', 'plan', 'balanced', emptyState(), unsure)).toMatchObject({ model: 'opus' });
  });
});
