import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, isAbsolute, join } from 'node:path';
import { Readable } from 'node:stream';
import { serveStatic } from '@hono/node-server/serve-static';
import { COMPLEXITY_LEVELS, describeEvent, normalizeCommandText, parseCommand, snapshot, TOOLS_NAMES, type Command, type EventStore } from '@hyde/core';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { discoverSkills, SKILL_DIRS } from '@hyde/skills';
import { getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { tierTable, type AgentPool } from './agents.ts';
import { readRawConfig, writeRawConfig, type HubConfig } from './config.ts';
import type { Detected } from './detect.ts';
import type { HostOps } from './host.ts';
import { agentMetrics, prometheus } from './metrics.ts';
import { TILE_FILES, tilePath } from './tiles.ts';
import { TERMS_URL, TERMS_VERSION, trustFolder } from './home.ts';
import { addProject, isGitRepo, removeProject } from './projects.ts';
import { CLIENT_COMMANDS, OWNER_ONLY_APPROVALS, type ClientName } from './clients.ts';
import type { Orchestrator } from './orchestrator.ts';
import { buildSummary } from './summary.ts';
import { API_VERSION, HUB_VERSION } from './version.ts';

export interface ApiDeps {
  orchestrator: Orchestrator;
  store: EventStore;
  config: HubConfig;
  pool: AgentPool;
  host: (node: string) => HostOps;
  ownerToken: string;
  /** Client tokens (token → client name): a narrower key for apps such as Hyde AI. */
  clientTokens?: Map<string, ClientName>;
  detect: () => Promise<Detected[]>;
  /** Applies a saved config without a restart. */
  reload: () => Promise<void>;
  whatsapp?: { verify(q: Record<string, string | undefined>): string | null; handleWebhook(raw: string, sig: string | undefined): Promise<boolean> };
  /** Built dashboard (apps/web/dist), if present. */
  webDir?: string;
}

const COOKIE = 'hyde_owner';

const taskBody = z.object({
  /** Project id or name (loose match). Optional when there is only one project. */
  project: z.string().trim().min(1).optional(),
  text: z.string().trim().min(1).max(20_000),
  agent: z.string().trim().min(1).optional(),
  /** Owner token only; a client token always records its own name. */
  source: z.enum(['api', 'cli', 'hyde-ai']).optional(),
  /** Makes retries safe: a second request with the same id creates nothing (409). */
  requestId: z.string().trim().min(1).max(100).optional(),
  /** The client's guess at the complexity; the hub's rules decide (it only settles what they can't). */
  complexity: z.enum(COMPLEXITY_LEVELS).optional(),
});
const levelBody = z.object({ level: z.enum(COMPLEXITY_LEVELS) });
const answerBody = z.union([z.object({ text: z.string().trim().min(1).max(10_000) }), z.object({ option: z.number().int().min(0).max(9) })]);
const decisionBody = z.object({ decision: z.enum(['approve', 'deny']) });

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
  /** The client a bearer token belongs to (never from a cookie). */
  const clientOf = (c: Context): ClientName | undefined => {
    const token = bearer(c.req.header('authorization'));
    if (!token || !deps.clientTokens) return undefined;
    for (const [t, name] of deps.clientTokens) if (same(token, t)) return name;
    return undefined;
  };
  // Cookie-authenticated writes must be JSON, which a cross-site form can't send without CORS.
  const jsonWrite = (c: Context) =>
    c.req.method !== 'GET' && c.req.method !== 'HEAD' && !bearer(c.req.header('authorization')) && !c.req.header('content-type')?.startsWith('application/json');
  const owner = async (c: Context, next: () => Promise<void>) => {
    if (!isOwner(c)) return c.json({ error: 'owner login required' }, 401);
    if (jsonWrite(c)) return c.json({ error: 'JSON body required' }, 415);
    await next();
  };
  /** The owner, or a client token (Hyde AI). Routes check what a client may do. */
  const ownerOrClient = async (c: Context, next: () => Promise<void>) => {
    if (!isOwner(c) && !clientOf(c)) return c.json({ error: 'owner or client token required' }, 401);
    if (jsonWrite(c)) return c.json({ error: 'JSON body required' }, 415);
    await next();
  };
  /** Who is asking, as the orchestrator records it. */
  const caller = (c: Context) => {
    const client = isOwner(c) ? undefined : clientOf(c);
    if (client) return { userId: `client:${client}`, gateway: client, client };
    const viaCookie = !bearer(c.req.header('authorization'));
    return { userId: viaCookie ? 'web:owner' : 'cli:owner', gateway: viaCookie ? 'web' : 'cli', client: undefined };
  };
  const run = async (c: Context, command: Command, idempotencyKey?: string) => {
    const who = caller(c);
    return orchestrator.handle({ command, userId: who.userId, gateway: who.gateway, chatId: '', commandId: `${who.gateway}:${idempotencyKey ?? randomUUID()}` });
  };

  app.get('/api/health', (c) => c.json({ ok: true, version: HUB_VERSION, apiVersion: API_VERSION }));

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
    if (!token || !same(token, deps.ownerToken)) return c.text('Invalid token. Run `hyde web` for a fresh link.', 401);
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 60 * 60 * 24 * 30 });
    // `hyde web` in a project folder opens the office on that project.
    const project = c.req.query('project');
    return c.redirect(project && /^[\w.-]+$/.test(project) ? `/?project=${project}#office` : '/');
  });

  app.post('/api/commands', ownerOrClient, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { text?: string; command?: Command } | null;
    const command = body?.command ?? (body?.text ? parseCommand(normalizeCommandText(body.text)) : null);
    if (!command) return c.json({ error: 'send {"text": "/command ..."}' }, 400);
    const { client } = caller(c);
    if (client) {
      if (!CLIENT_COMMANDS.has(command.kind)) return c.json({ error: `/${command.kind} needs the owner (use the dashboard or the hyde CLI)` }, 403);
      if (command.kind === 'decide' && OWNER_ONLY_APPROVALS.has(orchestrator.state.approvals.get(command.approvalId)?.kind ?? 'first-push')) {
        return c.json({ error: `${command.approvalId} needs the owner (use the dashboard or the hyde CLI)` }, 403);
      }
    }
    return c.json({ text: await run(c, command) });
  });

  // ---------------------------------------------------------------- typed client API (docs/api.md)

  app.post('/api/tasks', ownerOrClient, async (c) => {
    const parsed = taskBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'send {"text": "...", "project"?: "...", "agent"?: "...", "requestId"?: "..."}', code: 'invalid' }, 400);
    const { project, text, agent, source, requestId, complexity } = parsed.data;
    const who = caller(c);
    const gateway = who.client ?? source ?? 'api';
    const result = orchestrator.submitTask({
      command: { kind: 'new', text, ...(project && { project }), ...(agent && { agent }), ...(complexity && { complexity }) },
      userId: who.userId,
      gateway,
      chatId: '',
      commandId: `${gateway}:${requestId ?? randomUUID()}`,
    });
    if (result.error) return c.json({ error: result.text, code: result.error }, result.error === 'duplicate' ? 409 : 400);
    const task = orchestrator.state.tasks.get(result.taskId!)!;
    return c.json({ id: task.id, status: task.status, projectId: task.projectId, title: task.title, complexity: task.complexity ?? null, text: result.text }, 201);
  });

  app.post('/api/tasks/:id/level', ownerOrClient, async (c) => {
    const id = (c.req.param('id') ?? '').toUpperCase();
    if (!orchestrator.state.tasks.has(id)) return c.json({ error: `No task ${id}.`, code: 'not_found' }, 404);
    const parsed = levelBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'send {"level": "trivial" | "low" | "medium" | "high"}', code: 'invalid' }, 400);
    const reply = await run(c, { kind: 'level', taskId: id, level: parsed.data.level });
    return c.json({ id, complexity: orchestrator.state.tasks.get(id)!.complexity ?? null, text: reply });
  });

  app.post('/api/questions/:id/answer', ownerOrClient, async (c) => {
    const id = (c.req.param('id') ?? '').toUpperCase();
    const q = orchestrator.state.questions.get(id);
    if (!q) return c.json({ error: `No question ${id}.`, code: 'not_found' }, 404);
    if (q.status !== 'open') return c.json({ error: `${id} was already answered: ${q.answer ?? ''}`, code: 'closed' }, 409);
    const parsed = answerBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'send {"text": "..."} or {"option": <index>}', code: 'invalid' }, 400);
    if ('option' in parsed.data && !q.options[parsed.data.option]) return c.json({ error: `${id} has no option ${parsed.data.option}`, code: 'invalid' }, 400);
    const text = 'option' in parsed.data ? `#option:${parsed.data.option}` : parsed.data.text;
    const reply = await run(c, { kind: 'answer', questionId: id, text });
    const after = orchestrator.state.questions.get(id)!;
    return c.json({ id, status: after.status, answer: after.answer ?? null, text: reply });
  });

  app.post('/api/approvals/:id', ownerOrClient, async (c) => {
    const id = (c.req.param('id') ?? '').toUpperCase();
    const a = orchestrator.state.approvals.get(id);
    if (!a) return c.json({ error: `No approval ${id}.`, code: 'not_found' }, 404);
    if (caller(c).client && OWNER_ONLY_APPROVALS.has(a.kind)) return c.json({ error: `${id} needs the owner (use the dashboard or the hyde CLI)`, code: 'forbidden' }, 403);
    if (a.status !== 'open') return c.json({ error: `${id} was already ${a.status}.`, code: 'closed' }, 409);
    const parsed = decisionBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'send {"decision": "approve" | "deny"}', code: 'invalid' }, 400);
    const reply = await run(c, { kind: 'decide', approvalId: id, approved: parsed.data.decision === 'approve' });
    return c.json({ id, status: orchestrator.state.approvals.get(id)!.status, text: reply });
  });

  app.get('/api/summary', ownerOrClient, (c) => {
    const project = c.req.query('project');
    const projectId = project ? orchestrator.findProject(project).project?.id : undefined;
    if (project && !projectId) return c.json({ error: `Unknown project ${project}`, code: 'not_found' }, 404);
    return c.json({ version: HUB_VERSION, apiVersion: API_VERSION, ...buildSummary(orchestrator.state, config, deps.pool, Date.now(), projectId) });
  });

  app.get('/api/state', ownerOrClient, (c) =>
    c.json({
      ...snapshot(orchestrator.state),
      agents: config.agents.map((a) => ({ ...a, vendor: deps.pool.vendor(a.name), health: deps.pool.health.get(a.name) ?? null, tierTable: tierTable(a) })),
      projects: config.projects.map((p) => ({ id: p.id, name: p.name ?? p.id, path: p.path, baseBranch: p.baseBranch, releaseBranch: p.releaseBranch, checks: p.checks, preview: Boolean(p.preview) })),
      metrics: agentMetrics(orchestrator.state),
      stages: { planner: config.planner.enabled, review: config.review.enabled, browser: config.browser.enabled, policy: config.policy.enabled },
      routing: config.routing,
    }),
  );

  // Live updates: every new event, as server-sent events (works on the default Node runtime).
  app.get('/api/events', ownerOrClient, (c) =>
    streamSSE(c, async (stream) => {
      // A reconnecting EventSource sends Last-Event-ID; it picks up where it left off.
      let after = Number(c.req.query('after') ?? c.req.header('last-event-id') ?? orchestrator.state.lastSeq);
      if (!Number.isFinite(after)) after = orchestrator.state.lastSeq;
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

  app.get('/api/tasks/:id/events', ownerOrClient, (c) => c.json(store.list({ taskId: c.req.param('id') ?? '' })));

  app.get('/api/tasks/:id/diff', ownerOrClient, async (c) => {
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
  app.get('/api/feed', ownerOrClient, (c) => {
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 150) || 150));
    return c.json(store.list({}).filter((e) => describeEvent(e) !== null).slice(-limit));
  });

  app.get('/api/audit', owner, (c) => {
    const taskId = c.req.query('taskId');
    const events = store.list(taskId ? { taskId } : {}).filter((e) => e.type !== 'run.event' || ['run.started', 'run.failed', 'run.completed'].includes((e.payload as { event: { type: string } }).event.type));
    return c.json(
      events.slice(-500).map((e) => ({
        seq: e.seq,
        ts: e.ts,
        type: e.type,
        actor: e.actor,
        taskId: e.taskId,
        runId: e.runId,
        ...(e.type === 'task.created' && { source: (e.payload as { source: { kind: string } }).source.kind }),
      })),
    );
  });

  // Skills (owner): every skill per project, where it comes from, which CLIs get it, and its SKILL.md.
  app.get('/api/skills', owner, (c) => {
    const byName = new Map<string, { name: string; description: string; source: string; files: string[]; projects: string[]; enabled: boolean }>();
    for (const p of config.projects) {
      for (const s of discoverSkills({ user: orchestrator.userSkillsDir, project: join(p.path, '.hyde', 'skills'), folders: config.skills.folders })) {
        const row = byName.get(s.name) ?? { name: s.name, description: s.description, source: s.source, files: s.files, projects: [], enabled: !config.skills.disabled.includes(s.name) };
        row.projects.push(p.id);
        byName.set(s.name, row);
      }
    }
    return c.json({ skills: [...byName.values()], clis: SKILL_DIRS, proposals: [...orchestrator.state.skillProposals.values()], folders: config.skills.folders, disabled: config.skills.disabled });
  });

  app.get('/api/skills/:name', owner, (c) => {
    const name = c.req.param('name') ?? '';
    for (const p of config.projects) {
      const s = discoverSkills({ user: orchestrator.userSkillsDir, project: join(p.path, '.hyde', 'skills'), folders: config.skills.folders }).find((x) => x.name === name);
      if (s) return c.json({ name: s.name, source: s.source, dir: s.dir, files: s.files, text: readFileSync(join(s.dir, 'SKILL.md'), 'utf8') });
    }
    return c.json({ error: `No skill ${name}`, code: 'not_found' }, 404);
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

  // Projects: folders the owner trusts. Adding one records the trust and the accepted terms.
  app.get('/api/projects', owner, (c) => c.json({ projects: config.projects.map((p) => ({ id: p.id, name: p.name ?? p.id, path: p.path })), terms: { version: TERMS_VERSION, url: TERMS_URL } }));
  app.post('/api/projects', owner, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { path?: unknown; trust?: unknown } | null;
    const path = typeof body?.path === 'string' ? body.path.trim().replace(/^~(?=\/|$)/, homedir()) : '';
    if (!path || !isAbsolute(path)) return c.json({ error: 'Give the full path of the folder, e.g. /home/you/code/app' }, 400);
    if (body?.trust !== true) return c.json({ error: 'Trust the folder and accept the terms to add it' }, 400);
    if (!existsSync(path)) return c.json({ error: `${path} does not exist` }, 400);
    if (!isGitRepo(path)) return c.json({ error: `${path} is not a git repository. Run \`git init\` there first (or run \`hyde\` in it, which offers to).` }, 400);
    try {
      const { project, added } = await addProject(config.configFile, path);
      trustFolder(path);
      if (added) await deps.reload();
      return c.json({ ok: true, added, project: { id: project.id, name: project.name ?? project.id, path: project.path } });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });
  app.delete('/api/projects/:id', owner, async (c) => {
    try {
      removeProject(config.configFile, c.req.param('id') ?? '');
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
