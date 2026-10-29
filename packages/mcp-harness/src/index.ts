import { fileURLToPath } from 'node:url';

export { createHarnessServer, httpHubCall, TOOLS, type HubCall } from './server.ts';

/** Absolute path of the stdio entry point, for writing a run's MCP config. */
export const MCP_MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));
