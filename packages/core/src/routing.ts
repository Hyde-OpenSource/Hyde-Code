// Complexity tiers, routing modes and effort levels (pure, shared by the hub and the dashboard).
// A task gets a complexity level before it runs; every agent profile maps each level to a model
// and an effort. The router (apps/hub/src/agents.ts) picks the agent; this file holds the rules.

export const COMPLEXITY_LEVELS = ['trivial', 'low', 'medium', 'high'] as const;
export type Complexity = (typeof COMPLEXITY_LEVELS)[number];

/** Effort levels the CLIs accept, lowest first (claude --effort, codex model_reasoning_effort). */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/**
 * - balanced: a strong model plans and reviews, code goes to the tier its complexity needs.
 * - claude-only: Claude models only, by complexity.
 * - free-first: free models for trivial and low work, Claude for everything else.
 * - assistant-plans: the Hyde AI desktop assistant's plan is used for its own requests; CLIs code.
 */
export const ROUTING_MODES = ['balanced', 'claude-only', 'free-first', 'assistant-plans'] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

/** Moves every tier's effort: saver one step down, max one step up, auto down when quota runs low. */
export const HYDE_EFFORTS = ['saver', 'balanced', 'max', 'auto'] as const;
export type HydeEffort = (typeof HYDE_EFFORTS)[number];

/** Who decided a task's complexity. */
export const CLASSIFIERS = ['rules', 'model', 'planner', 'client', 'owner', 'harness'] as const;
export type Classifier = (typeof CLASSIFIERS)[number];

export interface TierSpec {
  model?: string;
  effort?: Effort;
  /** A free model: never plans, reviews or codes medium/high work. */
  free?: boolean;
}
export type TierTable = Partial<Record<Complexity, TierSpec>>;

/**
 * Built-in tier tables, used when a profile has no `tiers`. Claude: the aliases `claude --help`
 * documents (opus, sonnet; haiku). Codex: ids the owner chose on 2026-11-06 (AgentAnswers Q-001).
 * gpt-6-luna is in `codex debug models` (0.162.1); gpt-6-astra and gpt-6.1-sol are in the owner's
 * ~/.codex/config.toml but not in that catalog, so a run on them fails loudly if the account lacks them.
 * Other adapters keep their single `model` for every tier.
 */
export const BUILTIN_TIERS: Record<string, TierTable> = {
  'claude-code': {
    high: { model: 'opus', effort: 'high' },
    medium: { model: 'sonnet', effort: 'medium' },
    low: { model: 'haiku', effort: 'low' },
    trivial: { model: 'haiku', effort: 'low' },
  },
  codex: {
    high: { model: 'gpt-6-astra', effort: 'high' },
    medium: { model: 'gpt-6.1-sol', effort: 'medium' },
    low: { model: 'gpt-6-luna', effort: 'low' },
    trivial: { model: 'gpt-6-luna', effort: 'low' },
  },
};

/** The highest effort each CLI accepts; anything above is clamped. */
export const ADAPTER_MAX_EFFORT: Record<string, Effort> = { 'claude-code': 'max', codex: 'max', opencode: 'high' };

export function levelIndex(level: Complexity): number {
  return COMPLEXITY_LEVELS.indexOf(level);
}

export function higher(a: Complexity, b: Complexity): Complexity {
  return levelIndex(a) >= levelIndex(b) ? a : b;
}

/** Moves an effort up or down the ladder, clamped to [low, max]. */
export function shiftEffort(effort: Effort | undefined, by: number, max: Effort = 'max'): Effort | undefined {
  if (!effort) return undefined;
  const top = EFFORT_LEVELS.indexOf(max);
  const i = Math.max(0, Math.min(top, EFFORT_LEVELS.indexOf(effort) + by));
  return EFFORT_LEVELS[i];
}

/** How far the hub-wide effort setting moves a tier's effort, given the account's quota use (0..1). */
export function effortShift(setting: HydeEffort, quotaUsed: number): number {
  if (setting === 'saver') return -1;
  if (setting === 'max') return 1;
  if (setting === 'auto') return quotaUsed >= 0.6 ? -1 : 0;
  return 0;
}

/** A model the owner doesn't pay for. OpenCode's own `opencode/` provider serves free Zen models. */
export function isFreeModel(adapter: string, model: string | undefined, flag?: boolean): boolean {
  if (flag !== undefined) return flag;
  return adapter === 'opencode' && (model === undefined || model.startsWith('opencode/'));
}

export interface ClassifyHints {
  /** Planner size: L means more than a day of work. */
  size?: 'S' | 'M' | 'L';
}

export interface Classification {
  level: Complexity;
  /** False when the rules only guessed; a model (planner or cheap classifier) then decides. */
  confident: boolean;
  reason: string;
}

const TRIVIAL =
  /\b(rename[sd]?|typos?|spelling|misspel\w*|bump (the )?(version|dependency)|change (the )?(name|title|label|text|wording|copy|colou?r|icon)|update (the )?(copyright|year|version number)|fix (a |the )?(typo|spelling|link)|reword|capitali[sz]e)\b/i;
const HIGH =
  /\b(architecture|re-?architect\w*|redesign\w*|migrat(e|ion|ions)|rewrite|from scratch|security|authenticat\w*|authori[sz]ation|login flow|payments?|billing|encrypt\w*|database schema|concurren\w*|race conditions?|multi-?tenan\w*|scalab\w*|end[- ]to[- ]end|across the (whole|entire) (app|codebase|project|repo)|whole (app|project|repo|system|codebase)|everything|what is remaining|remaining work|complete (this|the) (thing|project|app)|production)\b/i;
const LOW =
  /(\bREADME\b|\bdocs?\/|\.md\b|\bdocumentation\b|\bcomments?\b|\bdocstrings?\b|\.editorconfig\b|\.gitignore\b|\.env\.example\b|\blicen[cs]e file\b|\bchangelog\b|\badd (a |one )?(unit )?test\b|\bconfig file\b)/i;
/** Signs the change is code, not docs: then a README or docs mention doesn't make it low. */
const CODE = /(\bsrc\/|\.(js|mjs|ts|tsx|jsx|py|rs|go|java|rb|php|cs)\b|\b(class|function|method|endpoint|component|api|module|tests? for (every|each|all))\b)/i;
const MEDIUM =
  /\b(add|implement|build|create|feature|page|screen|endpoint|component|api|button|toggle|form|integrat\w*|support|fix|bug|refactor|validation|filter|search|dark mode)\b/i;

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Cheap, deterministic first pass. Strong signals (rename, typo; migration, security, "whole app")
 * are confident; anything else is a guess that a model confirms when one is available.
 */
export function classifyByRules(text: string, hints: ClassifyHints = {}): Classification {
  const n = words(text);
  const steps = (text.match(/^\s*([-*]|\d+[.)])\s+/gm) ?? []).length + (text.match(/\band then\b|;\s/gi) ?? []).length;
  const high = HIGH.exec(text);
  const trivial = TRIVIAL.exec(text);
  if (hints.size === 'L') return { level: 'high', confident: true, reason: 'planner sized it L (more than a day)' };
  if (high && trivial) return { level: 'medium', confident: false, reason: `small edit ("${trivial[0]}") that mentions "${high[0]}"; unsure` };
  if (high) return { level: 'high', confident: true, reason: `mentions "${high[0]}"` };
  if (n > 150 || steps >= 5) return { level: 'high', confident: n > 150, reason: n > 150 ? `long request (${n} words)` : `${steps} steps` };
  if (trivial && n <= 30 && steps < 2) return { level: 'trivial', confident: true, reason: `small edit ("${trivial[0]}", ${n} words)` };
  const low = LOW.exec(text);
  if (low && n <= 60 && steps < 3 && !CODE.test(text)) return { level: 'low', confident: true, reason: `docs/config change ("${low[0]}")` };
  const medium = MEDIUM.exec(text);
  if (medium && n >= 4 && n <= 80) return { level: 'medium', confident: true, reason: `feature or fix ("${medium[0]}")` };
  if (n > 80) return { level: 'high', confident: false, reason: `long request (${n} words); unsure` };
  return { level: 'medium', confident: false, reason: n < 4 ? 'too short to tell' : 'no clear signal' };
}

/** The tier a job runs on: coding follows complexity; planning and review run one tier stronger. */
export function jobLevel(job: 'code' | 'plan' | 'review' | 'classify', complexity: Complexity | undefined): Complexity {
  const level = complexity ?? 'medium';
  if (job === 'classify') return 'trivial';
  if (job === 'plan') return level === 'trivial' || level === 'low' ? 'medium' : 'high';
  // A strong model reviews medium and high work (the owner's "strong plan/review").
  if (job === 'review') return level === 'trivial' || level === 'low' ? 'medium' : 'high';
  return level;
}

/**
 * The tier entry an agent uses for a level: its own entry, else the nearest stronger one
 * (never a weaker one: that would be a silent downgrade). Undefined when it can't serve the level.
 */
export function tierFor(table: TierTable, level: Complexity): { level: Complexity; spec: TierSpec } | undefined {
  for (let i = levelIndex(level); i < COMPLEXITY_LEVELS.length; i++) {
    const l = COMPLEXITY_LEVELS[i]!;
    const spec = table[l];
    if (spec) return { level: l, spec };
  }
  return undefined;
}

/** CLI value for an effort, for adapters that only know low/medium/high. */
export function clampEffort(effort: Effort | undefined, adapter: string): Effort | undefined {
  return shiftEffort(effort, 0, ADAPTER_MAX_EFFORT[adapter] ?? 'high');
}
