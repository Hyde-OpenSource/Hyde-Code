import { readFileSync } from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { timingSafeEqual } from 'node:crypto';
import type { AgentAdapter, AgentProfile, DetectResult, EventStore, HarnessEvent, QuotaSnapshot, RunHandle, RunSpec } from '@hyde/core';
import { PROJECT_PREFIX, type Hello, type NodeToHub, type StartParams } from '@hyde/node';
import type { HostOps } from '@hyde/workspace';
import { WebSocketServer, type WebSocket } from 'ws';
import type { HubConfig } from './config.ts';

// The hub side of worker nodes (docs/plan.md Phase 3, "Teammate nodes"): each teammate's node
// connects out to the hub over one WebSocket; the hub drives runs and git there through RPC.

interface RunStream {
  queue: HarnessEvent[];
  done: boolean;
  wake?: () => void;
  resolveExit: (exit: { code: number | null; signal: string | null }) => void;
}

class NodeConnection {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  readonly runs = new Map<string, RunStream>();

  constructor(
    readonly id: string,
    readonly ws: WebSocket,
  ) {}

  call(method: string, params: unknown, timeoutMs = 10 * 60_000): Promise<unknown> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`node ${this.id}: ${method} timed out`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  onMessage(msg: NodeToHub): void {
    if ('id' in msg) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error !== undefined) p?.reject(new Error(msg.error));
      else p?.resolve(msg.result);
      return;
    }
    if (msg.type === 'event' || msg.type === 'exit') {
      const run = this.runs.get(msg.runId);
      if (!run) return;
      if (msg.type === 'event') run.queue.push(msg.event);
      else {
        run.done = true;
        run.resolveExit(msg.exit);
      }
      run.wake?.();
    }
  }

  /** The node went away: fail its RPCs and runs. */
  lost(): void {
    for (const p of this.pending.values()) p.reject(new Error(`node ${this.id} disconnected`));
    this.pending.clear();
    for (const run of this.runs.values()) {
      if (run.done) continue;
      run.queue.push({ type: 'run.failed', reason: 'crashed', detail: `node ${this.id} disconnected` });
      run.done = true;
      run.resolveExit({ code: null, signal: 'node-disconnected' });
      run.wake?.();
    }
  }
}

export class NodeHub {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly connections = new Map<string, NodeConnection>();

  constructor(
    private readonly config: HubConfig,
    private readonly store: EventStore,
    /** nodeId → token, from HYDE_NODE_TOKENS="id:token,…". */
    private readonly tokens: Map<string, string>,
    private readonly log: (msg: string) => void,
  ) {}

  static parseTokens(value: string | undefined): Map<string, string> {
    return new Map(
      (value ?? '')
        .split(',')
        .map((pair) => pair.trim())
        .filter(Boolean)
        .map((pair) => pair.split(':') as [string, string]),
    );
  }

  attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!req.url?.startsWith('/api/nodes/connect')) return;
      const nodeId = this.authenticate(req.headers.authorization);
      if (!nodeId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(nodeId, ws));
    });
  }

  authenticate(header: string | undefined): string | null {
    const m = /^Bearer ([^:]+):(.+)$/.exec(header ?? '');
    if (!m) return null;
    const expected = this.tokens.get(m[1]!);
    if (!expected) return null;
    const a = Buffer.from(expected);
    const b = Buffer.from(m[2]!);
    return a.length === b.length && timingSafeEqual(a, b) ? m[1]! : null;
  }

  private accept(nodeId: string, ws: WebSocket): void {
    this.connections.get(nodeId)?.ws.close();
    const conn = new NodeConnection(nodeId, ws);
    this.connections.set(nodeId, conn);
    ws.on('message', (data) => {
      let msg: NodeToHub;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if ('type' in msg && msg.type === 'hello') return this.hello(nodeId, msg);
      conn.onMessage(msg);
    });
    ws.on('close', () => {
      if (this.connections.get(nodeId) !== conn) return;
      this.connections.delete(nodeId);
      conn.lost();
      this.store.append({ type: 'node.disconnected', actor: { kind: 'harness', id: 'hub' }, payload: { nodeId } });
      this.log(`node ${nodeId} disconnected`);
    });
  }

  private hello(nodeId: string, msg: Hello): void {
    const clis = msg.clis.map((c) => ({ kind: c.kind, installed: c.installed, signedIn: c.signedIn, ...(c.version && { version: c.version }) }));
    this.store.append({ type: 'node.connected', actor: { kind: 'harness', id: 'hub' }, payload: { nodeId, owner: msg.owner, host: msg.host, clis } });
    this.log(`node ${nodeId} connected (${msg.owner}@${msg.host}): ${clis.filter((c) => c.signedIn).map((c) => c.kind).join(', ') || 'no signed-in CLIs'}`);
  }

  connected(nodeId: string): boolean {
    return this.connections.has(nodeId);
  }

  private conn(nodeId: string): NodeConnection {
    const c = this.connections.get(nodeId);
    if (!c) throw new Error(`node ${nodeId} is not connected`);
    return c;
  }

  /** Hub repo paths cross the wire as project ids. */
  private toWire(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    const project = this.config.projects.find((p) => p.path === value);
    return project ? `${PROJECT_PREFIX}${project.id}` : value;
  }

  adapter(profile: AgentProfile): AgentAdapter | undefined {
    if (!this.connections.has(profile.node)) return undefined;
    return new RemoteAdapter(() => this.conn(profile.node), profile);
  }

  host(nodeId: string): HostOps {
    const call = (name: string, args: unknown[]) => this.conn(nodeId).call(`host.${name}`, { args: args.map((a) => this.toWire(a)) });
    return new Proxy({} as HostOps, {
      get: (_t, name: string) => {
        if (name === 'createWorktree') {
          return (spec: { repo: string }) => this.conn(nodeId).call('host.createWorktree', { args: [{ ...spec, repo: this.toWire(spec.repo) }] });
        }
        return (...args: unknown[]) => call(name, args);
      },
    });
  }
}

export class RemoteAdapter implements AgentAdapter {
  readonly kind: AgentProfile['adapter'];
  readonly vendor = 'other' as const;
  readonly structuredOutput = true;

  constructor(
    private readonly conn: () => NodeConnection,
    private readonly profile: AgentProfile,
  ) {
    this.kind = profile.adapter;
  }

  detect(): Promise<DetectResult> {
    return this.conn().call('detect', { profile: this.profile }) as Promise<DetectResult>;
  }

  async quota(): Promise<QuotaSnapshot[]> {
    return (await this.conn().call('quota', { profile: this.profile })) as QuotaSnapshot[];
  }

  start(runId: string, spec: RunSpec): Promise<RunHandle> {
    return this.launch(runId, spec);
  }

  resume(runId: string, sessionRef: string, spec: RunSpec): Promise<RunHandle> {
    return this.launch(runId, spec, sessionRef);
  }

  send(): Promise<void> {
    return Promise.reject(new Error('remote adapter: use resume() for follow-up turns'));
  }

  async interrupt(handle: RunHandle): Promise<void> {
    await this.conn().call('run.interrupt', { runId: handle.runId });
  }

  async *events(handle: RunHandle): AsyncIterable<HarnessEvent> {
    const run = this.conn().runs.get(handle.runId);
    if (!run) return;
    for (;;) {
      while (run.queue.length) yield run.queue.shift()!;
      if (run.done) break;
      await new Promise<void>((r) => (run.wake = r));
    }
  }

  private async launch(runId: string, spec: RunSpec, resume?: string): Promise<RunHandle> {
    const conn = this.conn();
    let resolveExit!: RunStream['resolveExit'];
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => (resolveExit = r));
    conn.runs.set(runId, { queue: [], done: false, resolveExit });
    const params: StartParams = {
      runId,
      profile: this.profile,
      spec,
      ...(spec.packetFile && { packet: readFileSync(spec.packetFile, 'utf8') }),
      ...(resume && { resume }),
    };
    const result = (await conn.call('run.start', params)) as { pid?: number };
    return { runId, pid: result.pid, exited };
  }
}
