#!/usr/bin/env node
// A minimal ACP agent for tests: on a prompt it asks permission to run a command, writes a
// file through the client, streams a message and ends the turn. FAKE_ACP_COMMAND sets the title.
import { createInterface } from 'node:readline';

let next = 100;
const waiting = new Map();
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const call = (method, params) =>
  new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
const update = (sessionId, u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });

createInterface({ input: process.stdin }).on('line', async (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && !msg.method) return waiting.get(msg.id)?.(msg.result ?? { error: msg.error });
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  if (msg.method === 'session/new') return send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'acp-sess-1' } });
  if (msg.method === 'session/load') return send({ jsonrpc: '2.0', id: msg.id, result: null });
  if (msg.method === 'session/prompt') {
    const sid = msg.params.sessionId;
    const title = process.env.FAKE_ACP_COMMAND ?? 'npm test';
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 't1', title, kind: 'execute', status: 'pending' });
    const perm = await call('session/request_permission', {
      sessionId: sid,
      toolCall: { toolCallId: 't1', title, kind: 'execute' },
      options: [
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const allowed = perm.outcome?.optionId === 'yes';
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', kind: 'execute', status: allowed ? 'completed' : 'failed' });
    const write = await call('fs/write_text_file', { sessionId: sid, path: 'acp.txt', content: 'from acp\n' });
    const text = msg.params.prompt[0].text.includes('JSON Schema') ? '{"verdict":"approve"}' : `allowed=${allowed} write=${write?.error ? 'refused' : 'ok'}`;
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    return send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  }
});
