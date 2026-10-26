import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  apply,
  canTransition,
  nextId,
  replay,
  retryDelayMs,
  TERMINAL_STATUSES,
  type Actor,
  type AgentAdapter,
  type AppendInput,
  type EventStore,
  type EventType,
  type HarnessEvent,
  type HarnessState,
  type Inbound,
  type OutboundMessage,
  type RunHandle,
  type RunSpec,
  type TaskStatus,
  type TaskView,
} from '@hyde/core';
import { addProgressEntry, buildTaskPacket, HARNESS_ENV, readLessons } from '@hyde/devflow';
import { HELP_TEXT } from '@hyde/gateway-telegram';
import { MCP_MAIN } from '@hyde/mcp-harness';
import { compileProfile, DEFAULT_DEV_PROFILE } from '@hyde/policy';
import {
  branchName,
  changedFiles,
  commitAll,
  commitsAhead,
  createWorktree,
  hasRemote,
  pushBranch,
} from '@hyde/workspace';
import type { HubConfig, ProjectConfig } from './config.ts';

const exec = promisify(execFile);
const HARNESS: Actor = { kind: 'harness', id: 'hub' };

export interface OrchestratorDeps {
  config: HubConfig;
  store: EventStore;
  adapter: AgentAdapter;
  /** Delivers a message to a chat; tasks without a chat only log. */
  notify: (chatId: string | undefined, message: OutboundMessage) => Promise<void>;
  /** Opens a PR and returns its URL. Defaults to `gh pr create`. */
  openPullRequest?: (cwd: string, pr: { base: string; head: string; title: string; body: string }) => Promise<string>;
  /** URL the agents' MCP server uses to reach the hub API. */
  hubUrl: string;
  log?: (msg: string) => void;
  now?: () => number;
}

interface LiveRun {
  handle: RunHandle;
  token: string;
  stalled: boolean;
}

/**
 * The only writer of task state (Symphony's single authority). A deterministic tick loop
 * reconciles running work and dispatches ready tasks; models only decide content.
 */
export class Orchestrator {
  readonly state: HarnessState;
  private readonly live = new Map<string, LiveRun>();
  private readonly tokens = new Map<string, string>(); // run token → run id
  private readonly retryAt = new Map<string, number>(); // task id → earliest next dispatch
  private readonly busy = new Set<string>(); // tasks with post-run work in flight
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private readonly openPullRequest: NonNullable<OrchestratorDeps['openPullRequest']>;

  constructor(private readonly deps: OrchestratorDeps) {
    this.state = replay(deps.store.list());
    deps.store.subscribe((record) => apply(this.state, record));
    this.log = deps.log ?? ((m) => console.log(m));
    this.now = deps.now ?? Date.now;
    this.openPullRequest = deps.openPullRequest ?? ghPullRequest;
  }

  /** Recovers from a restart: runs that were live have no process any more. */
  recover(): void {
    for (const run of this.state.runs.values()) {
      if (run.state !== 'running') continue;
      this.append({ type: 'run.exited', runId: run.id, taskId: run.taskId, payload: { runId: run.id, code: null, signal: 'hub-restart' } });
      const task = this.state.tasks.get(run.taskId);
      if (task?.status === 'running') this.setStatus(task, 'ready', 'hub restarted during the run');
    }
    for (const task of this.state.tasks.values()) {
      // Post-run steps are idempotent, so a task caught mid-verify simply runs them again.
      if (task.status === 'verifying') void this.verify(task.id);
    }
  }

  start(intervalMs = 3000): void {
    this.recover();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const run of this.live.values()) await this.deps.adapter.interrupt(run.handle);
  }

  // ---------------------------------------------------------------- tick loop

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.reconcile();
      await this.dispatchReady();
    } catch (err) {
      this.log(`tick error: ${(err as Error).stack ?? err}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Interrupts runs with no events for the stall timeout; the run's exit handler retries them. */
  private reconcile(): void {
    const limit = this.deps.config.stallTimeoutMinutes * 60_000;
    for (const [runId, live] of this.live) {
      const run = this.state.runs.get(runId);
      if (!run || live.stalled) continue;
      if (this.now() - Date.parse(run.lastEventTs) > limit) {
        live.stalled = true;
        this.log(`${run.taskId}: ${runId} stalled, interrupting`);
        void this.deps.adapter.interrupt(live.handle);
      }
    }
  }

  private async dispatchReady(): Promise<void> {
    const ready = [...this.state.tasks.values()]
      .filter((t) => t.status === 'ready' && !this.busy.has(t.id) && (this.retryAt.get(t.id) ?? 0) <= this.now())
      .sort((a, b) => a.priority - b.priority || a.createdSeq - b.createdSeq);
    for (const task of ready) {
      if (this.live.size >= this.deps.config.maxConcurrentRuns) return;
      const blocked = this.quotaBlock();
      if (blocked) return;
      await this.dispatch(task);
    }
  }

  /** A reason not to start runs on the (single, Phase 0) account, or null. */
  quotaBlock(): string | null {
    for (const q of this.state.quotas.values()) {
      const resetMs = q.resetsAt ? q.resetsAt * 1000 : 0;
      if (resetMs && resetMs < this.now()) continue; // window already reset
      if (q.status === 'rejected') return `${q.window} limit reached`;
      if ((q.utilization ?? 0) >= this.deps.config.quotaSoftCeiling) {
        return `${q.window} at ${Math.round((q.utilization ?? 0) * 100)}% (soft ceiling ${Math.round(this.deps.config.quotaSoftCeiling * 100)}%)`;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- dispatch

  private async dispatch(task: TaskView): Promise<void> {
    const project = this.project(task.projectId);
    const { config } = this.deps;
    const agent = config.agent.name;

    if (!task.worktree) {
      const branch = branchName(agent, 'feature', task.id, task.title);
      const worktree = await createWorktree({
        repo: project.path,
        worktreesRoot: join(config.dataDir, 'worktrees', project.id),
        taskId: task.id,
        branch,
        base: project.baseBranch,
      });
      this.append({
        type: 'task.workspace_assigned',
        taskId: task.id,
        payload: { taskId: task.id, agent, branch, worktree, baseBranch: project.baseBranch },
      });
    }

    const { mode, prompt } = this.nextTurn(task);
    const runId = nextId(this.state, 'run');
    const runDir = join(config.dataDir, 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    const token = randomBytes(24).toString('base64url');
    const packetFile = join(runDir, 'packet.md');
    writeFileSync(
      packetFile,
      buildTaskPacket({
        task,
        agent,
        model: config.agent.model ?? 'default model',
        branch: task.branch!,
        baseBranch: task.baseBranch!,
        projectName: project.name ?? project.id,
        answers: [...this.state.questions.values()].filter((q) => q.taskId === task.id && q.status === 'answered'),
        lessons: readLessons(project.path),
      }),
    );
    const mcpConfigFile = join(runDir, 'mcp.json');
    writeFileSync(
      mcpConfigFile,
      JSON.stringify({
        mcpServers: {
          hyde: {
            command: process.execPath,
            args: ['--import', import.meta.resolve('tsx/esm'), MCP_MAIN],
            env: { HYDE_HUB_URL: this.deps.hubUrl, HYDE_RUN_TOKEN: token },
          },
        },
      }),
      { mode: 0o600 },
    );

    const profile = compileProfile(DEFAULT_DEV_PROFILE);
    const spec: RunSpec = {
      cwd: task.worktree!,
      prompt,
      packetFile,
      mcpConfigFile,
      allow: profile.allow,
      deny: profile.deny,
      env: { ...HARNESS_ENV, HYDE_AGENT_NAME: agent, HYDE_TASK_ID: task.id },
      ...(config.agent.model && { model: config.agent.model }),
    };

    this.setStatus(task, 'running', `${mode} turn`);
    this.append({
      type: 'run.dispatched',
      taskId: task.id,
      runId,
      payload: { runId, taskId: task.id, attempt: task.attempts + (mode === 'start' ? 1 : 0), adapter: this.deps.adapter.kind, account: 'default', mode },
    });

    let handle: RunHandle;
    try {
      handle =
        mode === 'start' || !task.sessionRef
          ? await this.deps.adapter.start(runId, spec)
          : await this.deps.adapter.resume(runId, task.sessionRef, spec);
    } catch (err) {
      this.runEvent(runId, task.id, { type: 'run.failed', reason: 'crashed', detail: (err as Error).message });
      this.append({ type: 'run.exited', runId, taskId: task.id, payload: { runId, code: null, signal: null } });
      await this.afterRun(runId);
      return;
    }
    this.live.set(runId, { handle, token, stalled: false });
    this.tokens.set(token, runId);
    this.log(`${task.id}: dispatched ${runId} (${mode})`);
    void this.consume(runId, task.id, handle);
  }

  /** Decides the next turn from the log, so it survives restarts. */
  private nextTurn(task: TaskView): { mode: 'start' | 'continue' | 'answer' | 'fix'; prompt: string } {
    const lastRun = task.runIds.length ? this.state.runs.get(task.runIds.at(-1)!) : undefined;
    const since = lastRun?.dispatchedSeq ?? 0;
    if (task.sessionRef) {
      const answers = [...this.state.questions.values()].filter(
        (q) => q.taskId === task.id && q.status === 'answered' && (q.answeredSeq ?? 0) > since,
      );
      if (answers.length) {
        return {
          mode: 'answer',
          prompt: answers.map((q) => `The owner answered ${q.id} ("${q.text}"): ${q.answer}`).join('\n') + '\nContinue the task.',
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

  private async consume(runId: string, taskId: string, handle: RunHandle): Promise<void> {
    try {
      for await (const event of this.deps.adapter.events(handle)) {
        this.runEvent(runId, taskId, event);
        if (event.type === 'rate_limit') {
          this.append({
            type: 'quota.updated',
            payload: {
              account: 'default',
              window: event.window,
              status: event.status,
              ...(event.utilization !== undefined && { utilization: event.utilization }),
              ...(event.resetsAt !== undefined && { resetsAt: event.resetsAt }),
            },
          });
        }
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

  // ---------------------------------------------------------------- after a run

  private async afterRun(runId: string): Promise<void> {
    const live = this.live.get(runId);
    this.live.delete(runId);
    if (live) this.tokens.delete(live.token);
    const run = this.state.runs.get(runId)!;
    const task = this.state.tasks.get(run.taskId)!;
    if (task.status !== 'running') return; // cancelled or moved on while running

    const openBlocking = [...this.state.questions.values()].find(
      (q) => q.runId === runId && q.blocking && q.status === 'open',
    );
    if (openBlocking) {
      this.setStatus(task, 'blocked', `waiting for ${openBlocking.id}`, { kind: 'question', id: openBlocking.id });
      return;
    }
    if (task.completion?.runId === runId) {
      this.setStatus(task, 'verifying', 'agent reported done');
      await this.verify(task.id);
      return;
    }

    const failure = live?.stalled ? { reason: 'stalled', detail: 'no events before the stall timeout' } : run.failure;
    if (failure?.reason === 'auth') {
      await this.fail(task, 'Claude Code is not signed in on this machine', failure.detail ?? '');
      return;
    }
    if (failure?.reason === 'rate_limit') {
      this.setStatus(task, 'ready', 'rate limited; waiting for the window to reset');
      await this.notifyTask(task, { text: `${task.id} paused: usage limit reached. It resumes after the window resets.` });
      return;
    }
    if (failure && failure.reason !== 'cancelled') {
      const failures = task.runIds.filter((id) => this.state.runs.get(id)?.failure || id === runId).length;
      if (failures >= this.deps.config.maxAttempts) {
        await this.fail(task, `${task.id} failed ${failures} times`, `${failure.reason}: ${failure.detail ?? ''}`);
        return;
      }
      this.retryAt.set(task.id, this.now() + retryDelayMs(failures));
      this.setStatus(task, 'ready', `retry after ${failure.reason}`);
      return;
    }

    // Clean exit without complete_task: nudge in the same session, up to the limit.
    const continuations = task.runIds.filter((id) => this.state.runs.get(id)?.mode === 'continue').length;
    if (continuations >= this.deps.config.maxContinuations) {
      await this.fail(task, `${task.id} stopped without reporting done`, `after ${continuations} continuation prompts`);
      return;
    }
    this.retryAt.set(task.id, this.now() + 1000);
    this.setStatus(task, 'ready', 'turn ended without complete_task');
  }

  /** Verify stage: checks, then a progress.md entry, then the first-push approval. Idempotent. */
  private async verify(taskId: string): Promise<void> {
    if (this.busy.has(taskId)) return;
    this.busy.add(taskId);
    try {
      const task = this.state.tasks.get(taskId)!;
      const project = this.project(task.projectId);
      const cwd = task.worktree!;
      const results = [];
      for (const command of project.checks) results.push(await this.runCheck(cwd, command));
      const ok = results.every((r) => r.ok);
      this.append({ type: 'task.checks_finished', taskId, payload: { taskId, ok, results } });

      if (!ok) {
        const fixRounds = task.runIds.filter((id) => this.state.runs.get(id)?.mode === 'fix').length;
        if (fixRounds >= this.deps.config.maxFixRounds) {
          await this.fail(task, `${task.id}: checks still failing after ${fixRounds} fix rounds`, summarizeChecks(results));
          return;
        }
        this.setStatus(task, 'ready', 'checks failed; sending them back to the agent');
        return;
      }

      const c = task.completion!;
      const leftovers = await commitAll(cwd, `${task.id}: commit changes the agent left uncommitted`);
      const files = await changedFiles(cwd, task.baseBranch!);
      if (!hasProgressEntry(cwd, task.id) && addProgressEntry(cwd, {
        date: new Date(this.now()).toLocaleDateString('en-CA'), // local YYYY-MM-DD
        title: `${task.id}: ${task.title}`,
        agent: task.agent!,
        model: this.lastModel(task) ?? 'unknown',
        branch: task.branch!,
        what: c.summary,
        why: `Requested via ${task.source.kind}: ${task.spec.slice(0, 200)}`,
        files: files.filter((f) => f !== 'progress.md'),
        verified: [c.verified, ...results.map((r) => `\`${r.command}\` passed`)].join('; '),
        followUps: leftovers ? 'harness committed changes the agent left uncommitted' : '',
      })) {
        await commitAll(cwd, `${task.id}: progress.md entry\n\nWritten by the Hyde Code harness from the agent's report.`);
      }

      if ((await commitsAhead(cwd, task.baseBranch!)) === 0) {
        await this.fail(task, `${task.id}: agent reported done but made no commits`, c.summary);
        return;
      }

      if (!(await hasRemote(project.path))) {
        this.setStatus(task, 'awaiting_merge', 'no remote; branch ready locally');
        await this.notifyTask(task, {
          text:
            `✅ ${task.id} done: ${task.title}\n\n${c.summary}\n\nVerified: ${c.verified}\n` +
            `Branch ${task.branch} is ready locally at ${cwd}.\nThis repo has no "origin" remote, so no PR was opened.`,
        });
        return;
      }

      const approvalId = nextId(this.state, 'A');
      this.append({
        type: 'approval.requested',
        taskId,
        payload: { approvalId, taskId, kind: 'first-push', summary: `Push ${task.branch} and open a PR into ${task.baseBranch}` },
      });
      this.setStatus(task, 'blocked', `waiting for ${approvalId}`, { kind: 'approval', id: approvalId });
      await this.notifyTask(task, {
        text:
          `${task.id} is ready for review: ${task.title}\n\n${c.summary}\n\nVerified: ${c.verified}\n` +
          `Checks: ${results.length ? summarizeChecks(results) : 'none configured'}\nFiles: ${files.join(', ')}\n\n` +
          `${approvalId}: push ${task.branch} and open a PR into ${task.baseBranch}?`,
        buttons: [
          [
            { label: 'Push & open PR', action: { kind: 'decide', approvalId, approved: true } },
            { label: 'Not now', action: { kind: 'decide', approvalId, approved: false } },
          ],
        ],
      });
    } catch (err) {
      const task = this.state.tasks.get(taskId)!;
      await this.fail(task, `${task.id}: verify stage error`, (err as Error).message);
    } finally {
      this.busy.delete(taskId);
    }
  }

  private async runCheck(cwd: string, command: string): Promise<{ command: string; ok: boolean; output: string }> {
    try {
      const { stdout, stderr } = await exec('sh', ['-c', command], {
        cwd,
        timeout: this.deps.config.checkTimeoutMinutes * 60_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      return { command, ok: true, output: (stdout + stderr).slice(-4000) };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      return { command, ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message}`.slice(-4000) };
    }
  }

  private async pushAndOpenPr(task: TaskView): Promise<void> {
    const cwd = task.worktree!;
    const c = task.completion!;
    try {
      await pushBranch(cwd, task.branch!);
      const url = await this.openPullRequest(cwd, {
        base: task.baseBranch!,
        head: task.branch!,
        title: `${task.id}: ${task.title}`,
        body:
          `${c.summary}\n\n**Verified:** ${c.verified}\n\n**Files:** ${c.filesChanged.join(', ') || 'see diff'}\n\n` +
          `Task ${task.id}, agent ${task.agent}. Opened by Hyde Code after the owner approved the push.`,
      });
      this.append({ type: 'task.pr_opened', taskId: task.id, payload: { taskId: task.id, url } });
      this.setStatus(task, 'awaiting_merge', 'PR opened');
      await this.notifyTask(task, { text: `✅ ${task.id} done: ${task.title}\nPR: ${url}\n\nMerging stays with you.` });
    } catch (err) {
      this.setStatus(task, 'awaiting_merge', 'push or PR failed');
      await this.raiseIncident(task, `${task.id}: push or PR failed`, (err as Error).message);
    }
  }

  // ---------------------------------------------------------------- commands from chat / CLI

  async handle(inbound: Inbound): Promise<string> {
    const { command } = inbound;
    const actor: Actor = { kind: 'user', id: inbound.userId };
    switch (command.kind) {
      case 'help':
        return HELP_TEXT;
      case 'projects':
        return this.deps.config.projects.map((p) => `#${p.id}: ${p.path} (base ${p.baseBranch})`).join('\n');
      case 'new': {
        const projects = this.deps.config.projects;
        const project = command.project ? projects.find((p) => p.id === command.project) : projects.length === 1 ? projects[0] : undefined;
        if (!project) {
          return command.project
            ? `Unknown project #${command.project}. Projects: ${projects.map((p) => `#${p.id}`).join(', ')}`
            : `Which project? Add one of: ${projects.map((p) => `#${p.id}`).join(', ')}`;
        }
        const taskId = nextId(this.state, 'T');
        const created = this.deps.store.append({
          type: 'task.created',
          actor,
          taskId,
          projectId: project.id,
          commandId: inbound.commandId,
          payload: {
            taskId,
            projectId: project.id,
            title: titleFrom(command.text),
            spec: command.text,
            source: { kind: inbound.userId.startsWith('tg:') ? 'telegram' : 'cli', chatId: inbound.chatId },
          },
        });
        if (!created) return 'Already received.';
        this.setStatus(this.state.tasks.get(taskId)!, 'ready', 'Phase 0: no planner; straight to ready');
        void this.tick();
        const wait = this.quotaBlock();
        return `${taskId} accepted for #${project.id}: ${titleFrom(command.text)}\n` + (wait ? `Waiting: ${wait}.` : 'Starting when a slot is free.');
      }
      case 'status':
        return this.statusText();
      case 'stop': {
        const targets =
          command.target === 'all'
            ? [...this.state.tasks.values()].filter((t) => !TERMINAL_STATUSES.includes(t.status) && t.status !== 'awaiting_merge')
            : [this.state.tasks.get(command.target)].filter((t): t is TaskView => Boolean(t));
        if (!targets.length) return command.target === 'all' ? 'Nothing to stop.' : `No task ${command.target}.`;
        for (const task of targets) {
          for (const [runId, live] of this.live) {
            if (this.state.runs.get(runId)?.taskId === task.id) await this.deps.adapter.interrupt(live.handle);
          }
          if (canTransition(task.status, 'cancelled')) this.setStatus(task, 'cancelled', `stopped by ${inbound.userId}`);
        }
        return `Stopped ${targets.map((t) => t.id).join(', ')}. Worktrees and branches are kept.`;
      }
      case 'answer': {
        const q = this.state.questions.get(command.questionId);
        if (!q) return `No question ${command.questionId}.`;
        if (q.status === 'answered') return `${q.id} was already answered: ${q.answer}`;
        const option = /^#option:(\d)$/.exec(command.text);
        const answer = option ? q.options[Number(option[1])] : command.text;
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
          this.setStatus(task, 'ready', `${q.id} answered`);
          void this.tick();
        }
        return `${q.id} answered: ${answer}`;
      }
      case 'decide': {
        const a = this.state.approvals.get(command.approvalId);
        if (!a) return `No approval ${command.approvalId}.`;
        if (a.status !== 'open') return `${a.id} was already ${a.status}.`;
        const recorded = this.deps.store.append({
          type: 'approval.decided',
          actor,
          taskId: a.taskId,
          commandId: inbound.commandId,
          payload: { approvalId: a.id, approved: command.approved, by: inbound.userId },
        });
        if (!recorded) return 'Already received.';
        const task = this.state.tasks.get(a.taskId)!;
        if (!command.approved) {
          this.setStatus(task, 'awaiting_merge', `${a.id} denied; branch stays local`);
          return `${a.id} denied. ${task.branch} stays local at ${task.worktree}.`;
        }
        if (a.kind === 'first-push') void this.pushAndOpenPr(task);
        return `${a.id} approved. Pushing ${task.branch} and opening the PR…`;
      }
    }
  }

  statusText(): string {
    const active = [...this.state.tasks.values()].filter((t) => !TERMINAL_STATUSES.includes(t.status));
    const lines = active.length ? [] : ['No active tasks.'];
    for (const t of active) {
      const run = t.runIds.length ? this.state.runs.get(t.runIds.at(-1)!) : undefined;
      const doing = t.status === 'running' && run?.lastAction ? ` · ${run.lastAction}` : '';
      const why = t.blockedBy ? ` (${t.blockedBy.kind} ${t.blockedBy.id})` : '';
      lines.push(`${t.id} [${t.status}${why}] ${t.title}${doing}${t.prUrl ? `\n   PR: ${t.prUrl}` : ''}`);
    }
    const open = [...this.state.questions.values()].filter((q) => q.status === 'open');
    for (const q of open) lines.push(`${q.id} (${q.taskId}) waiting for you: ${q.text}`);
    const quota = [...this.state.quotas.values()]
      .map((q) => `${q.window} ${q.utilization !== undefined ? `${Math.round(q.utilization * 100)}%` : q.status}`)
      .join(', ');
    if (quota) lines.push(`Quota: ${quota}`);
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- agent tool calls (MCP → HTTP)

  runForToken(token: string): string | undefined {
    return this.tokens.get(token);
  }

  async agentCall(runId: string, tool: string, args: Record<string, unknown>): Promise<string> {
    const run = this.state.runs.get(runId)!;
    const task = this.state.tasks.get(run.taskId)!;
    const actor: Actor = { kind: 'agent', id: task.agent ?? 'agent' };
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
        await this.notifyTask(task, {
          text:
            `❓ ${questionId} from ${task.agent} on ${task.id} (${task.title})${blocking ? '' : ', not blocking'}:\n\n${text}` +
            (assumption ? `\n\nMeanwhile assuming: ${assumption}` : '') +
            `\n\nTap an answer, reply to this message, or send /answer ${questionId} <text>.`,
          questionId,
          ...(options.length && {
            buttons: options.map((label, option) => [{ label, action: { kind: 'answer' as const, questionId, option } }]),
          }),
        });
        return blocking
          ? `Recorded as ${questionId} and sent to the owner. End your turn now; you will be resumed in this session with the answer.`
          : `Recorded as ${questionId}. Continue with your stated assumption; it will be reviewed.`;
      }
      case 'report_progress': {
        const message = String(args.message);
        this.deps.store.append({ type: 'agent.progress', actor, taskId: task.id, runId, payload: { taskId: task.id, runId, message } });
        await this.notifyTask(task, { text: `${task.id} · ${message}` });
        return 'Sent.';
      }
      case 'complete_task': {
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
          },
        });
        return 'Recorded. End your turn now; the harness will run the checks and ask the owner to approve the push.';
      }
      default:
        throw new Error(`Unknown tool ${tool}`);
    }
  }

  // ---------------------------------------------------------------- helpers

  private append<T extends EventType>(input: Omit<AppendInput<T>, 'actor'> & { actor?: Actor }): void {
    this.deps.store.append({ actor: HARNESS, ...input } as AppendInput<T>);
  }

  private setStatus(
    task: TaskView,
    to: TaskStatus,
    reason: string,
    blockedBy?: { kind: 'question' | 'approval' | 'incident' | 'quota'; id: string },
  ): void {
    if (task.status === to && !blockedBy) return;
    if (!canTransition(task.status, to)) throw new Error(`${task.id}: illegal transition ${task.status} → ${to}`);
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

  private async raiseIncident(task: TaskView, about: string, evidence: string): Promise<void> {
    const incidentId = nextId(this.state, 'R');
    this.append({ type: 'incident.raised', taskId: task.id, payload: { incidentId, taskId: task.id, about, evidence } });
    await this.notifyTask(task, { text: `⚠️ ${incidentId}: ${about}\n\n${evidence.slice(0, 1500)}` });
  }

  private async notifyTask(task: TaskView, message: OutboundMessage): Promise<void> {
    try {
      await this.deps.notify(task.source.chatId, message);
    } catch (err) {
      this.log(`notify failed for ${task.id}: ${(err as Error).message}`);
    }
  }

  private project(id: string): ProjectConfig {
    const project = this.deps.config.projects.find((p) => p.id === id);
    if (!project) throw new Error(`Project ${id} is no longer configured`);
    return project;
  }

  private lastModel(task: TaskView): string | undefined {
    for (const id of [...task.runIds].reverse()) {
      const model = this.state.runs.get(id)?.model;
      if (model) return model;
    }
    return undefined;
  }
}

/** True when the worktree's progress.md already has this task's entry (verify may run twice). */
function hasProgressEntry(cwd: string, taskId: string): boolean {
  const path = join(cwd, 'progress.md');
  return existsSync(path) && new RegExp(`^### \\d{4}-\\d{2}-\\d{2}: ${taskId}:`, 'm').test(readFileSync(path, 'utf8'));
}

function titleFrom(text: string): string {
  const first = text.split('\n')[0]!.trim();
  return first.length > 72 ? `${first.slice(0, 69)}...` : first;
}

function summarizeChecks(results: { command: string; ok: boolean }[]): string {
  return results.map((r) => `${r.ok ? '✓' : '✗'} ${r.command}`).join(', ');
}

async function ghPullRequest(cwd: string, pr: { base: string; head: string; title: string; body: string }): Promise<string> {
  const { stdout } = await exec('gh', ['pr', 'create', '--base', pr.base, '--head', pr.head, '--title', pr.title, '--body', pr.body], { cwd });
  return stdout.trim().split('\n').at(-1)!;
}
