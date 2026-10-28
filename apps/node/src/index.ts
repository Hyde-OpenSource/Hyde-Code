import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { AcpAdapter } from '@hyde/adapter-acp';
import { ClaudeCodeAdapter } from '@hyde/adapter-claude-code';
import { CodexAdapter } from '@hyde/adapter-codex';
import { CommandAdapter } from '@hyde/adapter-command';
import { OpenCodeAdapter } from '@hyde/adapter-opencode';
import type { AgentAdapter, AgentProfile, RunHandle, RunSpec } from '@hyde/core';
import { MCP_MAIN } from '@hyde/mcp-harness';
import { LocalHost, type HostOps } from '@hyde/workspace';
import WebSocket from 'ws';
import { PROJECT_PREFIX, type Hello, type NodeToHub, type RpcRequest, type StartParams } from './protocol.ts';

export * from './protocol.ts';

export interface NodeOptions {
  hubUrl: string; // ws(s)://hub/api/nodes/connect
  nodeId: string;
  token: string;
  owner: string;
  /** Local clones of the hub's projects, by project id. */
  projects: Record<string, string>;
  dataDir: string;
  /** tsx ESM loader URL for the MCP server. */
  tsxLoader: string;
  log?: (msg: string) => void;
  host?: HostOps;
  adapters?: (profile: AgentProfile) => AgentAdapter;
}

export function makeAdapter(profile: AgentProfile): AgentAdapter {
  switch (profile.adapter) {
    case 'claude-code':
      return new ClaudeCodeAdapter();
    case 'codex':
      return new CodexAdapter();
    case 'opencode':
      return new OpenCodeAdapter();
    case 'acp':
      return new AcpAdapter({ command: profile.command! });
    case 'command':
      return new CommandAdapter(profile.command!);
    default:
      throw new Error(`This node has no adapter "${profile.adapter}"`);
  }
}

/**
 * A worker node: runs agent CLIs under its owner's own logins on its own machine, for a hub
 * elsewhere. One user, one login: the hub sends work, never credentials.
 */
export class WorkerNode {
  private ws: WebSocket | undefined;
  private readonly host: HostOps;
  private readonly adapters = new Map<string, AgentAdapter>();
  private readonly runs = new Map<string, { adapter: AgentAdapter; handle: RunHandle }>();
  private readonly log: (msg: string) => void;
  private closed = false;

  constructor(private readonly options: NodeOptions) {
    this.host = options.host ?? new LocalHost();
    this.log = options.log ?? ((m) => console.log(m));
  }

  /** Maps a `project:<id>` reference to the local clone. */
  local(path: string): string {
    if (!path.startsWith(PROJECT_PREFIX)) return path;
    const id = path.slice(PROJECT_PREFIX.length);
    const local = this.options.projects[id];
    if (!local) throw new Error(`This node has no clone of project ${id}`);
    return local;
  }

  private adapter(profile: AgentProfile): AgentAdapter {
    let a = this.adapters.get(profile.name);
    if (!a) {
      a = (this.options.adapters ?? makeAdapter)(profile);
      this.adapters.set(profile.name, a);
    }
    return a;
  }

  async connect(profiles: AgentProfile[] = []): Promise<void> {
    const ws = new WebSocket(this.options.hubUrl, { headers: { authorization: `Bearer ${this.options.nodeId}:${this.options.token}` } });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const kinds = [...new Set(['claude-code', 'codex', 'opencode', ...profiles.map((p) => p.adapter)])];
    const clis = await Promise.all(
      kinds.map(async (kind) => {
        const profile = profiles.find((p) => p.adapter === kind) ?? ({ name: `detect-${kind}`, adapter: kind } as AgentProfile);
        try {
          return { kind, ...(await this.adapter(profile).detect()) };
        } catch {
          return { kind, installed: false, signedIn: false };
        }
      }),
    );
    const hello: Hello = { type: 'hello', nodeId: this.options.nodeId, owner: this.options.owner, host: hostname(), clis };
    this.send(hello);
    ws.on('message', (data) => void this.onMessage(JSON.parse(String(data)) as RpcRequest));
    ws.on('close', () => {
      if (this.closed) return;
      this.log('node: connection to the hub closed; reconnecting in 5 s');
      setTimeout(() => void this.connect(profiles).catch((e: Error) => this.log(`node: ${e.message}`)), 5000).unref();
    });
    this.log(`node ${this.options.nodeId}: connected to ${this.options.hubUrl}`);
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  private send(msg: NodeToHub): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private async onMessage(req: RpcRequest): Promise<void> {
    try {
      this.send({ id: req.id, result: await this.call(req.method, req.params) });
    } catch (err) {
      this.send({ id: req.id, error: (err as Error).message });
    }
  }

  private async call(method: string, params: any): Promise<unknown> {
    if (method === 'run.start') return this.start(params as StartParams);
    if (method === 'run.interrupt') {
      const run = this.runs.get(params.runId);
      if (run) await run.adapter.interrupt(run.handle);
      return null;
    }
    if (method === 'quota') return this.adapter(params.profile).quota();
    if (method === 'detect') return this.adapter(params.profile).detect();
    if (method.startsWith('host.')) {
      const name = method.slice(5) as keyof HostOps;
      const args = (params.args as unknown[]).map((a) => (typeof a === 'string' ? this.local(a) : a));
      if (name === 'createWorktree') {
        const spec = args[0] as { repo: string; taskId: string; branch: string; base: string };
        return this.host.createWorktree({ ...spec, repo: this.local(spec.repo), worktreesRoot: join(this.options.dataDir, 'worktrees') });
      }
      const fn = this.host[name] as unknown as (...a: unknown[]) => Promise<unknown>;
      if (typeof fn !== 'function') throw new Error(`Unknown host method ${name}`);
      return fn.apply(this.host, args);
    }
    throw new Error(`Unknown method ${method}`);
  }

  private async start(p: StartParams): Promise<{ pid: number | undefined }> {
    const runDir = join(this.options.dataDir, 'runs', p.runId);
    mkdirSync(runDir, { recursive: true });
    let packetFile: string | undefined;
    if (p.packet !== undefined) {
      packetFile = join(runDir, 'packet.md');
      writeFileSync(packetFile, p.packet);
    }
    // Paths in the hub's spec are rewritten to this machine's; the hub URL and token stay.
    const spec: RunSpec = {
      ...p.spec,
      runDir,
      ...(packetFile ? { packetFile } : {}),
      ...(p.spec.mcp && { mcp: { command: process.execPath, args: ['--import', this.options.tsxLoader, MCP_MAIN], env: p.spec.mcp.env } }),
    };
    if (!packetFile) delete spec.packetFile;
    const adapter = this.adapter(p.profile);
    const handle = p.resume ? await adapter.resume(p.runId, p.resume, spec) : await adapter.start(p.runId, spec);
    this.runs.set(p.runId, { adapter, handle });
    void (async () => {
      for await (const event of adapter.events(handle)) this.send({ type: 'event', runId: p.runId, event });
      this.send({ type: 'exit', runId: p.runId, exit: await handle.exited });
      this.runs.delete(p.runId);
    })();
    return { pid: handle.pid };
  }
}
