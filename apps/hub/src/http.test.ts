import { describe, expect, it } from 'vitest';
import { createApi } from './http.ts';
import type { Orchestrator } from './orchestrator.ts';

const calls: unknown[] = [];
const fake = {
  runForToken: (t: string) => (t === 'run-token' ? 'run-1' : undefined),
  agentCall: async (runId: string, tool: string, args: unknown) => {
    calls.push([runId, tool, args]);
    return 'Recorded';
  },
  handle: async (inbound: { command: unknown; userId: string }) => JSON.stringify([inbound.command, inbound.userId]),
} as unknown as Orchestrator;
const app = createApi(fake, 'owner-token');
const post = (path: string, token: string | null, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });

describe('hub API', () => {
  it('accepts agent tool calls only with a live run token', async () => {
    expect((await post('/api/agent/complete_task', null, {})).status).toBe(401);
    expect((await post('/api/agent/complete_task', 'guess', {})).status).toBe(401);
    expect((await post('/api/agent/rm_rf', 'run-token', {})).status).toBe(404);
    const ok = await post('/api/agent/complete_task', 'run-token', { summary: 's' });
    expect(await ok.json()).toEqual({ text: 'Recorded' });
    expect(calls).toEqual([['run-1', 'complete_task', { summary: 's' }]]);
  });

  it('accepts commands only with the owner token', async () => {
    expect((await post('/api/commands', 'run-token', { text: '/status' })).status).toBe(401);
    expect((await post('/api/commands', 'owner-token', { text: 'not a command' })).status).toBe(400);
    const ok = await post('/api/commands', 'owner-token', { text: '/stop T-2' });
    expect(await ok.json()).toEqual({ text: JSON.stringify([{ kind: 'stop', target: 'T-2' }, 'cli:owner']) });
  });
});
