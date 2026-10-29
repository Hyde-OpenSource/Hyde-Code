import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHarnessServer, httpHubCall } from './server.ts';

// Started by the agent CLI from the run's MCP config; the hub sets both variables.
const url = process.env.HYDE_HUB_URL;
const token = process.env.HYDE_RUN_TOKEN;
if (!url || !token) {
  console.error('hyde MCP server: HYDE_HUB_URL and HYDE_RUN_TOKEN are required');
  process.exit(1);
}

await createHarnessServer(httpHubCall(url, token)).connect(new StdioServerTransport());
