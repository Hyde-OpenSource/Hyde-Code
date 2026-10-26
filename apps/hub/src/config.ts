import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

const projectSchema = z.object({
  /** Used in `/new ... #id`. */
  id: z.string().regex(/^[\w.-]+$/),
  name: z.string().optional(),
  /** Absolute path to the local clone. */
  path: z.string(),
  /** Branch every task branch is cut from and its PR targets. */
  baseBranch: z.string().default('staging'),
  /** Commands run in the worktree after the agent reports done. */
  checks: z.array(z.string()).default([]),
});

const configSchema = z.object({
  dataDir: z.string().default('.hyde'),
  port: z.number().int().default(7420),
  agent: z
    .object({
      name: z.string().default('claude-1'),
      /** Omit to use the CLI's default model. */
      model: z.string().optional(),
    })
    .default({ name: 'claude-1' }),
  /** Phase 0 runs one task at a time; keep 2 or 3 at most per subscription. */
  maxConcurrentRuns: z.number().int().min(1).max(3).default(1),
  /** Don't start runs on an account above this 5-hour or weekly utilization. */
  quotaSoftCeiling: z.number().min(0).max(1).default(0.8),
  stallTimeoutMinutes: z.number().positive().default(15),
  maxAttempts: z.number().int().min(1).default(3),
  maxContinuations: z.number().int().min(0).default(2),
  maxFixRounds: z.number().int().min(0).default(3),
  checkTimeoutMinutes: z.number().positive().default(10),
  projects: z.array(projectSchema).min(1),
});

export type ProjectConfig = z.output<typeof projectSchema>;
export type HubConfig = z.output<typeof configSchema> & {
  configDir: string;
  telegram?: { token: string; allowedUserIds: number[] };
  callbackSecret: string;
};

/** Loads hyde.config.json (non-secret settings) and secrets from the environment. */
export function loadConfig(path = process.env.HYDE_CONFIG ?? 'hyde.config.json'): HubConfig {
  // pnpm runs scripts inside apps/hub; INIT_CWD is where the command was typed.
  const file = resolve(process.env.INIT_CWD ?? process.cwd(), path);
  if (!existsSync(file)) {
    throw new Error(`Config not found: ${file}. Copy hyde.config.example.json to hyde.config.json and edit it.`);
  }
  const configDir = resolve(file, '..');
  const parsed = configSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const dataDir = isAbsolute(parsed.dataDir) ? parsed.dataDir : join(configDir, parsed.dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  for (const p of parsed.projects) {
    if (!isAbsolute(p.path)) throw new Error(`Project ${p.id}: path must be absolute`);
    if (!existsSync(join(p.path, '.git'))) throw new Error(`Project ${p.id}: ${p.path} is not a git repository`);
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const allowedUserIds = (process.env.TELEGRAM_ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isInteger);

  return {
    ...parsed,
    dataDir,
    configDir,
    ...(token && { telegram: { token, allowedUserIds } }),
    callbackSecret: process.env.HYDE_CALLBACK_SECRET ?? persistedSecret(join(dataDir, 'callback-secret')),
  };
}

/** A random secret kept in the data dir (0600), created on first use. */
export function persistedSecret(file: string): string {
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(32).toString('base64url');
  writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
