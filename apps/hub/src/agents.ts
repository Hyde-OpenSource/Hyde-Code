import { AcpAdapter } from '@hyde/adapter-acp';
import { ClaudeCodeAdapter } from '@hyde/adapter-claude-code';
import { CodexAdapter } from '@hyde/adapter-codex';
import { CommandAdapter } from '@hyde/adapter-command';
import { containerWrapper, type LaunchWrapper } from '@hyde/adapter-common';
import { OpenCodeAdapter } from '@hyde/adapter-opencode';
import {
  ADAPTER_MAX_EFFORT,
  BUILTIN_TIERS,
  effortShift,
  isFreeModel,
  jobLevel,
  Registry,
  shiftEffort,
  tierFor,
  type AgentAdapter,
  type Complexity,
  type Effort,
  type TierTable,
  type AgentProfile,
  type DetectResult,
  type HarnessState,
  type RunMode,
  type TaskView,
  type Vendor,
} from '@hyde/core';
import type { HubConfig, ProjectConfig } from './config.ts';

export type AdapterFactory = (profile: HubConfig['agents'][number], wrap: LaunchWrapper | undefined) => AgentAdapter;

/** The built-in adapters. Plugins add more with adapters.register(kind, factory). */
export function defaultAdapters(): Registry<AdapterFactory> {
  return new Registry<AdapterFactory>('adapter')
    .register('claude-code', (_p, wrap) => new ClaudeCodeAdapter('claude', wrap ? { wrap } : {}))
    .register('codex', (_p, wrap) => new CodexAdapter('codex', wrap ? { wrap } : {}))
    .register('opencode', (_p, wrap) => new OpenCodeAdapter('opencode', wrap ? { wrap } : {}))
    .register('acp', (p, wrap) => new AcpAdapter({ command: p.command!, ...(p.vendor && { vendor: p.vendor }), ...(wrap && { wrap }) }))
    .register('command', (p, wrap) => new CommandAdapter(p.command!, wrap ? { wrap } : {}));
}

export interface AgentHealth extends DetectResult {
  checkedAt: number;
}

/** Remote nodes provide adapters for agents that live on a teammate's machine. */
export type RemoteAdapterProvider = (profile: AgentProfile) => AgentAdapter | undefined;

export class AgentPool {
  private readonly adapters = new Map<string, AgentAdapter>();
  readonly health = new Map<string, AgentHealth>();

  constructor(
    private readonly config: HubConfig,
    private readonly registry: Registry<AdapterFactory>,
    private readonly hydeRoot: string,
    private readonly remote?: RemoteAdapterProvider,
  ) {}

  /** Drops cached adapters and health after a config change. */
  reset(): void {
    this.adapters.clear();
    this.health.clear();
  }

  profiles(): HubConfig['agents'] {
    return this.config.agents.filter((a) => a.enabled);
  }

  profile(name: string): HubConfig['agents'][number] | undefined {
    return this.config.agents.find((a) => a.name === name);
  }

  adapter(name: string): AgentAdapter {
    let adapter = this.adapters.get(name);
    if (adapter) return adapter;
    const profile = this.profile(name);
    if (!profile) throw new Error(`Unknown agent ${name}`);
    if (profile.node !== 'local') {
      adapter = this.remote?.(profile);
      if (!adapter) throw new Error(`Agent ${name} runs on node ${profile.node}, which is not connected`);
      return adapter; // not cached: the node may reconnect
    }
    const wrap =
      profile.isolation === 'container' && profile.container
        ? containerWrapper({
            image: profile.container.image,
            homeVolume: `hyde-${profile.name}-home`,
            readOnlyMounts: [this.hydeRoot],
            ...(profile.container.memory && { memory: profile.container.memory }),
            ...(profile.container.cpus && { cpus: profile.container.cpus }),
            ...(profile.container.network && { network: profile.container.network }),
          })
        : undefined;
    adapter = this.registry.get(profile.adapter)(profile, wrap);
    this.adapters.set(name, adapter);
    return adapter;
  }

  vendor(name: string): Vendor {
    const profile = this.profile(name);
    if (profile?.vendor) return profile.vendor;
    try {
      return this.adapter(name).vendor;
    } catch {
      return 'other';
    }
  }

  async refreshHealth(): Promise<void> {
    await Promise.all(
      this.profiles().map(async (p) => {
        try {
          const result = await this.adapter(p.name).detect();
          this.health.set(p.name, { ...result, checkedAt: Date.now() });
        } catch (err) {
          this.health.set(p.name, { installed: false, signedIn: false, problem: (err as Error).message, checkedAt: Date.now() });
        }
      }),
    );
  }

  /** Usable when enabled and (once checked) installed and signed in. */
  usable(name: string): boolean {
    const p = this.profile(name);
    if (!p?.enabled) return false;
    const h = this.health.get(name);
    return !h || (h.installed && h.signedIn);
  }
}

// ---------------------------------------------------------------- routing

export interface RouteInput {
  task: TaskView;
  mode: RunMode;
  project: ProjectConfig;
  state: HarnessState;
  pool: AgentPool;
  config: HubConfig;
  now: number;
  /** For review runs: the author's agent, whose vendor the reviewer must differ from. */
  author?: string;
}

export interface RoutedRun {
  agent: string;
  /** The tier entry used (may be stronger than asked when the agent has no entry for the level). */
  tier: Complexity;
  model?: string;
  effort?: Effort;
  free: boolean;
  /** Human-readable reason, stored on run.dispatched. */
  why: string;
}

export type RouteResult = RoutedRun | { wait: string } | { none: string };

const MODE_ROLE: Partial<Record<RunMode, string>> = { plan: 'plan', review: 'review', classify: 'triage' };

/** Running runs per agent and per account, from the state. */
export function load(state: HarnessState): { byAgent: Map<string, number>; byAccount: Map<string, number>; total: number } {
  const byAgent = new Map<string, number>();
  const byAccount = new Map<string, number>();
  let total = 0;
  for (const r of state.runs.values()) {
    if (r.state !== 'running') continue;
    total++;
    byAgent.set(r.agent, (byAgent.get(r.agent) ?? 0) + 1);
    byAccount.set(r.account, (byAccount.get(r.account) ?? 0) + 1);
  }
  return { byAgent, byAccount, total };
}

/** Highest utilization across an account's windows, and whether a window is exhausted. */
export function accountQuota(state: HarnessState, account: string, now: number): { max: number; blocked?: string } {
  let max = 0;
  let blocked: string | undefined;
  for (const q of state.quotas.values()) {
    if (q.account !== account) continue;
    if (q.resetsAt && q.resetsAt * 1000 < now) continue; // window already reset
    const u = q.utilization ?? 0;
    if (q.status === 'rejected') blocked = `${q.window} limit reached`;
    max = Math.max(max, u);
  }
  return { max, ...(blocked && { blocked }) };
}

function recentFailureRate(state: HarnessState, agent: string): number {
  const runs = [...state.runs.values()].filter((r) => r.agent === agent && r.state === 'exited').slice(-10);
  if (!runs.length) return 0;
  return runs.filter((r) => r.failure && r.failure.reason !== 'cancelled').length / runs.length;
}

/** A profile's tier table: its own `tiers`, the adapter's built-in table, or its one model for every level. */
export function tierTable(profile: Pick<AgentProfile, 'adapter' | 'model' | 'effort' | 'tiers'>): TierTable {
  if (profile.tiers && Object.keys(profile.tiers).length) return profile.tiers;
  const builtin = BUILTIN_TIERS[profile.adapter];
  if (builtin) return builtin;
  const one = { ...(profile.model && { model: profile.model }), ...(profile.effort && { effort: profile.effort }) };
  return { trivial: one, low: one, medium: one, high: one };
}

/** What a run of `mode` needs: the job kind and its complexity level. */
export function jobFor(task: TaskView, mode: RunMode): { job: 'code' | 'plan' | 'review' | 'classify'; level: Complexity } {
  const job = mode === 'plan' ? 'plan' : mode === 'review' ? 'review' : mode === 'classify' ? 'classify' : 'code';
  // A task the rules couldn't place is planned on the strong tier; coding waits for a real level.
  const complexity = task.complexity?.confident === false && job === 'plan' ? 'high' : task.complexity?.level;
  return { job, level: jobLevel(job, complexity) };
}

/** Free models only classify and do trivial or low coding. */
function freeAllowed(job: string, level: Complexity): boolean {
  return job === 'classify' || (job === 'code' && (level === 'trivial' || level === 'low'));
}

/** The tier an agent would use for a job, or why it can't take it. */
export function placeOn(
  profile: HubConfig['agents'][number],
  vendor: Vendor,
  job: 'code' | 'plan' | 'review' | 'classify',
  level: Complexity,
  routing: HubConfig['routing'],
): { tier: Complexity; model?: string; effort?: Effort; free: boolean } | { no: string } {
  const placed = tierFor(tierTable(profile), level);
  if (!placed) return { no: `${profile.name} has no ${level} tier or stronger` };
  const model = placed.spec.model ?? profile.model;
  const free = isFreeModel(profile.adapter, model, placed.spec.free);
  if (free && !freeAllowed(job, level)) return { no: `${profile.name} runs a free model, which may not ${job === 'code' ? `code ${level} work` : job}` };
  const claudeOnly = routing.mode === 'claude-only' || (routing.mode === 'free-first' && !freeAllowed(job, level));
  if (claudeOnly && vendor !== 'anthropic' && job !== 'classify') return { no: `${profile.name} is not Claude (mode ${routing.mode})` };
  const effort = placed.spec.effort ?? profile.effort;
  return { tier: placed.level, ...(model && { model }), ...(effort && { effort }), free };
}

/**
 * Picks an agent and tier for a run. Candidates must serve the job's tier (or a stronger one):
 * when they are all busy or out of quota the task waits instead of dropping to a weaker model.
 * Plan, review and classify runs need an agent with that role. A reviewer must come from a
 * different vendor than the author, except in claude-only mode.
 */
export function route(input: RouteInput): RouteResult {
  const { task, mode, project, state, pool, config, now } = input;
  const routing = config.routing;
  const { job, level } = jobFor(task, mode);
  const strictRole = MODE_ROLE[mode];
  const role = strictRole ?? task.role ?? 'implement';
  const loads = load(state);
  let candidates = pool.profiles().filter((p) => pool.usable(p.name));
  if (project.agents) candidates = candidates.filter((p) => project.agents!.includes(p.name));
  if (task.pinnedAgent && mode !== 'review' && mode !== 'classify') candidates = candidates.filter((p) => p.name === task.pinnedAgent);
  if (mode === 'review') {
    const sameVendorOk = routing.mode === 'claude-only';
    if (!sameVendorOk) candidates = candidates.filter((p) => p.name !== input.author);
    if (config.review.crossVendor && input.author && !sameVendorOk) {
      const authorVendor = pool.vendor(input.author);
      candidates = candidates.filter((p) => pool.vendor(p.name) !== authorVendor);
    }
    if (!candidates.length) return { none: 'no agent from a different vendor is enabled' };
  }
  if (strictRole && strictRole !== 'triage') {
    candidates = candidates.filter((p) => p.roles.includes(strictRole));
    if (!candidates.length) return { none: `no usable agent has the ${strictRole} role` };
  }
  if (!candidates.length) return { none: task.pinnedAgent ? `agent ${task.pinnedAgent} is not available` : 'no usable agent is enabled' };

  const placements = candidates.map((p) => ({ p, place: placeOn(p, pool.vendor(p.name), job, level, routing) }));
  const able = placements.filter((x) => !('no' in x.place));
  if (!able.length) return { none: `no agent can take ${job === 'code' ? `${level} coding` : `the ${job} step`}: ${placements.map((x) => ('no' in x.place ? x.place.no : '')).join('; ')}` };

  let waitReason = '';
  const scored: { run: RoutedRun; score: number; running: number; order: number }[] = [];
  able.forEach(({ p, place }, order) => {
    if ('no' in place) return;
    const quota = accountQuota(state, p.account, now);
    if (quota.blocked) return void (waitReason = `${p.name}: ${quota.blocked}`);
    if (quota.max >= config.quotaSoftCeiling) {
      return void (waitReason = `${p.name}: quota at ${Math.round(quota.max * 100)}% (soft ceiling ${Math.round(config.quotaSoftCeiling * 100)}%)`);
    }
    const accountRunning = loads.byAccount.get(p.account) ?? 0;
    const agentRunning = loads.byAgent.get(p.name) ?? 0;
    if (agentRunning >= p.maxConcurrent || accountRunning >= p.maxConcurrent) {
      return void (waitReason = `${p.name} is busy`);
    }
    const fit = p.roles.includes(role) ? 3 : p.roles.includes('implement') && job === 'code' ? 1 : 0;
    // Cheap work prefers free models (balanced: trivial only; free-first: trivial and low; classify: always).
    const wantsFree =
      job === 'classify' || (job === 'code' && (level === 'trivial' || (level === 'low' && routing.mode === 'free-first')));
    const costFit = wantsFree ? (place.free ? 2 : 0) : 0;
    // A stronger tier than needed is allowed but costs more; prefer exact matches.
    const exact = place.tier === level ? 0.5 : 0;
    const score = fit + costFit + exact + 2 * (1 - quota.max) - 3 * recentFailureRate(state, p.name);
    const shift = effortShift(routing.effort, quota.max);
    const effort = shiftEffort(place.effort, shift, ADAPTER_MAX_EFFORT[p.adapter] ?? 'high');
    const why = [
      `${job === 'code' ? `${level} coding` : `${job} (${level} tier)`}`,
      place.tier !== level ? `upgraded to ${p.name}'s ${place.tier} tier (no ${level} entry)` : '',
      shift && place.effort ? `effort ${place.effort} → ${effort} (hyde effort ${routing.effort}${routing.effort === 'auto' ? `, quota ${Math.round(quota.max * 100)}%` : ''})` : '',
      `mode ${routing.mode}`,
    ]
      .filter(Boolean)
      .join('; ');
    const run: RoutedRun = { agent: p.name, tier: place.tier, free: place.free, why, ...(place.model && { model: place.model }), ...(effort && { effort }) };
    scored.push({ run, score, running: agentRunning, order });
  });
  if (!scored.length) return { wait: waitReason || 'all agents are busy' };
  scored.sort((a, b) => b.score - a.score || a.running - b.running || a.order - b.order);
  return scored[0]!.run;
}
