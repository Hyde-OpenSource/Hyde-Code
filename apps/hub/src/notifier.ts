import type { ChatGateway, OutboundMessage, SourceKind } from '@hyde/core';

// Routes harness messages to the chat they belong to (docs/plan.md "Notifier"): replies go back
// where the task came from, progress is batched into digests, and quiet hours hold everything
// except incidents.

export interface Target {
  gateway: string;
  chatId: string;
}

export interface NotifierOptions {
  gateways: Map<string, ChatGateway>;
  /** "telegram:12345" — where CLI, web, schedule and WhatsApp tasks report. */
  ownerChat?: string;
  quietHours?: { start: string; end: string };
  digestMinutes: number;
  log: (msg: string) => void;
  now?: () => Date;
}

const CHAT_SOURCES: SourceKind[] = ['telegram', 'slack', 'discord'];

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function isQuiet(now: Date, window?: { start: string; end: string }): boolean {
  if (!window) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  const start = minutes(window.start);
  const end = minutes(window.end);
  return start <= end ? t >= start && t < end : t >= start || t < end;
}

export class Notifier {
  private readonly held: { target: Target; message: OutboundMessage }[] = [];
  private readonly digests = new Map<string, { target: Target; lines: string[] }>();
  private lastDigest = 0;
  private readonly now: () => Date;

  constructor(private readonly options: NotifierOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** Where messages about a task go. */
  target(source: { kind: SourceKind; chatId?: string }): Target | undefined {
    if (CHAT_SOURCES.includes(source.kind) && source.chatId && this.options.gateways.has(source.kind)) {
      return { gateway: source.kind, chatId: source.chatId };
    }
    return this.owner();
  }

  owner(): Target | undefined {
    const owner = this.options.ownerChat;
    if (owner) {
      const i = owner.indexOf(':');
      const gateway = owner.slice(0, i);
      if (this.options.gateways.has(gateway)) return { gateway, chatId: owner.slice(i + 1) };
    }
    return undefined;
  }

  async send(target: Target | undefined, message: OutboundMessage): Promise<void> {
    if (!target) {
      this.options.log(`[notify] ${message.text.replaceAll('\n', ' | ')}`);
      return;
    }
    const priority = message.priority ?? 'normal';
    if (priority === 'digest') {
      const key = `${target.gateway}:${target.chatId}`;
      const digest = this.digests.get(key) ?? { target, lines: [] };
      digest.lines.push(message.text);
      this.digests.set(key, digest);
      return;
    }
    if (priority !== 'urgent' && isQuiet(this.now(), this.options.quietHours)) {
      this.held.push({ target, message });
      return;
    }
    await this.deliver(target, message);
  }

  /** Called every tick: releases held messages after quiet hours and sends due digests. */
  async flush(force = false): Promise<void> {
    const quiet = isQuiet(this.now(), this.options.quietHours);
    if (!quiet && this.held.length) {
      for (const { target, message } of this.held.splice(0)) await this.deliver(target, message);
    }
    const due = force || this.now().getTime() - this.lastDigest >= this.options.digestMinutes * 60_000;
    if (!due || quiet) return;
    this.lastDigest = this.now().getTime();
    for (const [key, digest] of this.digests) {
      this.digests.delete(key);
      if (!digest.lines.length) continue;
      await this.deliver(digest.target, { text: `Progress digest:\n${digest.lines.map((l) => `• ${l}`).join('\n')}` });
    }
  }

  private async deliver(target: Target, message: OutboundMessage): Promise<void> {
    const gateway = this.options.gateways.get(target.gateway);
    if (!gateway) {
      this.options.log(`[notify:${target.gateway} missing] ${message.text.replaceAll('\n', ' | ')}`);
      return;
    }
    try {
      await gateway.send(target.chatId, message);
    } catch (err) {
      this.options.log(`notify via ${target.gateway} failed: ${(err as Error).message}`);
    }
  }
}
