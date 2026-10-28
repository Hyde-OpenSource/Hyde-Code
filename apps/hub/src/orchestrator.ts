import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  apply,
  canTransition,
  HELP_TEXT,
  nextId,
  replay,
  retryDelayMs,
  TERMINAL_STATUSES,
  type Actor,
  type AgentAdapter,
  type AppendInput,
  type ApprovalKind,
  type EventStore,
  type EventType,
  type HarnessEvent,
  type HarnessState,
  type Inbound,
  type OutboundMessage,
  type RunHandle,
  type RunMode,
  type RunSpec,
  type SourceKind,
  type TaskStatus,
  type TaskView,
} from '@hyde/core';
import { buildTaskPacket, HARNESS_ENV, hasProgressEntry, LESSON_FILES, readLessons, withLessons, withProgressEntry, writeDevflowFiles } from '@hyde/devflow';
import { MCP_MAIN } from '@hyde/mcp-harness';
import { compileProfile, DEFAULT_DEV_PROFILE } from '@hyde/policy';
import { branchName } from '@hyde/workspace';
import { accountQuota, route, type AgentPool } from './agents.ts';
import { browserCheck, type BrowserCheckInput, type BrowserCheckResult } from './browser.ts';
import type { HubConfig, ProjectConfig } from './config.ts';
import { worktreesRoot, type HostOps } from './host.ts';
import type { Notifier } from './notifier.ts';
import { checkPlan, PLAN_SCHEMA, plannerPrompt } from './planner.ts';
import { decide as decidePolicy, hookResponse } from './policy-engine.ts';
import { blockingFindings, parseReview, REVIEW_SCHEMA, reviewFixPrompt, reviewPrompt } from './review.ts';
import { readWorkflow, renderTemplate, type Workflow } from './workflow.ts';

const HARNESS: Actor = { kind: 'harness', id: 'hub' };
const CONTINUATION_MODES: RunMode[] = ['continue', 'answer', 'fix', 'review_fix', 'conflict', 'browser_fix'];

export interface OrchestratorDeps {
  config: HubConfig;
  store: EventStore;
  pool: AgentPool;
  notifier: Notifier;
  /** File and git operations for a node ('local' is the hub machine). */
  host: (node: string) => HostOps;
  /** URL the agents' MCP server and policy hook use to reach the hub API. */
  hubUrl: string;
  /** Root of this Hyde Code checkout (holds the MCP server). */
  hydeRoot: string;
  /** Resolves `tsx/esm` for running the TypeScript MCP server. */
  tsxLoader: string;
  browser?: (input: BrowserCheckInput) => Promise<BrowserCheckResult>;
  workflow?: (project: ProjectConfig) => Promise<Workflow>;
  log?: (msg: string) => void;
  now?: () => number;
}

interface LiveRun {
  handle: RunHandle;
  adapter: AgentAdapter;
  token: string;
  stalled: boolean;
  denials: number;
  breaker?: string;
}

/**
 * The only writer of task state (Symphony's single authority). A deterministic tick loop
 * reconciles running work and dispatches ready tasks; models only decide content (plans,
 * code, reviews). Every decision is an event in the log, so a restart replays to the same state.
 */
export class Orchestrator {
  readonly state: HarnessState;
  private readonly live = new Map<string, LiveRun>();
  private readonly tokens = new Map<string, string>(); // run token → run id
  private readonly retryAt = new Map<string, number>(); // task id → earliest next dispatch
  private readonly busy = new Set<string>(); // tasks with post-run work in flight
  private readonly merging = new Set<string>(); // projects with a merge in flight
  private readonly mergeQueue: string[] = []; // task ids, in order
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private devflowDirty = true;
  private lastQuotaPoll = 0;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private readonly browser: NonNullable<OrchestratorDeps['browser']>;
  private readonly workflow: NonNullable<OrchestratorDeps['workflow']>;

  constructor(private readonly deps: OrchestratorDeps) {
    this.state = replay(deps.store.list());
    deps.store.subscribe((record) => {
      apply(this.state, record);
      this.devflowDirty = true;
    });
    this.log = deps.log ?? ((m) => console.log(m));
    this.now = deps.now ?? Date.now;
    this.browser = deps.browser ?? browserCheck;
    this.workflow = deps.workflow ?? readWorkflow;
  }

  get config(): HubConfig {
    return this.deps.config;
  }

  /** Recovers from a restart: runs that were live have no process any more. */
  recover(): void {
    for (const run of this.state.runs.values()) {
      if (run.state !== 'running') continue;
      this.append({ type: 'run.exited', runId: run.id, taskId: run.taskId, payload: { runId: run.id, code: null, signal: 'hub-restart' } });
      const task = this.state.tasks.get(run.taskId);
      if (!task) continue;
      if (task.status === 'running') this.setStatus(task, 'ready', 'hub restarted during the run');
      if (task.status === 'clarifying' && run.mode === 'plan') this.retryAt.set(task.id, 0);
      if (task.status === 'review' && run.mode === 'review') void this.verify(task.id, { fromReview: true });
    }
    for (const task of this.state.tasks.values()) {
      // Post-run steps are idempotent, so a task caught mid-verify simply runs them again.
      if (task.status === 'verifying') void this.verify(task.id);
    }
  }

  start(intervalMs = 3000): void {
    this.recover();
    void this.deps.pool.refreshHealth().then(() => this.tick());
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const run of this.live.values()) await run.adapter.interrupt(run.handle);
  }

  /** Waits until no run, verify step or merge is in flight (for clean shutdown and tests). */
  async drain(timeoutMs = 5000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while ((this.live.size || this.busy.size || this.merging.size) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  // ================================================================ tick loop

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.reconcile();
      this.promoteChildren();
      await this.planPending();
      await this.dispatchReady();
      await this.processMergeQueue();
      await this.pollQuotas();
      await this.deps.notifier.flush();
      this.syncDevflow();
    } catch (err) {
      this.log(`tick error: ${(err as Error).stack ?? err}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Interrupts runs with no events for the stall timeout; the run's exit handler retries them. */
  private reconcile(): void {
    const limit = this.config.stallTimeoutMinutes * 60_000;
    for (const [runId, live] of this.live) {
      const run = this.state.runs.get(runId);
      if (!run || live.stalled) continue;
      if (this.now() - Date.parse(run.lastEventTs) > limit) {
        live.stalled = true;
        this.log(`${run.taskId}: ${runId} stalled, interrupting`);
        void live.adapter.interrupt(live.handle);
      }
    }
  }

  /** Child tasks of an approved plan become ready once their dependencies have reached review. */
  private promoteChildren(): void {
    for (const task of this.state.tasks.values()) {
      if (task.status !== 'backlog' || !task.parentId) continue;
      const parent = this.state.tasks.get(task.parentId);
      if (!parent || parent.status !== 'running') continue;
      const depsDone = task.dependsOn.every((id) => {
        const dep = this.state.tasks.get(id);
        return dep && (dep.status === 'awaiting_merge' || dep.status === 'done');
      });
      if (depsDone) this.setStatus(task, 'ready', task.dependsOn.length ? `dependencies ready: ${task.dependsOn.join(', ')}` : 'plan approved');
    }
    // Parents follow their children.
    for (const parent of this.state.tasks.values()) {
      if (!parent.children.length || parent.status !== 'running') continue;
      const kids = parent.children.map((id) => this.state.tasks.get(id)!).filter(Boolean);
      if (kids.every((k) => k.status === 'done' || k.status === 'cancelled')) this.setStatus(parent, 'awaiting_merge', 'all subtasks finished');
    }
    for (const parent of this.state.tasks.values()) {
      if (!parent.children.length || parent.status !== 'awaiting_merge') continue;
      const kids = parent.children.map((id) => this.state.tasks.get(id)!).filter(Boolean);
      if (kids.every((k) => k.status === 'done' || k.status === 'cancelled')) this.setStatus(parent, 'done', 'all subtasks merged');
    }
  }

  private async planPending(): Promise<void> {
    for (const task of this.state.tasks.values()) {
      if (task.status !== 'clarifying' || this.busy.has(task.id) || this.runningFor(task.id)) continue;
      if ((this.retryAt.get(task.id) ?? 0) > this.now()) continue;
      if (this.live.size >= this.config.maxConcurrentRuns) return;
      await this.dispatch(task, 'plan');
    }
  }

  private async dispatchReady(): Promise<void> {
    const ready = [...this.state.tasks.values()]
      .filter((t) => t.status === 'ready' && !t.children.length && !this.busy.has(t.id) && (this.retryAt.get(t.id) ?? 0) <= this.now())
      .sort((a, b) => a.priority - b.priority || a.createdSeq - b.createdSeq);
    for (const task of ready) {
      if (this.live.size >= this.config.maxConcurrentRuns) return;
      // A task with a session continues in it on the same agent; otherwise the router picks.
      await this.dispatch(task, task.sessionRef ? this.nextTurn(task).mode : 'start');
    }
  }

  private async pollQuotas(): Promise<void> {
    if (this.now() - this.lastQuotaPoll < 5 * 60_000) return;
    this.lastQuotaPoll = this.now();
    for (const profile of this.deps.pool.profiles()) {
      if (profile.node !== 'local') continue;
      try {
        for (const q of await this.deps.pool.adapter(profile.name).quota()) this.recordQuota(profile.account, q);
      } catch (err) {
        this.log(`quota poll ${profile.name}: ${(err as Error).message}`);
      }
    }
  }

  private recordQuota(account: string, q: { window: string; status: 'allowed' | 'warning' | 'rejected'; utilization?: number; resetsAt?: number }): void {
    const prev = this.state.quotas.get(`${account}:${q.window}`);
    const same = prev && prev.status === q.status && prev.utilization === q.utilization && prev.resetsAt === q.resetsAt;
    if (same) return;
    this.append({
      type: 'quota.updated',
      payload: {
        account,
        window: q.window,
        status: q.status,
        ...(q.utilization !== undefined && { utilization: q.utilization }),
        ...(q.resetsAt !== undefined && { resetsAt: q.resetsAt }),
      },
    });
    const crossed = (q.utilization ?? 0) >= this.config.quotaSoftCeiling && (prev?.utilization ?? 0) < this.config.quotaSoftCeiling;
    if (q.status === 'rejected' && prev?.status !== 'rejected') {
      void this.deps.notifier.send(this.deps.notifier.owner(), { text: `⚠️ ${account}: ${q.window} limit reached. Runs on it pause until ${resetText(q.resetsAt)}.`, priority: 'urgent' });
    } else if (crossed) {
      void this.deps.notifier.send(this.deps.notifier.owner(), {
        text: `Quota warning: ${account} ${q.window} at ${Math.round((q.utilization ?? 0) * 100)}% (resets ${resetText(q.resetsAt)}). New runs on it wait.`,
      });
    }
  }

  private syncDevflow(): void {
    if (!this.devflowDirty) return;
    this.devflowDirty = false;
    for (const project of this.config.projects) {
      try {
        writeDevflowFiles(join(this.config.dataDir, 'devflow', project.id), this.state, project.id, this.config.agents);
      } catch (err) {
        this.log(`devflow sync ${project.id}: ${(err as Error).message}`);
      }
    }
  }

  // ================================================================ dispatch

  private runningFor(taskId: string): boolean {
    return [...this.state.runs.values()].some((r) => r.taskId === taskId && r.state === 'running');
  }

  /** Starts one run for a task. Returns false when no agent is available yet. */
  private async dispatch(task: TaskView, mode: RunMode, extra: { prompt?: string; author?: string } = {}): Promise<boolean> {
    const workflow = await this.workflow(this.project(task.projectId));
    const project = workflow.project;
    const continuing = CONTINUATION_MODES.includes(mode);

    // Continuations stay with the agent that owns the session; everything else is routed.
    let agent: string;
    if (continuing && task.agent) {
      agent = task.agent;
      const profile = this.deps.pool.profile(agent);
      const quota = profile ? accountQuota(this.state, profile.account, this.now()) : undefined;
      if (!profile?.enabled || quota?.blocked) return false;
    } else {
      const routed = route({
        task,
        mode,
        project,
        state: this.state,
        pool: this.deps.pool,
        config: this.config,
        now: this.now(),
        ...(extra.author && { author: extra.author }),
      });
      if ('wait' in routed) return false;
      if ('none' in routed) {
        if (mode === 'plan') {
          // No planner available: plan-less flow.
          this.setStatus(task, 'ready', `no planner: ${routed.none}`);
          return false;
        }
        if (mode === 'review') return false;
        if (!this.retryAt.has(`none:${task.id}`)) {
          this.retryAt.set(`none:${task.id}`, this.now());
          await this.notifyTask(task, { text: `${task.id} can't start: ${routed.none}. Enable an agent in Settings or with \`pnpm hyde setup\`.` });
        }
        return false;
      }
      agent = routed.agent;
    }
    const profile = this.deps.pool.profile(agent)!;
    const host = this.deps.host(profile.node);
    const readOnly = mode === 'plan' || mode === 'review';

    if (!readOnly && !task.worktree) {
      const branch = branchName(agent, 'feature', task.id, task.title);
      // A task that depends on unmerged work starts from that work's branch (stacked PRs).
      const dep = task.dependsOn.map((id) => this.state.tasks.get(id)).find((d) => d && d.status === 'awaiting_merge' && d.branch);
      const base = dep?.branch ?? project.baseBranch;
      const worktree = await host.createWorktree({
        repo: project.path,
        worktreesRoot: worktreesRoot(this.config.dataDir, project.id),
        taskId: task.id,
        branch,
        base,
      });
      this.append({
        type: 'task.workspace_assigned',
        taskId: task.id,
        payload: { taskId: task.id, agent, branch, worktree, baseBranch: project.baseBranch, node: profile.node },
      });
    }

    const turn = extra.prompt ? { mode, prompt: extra.prompt } : this.nextTurn(task, mode);
    const runId = nextId(this.state, 'run');
    const runDir = join(this.config.dataDir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    const token = randomBytes(24).toString('base64url');
    const adapter = this.deps.pool.adapter(agent);

    const packetFile = join(runDir, 'packet.md');
    if (!readOnly) {
      writeFileSync(
        packetFile,
        buildTaskPacket({
          task,
          agent,
          model: profile.model ?? 'default model',
          branch: task.branch!,
          baseBranch: task.baseBranch!,
          projectName: project.name ?? project.id,
          answers: [...this.state.questions.values()].filter((q) => q.taskId === task.id && q.status === 'answered'),
          lessons: readLessons(project.path),
          ...(workflow.template && {
            workflow: renderTemplate(workflow.template, {
              'task.title': task.title,
              'task.doneWhen': task.doneWhen ?? '',
              'project.name': project.name ?? project.id,
            }),
          }),
        }),
      );
    }

    const policy = compileProfile(DEFAULT_DEV_PROFILE);
    // Agents on a teammate's node reach the hub through its public (Tailscale) URL.
    const hubUrl = profile.node === 'local' ? this.deps.hubUrl : (this.config.nodes.publicUrl ?? this.deps.hubUrl);
    const cwd = readOnly ? (task.worktree ?? project.path) : task.worktree!;
    const spec: RunSpec = {
      cwd,
      runDir,
      prompt: turn.prompt,
      ...(!readOnly && { packetFile }),
      mcp: {
        command: profile.isolation === 'container' ? 'node' : process.execPath,
        args: ['--import', this.deps.tsxLoader, MCP_MAIN],
        env: { HYDE_HUB_URL: hubUrl, HYDE_RUN_TOKEN: token },
      },
      allow: policy.allow,
      deny: policy.deny,
      readOnly,
      ...(mode === 'plan' && { jsonSchema: PLAN_SCHEMA }),
      ...(mode === 'review' && { jsonSchema: REVIEW_SCHEMA }),
      ...(!readOnly && { writableDirs: [await host.gitCommonDir(project.path)] }),
      ...(this.config.policy.enabled && !readOnly && { policyHook: { url: `${hubUrl}/api/policy/pre-tool-use`, token } }),
      env: { ...HARNESS_ENV, HYDE_AGENT_NAME: agent, HYDE_TASK_ID: task.id },
      ...(profile.model && { model: profile.model }),
      ...(profile.effort && { effort: profile.effort }),
    };

    if (!readOnly && task.status !== 'running') this.setStatus(task, 'running', `${mode} turn on ${agent}`);
    if (mode === 'review' && task.status !== 'review') this.setStatus(task, 'review', `reviewing with ${agent}`);
    this.append({
      type: 'run.dispatched',
      taskId: task.id,
      runId,
      payload: {
        runId,
        taskId: task.id,
        attempt: task.attempts + (mode === 'start' ? 1 : 0),
        adapter: adapter.kind,
        account: profile.account,
        agent,
        node: profile.node,
        mode,
      },
    });

    let handle: RunHandle;
    try {
      handle =
        continuing && task.sessionRef ? await adapter.resume(runId, task.sessionRef, spec) : await adapter.start(runId, spec);
    } catch (err) {
      this.runEvent(runId, task.id, { type: 'run.failed', reason: 'crashed', detail: (err as Error).message });
      this.append({ type: 'run.exited', runId, taskId: task.id, payload: { runId, code: null, signal: null } });
      await this.afterRun(runId);
      return true;
    }
    this.live.set(runId, { handle, adapter, token, stalled: false, denials: 0 });
    this.tokens.set(token, runId);
    this.log(`${task.id}: dispatched ${runId} (${mode}) on ${agent}`);
    void this.consume(runId, task.id, handle, adapter, profile.account);
    return true;
  }

  /** Decides the next turn from the log, so it survives restarts. */
  private nextTurn(task: TaskView, forced?: RunMode): { mode: RunMode; prompt: string } {
    if (forced === 'plan') {
      const answers = [...this.state.questions.values()]
        .filter((q) => q.taskId === task.id && q.status === 'answered')
        .map((q) => ({ q: q.text, a: q.answer! }));
      return { mode: 'plan', prompt: plannerPrompt({ title: task.title, spec: task.spec, answers, client: task.kind === 'client' }) };
    }
    const lastRun = task.runIds.length ? this.state.runs.get(task.runIds.at(-1)!) : undefined;
    const since = lastRun?.dispatchedSeq ?? 0;
    if (task.sessionRef) {
      const answers = [...this.state.questions.values()].filter(
        (q) => q.taskId === task.id && q.status === 'answered' && (q.answeredSeq ?? 0) > since,
      );
      const decisions = [...this.state.approvals.values()].filter(
        (a) => a.taskId === task.id && a.status !== 'open' && (a.decidedSeq ?? 0) > since && a.kind !== 'first-push' && a.kind !== 'merge' && a.kind !== 'promote',
      );
      if (answers.length || decisions.length) {
        return {
          mode: 'answer',
          prompt:
            [
              ...answers.map((q) => `The owner answered ${q.id} ("${q.text}"): ${q.answer}`),
              ...decisions.map((a) => `The owner ${a.status} ${a.id} (${a.summary}).${a.status === 'approved' ? ' You may go ahead with it now.' : ' Do not do it; find another way or ask.'}`),
            ].join('\n') + '\nContinue the task.',
        };
      }
      if (task.checks && !task.checks.ok && task.checks.seq > since) {
        const failed = task.checks.results.filter((r) => !r.ok);
        return {
          mode: 'fix',
          prompt:
            'The harness ran the project checks after you reported done, and they failed:\n\n' +
            failed.map((r) => `$ ${r.command}\n${r.output.slice(-3000)}`).join('\n\n') +
            '\n\nFix the cause, verify, commit, and call complete_task again.',
        };
      }
      if (task.browser && !task.browser.ok && task.browser.seq > since) {
        return {
          mode: 'browser_fix',
          prompt:
            `The harness opened your change in a browser (${task.browser.url}) and found problems:\n` +
            task.browser.errors.map((e) => `- ${e}`).join('\n') +
            '\n\nFix them, verify, commit, and call complete_task again.',
        };
      }
      const review = task.reviews.at(-1);
      if (review && review.verdict === 'changes' && review.seq > since) {
        return { mode: 'review_fix', prompt: reviewFixPrompt(blockingFindings(review.findings), review.reviewer) };
      }
      return {
        mode: 'continue',
        prompt:
          'Continue the task. When it is done and verified, commit and call complete_task. ' +
          'If you are blocked on a decision, call ask_question.',
      };
    }
    return {
      mode: 'start',
      prompt: `Start task ${task.id}: ${task.title}\n\n${task.spec}\n\nFollow the task packet in your system prompt.`,
    };
  }

  private async consume(runId: string, taskId: string, handle: RunHandle, adapter: AgentAdapter, account: string): Promise<void> {
    try {
      for await (const event of adapter.events(handle)) {
        this.runEvent(runId, taskId, event);
        if (event.type === 'rate_limit') this.recordQuota(account, event);
      }
    } catch (err) {
      this.runEvent(runId, taskId, { type: 'run.failed', reason: 'crashed', detail: (err as Error).message });
    }
    const exit = await handle.exited;
    this.append({ type: 'run.exited', runId, taskId, payload: { runId, code: exit.code, signal: exit.signal } });
    await this.afterRun(runId);
  }

  private runEvent(runId: string, taskId: string, event: HarnessEvent): void {
    // Raw transcripts stay in the CLI's own session files; keep the log small.
    const stored = event.type === 'text.delta' ? { ...event, text: event.text.slice(0, 2000) } : event;
    this.append({ type: 'run.event', runId, taskId, payload: { runId, event: stored } });
  }

  // ================================================================ after a run

  private async afterRun(runId: string): Promise<void> {
    const live = this.live.get(runId);
    this.live.delete(runId);
    if (live) this.tokens.delete(live.token);
    const run = this.state.runs.get(runId)!;
    const task = this.state.tasks.get(run.taskId)!;
    if (run.mode === 'plan') return this.afterPlan(task, runId, live);
    if (run.mode === 'review') return this.afterReview(task, runId);
    if (task.status !== 'running') return; // cancelled or moved on while running

    const openBlocking = [...this.state.questions.values()].find((q) => q.runId === runId && q.blocking && q.status === 'open');
    if (openBlocking) {
      this.setStatus(task, 'blocked', `waiting for ${openBlocking.id}`, { kind: 'question', id: openBlocking.id });
      return;
    }
    const openApproval = [...this.state.approvals.values()].find(
      (a) => a.taskId === task.id && a.status === 'open' && ['new-dependency', 'scope-change', 'destructive'].includes(a.kind),
    );
    if (openApproval) {
      this.setStatus(task, 'blocked', `waiting for ${openApproval.id}`, { kind: 'approval', id: openApproval.id });
      return;
    }
    if (live?.breaker) {
      this.setStatus(task, 'blocked', 'circuit breaker', { kind: 'incident', id: live.breaker });
      return;
    }
    if (task.completion?.runId === runId) {
      this.setStatus(task, 'verifying', 'agent reported done');
      await this.verify(task.id);
      return;
    }

    const failure = live?.stalled ? { reason: 'stalled', detail: 'no events before the stall timeout' } : run.failure;
    if (failure?.reason === 'auth') {
      await this.fail(task, `${run.agent} is not signed in on this machine`, failure.detail ?? '');
      return;
    }
    if (failure?.reason === 'rate_limit') {
      this.setStatus(task, 'ready', 'rate limited; waiting for the window to reset');
      this.recordQuota(run.account, { window: 'five_hour', status: 'rejected', resetsAt: Math.floor(this.now() / 1000) + 3600 });
      return;
    }
    if (failure && failure.reason !== 'cancelled') {
      const failures = task.runIds.filter((id) => {
        const r = this.state.runs.get(id);
        return r && r.mode !== 'plan' && r.mode !== 'review' && (r.failure || id === runId);
      }).length;
      if (failures >= this.config.maxAttempts) {
        await this.fail(task, `${task.id} failed ${failures} times`, `${failure.reason}: ${failure.detail ?? ''}`);
        return;
      }
      this.retryAt.set(task.id, this.now() + retryDelayMs(failures));
      this.setStatus(task, 'ready', `retry after ${failure.reason}`);
      return;
    }
    if (failure?.reason === 'cancelled') {
      this.setStatus(task, 'ready', 'run interrupted');
      return;
    }

    // Clean exit without complete_task: nudge in the same session, up to the limit.
    const continuations = task.runIds.filter((id) => this.state.runs.get(id)?.mode === 'continue').length;
    if (continuations >= this.config.maxContinuations) {
      await this.fail(task, `${task.id} stopped without reporting done`, `after ${continuations} continuation prompts. Last message: ${run.summary ?? ''}`);
      return;
    }
    this.retryAt.set(task.id, this.now() + 1000);
    this.setStatus(task, 'ready', 'turn ended without complete_task');
  }

  // ---------------------------------------------------------------- planning

  private async afterPlan(task: TaskView, runId: string, live: LiveRun | undefined): Promise<void> {
    if (task.status !== 'clarifying') return;
    const run = this.state.runs.get(runId)!;
    const asked = [...this.state.questions.values()].find((q) => q.runId === runId && q.blocking && q.status === 'open');
    if (asked && run.structured === undefined) {
      this.setStatus(task, 'blocked', `planner waiting for ${asked.id}`, { kind: 'question', id: asked.id });
      return;
    }
    const planRuns = task.runIds.filter((id) => this.state.runs.get(id)?.mode === 'plan').length;
    if (run.failure || live?.stalled || run.structured === undefined) {
      if (planRuns >= 2) {
        this.setStatus(task, 'ready', 'planner failed twice; running the task as one unit');
        return;
      }
      this.retryAt.set(task.id, this.now() + retryDelayMs(planRuns));
      return;
    }
    const check = checkPlan(run.structured);
    if (check.errors.length) {
      if (planRuns >= 2) {
        this.setStatus(task, 'ready', `plan rejected (${check.errors[0]}); running the task as one unit`);
        return;
      }
      this.log(`${task.id}: plan rejected: ${check.errors.join('; ')}`);
      this.retryAt.set(task.id, this.now());
      return;
    }
    const { plan } = check;

    // Questions first (devflow rule 4: never assume).
    let firstBlocking: string | undefined;
    for (const q of plan.questions) {
      const questionId = nextId(this.state, 'Q');
      this.append({
        type: 'question.asked',
        taskId: task.id,
        runId,
        payload: { questionId, taskId: task.id, runId, text: q.text, blocking: q.blocking, options: q.options ?? [] },
      });
      await this.notifyQuestion(task, questionId, q.text, q.blocking, q.options ?? [], 'planner');
      if (q.blocking && !firstBlocking) firstBlocking = questionId;
    }
    if (firstBlocking) {
      // Planned again once every blocking question has an answer.
      this.setStatus(task, 'blocked', `planner waiting for ${firstBlocking}`, { kind: 'question', id: firstBlocking });
      return;
    }

    if (plan.tasks.length <= 1) {
      const only = plan.tasks[0];
      this.append({
        type: 'task.planned',
        taskId: task.id,
        payload: {
          taskId: task.id,
          runId,
          children: [],
          ...(only && { doneWhen: only.doneWhen, writeScope: only.writeScope, role: only.role, size: only.size }),
        },
      });
      this.setStatus(task, 'ready', 'planned as one task');
      return;
    }

    const ids = new Map<string, string>();
    for (const t of plan.tasks) ids.set(t.key, `T-${Number(nextId(this.state, 'T').slice(2)) + ids.size}`);
    for (const t of plan.tasks) {
      const childId = ids.get(t.key)!;
      this.append({
        type: 'task.created',
        taskId: childId,
        projectId: task.projectId,
        payload: {
          taskId: childId,
          projectId: task.projectId,
          title: t.title,
          spec: `${t.spec ?? t.title}\n\n(Part of ${task.id}: ${task.title})`,
          priority: task.priority,
          source: task.source,
          kind: task.kind,
          parentId: task.id,
          doneWhen: t.doneWhen,
          writeScope: t.writeScope,
          role: t.role,
          dependsOn: t.dependsOn.map((k) => ids.get(k)!),
          size: t.size,
          ...(task.pinnedAgent && { agent: task.pinnedAgent }),
        },
      });
    }
    this.append({ type: 'task.planned', taskId: task.id, payload: { taskId: task.id, runId, children: [...ids.values()] } });
    const summary = plan.tasks.map((t) => `${ids.get(t.key)} [${t.size}] ${t.title}${t.dependsOn.length ? ` (after ${t.dependsOn.map((k) => ids.get(k)).join(', ')})` : ''}`).join('\n');
    if (plan.tasks.length > this.config.planner.approvalOver || plan.tasks.some((t) => t.size === 'L')) {
      const approvalId = this.requestApproval(task, 'plan', `Plan for ${task.id}: ${plan.tasks.length} subtasks`);
      this.setStatus(task, 'blocked', `waiting for ${approvalId}`, { kind: 'approval', id: approvalId });
      await this.notifyTask(task, {
        text: `📋 Plan for ${task.id} (${task.title}):\n${summary}\n\n${approvalId}: run this plan?`,
        buttons: [
          [
            { label: 'Approve plan', action: { kind: 'decide', approvalId, approved: true } },
            { label: 'Cancel', action: { kind: 'decide', approvalId, approved: false } },
          ],
        ],
      });
      return;
    }
    this.setStatus(task, 'running', `planned into ${plan.tasks.length} subtasks`);
    await this.notifyTask(task, { text: `📋 ${task.id} split into:\n${summary}`, priority: 'digest' });
  }

  // ---------------------------------------------------------------- verify, browser, review

  /**
   * Verify stage: checks, browser, cross-vendor review, then a progress.md entry and the
   * first-push approval (or a direct push when the branch is already on the remote). Idempotent.
   */
  private async verify(taskId: string, opts: { fromReview?: boolean } = {}): Promise<void> {
    if (this.busy.has(taskId)) return;
    this.busy.add(taskId);
    try {
      const task = this.state.tasks.get(taskId)!;
      const workflow = await this.workflow(this.project(task.projectId));
      const project = workflow.project;
      const host = this.deps.host(task.node ?? 'local');
      const cwd = task.worktree!;
      const fixRounds = task.runIds.filter((id) => ['fix', 'browser_fix'].includes(this.state.runs.get(id)?.mode ?? '')).length;

      if (!opts.fromReview) {
        const results = [];
        for (const command of project.checks) results.push(await host.run(cwd, command, this.config.checkTimeoutMinutes * 60_000));
        const ok = results.every((r) => r.ok);
        this.append({ type: 'task.checks_finished', taskId, payload: { taskId, ok, results } });
        if (!ok) {
          if (fixRounds >= this.config.maxFixRounds) {
            await this.fail(task, `${task.id}: checks still failing after ${fixRounds} fix rounds`, summarizeChecks(results));
            return;
          }
          this.setStatus(task, 'ready', 'checks failed; sending them back to the agent');
          return;
        }

        if (this.config.browser.enabled && project.preview && (task.node ?? 'local') === 'local') {
          const outDir = join(this.config.dataDir, 'artifacts', task.id, `check-${Date.now()}`);
          const result = await this.browser({
            cwd,
            command: project.preview.command,
            url: project.preview.url,
            paths: project.preview.paths,
            outDir,
            video: this.config.browser.video,
          });
          const artifactIds = result.files.map((f) => {
            const artifactId = nextId(this.state, 'art');
            this.append({ type: 'artifact.saved', taskId, payload: { artifactId, taskId, kind: f.kind, path: f.path, label: f.label } });
            return artifactId;
          });
          this.append({ type: 'task.browser_checked', taskId, payload: { taskId, ok: result.ok, url: result.url, errors: result.errors, artifactIds } });
          if (!result.ok) {
            if (fixRounds >= this.config.maxFixRounds) {
              await this.fail(task, `${task.id}: browser check still failing after ${fixRounds} fix rounds`, result.errors.join('\n'));
              return;
            }
            this.setStatus(task, 'ready', 'browser check failed; sending it back to the agent');
            return;
          }
        }

        if (this.config.review.enabled) {
          const reviews = task.runIds.filter((id) => this.state.runs.get(id)?.mode === 'review').length;
          const last = task.reviews.at(-1);
          const reviewedThisRound = last && last.seq > (task.completion?.seq ?? 0);
          if (!reviewedThisRound && reviews < this.config.review.rounds) {
            const diff = await host.diff(cwd, task.baseBranch!);
            this.busy.delete(taskId);
            const started = await this.dispatch(task, 'review', {
              author: task.agent!,
              prompt: reviewPrompt({ title: task.title, spec: task.spec, ...(task.doneWhen && { doneWhen: task.doneWhen }), diff, client: task.kind === 'client' }),
            });
            if (started) return;
            this.busy.add(taskId);
            // No reviewer from another vendor: carry on without review.
          }
        }
      }

      await this.finishVerify(task, project, host);
    } catch (err) {
      const task = this.state.tasks.get(taskId)!;
      await this.fail(task, `${task.id}: verify stage error`, (err as Error).message);
    } finally {
      this.busy.delete(taskId);
    }
  }

  private async afterReview(task: TaskView, runId: string): Promise<void> {
    const run = this.state.runs.get(runId)!;
    if (task.status !== 'review') return;
    const review = parseReview(run.structured);
    if (!review) {
      this.log(`${task.id}: review ${runId} returned no usable verdict (${run.failure?.reason ?? 'unparseable'}); continuing without it`);
      this.setStatus(task, 'verifying', 'review unavailable');
      await this.verify(task.id, { fromReview: true });
      return;
    }
    this.append({
      type: 'task.review_finished',
      taskId: task.id,
      payload: { taskId: task.id, runId, reviewer: run.agent, verdict: review.verdict, summary: review.summary, findings: review.findings },
    });
    const blocking = blockingFindings(review.findings);
    const fixRounds = task.runIds.filter((id) => this.state.runs.get(id)?.mode === 'review_fix').length;
    if (review.verdict === 'changes' && blocking.length && fixRounds < this.config.review.rounds) {
      this.setStatus(task, 'ready', `review by ${run.agent}: ${blocking.length} finding(s)`);
      await this.notifyTask(task, { text: `🔎 ${task.id} review by ${run.agent}: ${blocking.length} finding(s); sent back to ${task.agent}.`, priority: 'digest' });
      return;
    }
    this.setStatus(task, 'verifying', `review by ${run.agent}: ${review.verdict}`);
    await this.verify(task.id, { fromReview: true });
  }

  private async finishVerify(task: TaskView, project: ProjectConfig, host: HostOps): Promise<void> {
    const cwd = task.worktree!;
    const c = task.completion!;
    const leftovers = await host.commitAll(cwd, `${task.id}: commit changes the agent left uncommitted`);

    // Approved lessons go into this branch's CLAUDE.md and AGENTS.md.
    const lessons = [...this.state.lessons.values()].filter(
      (l) => l.status === 'approved' && !l.writtenIn && (!l.taskId || this.state.tasks.get(l.taskId)?.projectId === task.projectId),
    );
    if (lessons.length) {
      const date = new Date(this.now()).toLocaleDateString('en-CA');
      const lines = lessons.map((l) => `- ${date}: ${l.text}`);
      const touched: string[] = [];
      for (const name of LESSON_FILES) {
        const next = withLessons(await host.readFile(join(cwd, name)), name, lines);
        if (next === null) continue;
        await host.writeFile(join(cwd, name), next);
        touched.push(name);
      }
      if (touched.length) {
        await host.commitAll(cwd, `${task.id}: lessons learned\n\nApproved by the owner: ${lessons.map((l) => l.id).join(', ')}.`);
        for (const l of lessons) this.append({ type: 'lesson.written', taskId: task.id, payload: { lessonId: l.id, taskId: task.id } });
      }
    }

    const files = await host.changedFiles(cwd, task.baseBranch!);
    const review = task.reviews.at(-1);
    const progress = await host.readFile(join(cwd, 'progress.md'));
    if (progress !== null && !hasProgressEntry(progress, task.id)) {
      await host.writeFile(join(cwd, 'progress.md'), withProgressEntry(progress, {
      date: new Date(this.now()).toLocaleDateString('en-CA'), // local YYYY-MM-DD
      title: `${task.id}: ${task.title}`,
      agent: task.agent!,
      model: this.lastModel(task) ?? 'unknown',
      branch: task.branch!,
      what: c.summary,
      why: `Requested via ${task.source.kind}${task.kind === 'client' ? ' (client message)' : ''}: ${task.spec.slice(0, 200)}`,
      files: files.filter((f) => f !== 'progress.md'),
      verified: [
        c.verified,
        ...(task.checks?.results ?? []).map((r) => `\`${r.command}\` passed`),
        ...(task.browser?.ok ? [`browser check of ${task.browser.url} passed`] : []),
        ...(review ? [`reviewed by ${review.reviewer}: ${review.verdict}`] : []),
      ].join('; '),
      followUps: [c.followUps, leftovers ? 'harness committed changes the agent left uncommitted' : '', review && review.verdict === 'changes' ? `open review findings: ${review.findings.map((f) => f.text).join('; ')}` : '']
        .filter(Boolean)
        .join('; '),
      }));
      await host.commitAll(cwd, `${task.id}: progress.md entry\n\nWritten by the Hyde Code harness from the agent's report.`);
    }

    if ((await host.commitsAhead(cwd, task.baseBranch!)) === 0) {
      await this.fail(task, `${task.id}: agent reported done but made no commits`, c.summary);
      return;
    }

    const images = task.browser?.artifactIds
      .map((id) => this.state.artifacts.get(id))
      .filter((a) => a && a.kind === 'screenshot')
      .map((a) => ({ path: a!.path, caption: `${task.id} ${a!.label ?? ''}` }));

    if (!(await host.hasRemote(project.path))) {
      this.setStatus(task, 'awaiting_merge', 'no remote; branch ready locally');
      await this.notifyTask(task, {
        text: `✅ ${task.id} done: ${task.title}\n\n${c.summary}\n\nVerified: ${c.verified}\nBranch ${task.branch} is ready locally at ${cwd}.\nThis repo has no "origin" remote, so no PR was opened.`,
        ...(images?.length && { images }),
      });
      return;
    }

    // The first push of a branch needs the owner's approval (devflow); later pushes don't.
    const pushedBefore = [...this.state.approvals.values()].some((a) => a.taskId === task.id && a.kind === 'first-push' && a.status === 'approved');
    if (pushedBefore || task.prUrl) {
      await this.pushAndOpenPr(task);
      return;
    }
    const approvalId = this.requestApproval(task, 'first-push', `Push ${task.branch} and open a PR into ${task.baseBranch}`);
    this.setStatus(task, 'blocked', `waiting for ${approvalId}`, { kind: 'approval', id: approvalId });
    await this.notifyTask(task, {
      text:
        `${task.id} is ready: ${task.title}\n\n${c.summary}\n\nVerified: ${c.verified}\n` +
        `Checks: ${task.checks?.results.length ? summarizeChecks(task.checks.results) : 'none configured'}\n` +
        (task.browser ? `Browser: ${task.browser.ok ? 'passed' : 'failed'} (${task.browser.url})\n` : '') +
        (review ? `Review (${review.reviewer}): ${review.verdict}. ${review.summary}\n` : '') +
        `Files: ${files.join(', ')}\n\n${approvalId}: push ${task.branch} and open a PR into ${task.baseBranch}?`,
      buttons: [
        [
          { label: 'Push & open PR', action: { kind: 'decide', approvalId, approved: true } },
          { label: 'Not now', action: { kind: 'decide', approvalId, approved: false } },
        ],
      ],
      ...(images?.length && { images }),
    });
  }

  private async pushAndOpenPr(task: TaskView): Promise<void> {
    const host = this.deps.host(task.node ?? 'local');
    const cwd = task.worktree!;
    const c = task.completion!;
    const review = task.reviews.at(-1);
    try {
      await host.pushBranch(cwd, task.branch!);
      const url = await host.openPullRequest(cwd, {
        base: task.baseBranch!,
        head: task.branch!,
        title: `${task.id}: ${task.title}`,
        body: [
          c.summary,
          '',
          `**Verified:** ${c.verified}`,
          task.doneWhen ? `**Done when:** ${task.doneWhen}` : '',
          task.checks?.results.length ? `**Checks:** ${summarizeChecks(task.checks.results)}` : '',
          task.browser ? `**Browser:** ${task.browser.ok ? 'passed' : 'failed'} at ${task.browser.url}` : '',
          review ? `**Review (${review.reviewer}):** ${review.verdict}. ${review.summary}${review.findings.length ? '\n' + review.findings.map((f) => `- [${f.severity}] ${f.file ?? ''} ${f.text}`).join('\n') : ''}` : '',
          `**Files:** ${c.filesChanged.join(', ') || 'see diff'}`,
          '',
          `Task ${task.id}, agent ${task.agent}. Opened by Hyde Code after the owner approved the push.`,
        ]
          .filter((l) => l !== '')
          .join('\n'),
      });
      if (task.prUrl !== url) this.append({ type: 'task.pr_opened', taskId: task.id, payload: { taskId: task.id, url } });
      if (task.status !== 'awaiting_merge') this.setStatus(task, 'awaiting_merge', 'PR ready');
      if (task.kind === 'client' && !task.clientReply) {
        this.append({ type: 'task.client_reply_drafted', taskId: task.id, payload: { taskId: task.id, draft: clientReplyDraft(task) } });
      }
      await this.notifyTask(task, {
        text:
          `✅ ${task.id} done: ${task.title}\nPR: ${url}` +
          (task.clientReply ? `\n\nDraft reply for the client (not sent):\n${task.clientReply}` : '') +
          '\n\nMerge into staging stays with you.',
        buttons: [[{ label: `Merge into ${task.baseBranch}`, action: { kind: 'merge', taskId: task.id } }]],
      });
    } catch (err) {
      if (task.status !== 'awaiting_merge' && canTransition(task.status, 'awaiting_merge')) this.setStatus(task, 'awaiting_merge', 'push or PR failed');
      await this.raiseIncident(task, `${task.id}: push or PR failed`, (err as Error).message);
    }
  }

  // ---------------------------------------------------------------- merge queue

  /** Merge queue (Gas Town's Refinery, without rebasing shared history): one merge per project at a time. */
  private async processMergeQueue(): Promise<void> {
    for (const taskId of [...this.mergeQueue]) {
      const task = this.state.tasks.get(taskId);
      if (!task || task.status !== 'awaiting_merge') {
        this.mergeQueue.splice(this.mergeQueue.indexOf(taskId), 1);
        continue;
      }
      if (this.merging.has(task.projectId)) continue;
      this.mergeQueue.splice(this.mergeQueue.indexOf(taskId), 1);
      this.merging.add(task.projectId);
      void this.mergeTask(task).finally(() => this.merging.delete(task.projectId));
    }
  }

  private async mergeTask(task: TaskView): Promise<void> {
    const project = (await this.workflow(this.project(task.projectId))).project;
    const host = this.deps.host(task.node ?? 'local');
    const cwd = task.worktree!;
    try {
      const sync = await host.syncWithBase(cwd, task.baseBranch!);
      if (!sync.ok) {
        // Conflicts go back to the author in its own session (awaiting_merge → running).
        await this.dispatchConflict(task, sync.conflicts);
        return;
      }
      const results = [];
      for (const command of project.checks) results.push(await host.run(cwd, command, this.config.checkTimeoutMinutes * 60_000));
      if (!results.every((r) => r.ok)) {
        this.append({ type: 'task.checks_finished', taskId: task.id, payload: { taskId: task.id, ok: false, results } });
        this.setStatus(task, 'ready', `checks fail on top of the latest ${task.baseBranch}`);
        return;
      }
      await host.pushBranch(cwd, task.branch!);
      const sha = await host.mergePullRequest(cwd, task.branch!, this.config.merge.method);
      this.append({ type: 'task.merged', taskId: task.id, payload: { taskId: task.id, into: task.baseBranch!, ...(sha && { sha }) } });
      this.setStatus(task, 'done', `merged into ${task.baseBranch}`);
      if (this.config.merge.deleteWorktree) {
        await host.removeWorktree(project.path, cwd).catch((err: Error) => this.log(`${task.id}: worktree kept: ${err.message}`));
      }
      await this.notifyTask(task, { text: `🎉 ${task.id} merged into ${task.baseBranch}${sha ? ` (${sha.slice(0, 7)})` : ''}. Use /promote #${project.id} to release ${task.baseBranch} into ${project.releaseBranch}.` });
    } catch (err) {
      await this.raiseIncident(task, `${task.id}: merge failed`, (err as Error).message);
    }
  }

  private async dispatchConflict(task: TaskView, conflicts: string[]): Promise<void> {
    const started = conflicts.length
      ? await this.dispatch(task, 'conflict', {
          prompt:
            `The harness merged the latest ${task.baseBranch} into your branch and it conflicts in:\n${conflicts.map((f) => `- ${f}`).join('\n')}\n\n` +
            `The merge is in progress. Resolve the conflict markers keeping both sides' intent, verify, then \`git add\` the files and \`git commit\` to conclude the merge, and call complete_task.`,
        })
      : false;
    if (!started) {
      await this.deps.host(task.node ?? 'local').abortMerge(task.worktree!);
      const incidentId = await this.raiseIncident(task, `${task.id}: merge with ${task.baseBranch} failed`, `Conflicts in ${conflicts.join(', ') || 'unknown files'}; ${task.agent} can't take it now. /retry ${task.id} later.`);
      this.setStatus(task, 'blocked', 'merge conflict', { kind: 'incident', id: incidentId });
    }
  }

  // ================================================================ commands (chat, CLI, dashboard)

  async handle(inbound: Inbound): Promise<string> {
    const { command } = inbound;
    const actor: Actor = { kind: 'user', id: inbound.userId };
    switch (command.kind) {
      case 'help':
        return HELP_TEXT;
      case 'projects':
        return this.config.projects.map((p) => `#${p.id}: ${p.path} (base ${p.baseBranch}, release ${p.releaseBranch})`).join('\n');
      case 'new':
      case 'client':
        return this.createTask(inbound, command.kind === 'client' ? 'client' : 'task', command.text, command.project, command.kind === 'new' ? command.agent : undefined);
      case 'status':
        return this.statusText();
      case 'agents':
        return this.agentsText();
      case 'usage':
        return this.usageText();
      case 'logs':
        return this.logsText(command.taskId);
      case 'stop': {
        const targets =
          command.target === 'all'
            ? [...this.state.tasks.values()].filter((t) => !TERMINAL_STATUSES.includes(t.status) && t.status !== 'awaiting_merge')
            : [this.state.tasks.get(command.target)].filter((t): t is TaskView => Boolean(t));
        if (!targets.length) return command.target === 'all' ? 'Nothing to stop.' : `No task ${command.target}.`;
        for (const task of targets) {
          for (const [runId, live] of this.live) {
            if (this.state.runs.get(runId)?.taskId === task.id) await live.adapter.interrupt(live.handle);
          }
          if (canTransition(task.status, 'cancelled')) this.setStatus(task, 'cancelled', `stopped by ${inbound.userId}`);
        }
        return `Stopped ${targets.map((t) => t.id).join(', ')}. Worktrees and branches are kept.`;
      }
      case 'retry': {
        const task = this.state.tasks.get(command.taskId);
        if (!task) return `No task ${command.taskId}.`;
        if (task.status !== 'failed' && !(task.status === 'blocked' && task.blockedBy?.kind === 'incident')) return `${task.id} is ${task.status}, not failed.`;
        this.retryAt.delete(task.id);
        this.setStatus(task, 'ready', `retry requested by ${inbound.userId}`);
        void this.tick();
        return `${task.id} will run again.`;
      }
      case 'answer':
        return this.answer(command.questionId, command.text, inbound, actor);
      case 'decide':
        return this.decideApproval(command.approvalId, command.approved, inbound, actor);
      case 'lesson': {
        const lesson = this.state.lessons.get(command.lessonId);
        if (!lesson) return `No lesson ${command.lessonId}.`;
        if (lesson.status !== 'proposed') return `${lesson.id} was already ${lesson.status}.`;
        this.deps.store.append({ type: 'lesson.decided', actor, commandId: inbound.commandId, payload: { lessonId: lesson.id, approved: command.approved, by: inbound.userId } });
        return command.approved ? `${lesson.id} approved; it goes into CLAUDE.md and AGENTS.md with the next PR.` : `${lesson.id} rejected.`;
      }
      case 'merge': {
        const task = this.state.tasks.get(command.taskId);
        if (!task) return `No task ${command.taskId}.`;
        if (task.status !== 'awaiting_merge' || !task.prUrl) return `${task.id} has no PR waiting to merge (status ${task.status}).`;
        if (this.mergeQueue.includes(task.id)) return `${task.id} is already in the merge queue.`;
        this.mergeQueue.push(task.id);
        void this.tick();
        return `${task.id} queued: syncing with ${task.baseBranch}, re-running checks, then merging the PR.`;
      }
      case 'promote':
        return this.promote(command.project, inbound);
    }
  }

  private createTask(inbound: Inbound, kind: 'task' | 'client', text: string, projectTag?: string, agent?: string): string {
    const projects = this.config.projects;
    const project = projectTag ? projects.find((p) => p.id === projectTag) : projects.length === 1 ? projects[0] : undefined;
    if (!project) {
      return projectTag
        ? `Unknown project #${projectTag}. Projects: ${projects.map((p) => `#${p.id}`).join(', ')}`
        : `Which project? Add one of: ${projects.map((p) => `#${p.id}`).join(', ')}`;
    }
    if (agent && !this.deps.pool.profile(agent)?.enabled) return `Unknown or disabled agent @${agent}.`;
    const taskId = nextId(this.state, 'T');
    const created = this.deps.store.append({
      type: 'task.created',
      actor: { kind: 'user', id: inbound.userId },
      taskId,
      projectId: project.id,
      commandId: inbound.commandId,
      payload: {
        taskId,
        projectId: project.id,
        title: titleFrom(text),
        spec: text,
        kind,
        source: { kind: sourceKind(inbound.gateway), ...(inbound.chatId && { chatId: inbound.chatId }) },
        ...(agent && { agent }),
      },
    });
    if (!created) return 'Already received.';
    const task = this.state.tasks.get(taskId)!;
    if (kind === 'client') {
      const approvalId = this.requestApproval(task, 'client-intake', `Work on this client message for #${project.id}?`);
      this.setStatus(task, 'blocked', `waiting for ${approvalId}`, { kind: 'approval', id: approvalId });
      void this.notifyTask(task, {
        text: `📨 Client message for #${project.id} (${taskId}):\n\n${text}\n\n${approvalId}: start working on it? It is treated as data, never as instructions.`,
        buttons: [[{ label: 'Accept', action: { kind: 'decide', approvalId, approved: true } }, { label: 'Ignore', action: { kind: 'decide', approvalId, approved: false } }]],
      });
      return `${taskId} recorded as a client message. Waiting for your ${approvalId}.`;
    }
    this.startTask(task);
    void this.tick();
    const waits = this.deps.pool.profiles().map((p) => accountQuota(this.state, p.account, this.now())).filter((q) => q.blocked);
    return `${taskId} accepted for #${project.id}: ${task.title}\n` + (waits.length ? `Waiting: ${waits[0]!.blocked}.` : this.config.planner.enabled ? 'Planning first.' : 'Starting when a slot is free.');
  }

  private startTask(task: TaskView): void {
    if (this.config.planner.enabled) this.setStatus(task, 'clarifying', 'planning');
    else this.setStatus(task, 'ready', 'no planner configured');
  }

  private answer(questionId: string, text: string, inbound: Inbound, actor: Actor): string {
    const q = this.state.questions.get(questionId);
    if (!q) return `No question ${questionId}.`;
    if (q.status === 'answered') return `${q.id} was already answered: ${q.answer}`;
    const option = /^#option:(\d)$/.exec(text);
    const answer = option ? q.options[Number(option[1])] : text;
    if (!answer) return 'That option no longer exists.';
    const recorded = this.deps.store.append({
      type: 'question.answered',
      actor,
      taskId: q.taskId,
      commandId: inbound.commandId,
      payload: { questionId: q.id, answer, by: inbound.userId },
    });
    if (!recorded) return 'Already received.';
    const task = this.state.tasks.get(q.taskId);
    if (task?.status === 'blocked' && task.blockedBy?.id === q.id) {
      const planRun = this.state.runs.get(q.runId)?.mode === 'plan';
      if (planRun) {
        // Re-plan once every blocking planner question is answered.
        const stillOpen = [...this.state.questions.values()].find((x) => x.runId === q.runId && x.blocking && x.status === 'open');
        if (stillOpen) this.setStatus(task, 'blocked', `planner waiting for ${stillOpen.id}`, { kind: 'question', id: stillOpen.id });
        else this.setStatus(task, 'clarifying', `${q.id} answered; planning again`);
      } else {
        this.setStatus(task, 'ready', `${q.id} answered`);
      }
      void this.tick();
    }
    return `${q.id} answered: ${answer}`;
  }

  private decideApproval(approvalId: string, approved: boolean, inbound: Inbound, actor: Actor): string {
    const a = this.state.approvals.get(approvalId);
    if (!a) return `No approval ${approvalId}.`;
    if (a.status !== 'open') return `${a.id} was already ${a.status}.`;
    const recorded = this.deps.store.append({
      type: 'approval.decided',
      actor,
      taskId: a.taskId,
      commandId: inbound.commandId,
      payload: { approvalId: a.id, approved, by: inbound.userId },
    });
    if (!recorded) return 'Already received.';
    const task = this.state.tasks.get(a.taskId)!;
    switch (a.kind) {
      case 'first-push':
        if (!approved) {
          this.setStatus(task, 'awaiting_merge', `${a.id} denied; branch stays local`);
          return `${a.id} denied. ${task.branch} stays local at ${task.worktree}.`;
        }
        void this.pushAndOpenPr(task);
        return `${a.id} approved. Pushing ${task.branch} and opening the PR…`;
      case 'plan':
        if (!approved) {
          for (const id of task.children) {
            const child = this.state.tasks.get(id);
            if (child && canTransition(child.status, 'cancelled')) this.setStatus(child, 'cancelled', `${a.id} denied`);
          }
          this.setStatus(task, 'cancelled', `${a.id} denied`);
          return `${a.id} denied; ${task.id} and its subtasks are cancelled.`;
        }
        this.setStatus(task, 'running', `${a.id} approved`);
        void this.tick();
        return `${a.id} approved. Starting ${task.children.join(', ')}.`;
      case 'client-intake':
        if (!approved) {
          this.setStatus(task, 'cancelled', 'client message ignored');
          return `${task.id} ignored.`;
        }
        this.setStatus(task, this.config.planner.enabled ? 'clarifying' : 'ready', 'client message accepted');
        void this.tick();
        return `${task.id} accepted. ${this.config.planner.enabled ? 'Planning first.' : 'Starting when a slot is free.'}`;
      case 'promote':
        if (!approved) return `${a.id} denied; nothing was released.`;
        void this.finishPromote(a.data ?? {}, task);
        return `${a.id} approved. Merging the release PR…`;
      default:
        // new-dependency, scope-change, destructive: the agent is resumed with the decision.
        if (task.status === 'blocked' && task.blockedBy?.id === a.id) {
          this.setStatus(task, 'ready', `${a.id} ${approved ? 'approved' : 'denied'}`);
          void this.tick();
        }
        return `${a.id} ${approved ? 'approved' : 'denied'}.`;
    }
  }

  /** `/promote`: a PR from the base branch into the release branch, merged only after an explicit approval. */
  private async promote(projectTag: string | undefined, inbound: Inbound): Promise<string> {
    const projects = this.config.projects;
    const project = projectTag ? projects.find((p) => p.id === projectTag) : projects.length === 1 ? projects[0] : undefined;
    if (!project) return `Which project? ${projects.map((p) => `#${p.id}`).join(', ')}`;
    const host = this.deps.host('local');
    if (!(await host.hasRemote(project.path))) return `#${project.id} has no remote.`;
    let url: string;
    try {
      url = await host.openPullRequest(project.path, {
        base: project.releaseBranch,
        head: project.baseBranch,
        title: `Release ${project.baseBranch} → ${project.releaseBranch}`,
        body: `Promotes everything merged into ${project.baseBranch}. Opened by Hyde Code; merged only after the owner confirms.`,
      });
    } catch (err) {
      return `Could not open the release PR: ${(err as Error).message}`;
    }
    // Approvals hang off a task; a release gets its own bookkeeping task.
    const taskId = nextId(this.state, 'T');
    this.deps.store.append({
      type: 'task.created',
      actor: { kind: 'user', id: inbound.userId },
      taskId,
      projectId: project.id,
      commandId: inbound.commandId,
      payload: {
        taskId,
        projectId: project.id,
        title: `Release ${project.baseBranch} → ${project.releaseBranch}`,
        spec: url,
        source: { kind: sourceKind(inbound.gateway), ...(inbound.chatId && { chatId: inbound.chatId }) },
      },
    });
    const task = this.state.tasks.get(taskId)!;
    this.append({ type: 'task.pr_opened', taskId, payload: { taskId, url } });
    const approvalId = this.requestApproval(task, 'promote', `Merge ${project.baseBranch} into ${project.releaseBranch}`, { url, project: project.id });
    this.setStatus(task, 'blocked', `waiting for ${approvalId}`, { kind: 'approval', id: approvalId });
    void this.notifyTask(task, {
      text: `🚀 Release PR for #${project.id}: ${url}\n${approvalId}: merge ${project.baseBranch} into ${project.releaseBranch}? This is the production step.`,
      buttons: [[{ label: `Merge into ${project.releaseBranch}`, action: { kind: 'decide', approvalId, approved: true } }, { label: 'Not now', action: { kind: 'decide', approvalId, approved: false } }]],
    });
    return `Release PR opened: ${url}\nConfirm with ${approvalId}.`;
  }

  private async finishPromote(data: Record<string, unknown>, task: TaskView): Promise<void> {
    const project = this.project(String(data.project ?? task.projectId));
    try {
      const sha = await this.deps.host('local').mergePullRequest(project.path, project.baseBranch, this.config.merge.method);
      this.append({ type: 'task.merged', taskId: task.id, payload: { taskId: task.id, into: project.releaseBranch, ...(sha && { sha }) } });
      this.setStatus(task, 'awaiting_merge', 'release merged');
      this.setStatus(task, 'done', `released into ${project.releaseBranch}`);
      await this.notifyTask(task, { text: `🚀 ${project.baseBranch} merged into ${project.releaseBranch}${sha ? ` (${sha.slice(0, 7)})` : ''}.` });
    } catch (err) {
      await this.raiseIncident(task, `Release of #${project.id} failed`, (err as Error).message);
    }
  }

  // ---------------------------------------------------------------- text views

  statusText(): string {
    const active = [...this.state.tasks.values()].filter((t) => !TERMINAL_STATUSES.includes(t.status));
    const lines = active.length ? [] : ['No active tasks.'];
    for (const t of active) {
      const run = t.runIds.length ? this.state.runs.get(t.runIds.at(-1)!) : undefined;
      const doing = run?.state === 'running' ? ` · ${run.agent}${run.lastAction ? `: ${run.lastAction}` : ''}` : '';
      const why = t.blockedBy ? ` (${t.blockedBy.kind} ${t.blockedBy.id})` : '';
      lines.push(`${t.id} [${t.status}${why}] ${t.title}${doing}${t.prUrl ? `\n   PR: ${t.prUrl}` : ''}`);
    }
    for (const q of [...this.state.questions.values()].filter((q) => q.status === 'open')) lines.push(`${q.id} (${q.taskId}) waiting for you: ${q.text}`);
    for (const a of [...this.state.approvals.values()].filter((a) => a.status === 'open')) lines.push(`${a.id} (${a.taskId}) waiting for you: ${a.summary}`);
    for (const l of [...this.state.lessons.values()].filter((l) => l.status === 'proposed')) lines.push(`${l.id} lesson proposed: ${l.text}`);
    const quota = this.usageText();
    if (quota !== 'No quota data yet.') lines.push(quota);
    return lines.join('\n');
  }

  agentsText(): string {
    const lines: string[] = [];
    for (const p of this.config.agents) {
      const h = this.deps.pool.health.get(p.name);
      const running = [...this.state.runs.values()].filter((r) => r.agent === p.name && r.state === 'running');
      const q = accountQuota(this.state, p.account, this.now());
      const state = !p.enabled ? 'disabled' : h && (!h.installed || !h.signedIn) ? `unavailable: ${h.problem ?? 'not signed in'}` : running.length ? `working on ${running.map((r) => r.taskId).join(', ')}` : 'idle';
      lines.push(`${p.name} · ${p.adapter} (${this.deps.pool.vendor(p.name)})${p.model ? ` · ${p.model}` : ''} · ${state} · quota ${Math.round(q.max * 100)}%`);
    }
    return lines.join('\n');
  }

  usageText(): string {
    const quotas = [...this.state.quotas.values()];
    if (!quotas.length) return 'No quota data yet.';
    return quotas
      .map((q) => `${q.account} ${q.window}: ${q.utilization !== undefined ? `${Math.round(q.utilization * 100)}%` : q.status}${q.resetsAt ? `, resets ${resetText(q.resetsAt)}` : ''}`)
      .join('\n');
  }

  logsText(taskId: string): string {
    const task = this.state.tasks.get(taskId);
    if (!task) return `No task ${taskId}.`;
    const events = this.deps.store.list({ taskId }).slice(-15);
    return [
      `${task.id} [${task.status}] ${task.title}`,
      ...events.map((e) => {
        const p = e.payload as { event?: HarnessEvent; to?: string; reason?: string };
        const detail = e.type === 'run.event' && p.event ? describe(p.event) : e.type === 'task.status_changed' ? `→ ${p.to}${p.reason ? `: ${p.reason}` : ''}` : '';
        return `${e.ts.slice(11, 19)} ${e.type}${detail ? ` ${detail}` : ''}`;
      }),
    ].join('\n');
  }

  // ================================================================ agent tool calls (MCP → HTTP)

  runForToken(token: string): string | undefined {
    return this.tokens.get(token);
  }

  async agentCall(runId: string, tool: string, args: Record<string, unknown>): Promise<string> {
    const run = this.state.runs.get(runId)!;
    const task = this.state.tasks.get(run.taskId)!;
    const actor: Actor = { kind: 'agent', id: run.agent };
    const readOnly = run.mode === 'plan' || run.mode === 'review';
    switch (tool) {
      case 'ask_question': {
        const questionId = nextId(this.state, 'Q');
        const blocking = args.blocking !== false;
        const options = Array.isArray(args.options) ? (args.options as string[]).slice(0, 4) : [];
        const assumption = typeof args.assumption === 'string' ? args.assumption : '';
        const text = String(args.question);
        this.deps.store.append({
          type: 'question.asked',
          actor,
          taskId: task.id,
          runId,
          payload: { questionId, taskId: task.id, runId, text, blocking, options },
        });
        await this.notifyQuestion(task, questionId, text + (assumption ? `\n\nMeanwhile assuming: ${assumption}` : ''), blocking, options, run.agent);
        return blocking
          ? `Recorded as ${questionId} and sent to the owner. End your turn now; you will be resumed in this session with the answer.`
          : `Recorded as ${questionId}. Continue with your stated assumption; it will be reviewed.`;
      }
      case 'report_progress': {
        const message = String(args.message);
        this.deps.store.append({ type: 'agent.progress', actor, taskId: task.id, runId, payload: { taskId: task.id, runId, message } });
        await this.notifyTask(task, { text: `${task.id} · ${run.agent}: ${message}`, priority: 'digest' });
        return 'Sent.';
      }
      case 'complete_task': {
        if (readOnly) return 'Planner and reviewer runs return their JSON answer instead.';
        this.deps.store.append({
          type: 'task.agent_completed',
          actor,
          taskId: task.id,
          runId,
          payload: {
            taskId: task.id,
            runId,
            summary: String(args.summary),
            verified: String(args.verified),
            filesChanged: Array.isArray(args.filesChanged) ? args.filesChanged.map(String) : [],
            ...(typeof args.followUps === 'string' && args.followUps && { followUps: args.followUps }),
          },
        });
        return 'Recorded. End your turn now; the harness will run the checks and ask the owner to approve the push.';
      }
      case 'request_approval': {
        const kind = String(args.kind) as ApprovalKind;
        if (!['new-dependency', 'scope-change', 'destructive'].includes(kind)) throw new Error('kind must be new-dependency, scope-change or destructive');
        const summary = String(args.summary);
        const approvalId = this.requestApproval(task, kind, summary, typeof args.command === 'string' ? { command: args.command } : undefined);
        await this.notifyApproval(task, approvalId, `${run.agent} asks (${kind}): ${summary}${args.command ? `\n$ ${args.command}` : ''}`);
        return `Recorded as ${approvalId} and sent to the owner. End your turn now; you will be resumed with the decision.`;
      }
      case 'propose_lesson': {
        const lessonId = nextId(this.state, 'L');
        const text = String(args.text).replace(/\s+/g, ' ').trim();
        this.deps.store.append({ type: 'lesson.proposed', actor, taskId: task.id, payload: { lessonId, taskId: task.id, text, by: run.agent } });
        await this.notifyTask(task, {
          text: `💡 ${lessonId} lesson proposed by ${run.agent}: ${text}`,
          buttons: [[{ label: 'Keep it', action: { kind: 'lesson', lessonId, approved: true } }, { label: 'Discard', action: { kind: 'lesson', lessonId, approved: false } }]],
        });
        return `Recorded as ${lessonId}; the owner decides whether it goes into CLAUDE.md and AGENTS.md.`;
      }
      default:
        throw new Error(`Unknown tool ${tool}`);
    }
  }

  /** Claude's PreToolUse hook. Returns the hook response body. */
  policyCheck(runId: string, body: Record<string, unknown>): Record<string, unknown> {
    const run = this.state.runs.get(runId)!;
    const task = this.state.tasks.get(run.taskId)!;
    const live = this.live.get(runId);
    const tool = String(body.tool_name ?? '');
    const input = (body.tool_input ?? {}) as Record<string, unknown>;
    const approvedCommands = [...this.state.approvals.values()]
      .filter((a) => a.taskId === task.id && a.status === 'approved' && typeof a.data?.command === 'string')
      .map((a) => String(a.data!.command));
    const decision = decidePolicy({
      tool,
      input,
      cwd: task.worktree ?? '',
      writeScope: task.writeScope,
      approvalRequired: this.config.policy.approvalRequired,
      approvedCommands,
    });
    if (decision.decision !== 'allow' || ['Bash', 'Edit', 'Write'].includes(tool)) {
      this.append({
        type: 'policy.decided',
        taskId: task.id,
        runId,
        payload: { runId, tool, input: JSON.stringify(input).slice(0, 500), decision: decision.decision, rule: decision.rule },
      });
    }
    if (decision.decision === 'approval') {
      const already = [...this.state.approvals.values()].find((a) => a.taskId === task.id && a.status === 'open' && a.data?.command === input.command);
      if (!already) {
        const approvalId = this.requestApproval(task, decision.rule, decision.reason, { command: String(input.command ?? '') });
        void this.notifyApproval(task, approvalId, `${run.agent} wants to run (${decision.rule}):\n$ ${String(input.command ?? '')}`);
      }
    }
    if (decision.decision === 'deny' && live) {
      live.denials += 1;
      if (live.denials >= this.config.policy.circuitBreaker && !live.breaker) {
        const incidentId = nextId(this.state, 'R');
        live.breaker = incidentId;
        this.append({ type: 'incident.raised', taskId: task.id, payload: { incidentId, taskId: task.id, about: `${run.agent} hit the circuit breaker`, evidence: `${live.denials} denied actions in ${runId}; last: ${decision.rule}` } });
        void this.notifyTask(task, { text: `⚠️ ${incidentId}: ${run.agent} was paused after ${live.denials} denied actions on ${task.id}. /retry ${task.id} to let it continue.`, priority: 'urgent' });
        void live.adapter.interrupt(live.handle);
      }
    }
    return hookResponse(decision);
  }

  // ================================================================ helpers

  private append<T extends EventType>(input: Omit<AppendInput<T>, 'actor'> & { actor?: Actor }): void {
    this.deps.store.append({ actor: HARNESS, ...input } as AppendInput<T>);
  }

  private requestApproval(task: TaskView, kind: ApprovalKind, summary: string, data?: Record<string, unknown>): string {
    const approvalId = nextId(this.state, 'A');
    this.append({ type: 'approval.requested', taskId: task.id, payload: { approvalId, taskId: task.id, kind, summary, ...(data && { data }) } });
    return approvalId;
  }

  private setStatus(
    task: TaskView,
    to: TaskStatus,
    reason: string,
    blockedBy?: { kind: 'question' | 'approval' | 'incident' | 'quota'; id: string },
  ): void {
    if (task.status === to && !blockedBy) return;
    if (!canTransition(task.status, to) && task.status !== to) throw new Error(`${task.id}: illegal transition ${task.status} → ${to}`);
    this.append({
      type: 'task.status_changed',
      taskId: task.id,
      payload: { taskId: task.id, from: task.status, to, reason, ...(blockedBy && { blockedBy }) },
    });
  }

  private async fail(task: TaskView, about: string, evidence: string): Promise<void> {
    if (canTransition(task.status, 'failed')) this.setStatus(task, 'failed', about);
    await this.raiseIncident(task, about, evidence);
  }

  private async raiseIncident(task: TaskView, about: string, evidence: string): Promise<string> {
    const incidentId = nextId(this.state, 'R');
    this.append({ type: 'incident.raised', taskId: task.id, payload: { incidentId, taskId: task.id, about, evidence } });
    await this.notifyTask(task, { text: `⚠️ ${incidentId}: ${about}\n\n${evidence.slice(0, 1500)}`, priority: 'urgent' });
    return incidentId;
  }

  private async notifyQuestion(task: TaskView, questionId: string, text: string, blocking: boolean, options: string[], from: string): Promise<void> {
    await this.notifyTask(task, {
      text:
        `❓ ${questionId} from ${from} on ${task.id} (${task.title})${blocking ? '' : ', not blocking'}:\n\n${text}` +
        `\n\nTap an answer, reply to this message, or send /answer ${questionId} <text>.`,
      questionId,
      ...(options.length && {
        buttons: options.map((label, option) => [{ label, action: { kind: 'answer' as const, questionId, option } }]),
      }),
    });
  }

  private async notifyApproval(task: TaskView, approvalId: string, text: string): Promise<void> {
    await this.notifyTask(task, {
      text: `🔐 ${approvalId} on ${task.id}: ${text}`,
      buttons: [[{ label: 'Approve', action: { kind: 'decide', approvalId, approved: true } }, { label: 'Deny', action: { kind: 'decide', approvalId, approved: false } }]],
    });
  }

  private async notifyTask(task: TaskView, message: OutboundMessage): Promise<void> {
    try {
      await this.deps.notifier.send(this.deps.notifier.target(task.source), message);
    } catch (err) {
      this.log(`notify failed for ${task.id}: ${(err as Error).message}`);
    }
  }

  project(id: string): ProjectConfig {
    const project = this.config.projects.find((p) => p.id === id);
    if (!project) throw new Error(`Project ${id} is no longer configured`);
    return project;
  }

  private lastModel(task: TaskView): string | undefined {
    for (const id of [...task.runIds].reverse()) {
      const run = this.state.runs.get(id);
      if (run?.model && run.mode !== 'review' && run.mode !== 'plan') return run.model;
    }
    return undefined;
  }
}

function titleFrom(text: string): string {
  const first = text.split('\n')[0]!.trim();
  return first.length > 72 ? `${first.slice(0, 69)}...` : first;
}

function summarizeChecks(results: { command: string; ok: boolean }[]): string {
  return results.map((r) => `${r.ok ? '✓' : '✗'} ${r.command}`).join(', ');
}

function sourceKind(gateway: string): SourceKind {
  const known: SourceKind[] = ['telegram', 'slack', 'discord', 'whatsapp', 'web', 'cli', 'api', 'schedule'];
  return (known as string[]).includes(gateway) ? (gateway as SourceKind) : 'api';
}

function resetText(resetsAt?: number): string {
  if (!resetsAt) return 'later';
  return new Date(resetsAt * 1000).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', weekday: 'short' });
}

function describe(e: HarnessEvent): string {
  switch (e.type) {
    case 'tool.started':
      return `${e.tool}: ${e.summary}`;
    case 'text.delta':
      return e.text.replaceAll('\n', ' ').slice(0, 120);
    case 'run.failed':
      return `${e.reason}${e.detail ? `: ${e.detail.slice(0, 120)}` : ''}`;
    case 'run.started':
      return e.model;
    default:
      return e.type;
  }
}

/** A short client reply the owner can edit and send. Never sent automatically. */
export function clientReplyDraft(task: TaskView): string {
  return [
    'Hi! A quick update on your request:',
    '',
    `"${task.spec.split('\n')[0]!.slice(0, 200)}"`,
    '',
    `Done: ${task.completion?.summary.split('\n')[0] ?? task.title}`,
    task.browser?.ok ? 'We checked it in the browser and attached screenshots.' : '',
    'It is in review now and will go live after the final check. Let me know if you want anything changed.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
