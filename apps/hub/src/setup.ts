import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import type { RawConfig } from './config.ts';
import { detectAll, type Detected } from './detect.ts';

const exec = promisify(execFile);

// `hyde setup`: asks which of the detected tools the owner wants to use. Nothing is
// compulsory: every agent, gateway and stage is a choice, and the answers become
// hyde.config.json (settings) and .env (secrets, 0600).

export interface SetupAnswers {
  agents: { id: string; model?: string }[];
  project: { id: string; path: string; baseBranch: string; checks: string[]; preview?: string };
  planner: boolean;
  review: boolean;
  browser: boolean;
  policy: boolean;
  gateways: { telegram: boolean; slack: boolean; discord: boolean; whatsapp: boolean };
  quietHours?: { start: string; end: string };
  ownerChat?: string;
}

/** Pure: detected tools + answers → raw config (merged into any existing config). */
export function buildConfig(detected: Detected[], answers: SetupAnswers, existing?: RawConfig): RawConfig {
  const agents = answers.agents.map(({ id, model }) => {
    const d = detected.find((x) => x.id === id);
    if (!d?.suggest) throw new Error(`Unknown agent ${id}`);
    const s = d.suggest;
    return {
      name: s.name,
      adapter: s.adapter,
      roles: s.roles,
      ...(s.command && { command: s.command }),
      ...(s.vendor && { vendor: s.vendor as 'anthropic' | 'openai' | 'google' | 'other' }),
      ...((model ?? s.model) && { model: model ?? s.model }),
    };
  });
  const projects = (existing?.projects ?? []).filter((p) => p.id !== answers.project.id);
  projects.push({
    id: answers.project.id,
    path: answers.project.path,
    baseBranch: answers.project.baseBranch,
    checks: answers.project.checks,
    ...(answers.project.preview && { preview: { command: answers.project.preview, url: 'http://127.0.0.1:$PORT', paths: ['/'] } }),
  });
  return {
    ...existing,
    agents,
    maxConcurrentRuns: Math.max(1, Math.min(agents.length, 3)),
    planner: { enabled: answers.planner, approvalOver: 3 },
    review: { enabled: answers.review, rounds: 2, crossVendor: true },
    browser: { enabled: answers.browser, video: false },
    policy: { enabled: answers.policy, approvalRequired: ['new-dependency'], circuitBreaker: 5 },
    gateways: answers.gateways,
    notifications: {
      digestMinutes: 20,
      ...(answers.quietHours && { quietHours: answers.quietHours }),
      ...(answers.ownerChat && { ownerChat: answers.ownerChat }),
    },
    projects,
  };
}

/** Sets or replaces KEY=value lines in a .env text. */
export function upsertEnv(text: string, values: Record<string, string>): string {
  let out = text;
  for (const [key, value] of Object.entries(values)) {
    if (!value) continue;
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    out = re.test(out) ? out.replace(re, line) : `${out}${out && !out.endsWith('\n') ? '\n' : ''}${line}\n`;
  }
  return out;
}

export async function guessProject(path: string): Promise<{ baseBranch: string; checks: string[]; preview?: string }> {
  const branches: string[] = await exec('git', ['branch', '--list', '--format=%(refname:short)'], { cwd: path }).then((r) => r.stdout.split('\n'), () => []);
  const baseBranch = branches.includes('staging') ? 'staging' : branches.includes('main') ? 'main' : (branches[0] ?? 'main');
  const pkg = join(path, 'package.json');
  if (!existsSync(pkg)) return { baseBranch, checks: [] };
  const scripts = (JSON.parse(readFileSync(pkg, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
  const runner = existsSync(join(path, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(path, 'yarn.lock')) ? 'yarn' : 'npm';
  const checks = ['lint', 'typecheck', 'test'].filter((s) => scripts[s]).map((s) => (runner === 'npm' && s !== 'test' ? `npm run ${s}` : `${runner} ${s}`));
  const preview = scripts.dev ? `${runner} run dev -- --port $PORT` : undefined;
  return { baseBranch, checks, ...(preview && { preview }) };
}

export async function runSetup(configFile: string, envFile: string, opts: { projectPath?: string } = {}): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def = ''): Promise<string> => (await rl.question(`${q}${def ? ` [${def}]` : ''} `)).trim() || def;
  const yes = async (q: string, def: boolean): Promise<boolean> => /^y/i.test(await ask(`${q} (y/n)`, def ? 'y' : 'n'));

  console.log('\nHyde Code setup. Nothing here is compulsory: pick what you have and want.\n');
  console.log('Checking this machine…');
  const detected = await detectAll();
  for (const d of detected) {
    const mark = d.installed && d.signedIn ? '✓' : d.installed ? '!' : '✗';
    console.log(` ${mark} ${d.label}${d.version ? ` ${d.version}` : ''}${d.account ? ` (${d.account})` : ''}${d.problem ? ` — ${d.problem}` : ''}`);
  }

  const existing = existsSync(configFile) ? (JSON.parse(readFileSync(configFile, 'utf8')) as RawConfig) : undefined;
  console.log('\nAgents (each runs under your own login on this machine):');
  const agents: SetupAnswers['agents'] = [];
  for (const d of detected.filter((x) => x.kind === 'agent')) {
    if (!d.installed || !d.signedIn) {
      console.log(` - ${d.label}: not available. ${d.howTo ?? ''}`);
      continue;
    }
    if (await yes(` Use ${d.label}?`, ['claude-code', 'codex'].includes(d.id))) {
      const model = await ask(`   Model for ${d.label} (empty = CLI default)`, d.suggest?.model ?? '');
      agents.push({ id: d.id, ...(model && { model }) });
    }
  }
  if (!agents.length) {
    console.log('\nNo agent selected. Install and sign in to at least one CLI, then run `hyde` again.');
    rl.close();
    return false;
  }

  console.log('\nProject:');
  const path = resolve(await ask(' Path to the git repo agents will work on', opts.projectPath ?? existing?.projects?.[0]?.path ?? process.cwd()));
  if (!existsSync(join(path, '.git'))) throw new Error(`${path} is not a git repository`);
  const guess = await guessProject(path);
  const id = await ask(' Short id (used as #id in chat)', basename(path).toLowerCase().replace(/[^a-z0-9.-]+/g, '-'));
  const baseBranch = await ask(' Base branch for task PRs', guess.baseBranch);
  const checks = (await ask(' Checks to run after each task (comma-separated, empty for none)', guess.checks.join(', ')))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const vendors = new Set(agents.map((a) => detected.find((d) => d.id === a.id)?.suggest?.vendor ?? (a.id === 'claude-code' ? 'anthropic' : a.id === 'codex' ? 'openai' : 'other')));
  const playwright = detected.find((d) => d.id === 'playwright')?.installed ?? false;
  console.log('\nStages:');
  const planner = await yes(' Plan first (questions + task graph) before coding?', true);
  const review = vendors.size > 1 ? await yes(' Cross-vendor review of every diff?', true) : (console.log(' Cross-vendor review: needs agents from two vendors; skipped.'), false);
  const browser = playwright && guess.preview ? await yes(` Verify UI changes in a browser (${guess.preview})?`, true) : false;
  const policy = await yes(' Policy checks on agent tool calls (protected branches, write scope, approvals)?', true);

  console.log('\nChat (tokens go into .env, never into the config):');
  const env: Record<string, string> = {};
  const gateways = { telegram: false, slack: false, discord: false, whatsapp: false };
  if (await yes(' Telegram?', true)) {
    gateways.telegram = true;
    env.TELEGRAM_BOT_TOKEN = await ask('   Bot token from @BotFather (empty to add later)');
  }
  if (await yes(' Slack (Socket Mode)?', false)) {
    gateways.slack = true;
    env.SLACK_BOT_TOKEN = await ask('   Bot token (xoxb-…)');
    env.SLACK_APP_TOKEN = await ask('   App-level token (xapp-…)');
    env.SLACK_ALLOWED_USER_IDS = await ask('   Your Slack user id(s)');
  }
  if (await yes(' Discord?', false)) {
    gateways.discord = true;
    env.DISCORD_BOT_TOKEN = await ask('   Bot token');
    env.DISCORD_ALLOWED_USER_IDS = await ask('   Your Discord user id(s)');
  }
  if (await yes(' WhatsApp client intake (Cloud API, needs a public webhook URL)?', false)) {
    gateways.whatsapp = true;
    env.WHATSAPP_TOKEN = await ask('   Access token');
    env.WHATSAPP_PHONE_NUMBER_ID = await ask('   Phone number id');
    env.WHATSAPP_VERIFY_TOKEN = await ask('   Webhook verify token (any random string)');
    env.WHATSAPP_APP_SECRET = await ask('   App secret');
    env.WHATSAPP_CLIENT_NUMBERS = await ask('   Client numbers, comma-separated, no +');
  }
  const quiet = await ask('\nQuiet hours, e.g. 23:00-08:00 (empty for none)');
  const [qs, qe] = quiet.split('-');
  rl.close();

  const config = buildConfig(
    detected,
    {
      agents,
      project: { id, path, baseBranch, checks, ...(browser && guess.preview && { preview: guess.preview }) },
      planner,
      review,
      browser,
      policy,
      gateways,
      ...(qs && qe && { quietHours: { start: qs.trim(), end: qe.trim() } }),
    },
    existing,
  );
  mkdirSync(dirname(configFile), { recursive: true, mode: 0o700 });
  writeFileSync(configFile, JSON.stringify(existing ? config : { dataDir: 'data', ...config }, null, 2) + '\n');
  const envText = upsertEnv(existsSync(envFile) ? readFileSync(envFile, 'utf8') : '', env);
  writeFileSync(envFile, envText, { mode: 0o600 });
  chmodSync(envFile, 0o600);
  console.log(`\nSaved ${configFile} and ${envFile}.`);
  return true;
}
