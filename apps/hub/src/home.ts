import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Hyde Code's home: one per user, like ~/.claude or ~/.codex. The `hyde` command, the hub
// and the dashboard all read it, so a project added in one place shows up everywhere.
//
//   ~/.hyde/config.json   settings and the project list (no secrets)
//   ~/.hyde/.env          tokens (0600)
//   ~/.hyde/trust.json    trusted folders and the accepted terms version
//   ~/.hyde/data/         event store, worktrees, owner token
//   ~/.hyde/hub.log       output of the background hub

export const TERMS_VERSION = '2026-10-29';
export const TERMS_URL = 'https://github.com/Hyde-OpenSource/Hyde-Code/blob/main/TERMS.md';

export function hydeHome(): string {
  return resolve(process.env.HYDE_HOME ?? join(homedir(), '.hyde'));
}

export function homePaths(home = hydeHome()) {
  return {
    home,
    config: join(home, 'config.json'),
    env: join(home, '.env'),
    trust: join(home, 'trust.json'),
    log: join(home, 'hub.log'),
    pid: join(home, 'hub.pid'),
  };
}

/** Loads ~/.hyde/.env into process.env (values already set win). */
export function loadHomeEnv(home = hydeHome()): void {
  const file = homePaths(home).env;
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || m[1]! in process.env) continue;
    process.env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
}

export interface TrustFile {
  terms?: { version: string; acceptedAt: string };
  folders: Record<string, { trustedAt: string }>;
}

export function readTrust(home = hydeHome()): TrustFile {
  const file = homePaths(home).trust;
  if (!existsSync(file)) return { folders: {} };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<TrustFile>;
    return { ...(raw.terms && { terms: raw.terms }), folders: raw.folders ?? {} };
  } catch {
    return { folders: {} };
  }
}

function writeTrust(t: TrustFile, home = hydeHome()): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = homePaths(home).trust;
  writeFileSync(`${file}.tmp`, JSON.stringify(t, null, 2) + '\n', { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** The current terms were accepted (a new terms version asks again). */
export function termsAccepted(home = hydeHome()): boolean {
  return readTrust(home).terms?.version === TERMS_VERSION;
}

export function isTrusted(folder: string, home = hydeHome()): boolean {
  return termsAccepted(home) && Boolean(readTrust(home).folders[resolve(folder)]);
}

/** Records that the owner trusts this folder and accepts the current terms. */
export function trustFolder(folder: string, home = hydeHome(), now = new Date()): void {
  const t = readTrust(home);
  t.terms = { version: TERMS_VERSION, acceptedAt: now.toISOString() };
  t.folders[resolve(folder)] = { trustedAt: now.toISOString() };
  writeTrust(t, home);
}

export function untrustFolder(folder: string, home = hydeHome()): void {
  const t = readTrust(home);
  delete t.folders[resolve(folder)];
  writeTrust(t, home);
}
