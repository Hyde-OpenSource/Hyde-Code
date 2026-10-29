import type { HarnessState } from '@hyde/core';

// Audit and metrics (docs/plan.md Phase 4): numbers per agent and task, derived from the log.

export interface AgentMetrics {
  agent: string;
  runs: number;
  running: number;
  failed: number;
  successRate: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  avgMinutes: number;
  tasksDone: number;
}

export function agentMetrics(state: HarnessState): AgentMetrics[] {
  const by = new Map<string, AgentMetrics & { minutes: number; finished: number }>();
  for (const r of state.runs.values()) {
    const m = by.get(r.agent) ?? { agent: r.agent, runs: 0, running: 0, failed: 0, successRate: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, avgMinutes: 0, tasksDone: 0, minutes: 0, finished: 0 };
    m.runs++;
    if (r.state === 'running') m.running++;
    if (r.failure && r.failure.reason !== 'cancelled') m.failed++;
    m.inputTokens += r.inputTokens;
    m.outputTokens += r.outputTokens;
    m.costUsd += r.costUsd;
    if (r.endedTs) {
      m.minutes += (Date.parse(r.endedTs) - Date.parse(r.startedTs)) / 60_000;
      m.finished++;
    }
    by.set(r.agent, m);
  }
  for (const t of state.tasks.values()) {
    if (t.status === 'done' && t.agent) {
      const m = by.get(t.agent);
      if (m) m.tasksDone++;
    }
  }
  return [...by.values()].map(({ minutes, finished, ...m }) => ({
    ...m,
    successRate: m.runs - m.running ? (m.runs - m.running - m.failed) / (m.runs - m.running) : 0,
    avgMinutes: finished ? minutes / finished : 0,
  }));
}

export function prometheus(state: HarnessState): string {
  const lines: string[] = [];
  const metric = (name: string, help: string, type: 'gauge' | 'counter', values: [Record<string, string>, number][]) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of values) {
      const l = Object.entries(labels).map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, '_')}"`).join(',');
      lines.push(`${name}${l ? `{${l}}` : ''} ${value}`);
    }
  };
  const statuses = new Map<string, number>();
  for (const t of state.tasks.values()) statuses.set(t.status, (statuses.get(t.status) ?? 0) + 1);
  metric('hyde_tasks', 'Tasks by status', 'gauge', [...statuses].map(([status, n]) => [{ status }, n]));
  const agents = agentMetrics(state);
  metric('hyde_runs_total', 'Agent runs started', 'counter', agents.map((a) => [{ agent: a.agent }, a.runs]));
  metric('hyde_runs_failed_total', 'Agent runs that failed', 'counter', agents.map((a) => [{ agent: a.agent }, a.failed]));
  metric('hyde_runs_running', 'Agent runs in progress', 'gauge', agents.map((a) => [{ agent: a.agent }, a.running]));
  metric('hyde_tokens_total', 'Tokens used', 'counter', agents.flatMap((a) => [[{ agent: a.agent, kind: 'input' }, a.inputTokens], [{ agent: a.agent, kind: 'output' }, a.outputTokens]] as [Record<string, string>, number][]));
  metric('hyde_cost_usd_total', 'Estimated list-price cost reported by the CLIs', 'counter', agents.map((a) => [{ agent: a.agent }, Number(a.costUsd.toFixed(6))]));
  metric('hyde_quota_utilization', 'Latest quota window utilization (0-1)', 'gauge', [...state.quotas.values()].map((q) => [{ account: q.account, window: q.window }, q.utilization ?? 0]));
  metric('hyde_open_items', 'Items waiting for the owner', 'gauge', [
    [{ kind: 'question' }, [...state.questions.values()].filter((q) => q.status === 'open').length],
    [{ kind: 'approval' }, [...state.approvals.values()].filter((a) => a.status === 'open').length],
    [{ kind: 'incident' }, state.incidents.size],
  ]);
  metric('hyde_policy_decisions_total', 'Policy engine decisions', 'counter', Object.entries(state.policy).map(([decision, n]) => [{ decision }, n]));
  return lines.join('\n') + '\n';
}
