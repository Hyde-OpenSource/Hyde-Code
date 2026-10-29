import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { configPath, loadConfig, persistedSecret, readRawConfig } from './config.ts';
import { homePaths, hydeHome, isTrusted, loadHomeEnv, TERMS_URL, TERMS_VERSION, trustFolder, untrustFolder } from './home.ts';
import { addProject, findProject, isGitRepo } from './projects.ts';
import { box, c, choose } from './prompt.ts';
import { runSetup } from './setup.ts';

// `hyde`: run it in any folder, like `claude` or `codex`.
//   hyde               trust this folder (first time), register it, start the hub, open the office
//   hyde web           open the web office          hyde tui      the terminal office
//   hyde new "…"       a task for this folder       hyde status   what's going on
//   hyde hub stop|start|restart|status|logs         hyde setup    agents, stages, chat apps
// Anything else is the same slash command the chat bots accept.

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const hubDir = resolve(here, '..');
const cwd = process.env.INIT_CWD ?? process.cwd();
const [name, ...rest] = process.argv.slice(2);
const paths = homePaths();
loadHomeEnv();

function help(): void {
  console.log(`${c.bold('Hyde Code')}: your AI coding team, run from any folder.

  ${c.accent('hyde')}                 open this folder (asks to trust it the first time)
  ${c.accent('hyde web')}             open the office in your browser
  ${c.accent('hyde tui')}             open the office in this terminal
  ${c.accent('hyde new')} "task"      give this project a task
  ${c.accent('hyde status')}          what is running and what waits for you
  ${c.accent('hyde projects')}        every project Hyde knows
  ${c.accent('hyde forget')}          stop trusting this folder and remove it from Hyde
  ${c.accent('hyde hub')} stop|start|restart|status|logs
  ${c.accent('hyde setup')}           pick agents, stages and chat apps
  ${c.accent('hyde tiles')} <folder>  add your LimeZu tiles for the office art
  answer, approve, deny, merge, retry, stop, promote, usage, agents, logs: same as in chat

Home: ${hydeHome()}   Terms: ${TERMS_URL}`);
}

async function gitTop(folder: string): Promise<string | null> {
  try {
    return (await exec('git', ['rev-parse', '--show-toplevel'], { cwd: folder })).stdout.trim() || null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ the hub process

function base(): string {
  const port = existsSync(paths.config) || process.env.HYDE_CONFIG ? loadConfig(configPath()).port : 7420;
  return `http://127.0.0.1:${port}`;
}

async function hubUp(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

async function startHub(url: string, quiet = false): Promise<void> {
  if (await hubUp(url)) return;
  if (!quiet) process.stdout.write(c.dim('Starting the Hyde hub in the background… '));
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const out = openSync(paths.log, 'a');
  const tsx = join(hubDir, 'node_modules', '.bin', 'tsx');
  const child = spawn(tsx, [join(here, 'main.ts')], { cwd: hubDir, detached: true, stdio: ['ignore', out, out], env: { ...process.env, INIT_CWD: undefined } });
  child.unref();
  closeSync(out);
  for (let i = 0; i < 120; i++) {
    if (await hubUp(url)) {
      if (!quiet) console.log(c.ok('ready'));
      return;
    }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(c.bad('failed'));
  const tail = existsSync(paths.log) ? readFileSync(paths.log, 'utf8').split('\n').slice(-12).join('\n') : '';
  console.error(`The hub did not start. Last lines of ${paths.log}:\n${tail}`);
  process.exit(1);
}

function hubPid(): number | null {
  if (!existsSync(paths.pid)) return null;
  const pid = Number(readFileSync(paths.pid, 'utf8').trim());
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function stopHub(url: string): Promise<boolean> {
  const pid = hubPid();
  if (!pid) return false;
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 80 && (await hubUp(url)); i++) await new Promise((r) => setTimeout(r, 250));
  return true;
}

function ownerToken(): string {
  return persistedSecret(join(loadConfig(configPath()).dataDir, 'owner-token'));
}

async function api<T>(url: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${url}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerToken()}`, ...init.headers } });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args as string[], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // printed below anyway
  }
}

/** The registered project for the current folder (or the repo it is inside). */
async function currentProject(): Promise<{ id: string; path: string } | undefined> {
  if (!existsSync(paths.config) && !process.env.HYDE_CONFIG) return undefined;
  const raw = readRawConfig(configPath());
  const top = (await gitTop(cwd)) ?? cwd;
  const p = findProject(raw, top);
  return p && { id: p.id, path: p.path };
}

// ------------------------------------------------------------------ hyde (open this folder)

async function openFolder(target: string): Promise<void> {
  let folder = resolve(target);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    console.error(`${folder} is not a folder.`);
    process.exit(1);
  }
  folder = (await gitTop(folder)) ?? folder;

  console.log(`\n ${c.accent('▣')} ${c.bold('Hyde Code')}  ${c.dim(folder)}\n`);

  // 1. Trust, and the terms, once per folder (and again when the terms change).
  if (!isTrusted(folder)) {
    box([
      c.bold('Do you trust the files in this folder?'),
      '',
      folder,
      '',
      'Hyde Code lets AI agents (Claude Code, Codex, OpenCode and others, under your own logins) read and change files here, run commands, and push branches you approve. Only continue in folders you trust.',
      '',
      `Using Hyde Code means you accept the Hyde Code Terms (version ${TERMS_VERSION}):`,
      c.link(TERMS_URL),
    ]);
    const pick = await choose(['Yes, I trust this folder and accept the Terms', 'No, exit']);
    console.log('');
    if (pick !== 0) {
      console.log('Nothing was changed. Run `hyde` again when you are ready.');
      process.exit(0);
    }
    trustFolder(folder);
  }

  // 2. Hyde works on branches and pull requests, so the folder must be a git repository.
  if (!isGitRepo(folder)) {
    box(['This folder is not a git repository.', 'Hyde Code works on branches and pull requests, so it needs git.'], c.warn);
    const pick = await choose(['Run `git init` here and make an empty first commit', 'Exit']);
    console.log('');
    if (pick !== 0) process.exit(0);
    await exec('git', ['init'], { cwd: folder });
    await exec('git', ['commit', '--allow-empty', '-m', 'Initial commit'], { cwd: folder });
    console.log(c.ok('✓ git repository created'));
  }

  // 3. First run on this machine: pick agents, stages and chat apps.
  if (!existsSync(paths.config) && !process.env.HYDE_CONFIG) {
    console.log(c.dim('First run: let us set up your team.'));
    const ok = await runSetup(paths.config, paths.env, { projectPath: folder });
    if (!ok) process.exit(1);
    loadHomeEnv();
  }

  // 4. Register the folder and make sure the hub is running.
  const url = base();
  let project: { id: string; path: string };
  if (await hubUp(url)) {
    const res = await api<{ project: { id: string; path: string }; added: boolean }>(url, '/api/projects', { method: 'POST', body: JSON.stringify({ path: folder, trust: true }) });
    project = res.project;
    if (res.added) console.log(c.ok(`✓ added #${project.id}`));
  } else {
    const res = await addProject(configPath(), folder);
    project = res.project;
    if (res.added) console.log(c.ok(`✓ added #${project.id}`));
    await startHub(url);
  }

  const raw = readRawConfig(configPath());
  const p = raw.projects?.find((x) => x.id === project.id);
  const agents = (raw.agents ?? []).filter((a) => a.enabled !== false).map((a) => a.name);
  console.log(`${c.accent(`#${project.id}`)}  base ${c.bold(p?.baseBranch ?? 'main')}  ·  agents ${agents.join(', ') || 'none'}  ·  web ${c.link(url)}`);
  console.log(c.dim('Opening the office… (w opens the web view, q quits; the hub keeps working in the background)\n'));
  await new Promise((r) => setTimeout(r, 500));
  const { runTui } = await import('./tui.ts');
  await runTui(url, ownerToken(), { project: project.id });
  process.exit(0);
}

// ------------------------------------------------------------------ commands

if (!name || name === '.' || (existsSync(resolve(cwd, name)) && statSync(resolve(cwd, name)).isDirectory() && !['setup', 'tiles'].includes(name))) {
  await openFolder(name && name !== '.' ? resolve(cwd, name) : cwd);
}

if (name === 'help' || name === '--help' || name === '-h') {
  help();
  process.exit(0);
}

if (name === 'setup') {
  await runSetup(configPath(), paths.env, { projectPath: (await gitTop(cwd)) ?? cwd });
  console.log('Run `hyde hub restart` to use the new settings.');
  process.exit(0);
}

if (name === 'tiles') {
  // hyde tiles <unzipped Modern Interiors folder> [office-tileset.png=<file> …]
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
    const config = loadConfig(configPath());
    const { found, missing } = importTiles(config.dataDir, folder, explicit);
    for (const [n, p] of Object.entries(found)) console.log(`✓ ${n}  ←  ${p}`);
    for (const n of missing) console.log(`✗ ${n} not found (pass ${n}=<file> to pick it by hand)`);
    console.log(`Saved to ${tilesDir(config.dataDir)}. Reload the web office. LimeZu's licence requires credit; the office shows it.`);
    process.exit(missing.length ? 1 : 0);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

if (!existsSync(configPath())) {
  console.log('Hyde Code is not set up yet. Run `hyde` in a project folder to start.');
  process.exit(1);
}
const url = base();

if (name === 'hub') {
  const sub = rest[0] ?? 'status';
  if (sub === 'start') await startHub(url);
  else if (sub === 'stop') console.log((await stopHub(url)) ? 'Hub stopped. Running agents were interrupted and will resume next time.' : 'The hub is not running.');
  else if (sub === 'restart') {
    await stopHub(url);
    await startHub(url);
  } else if (sub === 'logs') console.log(existsSync(paths.log) ? readFileSync(paths.log, 'utf8').split('\n').slice(-60).join('\n') : 'No log yet.');
  else console.log((await hubUp(url)) ? `Running at ${url} (pid ${hubPid() ?? '?'}). Log: ${paths.log}` : 'Not running. `hyde hub start` or just `hyde`.');
  process.exit(0);
}

if (name === 'forget') {
  const top = (await gitTop(cwd)) ?? cwd;
  const p = findProject(readRawConfig(configPath()), top);
  untrustFolder(top);
  if (p) {
    await startHub(url, true);
    await api(url, `/api/projects/${encodeURIComponent(p.id)}`, { method: 'DELETE' }).catch((e: Error) => console.log(e.message));
  }
  console.log(`${top} is no longer trusted${p ? ` and #${p.id} was removed (its history stays in the log)` : ''}.`);
  process.exit(0);
}

await startHub(url, true);

if (name === 'tui') {
  const { runTui } = await import('./tui.ts');
  const p = await currentProject();
  await runTui(url, ownerToken(), p ? { project: p.id } : {});
  process.exit(0);
}

if (name === 'web' || name === 'dashboard') {
  const p = await currentProject();
  const link = `${url}/login?token=${ownerToken()}${p ? `&project=${encodeURIComponent(p.id)}` : ''}`;
  openBrowser(link);
  console.log(`Opened the web office. If no browser opened, use this link on this machine:\n${link}`);
  process.exit(0);
}

// Everything else: the chat command. New tasks default to this folder's project.
let args = rest;
if ((name === 'new' || name === 'client') && !rest.some((a) => /^#[\w.-]+$/.test(a))) {
  const p = await currentProject();
  if (p) args = [...rest, `#${p.id}`];
}
try {
  const body = await api<{ text?: string }>(url, '/api/commands', { method: 'POST', body: JSON.stringify({ text: `/${name} ${args.join(' ')}`.trim() }) });
  console.log(body.text ?? '');
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
}
