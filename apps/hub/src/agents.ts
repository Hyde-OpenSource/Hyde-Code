import { AcpAdapter } from '@hyde/adapter-acp';
import { ClaudeCodeAdapter } from '@hyde/adapter-claude-code';
import { CodexAdapter } from '@hyde/adapter-codex';
import { CommandAdapter } from '@hyde/adapter-command';
import { containerWrapper, type LaunchWrapper } from '@hyde/adapter-common';
import { OpenCodeAdapter } from '@hyde/adapter-opencode';
import {
  Registry,
  type AgentAdapter,
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

export type RouteResult = { agent: string } | { wait: string } | { none: string };

const MODE_ROLE: Partial<Record<RunMode, string>> = { plan: 'plan', review: 'review' };

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

/**
 * Scores each candidate agent: role fit, plus quota headroom, minus recent failure rate.
 * A reviewer must come from a different vendor than the author.
 */
export function route(input: RouteInput): RouteResult {
  const { task, mode, project, state, pool, config, now } = input;
  const role = MODE_ROLE[mode] ?? task.role ?? 'implement';
  const loads = load(state);
  let candidates = pool.profiles().filter((p) => pool.usable(p.name));
  if (project.agents) candidates = candidates.filter((p) => project.agents!.includes(p.name));
  if (task.pinnedAgent && mode !== 'review') candidates = candidates.filter((p) => p.name === task.pinnedAgent);
  if (mode === 'review') {
    candidates = candidates.filter((p) => p.name !== input.author);
    if (config.review.crossVendor && input.author) {
      const authorVendor = pool.vendor(input.author);
      candidates = candidates.filter((p) => pool.vendor(p.name) !== authorVendor);
    }
    if (!candidates.length) return { none: 'no agent from a different vendor is enabled' };
  }
  if (!candidates.length) return { none: task.pinnedAgent ? `agent ${task.pinnedAgent} is not available` : 'no usable agent is enabled' };

  let waitReason = '';
  const scored: { name: string; score: number; running: number; order: number }[] = [];
  candidates.forEach((p, order) => {
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
    const fit = p.roles.includes(role) ? 3 : p.roles.includes('implement') && role !== 'plan' && role !== 'review' ? 1 : 0;
    const score = fit + 2 * (1 - quota.max) - 3 * recentFailureRate(state, p.name);
    scored.push({ name: p.name, score, running: agentRunning, order });
  });
  if (!scored.length) return { wait: waitReason || 'all agents are busy' };
  scored.sort((a, b) => b.score - a.score || a.running - b.running || a.order - b.order);
  return { agent: scored[0]!.name };
}
