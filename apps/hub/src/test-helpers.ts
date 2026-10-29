// Shared fixtures for hub tests: scripted adapters, temp git repos with a bare remote, and a
// harness wired like main.ts but without real CLIs, chat or GitHub.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EventStore,
  Registry,
  type AgentAdapter,
  type ChatGateway,
  type HarnessEvent,
  type Inbound,
  type OutboundMessage,
  type RunHandle,
  type RunSpec,
  type Vendor,
} from '@hyde/core';
import { git } from '@hyde/workspace';
import { AgentPool, type AdapterFactory } from './agents.ts';
import type { BrowserCheckInput, BrowserCheckResult } from './browser.ts';
import { parseConfig, type HubConfig, type RawConfig } from './config.ts';
import { LocalHost } from '@hyde/workspace';
import { Notifier } from './notifier.ts';
import { Orchestrator } from './orchestrator.ts';

export type Turn = (ctx: { runId: string; spec: RunSpec; resumed: boolean; o: Orchestrator }) => Promise<HarnessEvent[]>;

/** An adapter that plays scripted turns instead of launching a CLI. */
export class ScriptedAdapter implements AgentAdapter {
  readonly kind = 'claude-code' as const;
  readonly structuredOutput = true;
  readonly calls: { runId: string; prompt: string; resumed: boolean; spec: RunSpec }[] = [];
  private readonly pending = new Map<string, { spec: RunSpec; resumed: boolean; resolve: (v: { code: number; signal: null }) => void }>();
  orchestrator!: Orchestrator;

  constructor(
    readonly vendor: Vendor,
    private readonly turns: Turn[],
  ) {}
  detect() {
    return Promise.resolve({ installed: true, signedIn: true });
  }
  start(runId: string, spec: RunSpec) {
    return Promise.resolve(this.handle(runId, spec, false));
  }
  resume(runId: string, _session: string, spec: RunSpec) {
    return Promise.resolve(this.handle(runId, spec, true));
  }
  send() {
    return Promise.resolve();
  }
  interrupt() {
    return Promise.resolve();
  }
  quota() {
    return Promise.resolve([]);
  }
  async *events(h: RunHandle): AsyncIterable<HarnessEvent> {
    const p = this.pending.get(h.runId)!;
    try {
      const turn = this.turns.shift();
      if (!turn) throw new Error('no scripted turn left');
      yield { type: 'run.started', sessionRef: `sess-${h.runId}`, model: `${this.vendor}-model` };
      for (const e of await turn({ runId: h.runId, spec: p.spec, resumed: p.resumed, o: this.orchestrator })) yield e;
    } finally {
      p.resolve({ code: 0, signal: null });
    }
  }
  private handle(runId: string, spec: RunSpec, resumed: boolean): RunHandle {
    this.calls.push({ runId, prompt: spec.prompt, resumed, spec });
    let resolve!: (v: { code: number; signal: null }) => void;
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => (resolve = r));
    this.pending.set(runId, { spec, resumed, resolve });
    return { runId, pid: 1, exited };
  }
}

/** LocalHost without GitHub: "PRs" are recorded, "merges" push the branch into the base on the bare remote. */
export class TestHost extends LocalHost {
  readonly prs: { base: string; head: string; title: string; body: string }[] = [];
  override async openPullRequest(_cwd: string, pr: { base: string; head: string; title: string; body: string }): Promise<string> {
    this.prs.push(pr);
    return `https://github.test/pr/${this.prs.length}`;
  }
  override async mergePullRequest(cwd: string, branch: string): Promise<string | undefined> {
    const pr = this.prs.find((p) => p.head === branch);
    await git(cwd, ['push', 'origin', `${branch}:refs/heads/${pr?.base ?? 'staging'}`]);
    return git(cwd, ['rev-parse', 'HEAD']);
  }
}

export class FakeGateway implements ChatGateway {
  readonly name = 'telegram';
  readonly sent: { chatId: string; message: OutboundMessage }[] = [];
  async start() {}
  async send(chatId: string, message: OutboundMessage) {
    this.sent.push({ chatId, message });
  }
  async stop() {}
}

export interface Harness {
  o: Orchestrator;
  root: string;
  repo: string;
  remote: string;
  store: EventStore;
  host: TestHost;
  gateway: FakeGateway;
  adapters: Record<string, ScriptedAdapter>;
  config: HubConfig;
  clock: { now: number };
  browserCalls: BrowserCheckInput[];
  inbound(command: Inbound['command'], n?: number): Inbound;
  until(check: () => boolean, what: string): Promise<void>;
  close(): Promise<void>;
}

let counter = 0;

export async function makeHarness(options: {
  agents: { name: string; vendor: Vendor; turns: Turn[]; roles?: string[] }[];
  config?: Partial<RawConfig>;
  checks?: string[];
  preview?: boolean;
  browser?: (input: BrowserCheckInput) => Promise<BrowserCheckResult>;
}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'hyde-hub-'));
  const repo = join(root, 'repo');
  const remote = join(root, 'remote.git');
  await git(root, ['init', '-q', '-b', 'main', repo]);
  await git(repo, ['config', 'user.name', 'Test']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(repo, 'progress.md'), '# Progress\n\n## Log\n<!-- New entries go directly below this line, newest first. -->\n');
  writeFileSync(join(repo, 'CLAUDE.md'), '# CLAUDE.md\n\n## Lessons learned\n- 2026-10-01: existing lesson\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  await git(repo, ['branch', 'staging']);
  await git(root, ['init', '-q', '--bare', remote]);
  await git(repo, ['remote', 'add', 'origin', remote]);
  await git(repo, ['push', '-q', 'origin', 'main', 'staging']);

  const raw: RawConfig = {
    dataDir: join(root, 'data'),
    maxConcurrentRuns: 2,
    maxAttempts: 2,
    maxContinuations: 1,
    maxFixRounds: 1,
    checkTimeoutMinutes: 1,
    agents: options.agents.map((a) => ({ name: a.name, adapter: 'claude-code', account: a.name, ...(a.roles && { roles: a.roles }) })),
    projects: [
      {
        id: 'demo',
        path: repo,
        baseBranch: 'staging',
        checks: options.checks ?? ['test -f hello.txt'],
        ...(options.preview && { preview: { command: 'true', url: 'http://127.0.0.1:$PORT' } }),
      },
    ],
    notifications: { digestMinutes: 0, ownerChat: 'telegram:owner' },
    ...options.config,
  };
  const config = parseConfig(raw, join(root, 'hyde.config.json'), {});
  config.callbackSecret = 's';
  const store = new EventStore(join(root, 'events.db'));
  const adapters: Record<string, ScriptedAdapter> = {};
  for (const a of options.agents) adapters[a.name] = new ScriptedAdapter(a.vendor, a.turns);
  const registry = new Registry<AdapterFactory>('adapter').register('claude-code', (p) => adapters[p.name]!);
  const pool = new AgentPool(config, registry, root);
  const gateway = new FakeGateway();
  // Real time, because event timestamps come from the store's clock (stall detection compares them).
  const clock = { now: Date.now() };
  const notifier = new Notifier({ gateways: new Map([['telegram', gateway]]), ownerChat: 'telegram:owner', digestMinutes: 0, log: () => {} });
  const host = new TestHost();
  const browserCalls: BrowserCheckInput[] = [];
  const o = new Orchestrator({
    config,
    store,
    pool,
    notifier,
    host: () => host,
    hubUrl: 'http://127.0.0.1:0',
    hydeRoot: root,
    tsxLoader: 'file:///tsx.mjs',
    browser: async (input) => {
      browserCalls.push(input);
      return options.browser ? options.browser(input) : { ok: true, url: 'http://127.0.0.1:1', errors: [], files: [] };
    },
    log: process.env.HYDE_TEST_LOG ? (m) => console.log(m) : () => {},
    now: () => clock.now,
  });
  for (const a of Object.values(adapters)) a.orchestrator = o;

  return {
    o,
    root,
    repo,
    remote,
    store,
    host,
    gateway,
    adapters,
    config,
    clock,
    browserCalls,
    inbound: (command, n) => ({ command, userId: 'tg:1', gateway: 'telegram', chatId: '100', commandId: `tg:${n ?? ++counter}` }),
    async until(check, what) {
      for (let i = 0; i < 300; i++) {
        if (check()) return;
        await o.tick();
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for ${what}:\n${o.statusText()}\n${[...o.state.incidents.values()].map((i) => `${i.about}: ${i.evidence}`).join("\n")}`);
    },
    async close() {
      await o.stop();
      await o.drain();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export const today = () => new Date().toLocaleDateString('en-CA');

/** A turn that writes a file, commits it and reports done. */
export function doWork(file = 'hello.txt', content = 'hi\n'): Turn {
  return async ({ runId, spec, o }) => {
    writeFileSync(join(spec.cwd, file), content);
    await git(spec.cwd, ['add', file]);
    await git(spec.cwd, ['commit', '-q', '-m', `Add ${file}`]);
    await o.agentCall(runId, 'complete_task', { summary: `Added ${file}`, verified: `cat ${file}`, filesChanged: [file] });
    return [{ type: 'run.completed', summary: 'done' }];
  };
}

/** A planner or reviewer turn that returns structured output. */
export function answer(structured: unknown): Turn {
  return async () => [{ type: 'run.completed', summary: JSON.stringify(structured), structured }];
}
