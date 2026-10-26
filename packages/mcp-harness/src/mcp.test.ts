import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createHarnessServer } from './server.ts';

async function connect(call: Parameters<typeof createHarnessServer>[0]) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createHarnessServer(call).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  return client;
}

describe('harness MCP server', () => {
  it('lists the three tools', async () => {
    const client = await connect(async () => 'ok');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['ask_question', 'complete_task', 'report_progress']);
  });

  it('forwards validated calls to the hub', async () => {
    const calls: unknown[] = [];
    const client = await connect(async (tool, args) => {
      calls.push([tool, args]);
      return 'Recorded as Q-1';
    });
    const res = await client.callTool({ name: 'ask_question', arguments: { question: 'Use OAuth?', options: ['Yes', 'No'] } });
    expect(res.content).toEqual([{ type: 'text', text: 'Recorded as Q-1' }]);
    expect(calls).toEqual([['ask_question', { question: 'Use OAuth?', options: ['Yes', 'No'], blocking: true }]]);
  });

  it('rejects invalid input and reports hub errors as tool errors', async () => {
    const client = await connect(async () => {
      throw new Error('down');
    });
    const bad = await client.callTool({ name: 'complete_task', arguments: { summary: '' } });
    expect(bad.isError).toBe(true);
    const down = await client.callTool({ name: 'report_progress', arguments: { message: 'hi' } });
    expect(down).toMatchObject({ isError: true, content: [{ text: 'Harness unavailable: down' }] });
  });
});

describe('MCP_MAIN', () => {
  it('is a real file path even when the repo path contains spaces', async () => {
    const { existsSync } = await import('node:fs');
    const { MCP_MAIN } = await import('./index.ts');
    expect(MCP_MAIN).not.toContain('%20');
    expect(existsSync(MCP_MAIN)).toBe(true);
  });
});
