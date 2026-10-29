import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { actionToCommand, decodeAction, encodeAction, HELP_TEXT, parseCommand, type ChatGateway, type Inbound, type OutboundMessage } from '@hyde/core';
import { Bot, InputFile, type Context } from 'grammy';

export interface TelegramOptions {
  token: string;
  /** Telegram user ids allowed to command the bot (from config). */
  allowedUserIds: number[];
  /** Secret for signing button callback data. */
  callbackSecret: string;
  /** File that stores user ids paired with a one-time code. */
  pairingFile: string;
  log?: (msg: string) => void;
  /** Tests: record API calls instead of calling Telegram, and don't poll. */
  offline?: { calls: { method: string; payload: unknown }[] };
}

/**
 * Telegram console over long polling, so it works behind a home connection with no public URL.
 * Only allowlisted or paired users can command it; everyone else gets nothing but their id.
 */
export class TelegramGateway implements ChatGateway {
  readonly name = 'telegram';
  private readonly bot: Bot;
  private readonly allowed: Set<number>;
  private pairingCode: string | null = null;
  /** Telegram message id → question id, so a text reply to a question answers it. */
  private readonly questionMessages = new Map<string, string>();
  private readonly log: (msg: string) => void;

  constructor(private readonly options: TelegramOptions) {
    this.bot = new Bot(
      options.token,
      options.offline ? { botInfo: { id: 1, is_bot: true, first_name: 'Hyde', username: 'hyde_test_bot' } as never } : {},
    );
    if (options.offline) {
      const calls = options.offline.calls;
      this.bot.api.config.use(async (_prev, method, payload) => {
        calls.push({ method, payload });
        return { ok: true, result: { message_id: calls.length, date: 0, chat: { id: 0, type: 'private' } } } as never;
      });
    }
    this.allowed = new Set([...options.allowedUserIds, ...readPaired(options.pairingFile)]);
    this.log = options.log ?? (() => {});
  }

  /** A one-time code the owner sends as `/pair <code>`. Only issued while nobody is allowed yet. */
  issuePairingCode(): string | null {
    if (this.allowed.size > 0) return null;
    this.pairingCode = randomBytes(4).toString('hex');
    return this.pairingCode;
  }

  async start(onInbound: (inbound: Inbound) => Promise<string | void>): Promise<void> {
    this.bot.catch((err) => this.log(`telegram error: ${err.message}`));

    this.bot.on('message:text', async (ctx) => {
      const userId = ctx.from.id;
      const text = ctx.message.text;
      if (!this.allowed.has(userId)) {
        const pair = /^\/pair\s+(\S+)/.exec(text);
        if (pair && this.pairingCode && pair[1] === this.pairingCode) {
          this.pairingCode = null;
          this.allowed.add(userId);
          writePaired(this.options.pairingFile, [...this.allowed]);
          await ctx.reply('Paired. You can now command Hyde Code.\n\n' + HELP_TEXT);
        } else {
          await ctx.reply(`Not authorised. Your Telegram user id is ${userId}.`);
        }
        return;
      }
      let command = parseCommand(text);
      const repliedTo = ctx.message.reply_to_message?.message_id;
      const questionId = repliedTo ? this.questionMessages.get(`${ctx.chat.id}:${repliedTo}`) : undefined;
      if (!command && questionId) command = { kind: 'answer', questionId, text };
      if (!command) {
        await ctx.reply('Send a command, or reply to a question message to answer it.\n\n' + HELP_TEXT);
        return;
      }
      if (command.kind === 'help') {
        await ctx.reply(HELP_TEXT);
        return;
      }
      await this.dispatch(ctx, onInbound, { command, ...this.ids(ctx) });
    });

    this.bot.on('callback_query:data', async (ctx) => {
      if (!this.allowed.has(ctx.from.id)) {
        await ctx.answerCallbackQuery({ text: 'Not authorised.' });
        return;
      }
      const action = decodeAction(this.options.callbackSecret, ctx.callbackQuery.data);
      if (!action) {
        await ctx.answerCallbackQuery({ text: 'Invalid or expired button.' });
        return;
      }
      await ctx.answerCallbackQuery();
      await this.dispatch(ctx, onInbound, { command: actionToCommand(action), ...this.ids(ctx) });
    });

    if (this.options.offline) return;
    await this.bot.init();
    this.log(`telegram: polling as @${this.bot.botInfo.username}`);
    // Not awaited: bot.start() resolves only when polling stops.
    void this.bot.start({ drop_pending_updates: false });
  }

  async send(chatId: string, message: OutboundMessage): Promise<void> {
    const keyboard = message.buttons?.map((row) =>
      row.map((b) => ({ text: b.label, callback_data: encodeAction(this.options.callbackSecret, b.action) })),
    );
    const sent = await this.bot.api.sendMessage(chatId, truncate(message.text), {
      ...(keyboard && { reply_markup: { inline_keyboard: keyboard } }),
      link_preview_options: { is_disabled: true },
    });
    if (message.questionId) this.questionMessages.set(`${chatId}:${sent.message_id}`, message.questionId);
    for (const image of message.images ?? []) {
      await this.bot.api.sendPhoto(chatId, new InputFile(image.path), image.caption ? { caption: image.caption.slice(0, 1000) } : {});
    }
  }

  async stop(): Promise<void> {
    if (!this.options.offline) await this.bot.stop();
  }

  /** Feeds one update through the handlers (tests and webhook mode). */
  handleUpdate(update: unknown): Promise<void> {
    return this.bot.handleUpdate(update as never);
  }

  private ids(ctx: Context): { userId: string; gateway: string; chatId: string; commandId: string } {
    return {
      userId: `tg:${ctx.from!.id}`,
      gateway: 'telegram',
      chatId: String(ctx.chat!.id),
      commandId: `tg:${ctx.update.update_id}`,
    };
  }

  private async dispatch(ctx: Context, onInbound: (i: Inbound) => Promise<string | void>, inbound: Inbound) {
    try {
      const reply = await onInbound(inbound);
      if (reply) await ctx.reply(truncate(reply), { link_preview_options: { is_disabled: true } });
    } catch (err) {
      await ctx.reply(`Error: ${(err as Error).message}`);
    }
  }
}

function truncate(text: string): string {
  return text.length > 4000 ? `${text.slice(0, 3990)}\n…` : text;
}

function readPaired(file: string): number[] {
  if (!existsSync(file)) return [];
  try {
    const ids = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(ids) ? ids.filter((n) => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

function writePaired(file: string, ids: number[]): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(ids), { mode: 0o600 });
}
