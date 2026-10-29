import { spawn } from 'node:child_process';
import type { Command, FeedEvent } from '@hyde/core';
import { SCREENS, boardTasks, cursorLimit, inboxEntries, render, type TuiState, type TuiView } from './tui-render.ts';

// `hyde tui`: the office in the terminal. It talks to the running hub over the same HTTP API
// as the web dashboard (owner token), so both views stay in step.

export async function runTui(base: string, token: string, opts: { project?: string } = {}): Promise<void> {
  const out = process.stdout;
  const input = process.stdin;
  if (!out.isTTY || !input.isTTY) {
    console.error('hyde tui needs an interactive terminal.');
    process.exitCode = 1;
    return;
  }
  const auth = { authorization: `Bearer ${token}` };
  const view: TuiView = { state: null, feed: [], screen: 'office', cursor: 0, session: [], connected: false, tick: 0, color: !process.env.NO_COLOR, ...(opts.project && { project: opts.project }), allProjects: !opts.project };
  let closed = false;
  let flashTimer: NodeJS.Timeout | undefined;

  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${base}${path}`, { headers: auth });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  };

  // ---------- drawing ----------
  let pending = false;
  const draw = () => {
    if (pending || closed) return;
    pending = true;
    setImmediate(() => {
      pending = false;
      if (closed) return;
      const lines = render(view, out.columns || 100, out.rows || 30);
      out.write(`\x1b[H${lines.join('\r\n')}`);
    });
  };
  const flash = (text: string) => {
    view.flash = text.split('\n')[0];
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      view.flash = undefined;
      draw();
    }, 5000);
    draw();
  };

  // ---------- data ----------
  let refreshTimer: NodeJS.Timeout | undefined;
  const refresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      try {
        view.state = await get<TuiState>('/api/state');
        view.cursor = Math.min(view.cursor, Math.max(0, cursorLimit(view) - 1));
        await loadSession();
      } catch (err) {
        flash(`Can't read the hub: ${(err as Error).message}`);
      }
      draw();
    }, 120);
  };

  /** The task whose transcript is shown: the selected agent's latest run, or the open task. */
  const sessionTask = (): string | undefined => {
    const s = view.state;
    if (!s) return undefined;
    if (view.screen === 'task') return view.taskId;
    if (view.screen !== 'office') return undefined;
    const agent = s.agents[view.cursor];
    return agent ? [...s.runs].reverse().find((r) => r.agent === agent.name)?.taskId : undefined;
  };
  const loadSession = async () => {
    const id = sessionTask();
    if (view.screen === 'office') view.taskId = id;
    if (!id) {
      view.session = [];
      return;
    }
    const events = await get<FeedEvent[]>(`/api/tasks/${encodeURIComponent(id)}/events`);
    const agent = view.screen === 'office' ? view.state?.agents[view.cursor]?.name : undefined;
    const runs = new Set(view.state?.runs.filter((r) => !agent || r.agent === agent).map((r) => r.id));
    view.session = events.filter((e) => !e.runId || runs.has(e.runId)).slice(-400);
  };

  const listen = async () => {
    let after = 0;
    while (!closed) {
      try {
        const res = await fetch(`${base}/api/events${after ? `?after=${after}` : ''}`, { headers: auth });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        view.connected = true;
        refresh();
        const decoder = new TextDecoder();
        let buf = '';
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          if (closed) return;
          buf += decoder.decode(chunk, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = block
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trimStart())
              .join('\n');
            if (!data) continue;
            try {
              const e = JSON.parse(data) as FeedEvent;
              after = Math.max(after, e.seq);
              view.feed.push(e);
              if (view.feed.length > 500) view.feed.splice(0, view.feed.length - 500);
              refresh();
            } catch {
              // ignore a malformed block
            }
          }
        }
      } catch {
        // fall through to reconnect
      }
      view.connected = false;
      draw();
      await new Promise((r) => setTimeout(r, 2000));
    }
  };

  const command = async (cmd: Command | string) => {
    try {
      const res = await fetch(`${base}/api/commands`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(typeof cmd === 'string' ? { text: cmd } : { command: cmd }),
      });
      const body = (await res.json()) as { text?: string; error?: string };
      flash(body.text ?? body.error ?? `HTTP ${res.status}`);
    } catch (err) {
      flash(`Failed: ${(err as Error).message}`);
    }
    refresh();
  };

  const openWeb = () => {
    const url = `${base}/login?token=${token}${view.project ? `&project=${encodeURIComponent(view.project)}` : ''}`;
    const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
    try {
      spawn(cmd, args as string[], { stdio: 'ignore', detached: true }).unref();
      flash('Opened the web office in your browser.');
    } catch {
      flash(`Open ${base} in a browser (hyde web prints a login link).`);
    }
  };

  // ---------- keys ----------
  const ask = (label: string, done: (text: string) => void) => {
    view.input = { label, text: '' };
    onSubmit = done;
    draw();
  };
  let onSubmit: ((text: string) => void) | undefined;

  const project = () => view.project ?? view.state?.projects[0]?.id;

  const onKey = (key: string) => {
    if (view.input) {
      if (key === '\r') {
        const text = view.input.text.trim();
        const done = onSubmit;
        view.input = undefined;
        onSubmit = undefined;
        if (text && done) done(text);
      } else if (key === '\x1b') {
        view.input = undefined;
        onSubmit = undefined;
      } else if (key === '\x7f' || key === '\b') {
        view.input.text = [...view.input.text].slice(0, -1).join('');
      } else if (key === '\x15') {
        view.input.text = '';
      } else if (!key.startsWith('\x1b') && key >= ' ') {
        view.input.text += key;
      } else if (key === '\x03') {
        return quit();
      }
      return draw();
    }

    const s = view.state;
    const limit = cursorLimit(view);
    const move = (d: number) => {
      view.cursor = limit ? (view.cursor + d + limit) % limit : 0;
      if (view.screen === 'office') void loadSession().then(draw);
    };
    switch (key) {
      case 'q':
      case '\x03':
        return quit();
      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
        if (view.screen === 'inbox' && s) {
          const it = inboxEntries(s, view)[view.cursor];
          const n = Number(key) - 1;
          if (it?.kind === 'question' && it.options[n] !== undefined) {
            void command({ kind: 'answer', questionId: it.id, text: `#option:${n}` });
            return;
          }
        }
        view.screen = SCREENS[Number(key) - 1]!;
        view.cursor = 0;
        void loadSession().then(draw);
        break;
      case '\t':
        view.screen = SCREENS[(SCREENS.indexOf(view.screen as (typeof SCREENS)[number]) + 1) % SCREENS.length]!;
        view.cursor = 0;
        void loadSession().then(draw);
        break;
      case '\x1b[A':
      case 'k':
        move(view.screen === 'activity' ? 1 : -1);
        break;
      case '\x1b[B':
      case 'j':
        move(view.screen === 'activity' ? -1 : 1);
        break;
      case '\x1b':
        if (view.screen === 'task') {
          view.screen = 'board';
          void loadSession().then(draw);
        }
        break;
      case '\r':
        if (view.screen === 'board' && s) {
          const t = boardTasks(s, view).flatMap((c) => c.tasks)[view.cursor];
          if (t) {
            view.screen = 'task';
            view.taskId = t.id;
            void loadSession().then(draw);
          }
        } else if (view.screen === 'inbox' && s) {
          const it = inboxEntries(s, view)[view.cursor];
          if (it?.taskId) {
            view.screen = 'task';
            view.taskId = it.taskId;
            void loadSession().then(draw);
          }
        }
        break;
      case 'n':
        ask(`new task #${project() ?? ''}`, (text) => void command({ kind: 'new', text, project: project() }));
        break;
      case 'c':
        ask(`client message #${project() ?? ''}`, (text) => void command({ kind: 'client', text, project: project() }));
        break;
      case ':':
      case '/':
        ask('command /', (text) => void command(`/${text.replace(/^\//, '')}`));
        break;
      case 'w':
        openWeb();
        break;
      case 'p':
        if (view.project) {
          view.allProjects = !view.allProjects;
          view.cursor = 0;
          flash(view.allProjects ? 'Showing all projects.' : `Showing #${view.project} only.`);
        }
        break;
      case 'a':
      case 'd':
      case 'r': {
        if (view.screen !== 'inbox' || !s) break;
        const it = inboxEntries(s, view)[view.cursor];
        if (!it) break;
        if (it.kind === 'question') {
          if (key === 'r' || key === 'a') ask(`answer ${it.id}`, (text) => void command({ kind: 'answer', questionId: it.id, text }));
        } else if (it.kind === 'approval' && key !== 'r') void command({ kind: 'decide', approvalId: it.id, approved: key === 'a' });
        else if (it.kind === 'merge' && key === 'a') void command({ kind: 'merge', taskId: it.id });
        else if (it.kind === 'lesson' && key !== 'r') void command({ kind: 'lesson', lessonId: it.id, approved: key === 'a' });
        break;
      }
      case 'm':
        if (view.screen === 'task' && view.taskId) void command({ kind: 'merge', taskId: view.taskId });
        break;
      case 's':
      case 't': {
        const id = view.screen === 'task' ? view.taskId : view.screen === 'board' && s ? boardTasks(s, view).flatMap((c) => c.tasks)[view.cursor]?.id : undefined;
        if (id) void command(key === 's' ? { kind: 'stop', target: id } : { kind: 'retry', taskId: id });
        break;
      }
    }
    draw();
  };

  // ---------- lifecycle ----------
  let ticker: NodeJS.Timeout | undefined;
  const restore = () => {
    out.write('\x1b[?25h\x1b[?1049l');
    if (input.isTTY) input.setRawMode(false);
  };
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => (resolveDone = r));
  function quit() {
    if (closed) return;
    closed = true;
    clearInterval(ticker);
    clearTimeout(refreshTimer);
    clearTimeout(flashTimer);
    input.off('data', onData);
    out.off('resize', onResize);
    input.pause();
    restore();
    resolveDone();
  }
  const onData = (buf: Buffer) => {
    const text = buf.toString('utf8');
    // Arrow keys arrive as one escape sequence; pasted text arrives as many characters.
    if (text.startsWith('\x1b[') || text.length === 1 || !view.input) {
      for (const key of text.startsWith('\x1b') ? [text] : [...text]) onKey(key);
    } else {
      view.input.text += text.replace(/[\r\n]+/g, ' ');
      draw();
    }
  };

  function onResize() {
    out.write('\x1b[2J');
    draw();
  }
  out.write('\x1b[?1049h\x1b[?25l\x1b[2J');
  input.setRawMode(true);
  input.resume();
  input.on('data', onData);
  out.on('resize', onResize);
  process.on('exit', () => !closed && restore());
  ticker = setInterval(() => {
    view.tick++;
    if (view.state?.runs.some((r) => r.state === 'running')) draw();
  }, 120);
  void listen();
  draw();
  await done;
}
