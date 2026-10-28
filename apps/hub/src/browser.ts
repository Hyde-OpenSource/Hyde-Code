import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { scrubEnv } from '@hyde/adapter-common';

// Browser verification and proof of work (docs/plan.md "Browser and computer use"): the harness,
// not the agent, starts the worktree's dev server, opens each page in headless Chromium and keeps
// screenshots (and optionally a video), so the evidence can't be faked.

export interface BrowserCheckInput {
  cwd: string;
  /** Dev server command; $PORT is replaced. */
  command: string;
  /** e.g. http://127.0.0.1:$PORT */
  url: string;
  paths: string[];
  outDir: string;
  video: boolean;
  startTimeoutMs?: number;
}

export interface BrowserCheckResult {
  ok: boolean;
  url: string;
  errors: string[];
  files: { path: string; kind: 'screenshot' | 'video'; label: string }[];
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function waitForUrl(url: string, timeoutMs: number, exited: () => boolean): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (exited()) throw new Error('the dev server exited before it was ready');
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the dev server did not answer at ${url} within ${Math.round(timeoutMs / 1000)}s`);
}

export async function browserCheck(input: BrowserCheckInput): Promise<BrowserCheckResult> {
  const port = await freePort();
  const base = input.url.replaceAll('$PORT', String(port)).replace(/\/$/, '');
  const command = input.command.replaceAll('$PORT', String(port));
  mkdirSync(input.outDir, { recursive: true });
  const server = spawn('sh', ['-c', command], {
    cwd: input.cwd,
    env: scrubEnv(process.env, { PORT: String(port), BROWSER: 'none', CI: '1' }),
    stdio: 'ignore',
    detached: true, // own process group, so the whole dev server tree can be stopped
  });
  let serverExited = false;
  server.once('exit', () => (serverExited = true));
  const errors: string[] = [];
  const files: BrowserCheckResult['files'] = [];
  try {
    await waitForUrl(base, input.startTimeoutMs ?? 90_000, () => serverExited);
    const { chromium } = await import('playwright');
    const browser = await chromium.launch();
    try {
      const videoDir = join(input.outDir, 'video');
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        ...(input.video && { recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } } }),
      });
      const page = await context.newPage();
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
      });
      page.on('pageerror', (err) => errors.push(`page error: ${err.message}`));
      for (const [i, path] of input.paths.entries()) {
        const target = `${base}${path.startsWith('/') ? path : `/${path}`}`;
        const res = await page.goto(target, { waitUntil: 'networkidle', timeout: 30_000 }).catch((err: Error) => {
          errors.push(`${path}: ${err.message.split('\n')[0]}`);
          return null;
        });
        if (res && res.status() >= 400) errors.push(`${path}: HTTP ${res.status()}`);
        const shot = join(input.outDir, `page-${i + 1}.png`);
        await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
        files.push({ path: shot, kind: 'screenshot', label: path });
      }
      await context.close();
      if (input.video) {
        for (const name of readdirSync(videoDir).filter((n) => n.endsWith('.webm'))) {
          const dest = join(input.outDir, 'walkthrough.webm');
          renameSync(join(videoDir, name), dest);
          files.push({ path: dest, kind: 'video', label: 'walkthrough' });
        }
      }
    } finally {
      await browser.close();
    }
  } catch (err) {
    errors.push((err as Error).message);
  } finally {
    try {
      if (server.pid) process.kill(-server.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  return { ok: errors.length === 0, url: base, errors, files };
}
