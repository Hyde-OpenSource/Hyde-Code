import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyState, apply, type ChatGateway, type OutboundMessage } from '@hyde/core';
import { describe, expect, it } from 'vitest';
import { accountQuota, route, type AgentPool } from './agents.ts';
import { parseConfig } from './config.ts';
import { isQuiet, Notifier } from './notifier.ts';
import { checkPlan, scopesOverlap } from './planner.ts';
import { decide, inWriteScope } from './policy-engine.ts';
import { blockingFindings, parseReview } from './review.ts';
import { applyWorkflow, parseWorkflow, renderTemplate } from './workflow.ts';

describe('planner checks', () => {
  const t = (key: string, extra: Record<string, unknown> = {}) => ({ key, title: key, doneWhen: `${key} returns 200 in tests`, writeScope: [`src/${key}/**`], role: 'implement', dependsOn: [], size: 'S', ...extra });

  it('accepts a good plan', () => {
    const r = checkPlan({ questions: [], tasks: [t('a'), t('b', { dependsOn: ['a'] })] });
    expect(r.errors).toEqual([]);
  });

  it('rejects cycles, unknown deps, duplicates and untestable done-when', () => {
    expect(checkPlan({ tasks: [t('a', { dependsOn: ['b'] }), t('b', { dependsOn: ['a'] })] }).errors).toContain('the task graph has a cycle');
    expect(checkPlan({ tasks: [t('a', { dependsOn: ['zz'] })] }).errors[0]).toMatch(/unknown task zz/);
    expect(checkPlan({ tasks: [t('a'), t('a')] }).errors[0]).toMatch(/duplicate/);
    expect(checkPlan({ tasks: [t('a', { doneWhen: 'ok' })] }).errors[0]).toMatch(/testable/);
    expect(checkPlan({ tasks: [] }).errors).toContain('the plan has no tasks');
    expect(checkPlan('nonsense').errors[0]).toMatch(/invalid plan/);
  });

  it('serializes overlapping write scopes', () => {
    const r = checkPlan({ tasks: [t('a', { writeScope: ['src/**'] }), t('b', { writeScope: ['src/b/**'] }), t('c', { writeScope: ['docs/**'] })] });
    expect(r.implicitDeps).toEqual([{ from: 'b', to: 'a' }]);
    expect(r.plan.tasks[1]!.dependsOn).toEqual(['a']);
    expect(scopesOverlap(['src/api/**'], ['src/ui/**'])).toBe(false);
    expect(scopesOverlap([], ['x'])).toBe(true);
  });
});

describe('review parsing', () => {
  it('parses verdicts and picks blocking findings', () => {
    const r = parseReview({ verdict: 'changes', summary: 's', findings: [{ severity: 'low', text: 'nit' }, { severity: 'high', text: 'bug' }] })!;
    expect(blockingFindings(r.findings)).toEqual([{ severity: 'high', text: 'bug' }]);
    expect(parseReview({ verdict: 'maybe' })).toBeNull();
  });
});

describe('policy engine', () => {
  const base = { cwd: '/w', writeScope: [], approvalRequired: ['new-dependency'], approvedCommands: [] };
  const bash = (command: string, extra = {}) => decide({ ...base, ...extra, tool: 'Bash', input: { command } });

  it('denies pushes, merges, protected checkouts, hook skipping and sudo', () => {
    expect(bash('git push origin feature')).toMatchObject({ decision: 'deny', rule: 'no-push' });
    expect(bash('npm test && git push')).toMatchObject({ decision: 'deny', rule: 'no-push' });
    expect(bash('git merge main')).toMatchObject({ decision: 'deny', rule: 'no-merge' });
    expect(bash('git checkout staging')).toMatchObject({ decision: 'deny', rule: 'protected-branch' });
    expect(bash('git checkout -b my-fix')).toMatchObject({ decision: 'allow' });
    expect(bash('git commit --no-verify -m x')).toMatchObject({ decision: 'deny', rule: 'no-skip-hooks' });
    expect(bash('sudo rm x')).toMatchObject({ decision: 'deny' });
    expect(bash('git branch -D old')).toMatchObject({ decision: 'deny', rule: 'no-branch-delete' });
  });

  it('asks before new dependencies and destructive commands, unless approved', () => {
    expect(bash('npm install zod')).toMatchObject({ decision: 'approval', rule: 'new-dependency' });
    expect(bash('pnpm add -D vitest')).toMatchObject({ decision: 'approval' });
    expect(bash('pip install requests')).toMatchObject({ decision: 'approval' });
    expect(bash('npm install')).toMatchObject({ decision: 'allow' });
    expect(bash('npm ci && npm test')).toMatchObject({ decision: 'allow' });
    expect(bash('npm install zod', { approvedCommands: ['npm install zod'] })).toMatchObject({ decision: 'allow' });
    expect(bash('rm -rf build')).toMatchObject({ decision: 'deny', rule: 'destructive' });
    expect(bash('rm -rf build', { approvalRequired: ['destructive'] })).toMatchObject({ decision: 'approval', rule: 'destructive' });
  });

  it('keeps edits inside the worktree, the write scope and away from harness files', () => {
    const edit = (file_path: string, writeScope: string[] = []) => decide({ ...base, writeScope, tool: 'Edit', input: { file_path } });
    expect(edit('/w/src/a.ts')).toMatchObject({ decision: 'allow' });
    expect(edit('/etc/hosts')).toMatchObject({ decision: 'deny', rule: 'outside-worktree' });
    expect(edit('/w/.env.local')).toMatchObject({ decision: 'deny', rule: 'env-file' });
    expect(edit('/w/progress.md')).toMatchObject({ decision: 'deny', rule: 'single-writer' });
    expect(edit('/w/src/api/x.ts', ['src/api/**'])).toMatchObject({ decision: 'allow' });
    expect(edit('/w/src/ui/x.ts', ['src/api/**'])).toMatchObject({ decision: 'deny', rule: 'write-scope' });
    expect(inWriteScope('/w', 'src/api/deep/x.ts', ['src/api/**'])).toBe(true);
    expect(inWriteScope('/w', 'README.md', ['*.md'])).toBe(true);
  });
});

describe('notifier', () => {
  class Recorder implements ChatGateway {
    readonly name = 'telegram';
    sent: { chatId: string; message: OutboundMessage }[] = [];
    async start() {}
    async send(chatId: string, message: OutboundMessage) {
      this.sent.push({ chatId, message });
    }
    async stop() {}
  }

  it('knows quiet hours across midnight', () => {
    const at = (h: number) => new Date(2026, 9, 29, h, 0);
    expect(isQuiet(at(23), { start: '23:00', end: '08:00' })).toBe(true);
    expect(isQuiet(at(3), { start: '23:00', end: '08:00' })).toBe(true);
    expect(isQuiet(at(9), { start: '23:00', end: '08:00' })).toBe(false);
    expect(isQuiet(at(13), { start: '12:00', end: '14:00' })).toBe(true);
    expect(isQuiet(at(13))).toBe(false);
  });

  it('routes to the source chat or the owner, holds during quiet hours and batches digests', async () => {
    const g = new Recorder();
    let now = new Date(2026, 9, 29, 23, 30);
    const n = new Notifier({ gateways: new Map([['telegram', g]]), ownerChat: 'telegram:42', quietHours: { start: '23:00', end: '08:00' }, digestMinutes: 20, log: () => {}, now: () => now });
    expect(n.target({ kind: 'telegram', chatId: '7' })).toEqual({ gateway: 'telegram', chatId: '7' });
    expect(n.target({ kind: 'cli' })).toEqual({ gateway: 'telegram', chatId: '42' });
    expect(n.target({ kind: 'slack', chatId: 'C1' })).toEqual({ gateway: 'telegram', chatId: '42' }); // slack not connected
    await n.send({ gateway: 'telegram', chatId: '7' }, { text: 'question' });
    await n.send({ gateway: 'telegram', chatId: '7' }, { text: 'incident', priority: 'urgent' });
    await n.send({ gateway: 'telegram', chatId: '7' }, { text: 'p1', priority: 'digest' });
    await n.send({ gateway: 'telegram', chatId: '7' }, { text: 'p2', priority: 'digest' });
    expect(g.sent.map((s) => s.message.text)).toEqual(['incident']);
    now = new Date(2026, 9, 30, 8, 30);
    await n.flush();
    expect(g.sent.map((s) => s.message.text)).toEqual(['incident', 'question', 'Progress digest:\n• p1\n• p2']);
  });
});

describe('workflow', () => {
  it('parses WORKFLOW.md front matter and template', () => {
    const text = '---\nchecks: ["npm test"]\npreview: { command: "npm run dev -- --port $PORT" }\nagents: { allowed: [codex-1] }\n---\nYou are working on {{ task.title }} in {{ project.name }}.';
    const { settings, template } = parseWorkflow(text);
    expect(settings.checks).toEqual(['npm test']);
    expect(template).toBe('You are working on {{ task.title }} in {{ project.name }}.');
    const project = { id: 'x', path: '/x', baseBranch: 'staging', releaseBranch: 'main', checks: [] };
    const w = applyWorkflow(project, text);
    expect(w.project).toMatchObject({ checks: ['npm test'], agents: ['codex-1'], preview: { command: 'npm run dev -- --port $PORT', url: 'http://127.0.0.1:$PORT', paths: ['/'] } });
    expect(applyWorkflow({ ...project, checks: ['make'] }, text).project.checks).toEqual(['make']);
    expect(renderTemplate(template, { 'task.title': 'T', 'project.name': 'P' })).toBe('You are working on T in P.');
    expect(applyWorkflow(project, null).template).toBe('');
  });
});

describe('config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hyde-cfg-'));
  mkdirSync(join(dir, 'repo', '.git'), { recursive: true });
  const project = { id: 'demo', path: join(dir, 'repo') };

  it('accepts the Phase 0 single-agent form and derives accounts', () => {
    const c = parseConfig({ agent: { name: 'claude-1' }, projects: [project] }, join(dir, 'hyde.config.json'), {});
    expect(c.agents).toEqual([expect.objectContaining({ name: 'claude-1', adapter: 'claude-code', account: 'local:claude-code', enabled: true })]);
    expect(c.dataDir).toBe(join(dir, '.hyde'));
  });

  it('validates agents, projects and schedules', () => {
    const f = join(dir, 'hyde.config.json');
    expect(() => parseConfig({ agents: [{ name: 'a', adapter: 'acp' }], projects: [project] }, f, {})).toThrow(/needs "command"/);
    expect(() => parseConfig({ agents: [{ name: 'a', adapter: 'codex', enabled: false }], projects: [project] }, f, {})).toThrow(/at least one agent/);
    expect(() => parseConfig({ agents: [{ name: 'a', adapter: 'codex' }, { name: 'a', adapter: 'codex' }], projects: [project] }, f, {})).toThrow(/twice/);
    expect(() => parseConfig({ projects: [{ id: 'x', path: 'relative' }] }, f, {})).toThrow(/absolute/);
    expect(() => parseConfig({ schedules: [{ id: 's', cron: '* * * * *', project: 'nope', text: 'x' }], projects: [project] }, f, {})).toThrow(/unknown project/);
  });

  it('reads secrets only from the environment', () => {
    const c = parseConfig({ projects: [project] }, join(dir, 'hyde.config.json'), { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_ALLOWED_USER_IDS: '1, 2,x', WHATSAPP_CLIENT_NUMBERS: '911234567890' });
    expect(c.secrets).toMatchObject({ telegramToken: 't', telegramAllowedUserIds: [1, 2], whatsappClients: ['911234567890'] });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('router', () => {
  const profiles = [
    { name: 'claude-1', adapter: 'claude-code', enabled: true, roles: ['plan', 'implement', 'review', 'ui'], maxConcurrent: 1, account: 'acc-claude', node: 'local', isolation: 'worktree' },
    { name: 'codex-1', adapter: 'codex', enabled: true, roles: ['implement', 'review'], maxConcurrent: 1, account: 'acc-codex', node: 'local', isolation: 'worktree' },
  ];
  const vendors: Record<string, string> = { 'claude-1': 'anthropic', 'codex-1': 'openai' };
  const pool = {
    profiles: () => profiles,
    profile: (n: string) => profiles.find((p) => p.name === n),
    usable: () => true,
    vendor: (n: string) => vendors[n],
  } as unknown as AgentPool;
  const config = { quotaSoftCeiling: 0.8, review: { crossVendor: true } } as never;
  const project = { id: 'demo', path: '/x', baseBranch: 'staging', releaseBranch: 'main', checks: [] };
  const task = { id: 'T-1', role: 'ui', dependsOn: [], writeScope: [] } as never;

  it('prefers role fit, respects quota and concurrency, and picks a different vendor to review', () => {
    const state = emptyState();
    expect(route({ task, mode: 'start', project, state, pool, config, now: 0 })).toEqual({ agent: 'claude-1' });
    expect(route({ task, mode: 'review', project, state, pool, config, now: 0, author: 'claude-1' })).toEqual({ agent: 'codex-1' });
    apply(state, { seq: 1, ts: '', type: 'quota.updated', actor: { kind: 'harness', id: 'h' }, payload: { account: 'acc-claude', window: 'five_hour', status: 'rejected', utilization: 1 } });
    expect(accountQuota(state, 'acc-claude', 0).blocked).toBe('five_hour limit reached');
    expect(route({ task, mode: 'start', project, state, pool, config, now: 0 })).toEqual({ agent: 'codex-1' });
    apply(state, { seq: 2, ts: '', type: 'run.dispatched', actor: { kind: 'harness', id: 'h' }, payload: { runId: 'run-1', taskId: 'T-9', attempt: 1, adapter: 'codex', account: 'acc-codex', agent: 'codex-1', node: 'local', mode: 'start' } });
    expect(route({ task, mode: 'start', project, state, pool, config, now: 0 })).toEqual({ wait: 'codex-1 is busy' });
    expect(route({ task, mode: 'review', project, state, pool, config, now: 0, author: 'codex-1' })).toMatchObject({ wait: expect.any(String) });
    expect(route({ task, mode: 'start', project: { ...project, agents: ['nobody'] }, state, pool, config, now: 0 })).toMatchObject({ none: expect.any(String) });
  });
});

describe('setup', async () => {
  const { buildConfig, upsertEnv } = await import('./setup.ts');
  const detected = [
    { id: 'claude-code', label: 'Claude Code', kind: 'agent' as const, installed: true, signedIn: true, suggest: { adapter: 'claude-code', name: 'claude-1', roles: ['plan', 'implement'] } },
    { id: 'gemini', label: 'Gemini', kind: 'agent' as const, installed: true, signedIn: true, suggest: { adapter: 'acp', name: 'gemini-1', command: ['gemini', '--experimental-acp'], vendor: 'google', roles: ['implement'] } },
  ];

  it('builds a valid config from only what the owner picked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hyde-setup-'));
    mkdirSync(join(dir, '.git'));
    const raw = buildConfig(detected, {
      agents: [{ id: 'gemini' }],
      project: { id: 'demo', path: dir, baseBranch: 'main', checks: ['npm test'] },
      planner: false,
      review: false,
      browser: false,
      policy: true,
      gateways: { telegram: true, slack: false, discord: false, whatsapp: false },
      quietHours: { start: '23:00', end: '08:00' },
    });
    expect(raw.agents).toEqual([{ name: 'gemini-1', adapter: 'acp', roles: ['implement'], command: ['gemini', '--experimental-acp'], vendor: 'google' }]);
    const parsed = parseConfig(raw, join(dir, 'hyde.config.json'), {});
    expect(parsed.agents[0]!.vendor).toBe('google');
    expect(parsed.notifications.quietHours).toEqual({ start: '23:00', end: '08:00' });
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps other projects and settings when run again', () => {
    const raw = buildConfig(detected, { agents: [{ id: 'claude-code', model: 'opus' }], project: { id: 'b', path: '/b', baseBranch: 'staging', checks: [] }, planner: true, review: false, browser: false, policy: true, gateways: { telegram: false, slack: false, discord: false, whatsapp: false } }, { port: 9999, projects: [{ id: 'a', path: '/a' }] });
    expect(raw.port).toBe(9999);
    expect(raw.projects!.map((p) => p.id)).toEqual(['a', 'b']);
    expect(raw.agents![0]!.model).toBe('opus');
  });

  it('upserts .env values without touching other lines', () => {
    expect(upsertEnv('A=1\nTELEGRAM_BOT_TOKEN=old\n', { TELEGRAM_BOT_TOKEN: 'new', SLACK_BOT_TOKEN: 'x', EMPTY: '' })).toBe('A=1\nTELEGRAM_BOT_TOKEN=new\nSLACK_BOT_TOKEN=x\n');
  });
});
