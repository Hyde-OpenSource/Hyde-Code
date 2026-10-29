import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { serveStatic } from '@hono/node-server/serve-static';
import { describeEvent, normalizeCommandText, parseCommand, snapshot, TOOLS_NAMES, type Command, type EventStore } from '@hyde/core';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import type { AgentPool } from './agents.ts';
import { readRawConfig, writeRawConfig, type HubConfig } from './config.ts';
import type { Detected } from './detect.ts';
import type { HostOps } from './host.ts';
import { agentMetrics, prometheus } from './metrics.ts';
import { TILE_FILES, tilePath } from './tiles.ts';
import type { Orchestrator } from './orchestrator.ts';

export interface ApiDeps {
  orchestrator: Orchestrator;
  store: EventStore;
  config: HubConfig;
  pool: AgentPool;
  host: (node: string) => HostOps;
  ownerToken: string;
  detect: () => Promise<Detected[]>;
  /** Applies a saved config without a restart. */
  reload: () => Promise<void>;
  whatsapp?: { verify(q: Record<string, string | undefined>): string | null; handleWebhook(raw: string, sig: string | undefined): Promise<boolean> };
  /** Built dashboard (apps/web/dist), if present. */
  webDir?: string;
}

const COOKIE = 'hyde_owner';

function bearer(header: string | undefined): string | null {
  const m = /^Bearer (\S+)$/.exec(header ?? '');
  return m ? m[1]! : null;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webm': 'video/webm', '.txt': 'text/plain', '.log': 'text/plain' };

/**
 * The hub API, served on 127.0.0.1 (reach it remotely only through Tailscale or similar).
 * Agents authenticate with their run's token, valid only while the run is live; the owner uses
 * the owner token (CLI) or the cookie set by /login (dashboard).
 */
export function createApi(deps: ApiDeps): Hono {
  const { orchestrator, store, config } = deps;
  const app = new Hono();

  const isOwner = (c: Context): boolean => {
    const token = bearer(c.req.header('authorization')) ?? getCookie(c, COOKIE) ?? '';
    return Boolean(token) && same(token, deps.ownerToken);
  };
  // Cookie-authenticated writes must be JSON, which a cross-site form can't send without CORS.
  const owner = async (c: Context, next: () => Promise<void>) => {
    if (!isOwner(c)) return c.json({ error: 'owner login required' }, 401);
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && !bearer(c.req.header('authorization')) && !c.req.header('content-type')?.startsWith('application/json')) {
      return c.json({ error: 'JSON body required' }, 415);
    }
    await next();
  };

  app.get('/api/health', (c) => c.json({ ok: true }));

  // ---------------------------------------------------------------- agents (run token)

  app.post('/api/agent/:tool', async (c) => {
    const tool = c.req.param('tool') ?? '';
    const token = bearer(c.req.header('authorization'));
    const runId = token ? orchestrator.runForToken(token) : undefined;
    if (!runId) return c.json({ error: 'unknown or expired run token' }, 401);
    if (!(TOOLS_NAMES as readonly string[]).includes(tool)) return c.json({ error: `unknown tool ${tool}` }, 404);
    const args = await c.req.json().catch(() => null);
    if (!args || typeof args !== 'object') return c.json({ error: 'JSON body required' }, 400);
    try {
      return c.json({ text: await orchestrator.agentCall(runId, tool, args as Record<string, unknown>) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // Claude Code's PreToolUse HTTP hook. Unknown tokens are denied, never allowed.
  app.post('/api/policy/pre-tool-use', async (c) => {
    const token = bearer(c.req.header('authorization'));
    const runId = token ? orchestrator.runForToken(token) : undefined;
    if (!runId) {
      return c.json({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Hyde Code: unknown run' } });
    }
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return c.json(orchestrator.policyCheck(runId, body));
  });

  // ---------------------------------------------------------------- owner

  app.get('/login', (c) => {
    const token = c.req.query('token') ?? '';
    if (!token || !same(token, deps.ownerToken)) return c.text('Invalid token. Run `pnpm hyde dashboard` for a fresh link.', 401);
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 60 * 60 * 24 * 30 });
    return c.redirect('/');
  });

  app.post('/api/commands', owner, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { text?: string; command?: Command } | null;
    const command = body?.command ?? (body?.text ? parseCommand(normalizeCommandText(body.text)) : null);
    if (!command) return c.json({ error: 'send {"text": "/command ..."}' }, 400);
    const viaCookie = !bearer(c.req.header('authorization'));
    const reply = await orchestrator.handle({
      command,
      userId: viaCookie ? 'web:owner' : 'cli:owner',
      gateway: viaCookie ? 'web' : 'cli',
      chatId: '',
      commandId: `${viaCookie ? 'web' : 'cli'}:${randomUUID()}`,
    });
    return c.json({ text: reply });
  });

  app.get('/api/state', owner, (c) =>
    c.json({
      ...snapshot(orchestrator.state),
      agents: config.agents.map((a) => ({ ...a, vendor: deps.pool.vendor(a.name), health: deps.pool.health.get(a.name) ?? null })),
      projects: config.projects.map((p) => ({ id: p.id, name: p.name ?? p.id, baseBranch: p.baseBranch, releaseBranch: p.releaseBranch, checks: p.checks, preview: Boolean(p.preview) })),
      metrics: agentMetrics(orchestrator.state),
      stages: { planner: config.planner.enabled, review: config.review.enabled, browser: config.browser.enabled, policy: config.policy.enabled },
    }),
  );

  // Live updates: every new event, as server-sent events (works on the default Node runtime).
  app.get('/api/events', owner, (c) =>
    streamSSE(c, async (stream) => {
      let after = Number(c.req.query('after') ?? orchestrator.state.lastSeq);
      const queue: unknown[] = [];
      let wake: (() => void) | undefined;
      const off = store.subscribe((record) => {
        queue.push(record);
        wake?.();
      });
      stream.onAbort(off);
      for (const r of store.list({ afterSeq: after })) await stream.writeSSE({ data: JSON.stringify(r), id: String(r.seq) });
      while (!stream.aborted) {
        while (queue.length) {
          const r = queue.shift() as { seq: number };
          if (r.seq <= after) continue;
          after = r.seq;
          await stream.writeSSE({ data: JSON.stringify(r), id: String(r.seq) });
        }
        await Promise.race([new Promise<void>((r) => (wake = r)), stream.sleep(15_000)]);
        if (!queue.length) await stream.writeSSE({ event: 'ping', data: '' });
      }
      off();
    }),
  );

  app.get('/api/tasks/:id/events', owner, (c) => c.json(store.list({ taskId: c.req.param('id') ?? '' })));

  app.get('/api/tasks/:id/diff', owner, async (c) => {
    const task = orchestrator.state.tasks.get(c.req.param('id') ?? '');
    if (!task?.worktree || !task.baseBranch) return c.json({ error: 'no worktree' }, 404);
    try {
      return c.text(await deps.host(task.node ?? 'local').diff(task.worktree, task.baseBranch));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // The owner's own LimeZu tiles for the office floor (never shipped with Hyde Code).
  app.get('/api/tiles', owner, (c) => c.json({ files: TILE_FILES.filter((f) => tilePath(config.dataDir, f)) }));
  app.on(['GET', 'HEAD'], '/api/tiles/:name', owner, (c) => {
    const p = tilePath(config.dataDir, c.req.param('name') ?? '');
    if (!p) return c.json({ error: 'not installed' }, 404);
    const body = c.req.method === 'HEAD' ? null : (Readable.toWeb(createReadStream(p)) as ReadableStream);
    return new Response(body, { headers: { 'content-type': 'image/png', 'content-length': String(statSync(p).size), 'cache-control': 'private, max-age=3600' } });
  });

  app.get('/api/artifacts/:id', owner, (c) => {
    const artifact = orchestrator.state.artifacts.get(c.req.param('id') ?? '');
    // Only files the harness itself recorded, under its own data dir.
    if (!artifact || !artifact.path.startsWith(config.dataDir) || !existsSync(artifact.path)) return c.json({ error: 'not found' }, 404);
    const stream = Readable.toWeb(createReadStream(artifact.path)) as ReadableStream;
    return new Response(stream, { headers: { 'content-type': MIME[extname(artifact.path)] ?? 'application/octet-stream', 'content-length': String(statSync(artifact.path).size) } });
  });

  // The activity feed: recent events that read as one line each (no text deltas or tool noise).
  app.get('/api/feed', owner, (c) => {
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 150) || 150));
    return c.json(store.list({}).filter((e) => describeEvent(e) !== null).slice(-limit));
  });

  app.get('/api/audit', owner, (c) => {
    const taskId = c.req.query('taskId');
    const events = store.list(taskId ? { taskId } : {}).filter((e) => e.type !== 'run.event' || ['run.started', 'run.failed', 'run.completed'].includes((e.payload as { event: { type: string } }).event.type));
    return c.json(events.slice(-500).map((e) => ({ seq: e.seq, ts: e.ts, type: e.type, actor: e.actor, taskId: e.taskId, runId: e.runId })));
  });

  app.get('/api/config', owner, (c) => c.json(readRawConfig(config.configFile)));

  app.put('/api/config', owner, async (c) => {
    const raw = await c.req.json().catch(() => null);
    try {
      writeRawConfig(config.configFile, raw);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    await deps.reload();
    return c.json({ ok: true });
  });

  app.get('/api/setup/detect', owner, async (c) => c.json(await deps.detect()));

  app.get('/metrics', owner, (c) => c.text(prometheus(orchestrator.state), 200, { 'content-type': 'text/plain; version=0.0.4' }));

  // ---------------------------------------------------------------- WhatsApp webhook (public)

  app.get('/webhooks/whatsapp', (c) => {
    const challenge = deps.whatsapp?.verify(c.req.query());
    return challenge === null || challenge === undefined ? c.text('forbidden', 403) : c.text(challenge);
  });
  app.post('/webhooks/whatsapp', async (c) => {
    if (!deps.whatsapp) return c.text('not configured', 404);
    const raw = await c.req.text();
    const ok = await deps.whatsapp.handleWebhook(raw, c.req.header('x-hub-signature-256'));
    return ok ? c.text('ok') : c.text('bad signature', 401);
  });

  // ---------------------------------------------------------------- dashboard

  if (deps.webDir && existsSync(join(deps.webDir, 'index.html'))) {
    app.use('/assets/*', serveStatic({ root: deps.webDir }));
    app.get('*', serveStatic({ root: deps.webDir, path: 'index.html' }));
  } else {
    app.get('/', (c) => c.text('Hyde Code hub is running. Build the dashboard with `pnpm --filter @hyde/web build`.'));
  }

  return app;
}
