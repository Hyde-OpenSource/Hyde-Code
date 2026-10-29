import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ButtonAction, Command } from './chat.ts';

// Chat commands shared by every gateway (docs/plan.md "Commands").

/** Parses a chat command. Returns null for text that is not a command. */
export function parseCommand(text: string): Command | null {
  const trimmed = text.trim();
  const match = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  const rest = (match[2] ?? '').trim();
  const taskArg = (): string | null => (/^T-\d+$/i.test(rest) ? rest.toUpperCase() : null);
  switch (name) {
    case 'new':
    case 'client': {
      let body = rest;
      let project: string | undefined;
      let agent: string | undefined;
      // Trailing #project and @agent tags, in any order.
      for (;;) {
        const tag = /(?:^|\s)([#@])([\w.-]+)\s*$/.exec(body);
        if (!tag) break;
        if (tag[1] === '#') project ??= tag[2]!;
        else agent ??= tag[2]!;
        body = body.slice(0, tag.index).trim();
      }
      if (!body) return { kind: 'help' };
      if (name === 'client') return { kind: 'client', text: body, ...(project && { project }) };
      return { kind: 'new', text: body, ...(project && { project }), ...(agent && { agent }) };
    }
    case 'status':
      return { kind: 'status' };
    case 'agents':
      return { kind: 'agents' };
    case 'usage':
      return { kind: 'usage' };
    case 'projects':
      return { kind: 'projects' };
    case 'logs': {
      const id = taskArg();
      return id ? { kind: 'logs', taskId: id } : { kind: 'help' };
    }
    case 'merge': {
      const id = taskArg();
      return id ? { kind: 'merge', taskId: id } : { kind: 'help' };
    }
    case 'retry': {
      const id = taskArg();
      return id ? { kind: 'retry', taskId: id } : { kind: 'help' };
    }
    case 'promote': {
      const tag = /^#?([\w.-]+)$/.exec(rest);
      return tag ? { kind: 'promote', project: tag[1]! } : rest ? { kind: 'help' } : { kind: 'promote' };
    }
    case 'stop': {
      if (/^all$/i.test(rest)) return { kind: 'stop', target: 'all' };
      const id = taskArg();
      return id ? { kind: 'stop', target: id } : { kind: 'help' };
    }
    case 'answer': {
      const m = /^(Q-\d+)\s+([\s\S]+)$/i.exec(rest);
      return m ? { kind: 'answer', questionId: m[1]!.toUpperCase(), text: m[2]!.trim() } : { kind: 'help' };
    }
    case 'approve':
    case 'deny': {
      if (/^A-\d+$/i.test(rest)) return { kind: 'decide', approvalId: rest.toUpperCase(), approved: name === 'approve' };
      if (/^L-\d+$/i.test(rest)) return { kind: 'lesson', lessonId: rest.toUpperCase(), approved: name === 'approve' };
      return { kind: 'help' };
    }
    default:
      return { kind: 'help' };
  }
}

export const HELP_TEXT = [
  'Hyde Code commands:',
  '/new <task> #project @agent: start a task (#project optional with one project, @agent optional)',
  '/client <message> #project: run a client message through the devflow-messages flow',
  '/status: running tasks and what each agent is doing',
  '/agents: roster with vendor, model, state and quota',
  '/usage: quota per account and when each window resets',
  '/logs T-3: the latest activity of a task',
  '/stop T-3, /stop all: interrupt runs cleanly',
  '/retry T-3: try a failed task again',
  '/answer Q-2 <text>: answer a question (or tap a button, or reply to the question)',
  '/approve A-1, /deny A-1: decide an approval (also L-1 for lessons)',
  '/merge T-3: merge a finished task into its base branch (staging)',
  '/promote #project: open and merge staging → main (asks you to confirm)',
  '/projects: registered projects',
].join('\n');

// Callback data is signed so a forged button press can't approve anything. Telegram allows
// 64 bytes: "a|Q-123|2|<12 sig chars>".

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 12);
}

export function encodeAction(secret: string, action: ButtonAction): string {
  const payload =
    action.kind === 'answer'
      ? `a|${action.questionId}|${action.option}`
      : action.kind === 'decide'
        ? `d|${action.approvalId}|${action.approved ? 1 : 0}`
        : action.kind === 'merge'
          ? `m|${action.taskId}|1`
          : `l|${action.lessonId}|${action.approved ? 1 : 0}`;
  return `${payload}|${sign(secret, payload)}`;
}

export function decodeAction(secret: string, data: string): ButtonAction | null {
  const parts = data.split('|');
  if (parts.length !== 4) return null;
  const payload = parts.slice(0, 3).join('|');
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(parts[3]!);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const [kind, id, value] = parts as [string, string, string];
  if (kind === 'a' && /^Q-\d+$/.test(id) && /^\d$/.test(value)) return { kind: 'answer', questionId: id, option: Number(value) };
  if (kind === 'd' && /^A-\d+$/.test(id) && (value === '0' || value === '1')) return { kind: 'decide', approvalId: id, approved: value === '1' };
  if (kind === 'm' && /^T-\d+$/.test(id) && value === '1') return { kind: 'merge', taskId: id };
  if (kind === 'l' && /^L-\d+$/.test(id) && (value === '0' || value === '1')) return { kind: 'lesson', lessonId: id, approved: value === '1' };
  return null;
}

/** Turns a decoded button press into the command it stands for. */
export function actionToCommand(action: ButtonAction): Command {
  switch (action.kind) {
    case 'answer':
      return { kind: 'answer', questionId: action.questionId, text: `#option:${action.option}` };
    case 'decide':
      return { kind: 'decide', approvalId: action.approvalId, approved: action.approved };
    case 'merge':
      return { kind: 'merge', taskId: action.taskId };
    case 'lesson':
      return { kind: 'lesson', lessonId: action.lessonId, approved: action.approved };
  }
}

/**
 * Slack reserves "/" for its own slash commands, so other gateways also accept "!new …" and
 * "hyde new …". Returns the text in "/new …" form, or unchanged.
 */
export function normalizeCommandText(text: string): string {
  const t = text.trim().replace(/^<@[\w]+>\s*/, ''); // a leading bot mention
  const m = /^(?:!|hyde\s+)(\w+)([\s\S]*)$/i.exec(t);
  return m ? `/${m[1]!.toLowerCase()}${m[2]}` : t;
}
