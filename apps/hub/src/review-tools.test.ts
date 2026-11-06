import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '@hyde/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { exportHtml, exportMarkdown, redact } from './export.ts';
import { createApi } from './http.ts';
import { expandTemplate, parseTemplate } from './templates.ts';
import { doWork, makeHarness, type Harness, type Turn } from './test-helpers.ts';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const api = (hh: Harness) =>
  createApi({ orchestrator: hh.o, store: hh.store, config: hh.config, pool: (hh.o as unknown as { deps: { pool: never } }).deps.pool, host: () => hh.host, ownerToken: 'o', clientTokens: new Map([['c', 'hyde-ai']]), detect: async () => [], reload: async () => undefined });

describe('diff comments, checkpoints, templates, export', () => {
  it('sends the owner\'s diff comments to the agent as a review_fix turn in its session', async () => {
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [doWork(), doWork('hello.txt', 'hello\n')] }] });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file' }));
    await h.until(() => h!.o.state.approvals.has('A-1'), 'first done');
    const app = api(h);
    const post = (path: string, token: string, body?: unknown) => app.request(path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body !== undefined && { body: JSON.stringify(body) }) });
    expect((await post('/api/tasks/T-1/comments', 'c', { file: 'hello.txt', line: 1, text: 'Say hello' })).status).toBe(401);
    expect((await post('/api/tasks/T-1/comments', 'o', { file: 'hello.txt' })).status).toBe(400);
    expect(await (await post('/api/tasks/T-1/comments', 'o', { file: 'hello.txt', line: 1, text: 'Say hello, not hi' })).json()).toEqual({ id: 'C-1' });
    expect(await (await post('/api/tasks/T-1/comments/send', 'o')).json()).toEqual({ text: '1 comment(s) sent to claude-1.' });
    await h.until(() => h!.adapters['claude-1']!.calls.length === 2 && h!.o.state.runs.get('run-2')?.state === 'exited', 'review_fix turn');
    const call = h.adapters['claude-1']!.calls[1]!;
    expect(call).toMatchObject({ resumed: true });
    expect(call.prompt).toContain('- hello.txt:1: Say hello, not hi');
    expect(h.o.state.runs.get('run-2')!.mode).toBe('review_fix');
    expect(await (await post('/api/tasks/T-1/comments/send', 'o')).json()).toEqual({ text: 'T-1 has no unsent comments.' });
  });

  it('checkpoints the worktree before each turn and undoes the last one', async () => {
    const messy: Turn = async (ctx) => {
      writeFileSync(join(ctx.spec.cwd, 'wrong.txt'), 'oops\n');
      await git(ctx.spec.cwd, ['add', 'wrong.txt']);
      await git(ctx.spec.cwd, ['commit', '-q', '-m', 'wrong']);
      writeFileSync(join(ctx.spec.cwd, 'draft.txt'), 'uncommitted\n');
      await ctx.o.agentCall(ctx.runId, 'complete_task', { summary: 'done?', verified: 'no' });
      return [{ type: 'run.completed', summary: 'done' }];
    };
    let undoPrompt = '';
    const redo: Turn = async (ctx) => {
      undoPrompt = ctx.spec.prompt;
      return doWork()(ctx);
    };
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [messy, redo] }], checks: ['test -f hello.txt'], config: { maxFixRounds: 0 } });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file' }));
    await h.until(() => h!.o.state.tasks.get('T-1')!.status === 'failed', 'checks fail');
    const task = h.o.state.tasks.get('T-1')!;
    expect(task.checkpoints).toHaveLength(1);
    expect(existsSync(join(task.worktree!, 'wrong.txt'))).toBe(true);
    const reply = await h.o.handle(h.inbound({ kind: 'undo', taskId: 'T-1' }));
    expect(reply).toMatch(/^T-1 is back to before run-1/);
    expect(existsSync(join(task.worktree!, 'wrong.txt'))).toBe(false);
    expect(existsSync(join(task.worktree!, 'draft.txt'))).toBe(false);
    await h.until(() => h!.o.state.approvals.has('A-1'), 'redone');
    expect(undoPrompt).toContain('The owner undid your last turn (run-1)');
  });

  it('runs task templates from .hyde/commands with $ARGUMENTS', async () => {
    const t = parseTemplate('bump', '---\ndescription: Bump a dependency\nlevel: low\nagent: claude-1\n---\nBump $ARGUMENTS to the latest patch release and run the tests.\n', 'project');
    expect(t).toMatchObject({ name: 'bump', description: 'Bump a dependency', level: 'low', agent: 'claude-1' });
    expect(expandTemplate(t, 'zod')).toBe('Bump zod to the latest patch release and run the tests.');
    expect(expandTemplate(parseTemplate('x', 'Fix the footer.', 'user'), 'on mobile')).toBe('Fix the footer.\n\non mobile');
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [doWork()] }] });
    mkdirSync(join(h.repo, '.hyde', 'commands'), { recursive: true });
    writeFileSync(join(h.repo, '.hyde', 'commands', 'hello.md'), '---\ndescription: Add a hello file\nlevel: trivial\n---\nAdd hello.txt saying $ARGUMENTS\n');
    expect(await h.o.handle(h.inbound({ kind: 'template', args: '' }))).toBe('/run hello: Add a hello file');
    const reply = await h.o.handle(h.inbound({ kind: 'template', name: 'hello', args: 'hi' }));
    expect(reply).toMatch(/^T-1 accepted for #demo: Add hello.txt saying hi/);
    expect(await h.o.handle(h.inbound({ kind: 'template', name: 'nope', args: '' }))).toMatch(/^No template nope/);
    await h.until(() => h!.o.state.approvals.has('A-1'), 'done');
  });

  it('exports a session as Markdown or HTML with secrets redacted', async () => {
    expect(redact('key sk-abcdefghijklmnopqrstuv and ghp_abcdefghijklmnopqrstuvwxyz1234 token=supersecretvalue')).toBe('key [redacted] and [redacted] token=[redacted]');
    expect(redact('bot 123456789:AAabcdefghijklmnopqrstuvwxyz0123456')).toBe('bot [redacted]');
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [doWork()] }] });
    await h.o.handle(h.inbound({ kind: 'new', text: 'Add a hello file. Use password: hunter2hunter2' }));
    await h.until(() => h!.o.state.approvals.has('A-1'), 'done');
    const md = exportMarkdown(h.o.state, 'T-1', h.store.list({ taskId: 'T-1' }));
    expect(md).toContain('# T-1: Add a hello file.');
    expect(md).toContain('password: [redacted]');
    expect(md.split('\n').filter((l) => l.includes('hunter2'))).toEqual([]);
    expect(md).toContain('agent reported done: Added hello.txt');
    expect(md).toMatch(/\| run-1 \| start \| claude-1 \|/);
    const html = exportHtml(h.o.state, 'T-1', h.store.list({ taskId: 'T-1' }));
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).not.toContain('<script');
    const res = await api(h).request('/api/tasks/T-1/export?format=md', { headers: { authorization: 'Bearer o' } });
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="T-1.md"');
    expect((await api(h).request('/api/tasks/T-1/export', { headers: { authorization: 'Bearer c' } })).status).toBe(401);
    expect(readFileSync(join(h.repo, 'progress.md'), 'utf8')).toBeTruthy();
  });
});
