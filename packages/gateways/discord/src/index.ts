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
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} from 'discord.js';

// Discord console. The bot needs the Message Content intent (docs/plan.md). Commands as text:
// "!new …", "hyde new …" or "/new …" (not registered as Discord slash commands).

export interface DiscordOptions {
  token: string;
  allowedUserIds: string[];
  callbackSecret: string;
  log?: (msg: string) => void;
}

export function toComponents(message: OutboundMessage, secret: string): ActionRowBuilder<ButtonBuilder>[] {
  return (message.buttons ?? []).slice(0, 5).map((row) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      row.slice(0, 5).map((b) =>
        new ButtonBuilder()
          .setCustomId(encodeAction(secret, b.action)) // ≤ 100 chars
          .setLabel(b.label.slice(0, 80))
          .setStyle(b.action.kind === 'decide' && !b.action.approved ? ButtonStyle.Secondary : ButtonStyle.Primary),
      ),
    ),
  );
}

export class DiscordGateway implements ChatGateway {
  readonly name = 'discord';
  private readonly client: Client;
  private readonly log: (msg: string) => void;

  constructor(private readonly options: DiscordOptions) {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
      partials: [Partials.Channel],
    });
    this.log = options.log ?? (() => {});
  }

  async start(onInbound: (inbound: Inbound) => Promise<string | void>): Promise<void> {
    this.client.on(Events.MessageCreate, async (msg) => {
      if (msg.author.bot) return;
      const command = parseCommand(normalizeCommandText(msg.content));
      if (!command) return;
      if (!this.options.allowedUserIds.includes(msg.author.id)) {
        await msg.reply(`Not authorised. Your Discord user id is ${msg.author.id}.`);
        return;
      }
      const reply =
        command.kind === 'help'
          ? HELP_TEXT
          : await this.run(onInbound, { command, userId: `discord:${msg.author.id}`, gateway: 'discord', chatId: msg.channelId, commandId: `discord:${msg.id}` });
      if (reply) await msg.reply(reply.slice(0, 1990));
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isButton()) return;
      if (!this.options.allowedUserIds.includes(interaction.user.id)) {
        await interaction.reply({ content: 'Not authorised.', ephemeral: true });
        return;
      }
      const action = decodeAction(this.options.callbackSecret, interaction.customId);
      if (!action) {
        await interaction.reply({ content: 'Invalid or expired button.', ephemeral: true });
        return;
      }
      await interaction.deferReply();
      const reply = await this.run(onInbound, {
        command: actionToCommand(action),
        userId: `discord:${interaction.user.id}`,
        gateway: 'discord',
        chatId: interaction.channelId,
        commandId: `discord:${interaction.id}`,
      });
      await interaction.editReply(String(reply ?? 'Done.').slice(0, 1990));
    });

    await this.client.login(this.options.token);
    this.log(`discord: logged in as ${this.client.user?.tag}`);
  }

  async send(chatId: string, message: OutboundMessage): Promise<void> {
    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !channel.isSendable()) throw new Error(`Discord channel ${chatId} not found or not writable`);
    await channel.send({
      content: message.text.slice(0, 1990),
      components: toComponents(message, this.options.callbackSecret),
      files: (message.images ?? []).map((i) => new AttachmentBuilder(i.path, i.caption ? { description: i.caption } : {})),
    });
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  private async run(onInbound: (i: Inbound) => Promise<string | void>, inbound: Inbound): Promise<string | void> {
    try {
      return await onInbound(inbound);
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
  }
}
