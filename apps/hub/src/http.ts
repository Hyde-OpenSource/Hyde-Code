import { randomUUID, timingSafeEqual } from 'node:crypto';
import { parseCommand } from '@hyde/gateway-telegram';
import { Hono } from 'hono';
import type { Orchestrator } from './orchestrator.ts';

const AGENT_TOOLS = new Set(['ask_question', 'report_progress', 'complete_task']);

function bearer(header: string | undefined): string | null {
  const m = /^Bearer (\S+)$/.exec(header ?? '');
  return m ? m[1]! : null;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The hub API. Agents authenticate with their run's token (valid only while the run is live);
 * the local CLI uses the owner token from the data dir. Served on 127.0.0.1 only.
 */
export function createApi(orchestrator: Orchestrator, ownerToken: string): Hono {
  const app = new Hono();

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.post('/api/agent/:tool', async (c) => {
    const tool = c.req.param('tool');
    const token = bearer(c.req.header('authorization'));
    const runId = token ? orchestrator.runForToken(token) : undefined;
    if (!runId) return c.json({ error: 'unknown or expired run token' }, 401);
    if (!AGENT_TOOLS.has(tool)) return c.json({ error: `unknown tool ${tool}` }, 404);
    const args = await c.req.json().catch(() => null);
    if (!args || typeof args !== 'object') return c.json({ error: 'JSON body required' }, 400);
    try {
      return c.json({ text: await orchestrator.agentCall(runId, tool, args as Record<string, unknown>) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post('/api/commands', async (c) => {
    const token = bearer(c.req.header('authorization'));
    if (!token || !same(token, ownerToken)) return c.json({ error: 'owner token required' }, 401);
    const body = (await c.req.json().catch(() => null)) as { text?: string } | null;
    const command = body?.text ? parseCommand(body.text) : null;
    if (!command) return c.json({ error: 'send {"text": "/command ..."}' }, 400);
    const reply = await orchestrator.handle({ command, userId: 'cli:owner', chatId: '', commandId: `cli:${randomUUID()}` });
    return c.json({ text: reply });
  });

  return app;
}
