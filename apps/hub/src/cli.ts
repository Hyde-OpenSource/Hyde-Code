#!/usr/bin/env -S node --import tsx
import { join } from 'node:path';
import { loadConfig, persistedSecret } from './config.ts';

// Local front door: `pnpm hyde new "Add a footer" #demo`, `pnpm hyde status`, ...
// Each argument list becomes the same slash command the Telegram bot accepts.
const [name, ...rest] = process.argv.slice(2);
if (!name) {
  console.log('usage: hyde <new|status|projects|stop|answer|approve|deny|help> [args]');
  process.exit(1);
}
const config = loadConfig();
const token = persistedSecret(join(config.dataDir, 'owner-token'));
const res = await fetch(`http://127.0.0.1:${config.port}/api/commands`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ text: `/${name} ${rest.join(' ')}`.trim() }),
}).catch(() => {
  console.error(`The hub is not running on port ${config.port}. Start it with: pnpm start`);
  process.exit(1);
});
const body = (await res.json()) as { text?: string; error?: string };
console.log(body.text ?? body.error);
process.exitCode = res.ok ? 0 : 1;
