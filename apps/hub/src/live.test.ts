import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createApi } from './http.ts';
import { LiveBrowser, type LiveMessage } from './live.ts';
import { doWork, makeHarness, type Harness, type Turn } from './test-helpers.ts';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const JPEG = Buffer.from('ffd8ffe000104a46494600', 'hex').toString('base64');

describe('live browser in the hub', () => {
  it('logs each step with a keyframe, asks before acting on other sites, and passes owner notes', async () => {
    const results: Record<string, unknown>[] = [];
    const browse: Turn = async (ctx) => {
      const call = (op: string, body: Record<string, unknown>) => ctx.o.browserCall(ctx.runId, op, body);
      results.push(await call('before', { op: 'click', url: 'http://127.0.0.1:5173/', label: "click 'Sign in'" }));
      results.push(
        await call('after', { op: 'click', url: 'http://127.0.0.1:5173/', label: "click 'Sign in'", ok: true, box: { x: 10, y: 20, width: 100, height: 30 }, x: 60, y: 35, viewport: { width: 1280, height: 800 }, keyframe: JPEG }),
      );
      ctx.o.browserLive.takeOver('T-1', 5, 6);
      results.push(await call('frame', { jpeg: JPEG, width: 1280, height: 800, url: 'http://127.0.0.1:5173/' }));
      results.push(await call('before', { op: 'fill', url: 'https://example.com/login', label: 'type into e1' }));
      results.push(await call('before', { op: 'fill', url: 'https://example.com/login', label: 'type into e1' }));
      return doWork()(ctx);
    };
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [browse] }] });
    const seen: LiveMessage[] = [];
    h!.o.browserLive.watch('T-1', (m) => seen.push(m));
    await h!.o.handle(h!.inbound({ kind: 'new', text: 'Add a hello file' }));
    await h!.until(() => h!.o.state.tasks.get('T-1')!.status === 'blocked', 'blocked on the browser approval');
    expect(results[0]).toEqual({ allowed: true, notes: [] });
    expect(results[2]).toEqual({ commands: [{ kind: 'click', x: 5, y: 6 }] });
    expect(results[3]).toEqual({ allowed: false, message: "Acting on example.com needs the owner's approval (A-1). End your turn now; you will be resumed with the decision." });
    expect(results[4]).toMatchObject({ allowed: false, message: expect.stringContaining('(A-1)') }); // not asked twice
    const step = h!.store.list({ taskId: 'T-1' }).find((e) => e.type === 'browser.action')!.payload as Record<string, unknown>;
    expect(step).toMatchObject({ step: 1, op: 'click', x: 60, y: 35, box: { width: 100 }, artifactId: 'art-1' });
    const art = h!.o.state.artifacts.get('art-1')!;
    expect(art).toMatchObject({ kind: 'screenshot', label: "browser step 1: click 'Sign in'" });
    expect(readFileSync(art.path).toString('base64')).toBe(JPEG);
    expect(h!.o.state.tasks.get('T-1')!.browserSteps).toBe(1);
    expect(seen.map((m) => m.type)).toEqual(['state', 'action', 'frame']);
    expect(h!.o.state.approvals.get('A-1')).toMatchObject({ kind: 'destructive', data: { browserHost: 'example.com' } });
    // After approval, actions on that host go through.
    expect(await h!.o.browserCall('run-1', 'before', { op: 'fill', url: 'https://example.com/', label: 'x' })).toMatchObject({ allowed: false });
  });

  it('holds steps while the owner has paused the browser', async () => {
    const live = new LiveBrowser();
    live.setPaused('T-1', true);
    let t = 0;
    expect(await live.waitWhilePaused('T-1', 1000, () => (t += 600))).toBe(false);
    const wait = live.waitWhilePaused('T-1', 10_000);
    setTimeout(() => live.setPaused('T-1', false), 50);
    expect(await wait).toBe(true);
    live.takeOver('T-1', 1, 2);
    expect(live.drainNotes('T-1')[0]).toMatch(/owner clicked at \(1, 2\)/);
    expect(live.drainNotes('T-1')).toEqual([]);
  });

  it('serves the live controls to the owner only', async () => {
    h = await makeHarness({ agents: [{ name: 'claude-1', vendor: 'anthropic', turns: [] }] });
    await h!.o.handle(h!.inbound({ kind: 'new', text: 'Add a hello file' }));
    const app = createApi({ orchestrator: h.o, store: h!.store, config: h!.config, pool: (h.o as unknown as { deps: { pool: never } }).deps.pool, host: () => h!.host, ownerToken: 'o', clientTokens: new Map([['c', 'hyde-ai']]), detect: async () => [], reload: async () => undefined });
    const post = (token: string, body: unknown) => app.request('/api/tasks/T-1/live', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post('c', { action: 'pause' })).status).toBe(401);
    expect(await (await post('o', { action: 'pause' })).json()).toEqual({ ok: true, paused: true });
    expect((await post('o', { action: 'click', x: 1 })).status).toBe(400);
    expect(await (await post('o', { action: 'resume' })).json()).toEqual({ ok: true, paused: false });
    expect((await app.request('/api/agent/browser/before', { method: 'POST', body: '{}' })).status).toBe(401);
  });
});
