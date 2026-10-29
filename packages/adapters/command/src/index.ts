import { execFileAsync, ProcessAdapter, type Launch, type LaunchWrapper, type LineParser } from '@hyde/adapter-common';
import type { DetectResult, HarnessEvent, RunSpec } from '@hyde/core';

// Fallback for any CLI without a structured interface (docs/plan.md "Anything else"): run it
// non-interactively with the prompt, stream stdout as text, and treat exit code 0 as done.
// `{prompt}` in the command is replaced by the prompt; otherwise the prompt goes on stdin.

export class PlainTextParser implements LineParser {
  private readonly tail: string[] = [];
  private started = false;

  constructor(private readonly runId: string) {}

  parseLine(line: string): HarnessEvent[] {
    const out: HarnessEvent[] = [];
    if (!this.started) {
      this.started = true;
      out.push({ type: 'run.started', sessionRef: this.runId, model: 'command' });
    }
    this.tail.push(line);
    if (this.tail.length > 40) this.tail.shift();
    if (line.trim()) out.push({ type: 'text.delta', text: line });
    return out;
  }

  finish(exit: { code: number | null; signal: string | null }, interrupted: boolean): HarnessEvent[] {
    const head: HarnessEvent[] = this.started ? [] : [{ type: 'run.started', sessionRef: this.runId, model: 'command' }];
    if (interrupted) return [...head, { type: 'run.failed', reason: 'cancelled' }];
    if (exit.code !== 0) return [...head, { type: 'run.failed', reason: 'crashed', detail: `exit code ${exit.code}: ${this.tail.slice(-5).join('\n')}` }];
    return [...head, { type: 'run.completed', summary: this.tail.join('\n').trim() }];
  }
}

export class CommandAdapter extends ProcessAdapter {
  readonly kind = 'command' as const;
  readonly vendor = 'other' as const;
  readonly structuredOutput = false;

  constructor(
    private readonly command: string[],
    options: { wrap?: LaunchWrapper } = {},
  ) {
    super(command[0]!, options);
  }

  async detect(): Promise<DetectResult> {
    try {
      await execFileAsync('sh', ['-c', `command -v "$0"`, this.bin]);
      return { installed: true, signedIn: true, account: this.bin };
    } catch {
      return { installed: false, signedIn: false, problem: `${this.bin} not found on PATH` };
    }
  }

  protected launch(spec: RunSpec): Launch {
    const packet = spec.packetFile ? `Follow the task packet in ${spec.packetFile}.\n\n` : '';
    const prompt = packet + spec.prompt;
    const usesArg = this.command.some((a) => a.includes('{prompt}'));
    const args = this.command.slice(1).map((a) => a.replaceAll('{prompt}', prompt));
    return usesArg ? { command: this.bin, args } : { command: this.bin, args, stdin: prompt };
  }

  protected parser(): LineParser {
    return new PlainTextParser(`cmd-${Date.now()}`);
  }
}
