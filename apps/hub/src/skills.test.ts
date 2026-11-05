import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '@hyde/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { answer, doWork, makeHarness, type Harness, type Turn } from './test-helpers.ts';

let h: Harness;
afterEach(async () => h?.close());

function projectSkill(repo: string, name: string, description: string): void {
  mkdirSync(join(repo, '.hyde', 'skills', name), { recursive: true });
  writeFileSync(join(repo, '.hyde', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nSteps for ${name}.\n`);
}

describe('skills in runs', () => {
  it('gives every enabled skill to a run in the CLI folder, lists them in the packet, and never commits them', async () => {
    let seen: string[] = [];
    const look: Turn = async (ctx) => {
      seen = ['hyde-verify', 'deploy-notes'].filter((n) => existsSync(join(ctx.spec.cwd, '.claude', 'skills', n, 'SKILL.md')));
      return doWork()(ctx);
    };
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [look] }] });
    projectSkill(h.repo, 'deploy-notes', 'Use when the task touches deployment');
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file' }));
    await h.until(() => h.o.state.approvals.has('A-1'), 'done');
    expect(seen).toEqual(['hyde-verify', 'deploy-notes']);
    const task = h.o.state.tasks.get('T-1')!;
    const packet = readFileSync(h.adapters['claude-1']!.calls[0]!.spec.packetFile!, 'utf8');
    expect(packet).toContain('## Skills for this task');
    expect(packet).toContain('- **deploy-notes**: Use when the task touches deployment');
    const files = await git(task.worktree!, ['log', '--name-only', '--format=', 'staging..HEAD']);
    expect(files).not.toContain('.claude/skills');
    expect(readFileSync(join(h.repo, '.git', 'info', 'exclude'), 'utf8')).toContain('/.claude/skills/deploy-notes/');
  });

  it('uses the planner\'s skill choice, and the owner can change it', async () => {
    const plan = {
      complexity: 'low', complexityReason: 'x', questions: [], assumptions: [],
      tasks: [{ key: 'a', title: 'Add a hello file', spec: 'Write hello.txt', doneWhen: 'hello.txt exists with hi', writeScope: [], role: 'implement', dependsOn: [], size: 'S', complexity: 'low', skills: ['deploy-notes', 'nope'] }],
    };
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [answer(plan), doWork()] }], config: { planner: { enabled: true } } });
    projectSkill(h.repo, 'deploy-notes', 'Use when the task touches deployment');
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file' }));
    await h.until(() => h.o.state.approvals.has('A-1'), 'done');
    expect(h.adapters['claude-1']!.calls[0]!.prompt).toContain('  - deploy-notes: Use when the task touches deployment');
    const packet = readFileSync(h.adapters['claude-1']!.calls[1]!.spec.packetFile!, 'utf8');
    expect(packet).toContain('deploy-notes');
    expect(packet).not.toContain('**hyde-verify**');
    expect(await h.o.handle(h.inbound({ kind: 'skills', taskId: 'T-1', add: ['hyde-verify'], remove: ['deploy-notes'] }))).toBe('T-1 skills: hyde-verify. The next run gets them.');
    expect(await h.o.handle(h.inbound({ kind: 'skills', taskId: 'T-1', add: ['ghost'], remove: [] }))).toMatch(/^Unknown skill\(s\): ghost/);
  });

  it('saves a proposed skill only after the owner approves it', async () => {
    let reply = '';
    const propose: Turn = async (ctx) => {
      reply = await ctx.o.agentCall(ctx.runId, 'propose_skill', { name: 'run-e2e', description: 'Use to run this repo\'s end-to-end tests', body: '1. npm run e2e\n2. read the report' });
      return doWork()(ctx);
    };
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [propose] }] });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file' }));
    await h.until(() => h.o.state.approvals.has('A-1'), 'done');
    expect(reply).toBe('Recorded as S-1; the owner decides whether it becomes a skill.');
    const dir = join(h.config.configDir, 'skills', 'run-e2e');
    expect(existsSync(dir)).toBe(false);
    const notice = h.gateway.sent.find((s) => s.message.text.startsWith('🧩 S-1'))!;
    expect(notice.message.buttons?.[0]?.[0]?.action).toEqual({ kind: 'skill', skillId: 'S-1', approved: true });
    expect(await h.o.handle(h.inbound({ kind: 'skill', skillId: 'S-1', approved: true }))).toMatch(/^S-1 saved as skill run-e2e/);
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toContain('description: Use to run this repo\'s end-to-end tests');
    expect(await h.o.handle(h.inbound({ kind: 'skills', add: [], remove: [] }))).toContain('run-e2e (user)');
  });
});
