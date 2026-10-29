import {
  actionToCommand,
  decodeAction,
  encodeAction,
  HELP_TEXT,
  normalizeCommandText,
  parseCommand,
  type ChatGateway,
  type Inbound,
  type OutboundMessage,
} from '@hyde/core';
import bolt from '@slack/bolt';

// Slack console over Socket Mode (no public URL). One thread per task: replies stay in the
// thread the task came from. Slack reserves "/" commands, so use "hyde new …" or "!new …".

export interface SlackOptions {
  botToken: string;
  appToken: string;
  allowedUserIds: string[];
  callbackSecret: string;
  log?: (msg: string) => void;
}

/** Slack Block Kit for a message with buttons; every button value is signed. */
export function toBlocks(message: OutboundMessage, secret: string): unknown[] {
  const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: message.text.slice(0, 2900) } }];
  for (const row of message.buttons ?? []) {
    blocks.push({
      type: 'actions',
      elements: row.map((b, i) => ({
        type: 'button',
        text: { type: 'plain_text', text: b.label.slice(0, 75) },
        action_id: `hyde_${i}_${encodeAction(secret, b.action).slice(-12)}`,
        value: encodeAction(secret, b.action),
      })),
    });
  }
  return blocks;
}

export class SlackGateway implements ChatGateway {
  readonly name = 'slack';
  private readonly app: InstanceType<typeof bolt.App>;
  private readonly log: (msg: string) => void;

  constructor(private readonly options: SlackOptions) {
    this.app = new bolt.App({ token: options.botToken, appToken: options.appToken, socketMode: true });
    this.log = options.log ?? (() => {});
  }

  async start(onInbound: (inbound: Inbound) => Promise<string | void>): Promise<void> {
    this.app.message(async ({ message, say }) => {
      const m = message as { user?: string; text?: string; channel: string; ts: string; thread_ts?: string; subtype?: string; bot_id?: string };
      if (m.subtype || m.bot_id || !m.user || !m.text) return;
      const thread = m.thread_ts ?? m.ts;
      const command = parseCommand(normalizeCommandText(m.text));
      if (!command) return; // ordinary chat in the channel
      if (!this.options.allowedUserIds.includes(m.user)) {
        await say({ text: `Not authorised. Your Slack user id is ${m.user}.`, thread_ts: thread });
        return;
      }
      const reply =
        command.kind === 'help'
          ? HELP_TEXT
          : await this.run(onInbound, { command, userId: `slack:${m.user}`, gateway: 'slack', chatId: `${m.channel}:${thread}`, commandId: `slack:${m.channel}:${m.ts}` });
      if (reply) await say({ text: reply, thread_ts: thread });
    });

    this.app.action(/^hyde_/, async ({ ack, body, action, respond }) => {
      await ack();
      const user = (body as { user?: { id?: string } }).user?.id ?? '';
      if (!this.options.allowedUserIds.includes(user)) return;
      const decoded = decodeAction(this.options.callbackSecret, String((action as { value?: string }).value ?? ''));
      if (!decoded) return;
      const b = body as { channel?: { id?: string }; message?: { ts?: string; thread_ts?: string }; actions?: { action_ts?: string }[] };
      const thread = b.message?.thread_ts ?? b.message?.ts ?? '';
      const reply = await this.run(onInbound, {
        command: actionToCommand(decoded),
        userId: `slack:${user}`,
        gateway: 'slack',
        chatId: `${b.channel?.id}:${thread}`,
        commandId: `slack:action:${b.actions?.[0]?.action_ts ?? Date.now()}`,
      });
      if (reply) await respond({ text: reply, replace_original: false, thread_ts: thread } as never);
    });

    await this.app.start();
    this.log('slack: connected over Socket Mode');
  }

  async send(chatId: string, message: OutboundMessage): Promise<void> {
    const [channel, thread] = chatId.split(':');
    await this.app.client.chat.postMessage({
      channel: channel!,
      text: message.text.slice(0, 3000),
      blocks: toBlocks(message, this.options.callbackSecret) as never,
      ...(thread && { thread_ts: thread }),
    });
    for (const image of message.images ?? []) {
      await this.app.client.files.uploadV2({ channel_id: channel!, file: image.path, title: image.caption ?? 'screenshot', ...(thread && { thread_ts: thread }) } as never);
    }
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }

  private async run(onInbound: (i: Inbound) => Promise<string | void>, inbound: Inbound): Promise<string | void> {
    try {
      return await onInbound(inbound);
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  }
}
