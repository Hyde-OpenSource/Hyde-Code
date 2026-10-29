import { readFileSync } from 'node:fs';

/** The hub's version (apps/hub/package.json). */
export const HUB_VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/**
 * Version of the client API (health, state, summary, tasks, questions, approvals, events; see
 * docs/api.md). Bump it on any breaking change so clients such as Hyde AI can warn.
 */
export const API_VERSION = 1;
