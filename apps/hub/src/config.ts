import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AgentProfile } from '@hyde/core';
import { z } from 'zod';
import { homePaths } from './home.ts';

// hyde.config.json holds non-secret settings; secrets come only from the environment (.env).
// Everything is optional except one project and one enabled agent: the owner picks which CLIs,
// gateways and stages to use (`hyde setup`, or Settings in the dashboard).

const ROLES = ['plan', 'implement', 'review', 'ui', 'bulk', 'triage'] as const;

const agentSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** claude-code, codex, opencode, acp, command, or a kind a plugin registers. */
  adapter: z.string().min(1),
  enabled: z.boolean().default(true),
  model: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  roles: z.array(z.string()).default(['plan', 'implement', 'review', 'ui']),
  maxConcurrent: z.number().int().min(1).max(5).default(1),
  account: z.string().optional(),
  node: z.string().default('local'),
  isolation: z.enum(['worktree', 'container']).default('worktree'),
  command: z.array(z.string()).optional(),
  /** For acp/command agents: which vendor is behind it (cross-vendor review needs to know). */
  vendor: z.enum(['anthropic', 'openai', 'google', 'other']).optional(),
  container: z
    .object({
      image: z.string(),
      memory: z.string().optional(),
      cpus: z.string().optional(),
      network: z.string().optional(),
    })
    .optional(),
});

const projectSchema = z.object({
  /** Used in `/new ... #id`. */
  id: z.string().regex(/^[\w.-]+$/),
  name: z.string().optional(),
  /** Absolute path to the local clone. */
  path: z.string(),
  /** Branch every task branch is cut from and its PR targets. */
  baseBranch: z.string().default('staging'),
  /** Branch `/promote` merges the base branch into. */
  releaseBranch: z.string().default('main'),
  /** Commands run in the worktree after the agent reports done. */
  checks: z.array(z.string()).default([]),
  /** Dev server for browser verification; $PORT is replaced with a free port. */
  preview: z
    .object({
      command: z.string(),
      url: z.string().default('http://127.0.0.1:$PORT'),
      paths: z.array(z.string()).default(['/']),
    })
    .optional(),
  /** Restrict which agents may work here. */
  agents: z.array(z.string()).optional(),
  protectedBranches: z.array(z.string()).optional(),
});

const scheduleSchema = z.object({
  id: z.string().regex(/^[\w.-]+$/),
  /** Cron expression in the hub's local time zone, e.g. "0 9 * * 1-5". */
  cron: z.string(),
  project: z.string(),
  text: z.string(),
  agent: z.string().optional(),
  enabled: z.boolean().default(true),
});

const configSchema = z.object({
  dataDir: z.string().default('.hyde'),
  port: z.number().int().default(7420),
  agents: z.array(agentSchema).default([]),
  /** Phase 0 single-agent form, still accepted. */
  agent: z.object({ name: z.string().default('claude-1'), model: z.string().optional() }).optional(),
  /** Runs across all agents at once. */
  maxConcurrentRuns: z.number().int().min(1).max(10).default(2),
  /** Don't start runs on an account above this 5-hour or weekly utilization. */
  quotaSoftCeiling: z.number().min(0).max(1).default(0.8),
  stallTimeoutMinutes: z.number().positive().default(15),
  maxAttempts: z.number().int().min(1).default(3),
  maxContinuations: z.number().int().min(0).default(2),
  maxFixRounds: z.number().int().min(0).default(3),
  checkTimeoutMinutes: z.number().positive().default(10),
  planner: z
    .object({
      enabled: z.boolean().default(false),
      /** Plans with more subtasks than this, or any size L task, wait for the owner's approval. */
      approvalOver: z.number().int().min(1).default(3),
    })
    .default({ enabled: false, approvalOver: 3 }),
  review: z
    .object({
      enabled: z.boolean().default(false),
      rounds: z.number().int().min(1).default(2),
      /** Require a different vendor for the reviewer; with one vendor, review is skipped. */
      crossVendor: z.boolean().default(true),
    })
    .default({ enabled: false, rounds: 2, crossVendor: true }),
  browser: z.object({ enabled: z.boolean().default(false), video: z.boolean().default(false) }).default({ enabled: false, video: false }),
  merge: z
    .object({
      /** gh pr merge strategy. */
      method: z.enum(['merge', 'squash']).default('merge'),
      deleteWorktree: z.boolean().default(true),
    })
    .default({ method: 'merge', deleteWorktree: true }),
  policy: z
    .object({
      /** Claude PreToolUse hook to the hub: protected branches, write scope, new dependencies. */
      enabled: z.boolean().default(true),
      approvalRequired: z.array(z.enum(['new-dependency', 'destructive'])).default(['new-dependency']),
      /** Pause an agent after this many denied actions in one run. */
      circuitBreaker: z.number().int().min(1).default(5),
    })
    .default({ enabled: true, approvalRequired: ['new-dependency'], circuitBreaker: 5 }),
  notifications: z
    .object({
      /** Hold non-urgent messages, e.g. { start: "23:00", end: "08:00" }. */
      quietHours: z.object({ start: z.string(), end: z.string() }).optional(),
      digestMinutes: z.number().int().min(0).default(20),
      /** Where tasks from the CLI, schedules and WhatsApp report: "telegram:<chatId>". */
      ownerChat: z.string().optional(),
    })
    .default({ digestMinutes: 20 }),
  gateways: z
    .object({
      telegram: z.boolean().default(true),
      slack: z.boolean().default(false),
      discord: z.boolean().default(false),
      whatsapp: z.boolean().default(false),
    })
    .default({ telegram: true, slack: false, discord: false, whatsapp: false }),
  schedules: z.array(scheduleSchema).default([]),
  nodes: z
    .object({
      enabled: z.boolean().default(false),
      /** How agents on teammates' nodes reach this hub (e.g. its Tailscale URL). */
      publicUrl: z.string().url().optional(),
    })
    .default({ enabled: false }),
  /** Plugin modules exporting `register(registries)`. */
  plugins: z.array(z.string()).default([]),
  projects: z.array(projectSchema).min(1),
});

export type ProjectConfig = z.output<typeof projectSchema>;
export type ScheduleConfig = z.output<typeof scheduleSchema>;
export type AgentConfig = z.output<typeof agentSchema>;
export type RawConfig = z.input<typeof configSchema>;
export type HubConfig = Omit<z.output<typeof configSchema>, 'agents' | 'agent'> & {
  agents: (AgentProfile & Pick<AgentConfig, 'vendor' | 'container'>)[];
  configFile: string;
  configDir: string;
  secrets: Secrets;
  callbackSecret: string;
};

export interface Secrets {
  telegramToken?: string;
  telegramAllowedUserIds: number[];
  slackBotToken?: string;
  slackAppToken?: string;
  slackAllowedUserIds: string[];
  discordToken?: string;
  discordAllowedUserIds: string[];
  whatsappToken?: string;
  whatsappPhoneId?: string;
  whatsappVerifyToken?: string;
  whatsappAppSecret?: string;
  /** Client phone numbers whose WhatsApp messages become intake (E.164 without +). */
  whatsappClients: string[];
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function readSecrets(env: NodeJS.ProcessEnv): Secrets {
  return {
    ...(env.TELEGRAM_BOT_TOKEN && { telegramToken: env.TELEGRAM_BOT_TOKEN }),
    telegramAllowedUserIds: list(env.TELEGRAM_ALLOWED_USER_IDS).map(Number).filter(Number.isInteger),
    ...(env.SLACK_BOT_TOKEN && { slackBotToken: env.SLACK_BOT_TOKEN }),
    ...(env.SLACK_APP_TOKEN && { slackAppToken: env.SLACK_APP_TOKEN }),
    slackAllowedUserIds: list(env.SLACK_ALLOWED_USER_IDS),
    ...(env.DISCORD_BOT_TOKEN && { discordToken: env.DISCORD_BOT_TOKEN }),
    discordAllowedUserIds: list(env.DISCORD_ALLOWED_USER_IDS),
    ...(env.WHATSAPP_TOKEN && { whatsappToken: env.WHATSAPP_TOKEN }),
    ...(env.WHATSAPP_PHONE_NUMBER_ID && { whatsappPhoneId: env.WHATSAPP_PHONE_NUMBER_ID }),
    ...(env.WHATSAPP_VERIFY_TOKEN && { whatsappVerifyToken: env.WHATSAPP_VERIFY_TOKEN }),
    ...(env.WHATSAPP_APP_SECRET && { whatsappAppSecret: env.WHATSAPP_APP_SECRET }),
    whatsappClients: list(env.WHATSAPP_CLIENT_NUMBERS),
  };
}

/** Validates raw config into the hub's shape. Pure apart from checking project paths exist. */
export function parseConfig(raw: unknown, configFile: string, env: NodeJS.ProcessEnv = process.env): HubConfig {
  const parsed = configSchema.parse(raw);
  const configDir = dirname(configFile);
  const dataDir = isAbsolute(parsed.dataDir) ? parsed.dataDir : join(configDir, parsed.dataDir);
  for (const p of parsed.projects) {
    if (!isAbsolute(p.path)) throw new Error(`Project ${p.id}: path must be absolute`);
    if (!existsSync(join(p.path, '.git'))) throw new Error(`Project ${p.id}: ${p.path} is not a git repository`);
  }
  const agents = parsed.agents.length
    ? parsed.agents
    : [agentSchema.parse({ name: parsed.agent?.name ?? 'claude-1', adapter: 'claude-code', model: parsed.agent?.model })];
  const names = new Set<string>();
  for (const a of agents) {
    if (names.has(a.name)) throw new Error(`Agent name "${a.name}" is used twice`);
    names.add(a.name);
    if ((a.adapter === 'acp' || a.adapter === 'command') && !a.command?.length) {
      throw new Error(`Agent ${a.name}: adapter ${a.adapter} needs "command"`);
    }
    if (a.isolation === 'container' && !a.container) throw new Error(`Agent ${a.name}: isolation "container" needs "container.image"`);
  }
  if (!agents.some((a) => a.enabled)) throw new Error('Enable at least one agent');
  for (const s of parsed.schedules) {
    if (!parsed.projects.some((p) => p.id === s.project)) throw new Error(`Schedule ${s.id}: unknown project ${s.project}`);
  }
  const { agent: _legacy, ...rest } = parsed;
  return {
    ...rest,
    dataDir,
    configFile,
    configDir,
    agents: agents.map((a) => ({
      ...a,
      // Agents on the same CLI share one login, so one quota, unless told otherwise.
      account: a.account ?? `${a.node}:${a.adapter}`,
    })) as HubConfig['agents'],
    secrets: readSecrets(env),
    callbackSecret: env.HYDE_CALLBACK_SECRET ?? '',
  };
}

/** Where the config lives: $HYDE_CONFIG, else ~/.hyde/config.json. */
export function configPath(): string {
  // pnpm runs scripts inside apps/hub; INIT_CWD is where the command was typed.
  return process.env.HYDE_CONFIG ? resolve(process.env.INIT_CWD ?? process.cwd(), process.env.HYDE_CONFIG) : homePaths().config;
}

/** Loads the config and secrets from the environment, creating the data dir. */
export function loadConfig(path = configPath()): HubConfig {
  const file = resolve(path);
  if (!existsSync(file)) {
    throw new Error(`Config not found: ${file}. Run \`hyde\` in a project folder to set Hyde Code up.`);
  }
  const config = parseConfig(JSON.parse(readFileSync(file, 'utf8')), file);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  if (!config.callbackSecret) config.callbackSecret = persistedSecret(join(config.dataDir, 'callback-secret'));
  return config;
}

/** Reads the raw JSON (for the settings page) without validation side effects. */
export function readRawConfig(file: string): RawConfig {
  return JSON.parse(readFileSync(file, 'utf8')) as RawConfig;
}

/** Validates and writes the raw config atomically. Throws on invalid input; nothing is written then. */
export function writeRawConfig(file: string, raw: unknown): void {
  parseConfig(raw, file, {});
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  renameSync(tmp, file); // atomic on the same filesystem
}

/** A random secret kept in the data dir (0600), created on first use. */
export function persistedSecret(file: string): string {
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString('base64url');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export { ROLES };
