import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { failureFromText, scrubEnv, summarize, type LaunchWrapper } from '@hyde/adapter-common';
import type { AgentAdapter, DetectResult, HarnessEvent, QuotaSnapshot, RunHandle, RunSpec, Vendor } from '@hyde/core';

// A generic Agent Client Protocol client (JSON-RPC 2.0 over stdio): one adapter that reaches
// Gemini CLI, Copilot CLI and every other agent in the ACP registry (docs/plan.md).

export interface AcpOptions {
  /** e.g. ['gemini', '--experimental-acp'] */
  command: string[];
  vendor?: Vendor;
  wrap?: LaunchWrapper;
}

type Json = Record<string, any>;

/** Whether a tool call may run under the spec's rules. Returns a reason when it may not. */
export function permissionDenied(spec: RunSpec, toolCall: Json): string | null {
  const kind = String(toolCall?.kind ?? 'other');
  const title = String(toolCall?.title ?? '');
  if (spec.readOnly && ['edit', 'delete', 'move', 'execute'].includes(kind)) return `read-only run: ${kind} not allowed`;
  for (const rule of spec.deny ?? []) {
    const m = /^Bash\((.*?)(?::\*| \*)?\)$/.exec(rule);
    if (m && title.includes(m[1]!)) return `denied by ${rule}`;
  }
  return null;
}

function insideAllowed(spec: RunSpec, path: string, write: boolean): boolean {
  const roots = [spec.cwd, ...(write ? (spec.writableDirs ?? []) : [spec.cwd, ...(spec.writableDirs ?? [])])];
  const abs = resolve(spec.cwd, path);
  return roots.some((root) => {
    const rel = relative(root, abs);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

class Session {
  readonly queue: HarnessEvent[] = [];
  private wake: (() => void) | undefined;
  done = false;
  interrupted = false;
  sessionId = '';
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private lastText = '';

  constructor(
    readonly child: ChildProcess,
    private readonly spec: RunSpec,
  ) {
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', (line) => this.onLine(line));
    child.once('exit', () => {
      for (const p of this.pending.values()) p.reject(new Error('agent exited'));
      this.pending.clear();
      this.end();
    });
  }

  push(event: HarnessEvent): void {
    this.queue.push(event);
    this.wake?.();
  }

  end(): void {
    this.done = true;
    this.wake?.();
  }

  waitForMore(): Promise<void> {
    return new Promise((r) => (this.wake = r));
  }

  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    this.send({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private send(msg: Json): void {
    this.child.stdin?.write(JSON.stringify(msg) + '\n');
  }

  private onLine(line: string): void {
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message ?? 'ACP error'));
      else p?.resolve(msg.result);
      return;
    }
    if (msg.method === 'session/update') return this.onUpdate(msg.params?.update ?? {});
    if (msg.id !== undefined && msg.method) void this.onRequest(msg.id, msg.method, msg.params ?? {});
  }

  private onUpdate(u: Json): void {
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content?.type === 'text') {
          this.lastText += u.content.text;
          this.push({ type: 'text.delta', text: u.content.text });
        }
        break;
      case 'tool_call':
        this.push({ type: 'tool.started', tool: String(u.kind ?? 'tool'), summary: summarize({ command: u.title }) });
        for (const loc of u.locations ?? []) if (u.kind === 'edit' && loc.path) this.push({ type: 'file.changed', path: loc.path });
        break;
      case 'tool_call_update':
        if (u.status === 'completed' || u.status === 'failed') {
          this.push({ type: 'tool.finished', tool: String(u.kind ?? 'tool'), summary: u.status === 'completed' ? 'ok' : 'error' });
        }
        break;
    }
  }

  private async onRequest(id: number, method: string, params: Json): Promise<void> {
    const reply = (result: unknown) => this.send({ jsonrpc: '2.0', id, result });
    const fail = (message: string) => this.send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
    switch (method) {
      case 'session/request_permission': {
        const denied = permissionDenied(this.spec, params.toolCall);
        const options: Json[] = params.options ?? [];
        const pick = denied
          ? options.find((o) => o.kind === 'reject_once') ?? options.find((o) => String(o.kind).startsWith('reject'))
          : options.find((o) => o.kind === 'allow_once') ?? options.find((o) => String(o.kind).startsWith('allow'));
        if (denied) this.push({ type: 'permission.requested', requestId: String(id), action: `denied: ${denied}` });
        return reply(pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : { outcome: { outcome: 'cancelled' } });
      }
      case 'fs/read_text_file':
        if (!insideAllowed(this.spec, params.path, false)) return fail('path outside the task workspace');
        try {
          return reply({ content: readFileSync(resolve(this.spec.cwd, params.path), 'utf8') });
        } catch (err) {
          return fail((err as Error).message);
        }
      case 'fs/write_text_file':
        if (this.spec.readOnly || !insideAllowed(this.spec, params.path, true)) return fail('write not allowed here');
        writeFileSync(resolve(this.spec.cwd, params.path), String(params.content ?? ''));
        this.push({ type: 'file.changed', path: resolve(this.spec.cwd, params.path) });
        return reply(null);
      default:
        return fail(`method not supported: ${method}`);
    }
  }

  async run(prompt: string, resume?: string): Promise<void> {
    try {
      const init = await this.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      });
      const mcpServers = this.spec.mcp
        ? [{ name: 'hyde', command: this.spec.mcp.command, args: this.spec.mcp.args, env: Object.entries(this.spec.mcp.env).map(([name, value]) => ({ name, value })) }]
        : [];
      if (resume && init?.agentCapabilities?.loadSession) {
        await this.request('session/load', { sessionId: resume, cwd: this.spec.cwd, mcpServers });
        this.sessionId = resume;
      } else {
        const created = await this.request('session/new', { cwd: this.spec.cwd, mcpServers });
        this.sessionId = String(created.sessionId);
      }
      this.push({ type: 'run.started', sessionRef: this.sessionId, model: this.spec.model ?? 'acp-agent' });
      const packet = this.spec.packetFile ? readFileSync(this.spec.packetFile, 'utf8') + '\n\n' : '';
      const schema = this.spec.jsonSchema
        ? `\n\nYour final message must be only a JSON object matching this JSON Schema:\n${JSON.stringify(this.spec.jsonSchema)}`
        : '';
      const result = await this.request('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: `${resume ? '' : packet}${prompt}${schema}` }],
      });
      const stop = String(result?.stopReason ?? 'end_turn');
      if (stop === 'cancelled' || this.interrupted) this.push({ type: 'run.failed', reason: 'cancelled' });
      else if (stop === 'refusal') this.push({ type: 'run.failed', reason: 'crashed', detail: 'agent refused' });
      else {
        let structured: unknown;
        if (this.spec.jsonSchema) {
          try {
            structured = JSON.parse(this.lastText.trim().replace(/^```(?:json)?|```$/g, ''));
          } catch {
            structured = undefined;
          }
        }
        this.push({ type: 'run.completed', summary: this.lastText, ...(structured !== undefined && { structured }) });
      }
    } catch (err) {
      const detail = (err as Error).message;
      this.push(this.interrupted ? { type: 'run.failed', reason: 'cancelled' } : { type: 'run.failed', reason: failureFromText(detail), detail });
    } finally {
      this.child.stdin?.end();
      setTimeout(() => this.child.kill('SIGTERM'), 2000).unref();
    }
  }
}

export class AcpAdapter implements AgentAdapter {
  readonly kind = 'acp' as const;
  readonly vendor: Vendor;
  readonly structuredOutput = false;
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly options: AcpOptions) {
    this.vendor = options.vendor ?? 'other';
  }

  async detect(): Promise<DetectResult> {
    const [bin] = this.options.command;
    try {
      const child = spawn(bin!, ['--version'], { stdio: 'ignore' });
      const code = await new Promise<number | null>((r) => {
        child.once('exit', r);
        child.once('error', () => r(-1));
      });
      return code === -1
        ? { installed: false, signedIn: false, problem: `${bin} not found` }
        : { installed: true, signedIn: true, account: bin! };
    } catch {
      return { installed: false, signedIn: false, problem: `${bin} not found` };
    }
  }

  start(runId: string, spec: RunSpec): Promise<RunHandle> {
    return Promise.resolve(this.launch(runId, spec));
  }

  resume(runId: string, sessionRef: string, spec: RunSpec): Promise<RunHandle> {
    return Promise.resolve(this.launch(runId, spec, sessionRef));
  }

  send(): Promise<void> {
    return Promise.reject(new Error('acp adapter: use resume() for follow-up turns'));
  }

  async interrupt(handle: RunHandle): Promise<void> {
    const session = this.sessions.get(handle.runId);
    if (!session) return;
    session.interrupted = true;
    if (session.sessionId) session.notify('session/cancel', { sessionId: session.sessionId });
    setTimeout(() => session.child.kill('SIGINT'), 3000).unref();
  }

  async *events(handle: RunHandle): AsyncIterable<HarnessEvent> {
    const session = this.sessions.get(handle.runId);
    if (!session) return;
    while (true) {
      while (session.queue.length) yield session.queue.shift()!;
      if (session.done) break;
      await session.waitForMore();
    }
    this.sessions.delete(handle.runId);
  }

  async quota(): Promise<QuotaSnapshot[]> {
    return [];
  }

  private launch(runId: string, spec: RunSpec, resume?: string): RunHandle {
    const [command, ...args] = this.options.command;
    const base = { command: command!, args };
    const launch = this.options.wrap ? this.options.wrap(base, spec) : base;
    const child = spawn(launch.command, launch.args, { cwd: spec.cwd, env: scrubEnv(process.env, spec.env), stdio: ['pipe', 'pipe', 'ignore'] });
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => {
      child.once('exit', (code, signal) => r({ code, signal }));
      child.once('error', () => r({ code: null, signal: null }));
    });
    const session = new Session(child, spec);
    this.sessions.set(runId, session);
    void session.run(spec.prompt, resume).then(() => session.end());
    return { runId, pid: child.pid, exited };
  }
}
