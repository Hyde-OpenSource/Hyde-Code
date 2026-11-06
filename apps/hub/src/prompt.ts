// Small interactive prompts for the `hyde` command: a boxed message and an arrow-key menu,
// in the style of other agent CLIs. Falls back to a numbered question when stdin is not a TTY.

import { createInterface } from 'node:readline/promises';

const color = !process.env.NO_COLOR && process.stdout.isTTY;
const sgr = (code: string) => (text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
export const c = {
  bold: sgr('1'),
  dim: sgr('2'),
  accent: sgr('38;2;242;181;68'),
  ok: sgr('38;2;124;219;149'),
  warn: sgr('38;2;255;169;94'),
  bad: sgr('38;2;255;122;122'),
  link: sgr('4;38;2;124;188;255'),
};

const visible = (s: string) => [...s.replace(/\x1b\[[0-9;]*m/g, '')].length;

/** Prints lines inside a rounded box sized to the terminal. */
export function box(lines: string[], tone: (s: string) => string = c.accent): void {
  const width = Math.min(Math.max(...lines.map(visible), 40) + 4, (process.stdout.columns || 100) - 2);
  const inner = width - 4;
  const wrap = (line: string): string[] => {
    if (visible(line) <= inner) return [line];
    const out: string[] = [];
    let cur = '';
    for (const word of line.split(' ')) {
      if (visible(cur) + visible(word) + 1 > inner && cur) {
        out.push(cur);
        cur = word;
      } else cur = cur ? `${cur} ${word}` : word;
    }
    if (cur) out.push(cur);
    return out;
  };
  console.log(tone(`╭${'─'.repeat(width - 2)}╮`));
  for (const line of lines.flatMap(wrap)) console.log(`${tone('│')} ${line}${' '.repeat(Math.max(0, inner - visible(line)))} ${tone('│')}`);
  console.log(tone(`╰${'─'.repeat(width - 2)}╯`));
}

/** Arrow-key menu. Returns the chosen index, or -1 on Esc / Ctrl+C. */
export async function choose(options: string[], initial = 0): Promise<number> {
  const input = process.stdin;
  if (!input.isTTY) {
    options.forEach((o, i) => console.log(`  ${i + 1}. ${o}`));
    const rl = createInterface({ input, output: process.stdout });
    const a = Number((await rl.question('Choose a number: ')).trim());
    rl.close();
    return Number.isInteger(a) && a >= 1 && a <= options.length ? a - 1 : -1;
  }
  let sel = initial;
  const draw = (first: boolean) => {
    if (!first) process.stdout.write(`\x1b[${options.length}A`);
    options.forEach((o, i) => process.stdout.write(`\x1b[2K${i === sel ? c.accent(`❯ ${i + 1}. ${o}`) : `  ${i + 1}. ${o}`}\n`));
  };
  process.stdout.write('\x1b[?25l');
  draw(true);
  input.setRawMode(true);
  input.resume();
  return new Promise((done) => {
    const finish = (n: number) => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write('\x1b[?25h');
      done(n);
    };
    const onData = (buf: Buffer) => {
      const k = buf.toString('utf8');
      if (k === '\x1b[A' || k === 'k') sel = (sel - 1 + options.length) % options.length;
      else if (k === '\x1b[B' || k === 'j') sel = (sel + 1) % options.length;
      else if (/^[1-9]$/.test(k) && Number(k) <= options.length) {
        sel = Number(k) - 1;
        draw(false);
        return finish(sel);
      } else if (k === '\r' || k === '\n') return finish(sel);
      else if (k === '\x1b' || k === '\x03' || k === 'q') return finish(-1);
      draw(false);
    };
    input.on('data', onData);
  });
}
