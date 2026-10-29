#!/usr/bin/env -S node --import tsx
import { join, resolve } from 'node:path';
import { loadConfig, persistedSecret } from './config.ts';
import { runSetup } from './setup.ts';

// Local front door: `pnpm hyde new "Add a footer" #demo`, `pnpm hyde status`, `pnpm hyde setup`,
// `pnpm hyde dashboard`, `pnpm hyde tui` (the office in the terminal). Other arguments become the same slash command the chat bots accept.
const [name, ...rest] = process.argv.slice(2);
if (!name) {
  console.log('usage: hyde <tui|tiles|setup|dashboard|new|client|status|agents|usage|logs|stop|retry|answer|approve|deny|merge|promote|projects|help> [args]');
  process.exit(1);
}
const cwd = process.env.INIT_CWD ?? process.cwd();

if (name === 'setup') {
  await runSetup(resolve(cwd, process.env.HYDE_CONFIG ?? 'hyde.config.json'), resolve(cwd, '.env'));
  process.exit(0);
}

const config = loadConfig();
const token = persistedSecret(join(config.dataDir, 'owner-token'));
const base = `http://127.0.0.1:${config.port}`;

if (name === 'tui') {
  const { runTui } = await import('./tui.ts');
  await runTui(base, token);
  process.exit(0);
}

if (name === 'tiles') {
  // pnpm hyde tiles <unzipped Modern Interiors folder> [office-tileset.png=<file> …]
  const { importTiles, TILE_FILES, tilesDir } = await import('./tiles.ts');
  const explicit: Record<string, string> = {};
  let folder: string | undefined;
  for (const arg of rest) {
    const m = /^([\w.-]+\.png)=(.+)$/.exec(arg);
    if (m) explicit[m[1]!] = resolve(cwd, m[2]!);
    else folder = resolve(cwd, arg);
  }
  if (!folder && !Object.keys(explicit).length) {
    console.log(`usage: hyde tiles <folder> [${TILE_FILES.map((f) => `${f}=<file>`).join(' ')}]`);
    console.log('Imports your own licensed copy of LimeZu "Modern Interiors" (https://limezu.itch.io/moderninteriors) for the office floor.');
    process.exit(1);
  }
  try {
    const { found, missing } = importTiles(config.dataDir, folder, explicit);
    for (const [n, p] of Object.entries(found)) console.log(`✓ ${n}  ←  ${p}`);
    for (const n of missing) console.log(`✗ ${n} not found (pass ${n}=<file> to pick it by hand)`);
    console.log(`Saved to ${tilesDir(config.dataDir)} (gitignored). Reload the dashboard. LimeZu's licence requires credit; the office shows it.`);
    process.exit(missing.length ? 1 : 0);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

if (name === 'dashboard') {
  console.log(`Open this link once on this machine (it sets a login cookie):\n${base}/login?token=${token}`);
  process.exit(0);
}

const res = await fetch(`${base}/api/commands`, {
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
