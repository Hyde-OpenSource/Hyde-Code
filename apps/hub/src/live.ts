import { spawn, type ChildProcess } from 'node:child_process';
import { scrubEnv } from '@hyde/adapter-common';
import { freePort, waitForUrl } from './browser.ts';

// The live browser channel (docs/roadmap-v2.md section 3). Frames are kept in memory only: the
// latest one per task plus whoever watches. Actions and keyframes go into the event log through
// the orchestrator; this class never writes state.

export type LiveMessage =
  | { type: 'frame'; jpeg: string; width: number; height: number; url: string; ts: number }
  | { type: 'action'; step: number; op: string; label: string; url: string; ok: boolean; box?: { x: number; y: number; width: number; height: number }; x?: number; y?: number; text?: string; viewport: { width: number; height: number }; artifactId?: string; ts: number }
  | { type: 'state'; paused: boolean; previewUrl?: string };

export class LiveBrowser {
  private readonly frames = new Map<string, Extract<LiveMessage, { type: 'frame' }>>();
  private readonly watchers = new Map<string, Set<(m: LiveMessage) => void>>();
  private readonly paused = new Set<string>();
  private readonly commands = new Map<string, { kind: 'click'; x: number; y: number }[]>();
  private readonly notes = new Map<string, string[]>();
  private readonly previews = new Map<string, { proc: ChildProcess; url: string }>();

  latest(taskId: string) {
    return this.frames.get(taskId);
  }

  watch(taskId: string, fn: (m: LiveMessage) => void): () => void {
    const set = this.watchers.get(taskId) ?? new Set();
    set.add(fn);
    this.watchers.set(taskId, set);
    const frame = this.frames.get(taskId);
    if (frame) fn(frame);
    fn({ type: 'state', paused: this.paused.has(taskId), ...(this.previews.get(taskId) && { previewUrl: this.previews.get(taskId)!.url }) });
    return () => set.delete(fn);
  }

  publish(taskId: string, m: LiveMessage): void {
    if (m.type === 'frame') this.frames.set(taskId, m);
    for (const fn of this.watchers.get(taskId) ?? []) fn(m);
  }

  isPaused(taskId: string): boolean {
    return this.paused.has(taskId);
  }

  setPaused(taskId: string, paused: boolean): void {
    if (paused) this.paused.add(taskId);
    else this.paused.delete(taskId);
    this.publish(taskId, { type: 'state', paused });
  }

  /** The owner clicked in the live view: the browser does it, and the agent is told before its next step. */
  takeOver(taskId: string, x: number, y: number): void {
    const list = this.commands.get(taskId) ?? [];
    list.push({ kind: 'click', x: Math.round(x), y: Math.round(y) });
    this.commands.set(taskId, list);
    const notes = this.notes.get(taskId) ?? [];
    notes.push(`The owner clicked at (${Math.round(x)}, ${Math.round(y)}) in the live browser; take a fresh browser_snapshot before you continue.`);
    this.notes.set(taskId, notes);
  }

  drainCommands(taskId: string) {
    const list = this.commands.get(taskId) ?? [];
    this.commands.delete(taskId);
    return list;
  }

  drainNotes(taskId: string): string[] {
    const list = this.notes.get(taskId) ?? [];
    this.notes.delete(taskId);
    return list;
  }

  /** Waits while the owner has paused this task's browser; true when it may go on. */
  async waitWhilePaused(taskId: string, maxMs: number, now: () => number = Date.now): Promise<boolean> {
    const until = now() + maxMs;
    while (this.paused.has(taskId)) {
      if (now() >= until) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
    return true;
  }

  /** The task's dev server on a free port, started once and kept until the task leaves the active states. */
  async preview(taskId: string, cwd: string, command: string, urlTemplate: string): Promise<string> {
    const running = this.previews.get(taskId);
    if (running && running.proc.exitCode === null) return running.url;
    const port = await freePort();
    const url = urlTemplate.replaceAll('$PORT', String(port)).replace(/\/$/, '');
    const proc = spawn('sh', ['-c', command.replaceAll('$PORT', String(port))], {
      cwd,
      env: scrubEnv(process.env, { PORT: String(port), BROWSER: 'none', CI: '1' }),
      stdio: 'ignore',
      detached: true,
    });
    let exited = false;
    proc.once('exit', () => (exited = true));
    try {
      await waitForUrl(url, 90_000, () => exited);
    } catch (err) {
      this.kill(proc);
      throw err;
    }
    this.previews.set(taskId, { proc, url });
    this.publish(taskId, { type: 'state', paused: this.paused.has(taskId), previewUrl: url });
    return url;
  }

  stopPreview(taskId: string): void {
    const p = this.previews.get(taskId);
    if (!p) return;
    this.previews.delete(taskId);
    this.kill(p.proc);
  }

  stopAll(): void {
    for (const id of [...this.previews.keys()]) this.stopPreview(id);
  }

  private kill(proc: ChildProcess): void {
    try {
      if (proc.pid) process.kill(-proc.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}
