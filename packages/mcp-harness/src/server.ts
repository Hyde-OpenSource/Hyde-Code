import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// The tools every agent uses to talk to the harness (docs/plan.md: "Give every worker a
// harness MCP server"). Unattended runs have no AskUserQuestion, so ask_question is the way in.

export type HubCall = (tool: 'ask_question' | 'report_progress' | 'complete_task', args: unknown) => Promise<string>;

export function createHarnessServer(call: HubCall): McpServer {
  const server = new McpServer({ name: 'hyde', version: '0.0.0' });
  const reply = async (tool: Parameters<HubCall>[0], args: unknown) => {
    try {
      return { content: [{ type: 'text' as const, text: await call(tool, args) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text' as const, text: `Harness unavailable: ${(err as Error).message}` }] };
    }
  };

  server.registerTool(
    'ask_question',
    {
      description:
        'Ask the project owner a question (never assume). The owner answers in chat. ' +
        'blocking=true: call this, then end your turn; you will be resumed with the answer. ' +
        'blocking=false: continue with your stated assumption; it will be reviewed.',
      inputSchema: {
        question: z.string().min(1).describe('The question, with the context the owner needs'),
        blocking: z.boolean().default(true),
        options: z.array(z.string().min(1).max(60)).max(4).optional().describe('Suggested answers, shown as buttons'),
        assumption: z.string().optional().describe('For non-blocking questions: what you will assume meanwhile'),
      },
    },
    (args) => reply('ask_question', args),
  );

  server.registerTool(
    'report_progress',
    {
      description: 'Send a short progress note to the owner (batched into digests). Use sparingly.',
      inputSchema: { message: z.string().min(1).max(500) },
    },
    (args) => reply('report_progress', args),
  );

  server.registerTool(
    'complete_task',
    {
      description:
        'Report that the task is done. Only call this after verifying the change and committing it. ' +
        'The harness then runs checks, writes progress.md and asks the owner to approve the push.',
      inputSchema: {
        summary: z.string().min(1).describe('What changed and why'),
        verified: z.string().min(1).describe('How you verified it, and the result'),
        filesChanged: z.array(z.string()).default([]),
        followUps: z.string().optional().describe('Anything left open, or omit'),
      },
    },
    (args) => reply('complete_task', args),
  );

  return server;
}

/** A HubCall that POSTs to the hub with the run's bearer token. */
export function httpHubCall(baseUrl: string, token: string): HubCall {
  return async (tool, args) => {
    const res = await fetch(`${baseUrl}/api/agent/${tool}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(args),
    });
    const body = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body.text ?? 'ok';
  };
}
