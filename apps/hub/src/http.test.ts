import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApi } from './http.ts';
import { doWork, makeHarness, type Harness } from './test-helpers.ts';

let h: Harness;
afterEach(async () => h?.close());

async function api() {
  h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [doWork()] }] });
  writeFileSync(h.config.configFile, JSON.stringify({ projects: [{ id: 'demo', path: h.repo }], agents: [{ name: 'claude-1', adapter: 'claude-code' }] }));
  let reloaded = 0;
  const app = createApi({
    orchestrator: h.o,
    store: h.store,
    config: h.config,
    pool: (h.o as unknown as { deps: { pool: never } }).deps.pool,
    host: () => h.host,
    ownerToken: 'owner-secret',
    detect: async () => [{ id: 'claude-code', label: 'Claude Code', kind: 'agent', installed: true, signedIn: true }],
    reload: async () => void reloaded++,
  });
  const req = (path: string, init: RequestInit & { token?: string | null; cookie?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.token !== null) headers.set('authorization', `Bearer ${init.token ?? 'owner-secret'}`);
    if (init.cookie) headers.set('cookie', init.cookie);
    return app.request(path, { ...init, headers });
  };
  return { app, req, reloaded: () => reloaded };
}

describe('hub API', () => {
  it('requires the owner token or login cookie', async () => {
    const { req } = await api();
    expect((await req('/api/state', { token: null })).status).toBe(401);
    expect((await req('/api/state', { token: 'guess' })).status).toBe(401);
    const state = await (await req('/api/state')).json();
    expect(state).toMatchObject({ tasks: [], agents: [{ name: 'claude-1', vendor: 'anthropic' }], projects: [{ id: 'demo' }] });

    const login = await req('/login?token=owner-secret', { token: null });
    expect(login.status).toBe(302);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    expect(login.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect((await req('/api/state', { token: null, cookie })).status).toBe(200);
    // Cookie-authenticated writes must be JSON (no cross-site form posts).
    expect((await req('/api/commands', { token: null, cookie, method: 'POST', body: 'text=/status' })).status).toBe(415);
    const ok = await req('/api/commands', { token: null, cookie, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hyde status' }) });
    expect(await ok.json()).toEqual({ text: 'No active tasks.' });
    expect((await req('/login?token=nope', { token: null })).status).toBe(401);
  });

  it('runs commands from the web as the owner, with sources recorded as web', async () => {
    const { req } = await api();
    const login = await req('/login?token=owner-secret', { token: null });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    await req('/api/commands', { token: null, cookie, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: { kind: 'new', text: 'Add a hello file' } }) });
    expect(h.o.state.tasks.get('T-1')!.source.kind).toBe('web');
  });

  it('accepts agent calls and policy checks only with a live run token', async () => {
    const { req } = await api();
    expect((await req('/api/agent/complete_task', { token: 'nope', method: 'POST', body: '{}' })).status).toBe(401);
    const deny = (await (await req('/api/policy/pre-tool-use', { token: 'nope', method: 'POST', body: '{}' })).json()) as { hookSpecificOutput: { permissionDecision: string } };
    expect(deny.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('validates config updates before writing and reloads', async () => {
    const { req, reloaded } = await api();
    const bad = await req('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projects: [] }) });
    expect(bad.status).toBe(400);
    const raw = (await (await req('/api/config')).json()) as Record<string, unknown>;
    raw.review = { enabled: true };
    const good = await req('/api/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(raw) });
    expect(good.status).toBe(200);
    expect(reloaded()).toBe(1);
  });

  it('serves only recorded artifacts from the data dir, metrics and detection', async () => {
    const { req } = await api();
    const dir = join(h.config.dataDir, 'artifacts', 'T-1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'page-1.png'), 'png');
    h.store.append({ type: 'artifact.saved', actor: { kind: 'harness', id: 'hub' }, payload: { artifactId: 'art-1', taskId: 'T-1', kind: 'screenshot', path: join(dir, 'page-1.png') } });
    h.store.append({ type: 'artifact.saved', actor: { kind: 'harness', id: 'hub' }, payload: { artifactId: 'art-2', taskId: 'T-1', kind: 'log', path: '/etc/passwd' } });
    const art = await req('/api/artifacts/art-1');
    expect(art.headers.get('content-type')).toBe('image/png');
    expect(await art.text()).toBe('png');
    expect((await req('/api/artifacts/art-2')).status).toBe(404);
    expect(await (await req('/metrics')).text()).toContain('# TYPE hyde_tasks gauge');
    expect(await (await req('/api/setup/detect')).json()).toEqual([expect.objectContaining({ id: 'claude-code' })]);
  });
});
