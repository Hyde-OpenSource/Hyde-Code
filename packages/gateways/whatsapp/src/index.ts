import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ChatGateway, Inbound, OutboundMessage } from '@hyde/core';

// WhatsApp Cloud API (official) for client-message intake and short status notes only.
// Meta banned general-purpose AI chatbots on the Business API from Jan 15, 2026; this is a
// business task (intake and notifications). Client messages become client tasks the owner must
// accept, and replies to clients are drafted for the owner, never sent automatically.

export interface WhatsAppOptions {
  token: string;
  phoneNumberId: string;
  verifyToken: string;
  appSecret: string;
  /** Numbers (E.164 without +) whose messages are accepted as client intake. */
  clients: string[];
  graphVersion?: string;
  log?: (msg: string) => void;
  fetch?: typeof fetch;
}

export interface IncomingMessage {
  id: string;
  from: string;
  name?: string;
  text: string;
}

/** GET verification handshake: returns the challenge to echo, or null to refuse. */
export function verifyChallenge(query: Record<string, string | undefined>, verifyToken: string): string | null {
  return query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === verifyToken ? (query['hub.challenge'] ?? '') : null;
}

/** X-Hub-Signature-256 check over the raw request body. */
export function verifySignature(rawBody: string, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', appSecret).update(rawBody).digest('hex'));
  const given = Buffer.from(header.slice(7));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function parseWebhook(body: unknown): IncomingMessage[] {
  const out: IncomingMessage[] = [];
  const entries = (body as { entry?: { changes?: { value?: Record<string, any> }[] }[] })?.entry ?? [];
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const names = new Map<string, string>((value.contacts ?? []).map((c: any) => [String(c.wa_id), String(c.profile?.name ?? '')]));
      for (const m of value.messages ?? []) {
        const text = m.type === 'text' ? m.text?.body : m.type === 'button' ? m.button?.text : m.type === 'interactive' ? (m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title) : undefined;
        if (!text) continue;
        out.push({ id: String(m.id), from: String(m.from), text: String(text), ...(names.get(String(m.from)) && { name: names.get(String(m.from))! }) });
      }
    }
  }
  return out;
}

export class WhatsAppGateway implements ChatGateway {
  readonly name = 'whatsapp';
  private onInbound: ((inbound: Inbound) => Promise<string | void>) | undefined;
  private readonly log: (msg: string) => void;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: WhatsAppOptions) {
    this.log = options.log ?? (() => {});
    this.fetch = options.fetch ?? fetch;
  }

  async start(onInbound: (inbound: Inbound) => Promise<string | void>): Promise<void> {
    this.onInbound = onInbound;
    this.log(`whatsapp: webhook ready for ${this.options.clients.length} client number(s)`);
  }

  verify(query: Record<string, string | undefined>): string | null {
    return verifyChallenge(query, this.options.verifyToken);
  }

  /** Handles a webhook POST. Returns false when the signature is wrong (respond 401). */
  async handleWebhook(rawBody: string, signature: string | undefined): Promise<boolean> {
    if (!verifySignature(rawBody, signature, this.options.appSecret)) return false;
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return true;
    }
    for (const m of parseWebhook(body)) {
      if (!this.options.clients.includes(m.from)) {
        this.log(`whatsapp: ignored a message from ${m.from}, not a known client number`);
        continue;
      }
      const text = `${m.name ? `${m.name} (+${m.from})` : `+${m.from}`} wrote on WhatsApp:\n\n${m.text}`;
      await this.onInbound?.({ command: { kind: 'client', text }, userId: `wa:${m.from}`, gateway: 'whatsapp', chatId: '', commandId: `wa:${m.id}` });
    }
    return true;
  }

  /** Short status notes only (no buttons on WhatsApp). */
  async send(chatId: string, message: OutboundMessage): Promise<void> {
    const res = await this.fetch(`https://graph.facebook.com/${this.options.graphVersion ?? 'v21.0'}/${this.options.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.options.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: chatId, type: 'text', text: { body: message.text.slice(0, 4000), preview_url: false } }),
    });
    if (!res.ok) throw new Error(`WhatsApp send failed: HTTP ${res.status}`);
  }

  async stop(): Promise<void> {}
}
