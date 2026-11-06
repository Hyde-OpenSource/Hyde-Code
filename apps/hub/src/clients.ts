import { join } from 'node:path';
import type { ApprovalKind, Command } from '@hyde/core';
import { persistedSecret } from './config.ts';

// Client tokens: narrower than the owner token, for local apps that drive the hub (Hyde AI).
// A client can read state, create tasks, answer questions, approve or deny, stop, retry,
// merge and set a task's complexity level. It can't change config, trust or remove projects, promote, decide lessons, run client
// intake, or log in to the dashboard. Each token lives in <dataDir>/clients/<name>.token (0600);
// delete the file and restart the hub to rotate it.

export const CLIENTS = ['hyde-ai'] as const;
export type ClientName = (typeof CLIENTS)[number];

/** Chat commands a client token may run through /api/commands. */
export const CLIENT_COMMANDS: ReadonlySet<Command['kind']> = new Set(['new', 'answer', 'decide', 'stop', 'retry', 'merge', 'level', 'template', 'todos', 'status', 'agents', 'usage', 'projects', 'logs', 'help']);

/** Approvals a client may not decide: approving a promote merges the release branch. */
export const OWNER_ONLY_APPROVALS: ReadonlySet<ApprovalKind> = new Set(['promote']);

export function clientTokenFile(dataDir: string, name: ClientName): string {
  return join(dataDir, 'clients', `${name}.token`);
}

/** Token → client name, creating missing tokens. */
export function loadClientTokens(dataDir: string): Map<string, ClientName> {
  return new Map(CLIENTS.map((name) => [persistedSecret(clientTokenFile(dataDir, name)), name]));
}
