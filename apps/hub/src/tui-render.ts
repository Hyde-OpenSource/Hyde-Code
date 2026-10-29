import { agentActivity, describeEvent, openItems, sessionLine, type AgentActivity, type FeedEvent, type StateSnapshot } from '@hyde/core';

// The terminal office. Pure: (view, size) -> lines. tui.ts does the I/O.
// Lines are built from styled segments so width math ignores colour codes.

export interface TuiAgent {
  name: string;
  adapter: string;
  enabled: boolean;
  model?: string;
  account: string;
  node: string;
  vendor: string;
  health: { installed: boolean; signedIn: boolean; problem?: string } | null;
}

export type TuiState = StateSnapshot & {
  agents: TuiAgent[];
  projects: { id: string; baseBranch: string }[];
  metrics: { agent: string; runs: number; successRate: number; tasksDone: number; inputTokens: number; outputTokens: number }[];
};

export const SCREENS = ['office', 'board', 'inbox', 'activity', 'usage'] as const;
export type Screen = (typeof SCREENS)[number] | 'task';

export interface TuiView {
  state: TuiState | null;
  feed: FeedEvent[];
  screen: Screen;
  cursor: number;
  /** Task shown on the task screen, or whose session is shown on the office screen. */
  taskId?: string;
  session: FeedEvent[];
  input?: { label: string; text: string };
  flash?: string;
  connected: boolean;
  tick: number;
  color: boolean;
}

type Style = 'accent' | 'accentBg' | 'dim' | 'ok' | 'warn' | 'bad' | 'info' | 'crt' | 'bold' | 'inverse' | 'plain';
interface Seg {
  text: string;
  style?: Style;
}
type Line = Seg[];

const SGR: Record<Style, string> = {
  accent: '38;2;242;181;68',
  accentBg: '48;2;242;181;68;38;2;35;24;4;1',
  dim: '38;2;140;138;155',
  ok: '38;2;124;219;149',
  warn: '38;2;255;169;94',
  bad: '38;2;255;122;122',
  info: '38;2;124;188;255',
  crt: '38;2;124;242;154',
  bold: '1',
  inverse: '7',
  plain: '',
};

const s = (text: string, style?: Style): Seg => ({ text, style });

/** Visible width: one column per code point (we only use single-width symbols). */
export function width(text: string): number {
  return [...text].length;
}

function clip(text: string, n: number): string {
  const chars = [...text];
  if (chars.length <= n) return text;
  return n <= 1 ? chars.slice(0, n).join('') : `${chars.slice(0, n - 1).join('')}…`;
}

/** Renders one line exactly `cols` wide (truncated or padded). */
export function paint(line: Line, cols: number, color: boolean, fill?: Style): string {
  let out = '';
  let used = 0;
  for (const seg of line) {
    if (used >= cols) break;
    const text = clip(seg.text.replace(/[\r\n\t]/g, ' '), cols - used);
    used += width(text);
    const style = seg.style ?? fill;
    out += color && style && SGR[style] ? `\x1b[${SGR[style]}m${text}\x1b[0m` : text;
  }
  if (used < cols) {
    const pad = ' '.repeat(cols - used);
    out += color && fill && SGR[fill] ? `\x1b[${SGR[fill]}m${pad}\x1b[0m` : pad;
  }
  return out;
}

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const MOOD: Record<AgentActivity['mood'], { label: string; style: Style; icon: string }> = {
  off: { label: 'off', style: 'dim', icon: '-' },
  broken: { label: 'needs setup', style: 'bad', icon: '!' },
  'needs-you': { label: 'needs you', style: 'warn', icon: '?' },
  working: { label: 'working', style: 'accent', icon: '»' },
  planning: { label: 'planning', style: 'info', icon: '✎' },
  reviewing: { label: 'reviewing', style: 'info', icon: '◎' },
  idle: { label: 'free', style: 'ok', icon: '·' },
};

export function activities(state: TuiState): AgentActivity[] {
  return state.agents.map((a) => agentActivity(state, a));
}

/** Items on the inbox screen, in the order the cursor walks them. */
export function inboxEntries(state: TuiState) {
  const o = openItems(state);
  const merges = state.tasks.filter((t) => t.status === 'awaiting_merge' && t.prUrl && !t.children.length);
  return [
    ...o.approvals.map((a) => ({ kind: 'approval' as const, id: a.id, taskId: a.taskId, title: `${a.kind.replace('-', ' ')}: ${a.summary}`, options: [] as string[] })),
    ...o.questions.map((q) => ({ kind: 'question' as const, id: q.id, taskId: q.taskId, title: q.text, options: q.options })),
    ...merges.map((t) => ({ kind: 'merge' as const, id: t.id, taskId: t.id, title: `ready to merge into ${t.baseBranch}: ${t.title}`, options: [] as string[] })),
    ...o.lessons.map((l) => ({ kind: 'lesson' as const, id: l.id, taskId: l.taskId, title: `lesson from ${l.by}: ${l.text}`, options: [] as string[] })),
  ];
}

const BOARD: [string, string[]][] = [
  ['PLANNING', ['backlog', 'clarifying', 'ready']],
  ['RUNNING', ['running']],
  ['CHECKING', ['verifying', 'review']],
  ['TO MERGE', ['awaiting_merge']],
  ['DONE', ['done']],
];

export function boardTasks(state: TuiState) {
  const placed = (t: TuiState['tasks'][number]) => (t.status === 'blocked' || t.status === 'failed' ? (t.statusHistory.at(-1)?.from ?? 'running') : t.status);
  return BOARD.map(([title, statuses]) => ({ title, tasks: state.tasks.filter((t) => t.status !== 'cancelled' && statuses.includes(placed(t))) }));
}

function bar(value: number, n: number): Line {
  const filled = Math.round(Math.min(1, Math.max(0, value)) * n);
  const style: Style = value >= 0.95 ? 'bad' : value >= 0.8 ? 'warn' : 'ok';
  return [s('█'.repeat(filled), style), s('░'.repeat(n - filled), 'dim')];
}

function header(v: TuiView, count: number): Line {
  const tabs: Line = [];
  SCREENS.forEach((id, i) => {
    const label = `${i + 1} ${id[0]!.toUpperCase()}${id.slice(1)}${id === 'inbox' && count ? ` (${count})` : ''}`;
    const on = v.screen === id || (v.screen === 'task' && id === 'board');
    tabs.push(s(` ${label} `, on ? 'accentBg' : id === 'inbox' && count ? 'warn' : 'dim'), s(' '));
  });
  return [s(' ▣ HYDE CODE ', 'accentBg'), s('  '), ...tabs];
}

function footer(v: TuiView): Line {
  if (v.input) return [s(` ${v.input.label} `, 'accentBg'), s(' '), s(v.input.text), s('▏', 'accent'), s('   enter send · esc cancel', 'dim')];
  if (v.flash) return [s(' ', 'plain'), s(v.flash, 'accent')];
  const keys: Record<string, string> = {
    office: '↑↓ pick agent · enter session · n new task',
    board: '↑↓ pick task · enter open · s stop · t retry',
    inbox: '↑↓ pick · a approve/merge · d deny · r reply · 1-4 option',
    activity: '↑↓ scroll',
    usage: '',
    task: 'esc back · m merge · s stop · t retry',
  };
  return [s(` ${v.connected ? '● live' : '○ reconnecting'} `, v.connected ? 'ok' : 'warn'), s(` ${keys[v.screen]} · : command · w web · q quit`, 'dim')];
}

function box(title: string, lines: Line[], w: number, h: number, accent = false): Line[] {
  const inner = Math.max(0, w - 2);
  const out: Line[] = [[s('┌─', 'dim'), s(` ${title} `, accent ? 'accent' : 'bold'), s(`${'─'.repeat(Math.max(0, inner - width(title) - 3))}┐`, 'dim')]];
  for (let i = 0; i < h - 2; i++) {
    const body = lines[i] ?? [];
    let used = 0;
    const clipped: Line = [];
    for (const seg of body) {
      if (used >= inner) break;
      const text = clip(seg.text, inner - used);
      used += width(text);
      clipped.push({ ...seg, text });
    }
    out.push([s('│', 'dim'), ...clipped, s(' '.repeat(inner - used)), s('│', 'dim')]);
  }
  out.push([s(`└${'─'.repeat(inner)}┘`, 'dim')]);
  return out;
}

/** Joins boxes side by side. */
function beside(cols: Line[][]): Line[] {
  const h = Math.max(...cols.map((c) => c.length));
  const out: Line[] = [];
  for (let i = 0; i < h; i++) out.push(cols.flatMap((c) => c[i] ?? []));
  return out;
}

function officeScreen(v: TuiView, state: TuiState, cols: number, rows: number): Line[] {
  const acts = activities(state);
  const spin = SPIN[v.tick % SPIN.length]!;
  const person = (a: AgentActivity): Line => {
    const m = MOOD[a.mood];
    return [s(` ${a.mood === 'working' ? spin : m.icon} `, m.style), s(a.name, a.mood === 'off' ? 'dim' : 'bold'), s(a.taskId ? ` ${a.taskId}` : '', 'dim')];
  };
  const inRoom = (spots: string[]) => acts.filter((a) => spots.includes(a.spot)).map(person);
  const count = inboxEntries(state).length;
  const inPlay = state.tasks.filter((t) => !['done', 'cancelled'].includes(t.status)).length;

  // The floor: four rooms, each listing who is in it.
  const roomH = Math.max(4, Math.min(state.agents.length + 3, 8));
  const w = Math.floor(cols / 4);
  const floor = beside([
    box("Hyde's office", [[s(' ◆ ', 'accent'), s('Hyde', 'bold'), s(' (hub)', 'dim')], [s(`   ${inPlay} tasks in play`, 'dim')], [s(count ? `   ✉ ${count} on your desk` : '   your desk is clear', count ? 'warn' : 'dim')]], w, roomH, true),
    box('Desks', inRoom(['desk']), w, roomH),
    box('War room', inRoom(['whiteboard', 'review']), w, roomH),
    box('Kitchen · free', inRoom(['coffee', 'away']), cols - 3 * w, roomH),
  ]);

  // The team table, with the cursor.
  const team: Line[] = [[s('   AGENT          STATE        TASK    DOING', 'dim')]];
  acts.forEach((a, i) => {
    const agent = state.agents[i]!;
    const m = MOOD[a.mood];
    const quotas = state.quotas.filter((q) => q.account === agent.account);
    const max = Math.max(0, ...quotas.map((q) => q.utilization ?? 0));
    const sel = i === v.cursor;
    team.push([
      s(sel ? ' ▶ ' : '   ', 'accent'),
      s(clip(a.name, 14).padEnd(15), sel ? 'accent' : 'bold'),
      s(`${a.mood === 'working' ? spin : m.icon} ${m.label}`.padEnd(13), m.style),
      s((a.taskId ?? '').padEnd(8), 'dim'),
      s('quota ', 'dim'),
      ...bar(max, 6),
      s(` ${a.line}`),
    ]);
  });

  // The selected agent's session.
  const sessH = Math.max(3, rows - floor.length - team.length - 1);
  const agent = acts[v.cursor];
  const lines = sessionLines(v.session, sessH - 2);
  const title = agent ? `${agent.name} session${v.taskId ? ` · ${v.taskId}` : ''}` : 'session';
  const sess = box(title, lines.length ? lines : [[s(' No session yet. Pick an agent with ↑↓.', 'dim')]], cols, sessH);
  return [...floor, ...team, [], ...sess];
}

function sessionLines(events: FeedEvent[], n: number): Line[] {
  const out: Line[] = [];
  for (const e of events) {
    const l = sessionLine(e);
    if (!l) continue;
    const style: Style = l.kind === 'tool' ? 'crt' : l.kind === 'ok' ? 'ok' : l.kind === 'bad' ? 'bad' : l.kind === 'meta' ? 'dim' : 'plain';
    for (const part of l.text.split('\n')) if (part.trim()) out.push([s(' '), s(part, style)]);
  }
  return out.slice(-n);
}

function boardScreen(v: TuiView, state: TuiState, cols: number, rows: number): Line[] {
  const columns = boardTasks(state);
  const flat = columns.flatMap((c) => c.tasks);
  const selected = flat[v.cursor];
  const w = Math.floor(cols / columns.length);
  const boxes = columns.map((c, i) => {
    const lines: Line[] = [];
    for (const t of c.tasks) {
      const sel = t === selected;
      const tag = t.status === 'blocked' ? ' ⏸' : t.status === 'failed' ? ' ✗' : '';
      lines.push([s(sel ? '▶' : ' ', 'accent'), s(t.id, sel ? 'accent' : 'bold'), s(tag, t.status === 'failed' ? 'bad' : 'warn'), s(` ${t.agent ?? ''}`, 'dim')]);
      lines.push([s('  '), s(t.title, sel ? 'plain' : 'dim')]);
    }
    return box(`${c.title} ${c.tasks.length}`, lines, i === columns.length - 1 ? cols - w * (columns.length - 1) : w, rows);
  });
  return beside(boxes);
}

function inboxScreen(v: TuiView, state: TuiState, cols: number): Line[] {
  const items = inboxEntries(state);
  if (!items.length) return [[], [s('  Nothing is waiting for you. The team is on it.', 'ok')]];
  const out: Line[] = [[]];
  items.forEach((it, i) => {
    const sel = i === v.cursor;
    const tone: Style = it.kind === 'approval' ? 'warn' : it.kind === 'question' ? 'info' : it.kind === 'merge' ? 'ok' : 'accent';
    out.push([s(sel ? ' ▶ ' : '   ', 'accent'), s(` ${it.kind.toUpperCase()} `, tone), s(` ${it.id} `, 'bold'), s(it.taskId && it.taskId !== it.id ? `${it.taskId} ` : '', 'dim'), s(it.title, sel ? 'plain' : 'dim')]);
    if (sel && it.options.length) out.push([s('      '), ...it.options.flatMap((o, k) => [s(` ${k + 1} `, 'accentBg'), s(` ${o}  `)])]);
    if (sel) {
      const hint = it.kind === 'question' ? 'r reply' : it.kind === 'merge' ? 'a merge' : 'a approve · d deny';
      out.push([s(`      ${hint}`, 'dim')]);
    }
  });
  void cols;
  return out;
}

function activityScreen(v: TuiView, rows: number): Line[] {
  const lines = v.feed.map((e) => ({ e, text: describeEvent(e) })).filter((x) => x.text);
  const n = rows - 2;
  const end = Math.max(0, lines.length - v.cursor);
  return lines.slice(Math.max(0, end - n), end).map(({ e, text }) => [s(` ${e.ts.slice(11, 16)} `, 'dim'), s(text!, e.type.startsWith('question') || e.type.startsWith('approval') ? 'warn' : e.type === 'incident.raised' ? 'bad' : 'plain')]);
}

function usageScreen(state: TuiState): Line[] {
  const out: Line[] = [[]];
  for (const account of [...new Set(state.agents.map((a) => a.account))]) {
    const agents = state.agents.filter((a) => a.account === account).map((a) => a.name);
    out.push([s(`  ${account}`, 'bold'), s(`  ${agents.join(', ')}`, 'dim')]);
    const quotas = state.quotas.filter((q) => q.account === account);
    if (!quotas.length) out.push([s('    no quota data yet', 'dim')]);
    for (const q of quotas) out.push([s(`    ${q.window.replace('_', ' ').padEnd(14)}`), ...bar(q.utilization ?? 0, 24), s(` ${Math.round((q.utilization ?? 0) * 100)}%`)]);
    out.push([]);
  }
  out.push([s('  AGENT          RUNS  SUCCESS  MERGED  TOKENS IN/OUT', 'dim')]);
  for (const m of state.metrics) {
    out.push([s(`  ${m.agent.padEnd(15)}${String(m.runs).padEnd(6)}${`${Math.round(m.successRate * 100)}%`.padEnd(9)}${String(m.tasksDone).padEnd(8)}${m.inputTokens.toLocaleString()} / ${m.outputTokens.toLocaleString()}`)]);
  }
  return out;
}

function taskScreen(v: TuiView, state: TuiState, cols: number, rows: number): Line[] {
  const t = state.tasks.find((x) => x.id === v.taskId);
  if (!t) return [[s(`  No task ${v.taskId}`, 'bad')]];
  const out: Line[] = [
    [],
    [s(`  ${t.id} `, 'accent'), s(t.title, 'bold')],
    [s(`  ${t.status.replace('_', ' ')}`, t.status === 'failed' ? 'bad' : t.status === 'done' ? 'ok' : 'accent'), s(`  #${t.projectId}${t.agent ? ` · ${t.agent}` : ''}${t.branch ? ` · ${t.branch}` : ''}`, 'dim')],
  ];
  if (t.prUrl) out.push([s(`  PR ${t.prUrl}`, 'info')]);
  if (t.doneWhen) out.push([s('  done when: ', 'dim'), s(t.doneWhen)]);
  const review = t.reviews.at(-1);
  if (review) out.push([s(`  review by ${review.reviewer}: `, 'dim'), s(review.verdict, review.verdict === 'approve' ? 'ok' : 'warn'), s(` ${review.summary}`, 'dim')]);
  if (t.checks) out.push([s('  checks: ', 'dim'), ...t.checks.results.map((r) => s(`${r.ok ? '✓' : '✗'} ${r.command}  `, r.ok ? 'ok' : 'bad'))]);
  out.push([]);
  const sessH = Math.max(3, rows - out.length - 2);
  return [...out, ...box('transcript', sessionLines(v.session, sessH - 2), cols, sessH)];
}

/** The whole frame, exactly rows × cols. */
export function render(v: TuiView, cols: number, rows: number): string[] {
  if (!v.state) {
    return [paint(header(v, 0), cols, v.color, 'plain'), paint([s(v.connected ? '  Loading…' : '  Connecting to the hub…', 'dim')], cols, v.color), ...Array(Math.max(0, rows - 3)).fill(' '.repeat(cols)), paint(footer(v), cols, v.color)];
  }
  const state = v.state;
  const count = inboxEntries(state).length;
  const bodyRows = rows - 2;
  const body =
    v.screen === 'board'
      ? boardScreen(v, state, cols, bodyRows)
      : v.screen === 'inbox'
        ? inboxScreen(v, state, cols)
        : v.screen === 'activity'
          ? activityScreen(v, bodyRows)
          : v.screen === 'usage'
            ? usageScreen(state)
            : v.screen === 'task'
              ? taskScreen(v, state, cols, bodyRows)
              : officeScreen(v, state, cols, bodyRows);
  const lines = [paint(header(v, count), cols, v.color, 'plain')];
  for (let i = 0; i < bodyRows; i++) lines.push(paint(body[i] ?? [], cols, v.color));
  lines.push(paint(footer(v), cols, v.color));
  return lines;
}

/** How many items the cursor can walk on the current screen. */
export function cursorLimit(v: TuiView): number {
  if (!v.state) return 0;
  if (v.screen === 'office') return v.state.agents.length;
  if (v.screen === 'board') return boardTasks(v.state).flatMap((c) => c.tasks).length;
  if (v.screen === 'inbox') return inboxEntries(v.state).length;
  if (v.screen === 'activity') return v.feed.length;
  return 0;
}
