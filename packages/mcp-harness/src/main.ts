import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHarnessServer, httpHubCall } from './server.ts';

// Started by the agent CLI from the run's MCP config; the hub sets both variables.
const url = process.env.HYDE_HUB_URL;
const token = process.env.HYDE_RUN_TOKEN;
if (!url || !token) {
  console.error('hyde MCP server: HYDE_HUB_URL and HYDE_RUN_TOKEN are required');
  process.exit(1);
}

const server = createHarnessServer(httpHubCall(url, token));
let closeBrowser: (() => Promise<void>) | undefined;
// Runs that need a browser get the live browser tools (Playwright loads only then).
if (process.env.HYDE_BROWSER === '1') {
  const { BrowserSession, httpBrowserHub, registerBrowserTools } = await import('@hyde/browser-live');
  const hub = httpBrowserHub(url, token);
  const session = new BrowserSession(hub, { headless: process.env.HYDE_BROWSER_HEADED !== '1' });
  registerBrowserTools(server, session, () => hub.preview());
  closeBrowser = () => session.close();
}

const transport = new StdioServerTransport();
// When the agent's turn ends the CLI closes our stdin: save the browser recording first.
transport.onclose = () => void (closeBrowser?.() ?? Promise.resolve()).finally(() => process.exit(0));
process.stdin.on('end', () => void (closeBrowser?.() ?? Promise.resolve()).finally(() => process.exit(0)));
await server.connect(transport);
