import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAction, type Inbound } from '@hyde/core';
import { afterEach, describe, expect, it } from 'vitest';
import { TelegramGateway } from './gateway.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

let updateId = 0;
const text = (from: number, body: string, replyTo?: number) => ({
  update_id: ++updateId,
  message: {
    message_id: updateId,
    date: 0,
    chat: { id: from, type: 'private' },
    from: { id: from, is_bot: false, first_name: 'U' },
    text: body,
    ...(replyTo && { reply_to_message: { message_id: replyTo, date: 0, chat: { id: from, type: 'private' } } }),
  },
});
const press = (from: number, data: string) => ({
  update_id: ++updateId,
  callback_query: { id: String(updateId), chat_instance: 'c', data, from: { id: from, is_bot: false, first_name: 'U' }, message: { message_id: 1, date: 0, chat: { id: from, type: 'private' } } },
});

async function gateway(allowed: number[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'hyde-tg-'));
  dirs.push(dir);
  const calls: { method: string; payload: any }[] = [];
  const seen: Inbound[] = [];
  const g = new TelegramGateway({ token: 'x', allowedUserIds: allowed, callbackSecret: 's', pairingFile: join(dir, 'paired.json'), offline: { calls } });
  await g.start(async (i) => {
    seen.push(i);
    return `ok ${i.command.kind}`;
  });
  return { g, calls, seen, dir };
}

describe('TelegramGateway', () => {
  it('refuses strangers and pairs the owner with a one-time code', async () => {
    const { g, calls, seen, dir } = await gateway();
    await g.handleUpdate(text(5, '/status'));
    expect(calls.at(-1)!.payload.text).toBe('Not authorised. Your Telegram user id is 5.');
    const code = g.issuePairingCode()!;
    await g.handleUpdate(text(5, '/pair wrong'));
    expect(seen).toHaveLength(0);
    await g.handleUpdate(text(5, `/pair ${code}`));
    expect(calls.at(-1)!.payload.text).toMatch(/^Paired/);
    expect(JSON.parse(readFileSync(join(dir, 'paired.json'), 'utf8'))).toEqual([5]);
    expect(g.issuePairingCode()).toBeNull(); // only while nobody is paired
    await g.handleUpdate(text(5, '/status'));
    expect(seen[0]).toMatchObject({ command: { kind: 'status' }, userId: 'tg:5', gateway: 'telegram', chatId: '5' });
  });

  it('turns replies to a question into answers and signed buttons into commands', async () => {
    const { g, calls, seen } = await gateway([7]);
    await g.send('7', { text: 'Q-1?', questionId: 'Q-1', buttons: [[{ label: 'Yes', action: { kind: 'answer', questionId: 'Q-1', option: 0 } }]] });
    const sent = calls.at(-1)!;
    expect(sent.method).toBe('sendMessage');
    expect(sent.payload.reply_markup.inline_keyboard[0][0].text).toBe('Yes');
    await g.handleUpdate(text(7, 'Use OAuth', calls.length));
    expect(seen.at(-1)!.command).toEqual({ kind: 'answer', questionId: 'Q-1', text: 'Use OAuth' });
    await g.handleUpdate(press(7, encodeAction('s', { kind: 'merge', taskId: 'T-2' })));
    expect(seen.at(-1)!.command).toEqual({ kind: 'merge', taskId: 'T-2' });
    const before = seen.length;
    await g.handleUpdate(press(7, 'm|T-2|1|forgedsig123'));
    await g.handleUpdate(press(8, encodeAction('s', { kind: 'merge', taskId: 'T-2' })));
    expect(seen).toHaveLength(before);
  });

  it('attaches screenshots as photos', async () => {
    const { g, calls } = await gateway([7]);
    await g.send('7', { text: 'done', images: [{ path: __filename, caption: 'T-1 /' }] });
    expect(calls.map((c) => c.method)).toEqual(['sendMessage', 'sendPhoto']);
  });
});
