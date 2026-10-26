import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ButtonAction, Command } from '@hyde/core';

/** Parses a chat command. Returns null for text that is not a command. */
export function parseCommand(text: string): Command | null {
  const trimmed = text.trim();
  const match = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  const rest = (match[2] ?? '').trim();
  switch (name) {
    case 'new': {
      if (!rest) return { kind: 'help' };
      const tag = /(?:^|\s)#([\w.-]+)\s*$/.exec(rest);
      const body = tag ? rest.slice(0, tag.index).trim() : rest;
      if (!body) return { kind: 'help' };
      return tag ? { kind: 'new', text: body, project: tag[1]! } : { kind: 'new', text: body };
    }
    case 'status':
      return { kind: 'status' };
    case 'projects':
      return { kind: 'projects' };
    case 'stop': {
      if (/^all$/i.test(rest)) return { kind: 'stop', target: 'all' };
      const id = /^T-\d+$/i.exec(rest);
      return id ? { kind: 'stop', target: rest.toUpperCase() } : { kind: 'help' };
    }
    case 'answer': {
      const m = /^(Q-\d+)\s+([\s\S]+)$/i.exec(rest);
      return m ? { kind: 'answer', questionId: m[1]!.toUpperCase(), text: m[2]!.trim() } : { kind: 'help' };
    }
    case 'approve':
    case 'deny': {
      const m = /^A-\d+$/i.exec(rest);
      return m ? { kind: 'decide', approvalId: rest.toUpperCase(), approved: name === 'approve' } : { kind: 'help' };
    }
    case 'help':
    case 'start':
      return { kind: 'help' };
    default:
      return { kind: 'help' };
  }
}

export const HELP_TEXT = [
  'Hyde Code commands:',
  '/new <task> #project: start a task (#project optional when there is one project)',
  '/status: running tasks and what each agent is doing',
  '/projects: registered projects',
  '/stop T-3, /stop all: interrupt runs cleanly',
  '/answer Q-2 <text>: answer a question (or reply to the question message)',
  '/approve A-1, /deny A-1: decide an approval',
].join('\n');

// Callback data is signed so a forged button press can't approve anything. Telegram allows
// 64 bytes: "a|Q-123|2|<12 sig chars>" or "d|A-123|1|<12 sig chars>".

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 12);
}

export function encodeAction(secret: string, action: ButtonAction): string {
  const payload =
    action.kind === 'answer'
      ? `a|${action.questionId}|${action.option}`
      : `d|${action.approvalId}|${action.approved ? 1 : 0}`;
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
  if (kind === 'a' && /^Q-\d+$/.test(id) && /^\d$/.test(value)) {
    return { kind: 'answer', questionId: id, option: Number(value) };
  }
  if (kind === 'd' && /^A-\d+$/.test(id) && (value === '0' || value === '1')) {
    return { kind: 'decide', approvalId: id, approved: value === '1' };
  }
  return null;
}
