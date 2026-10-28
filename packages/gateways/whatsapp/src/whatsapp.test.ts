import { createHmac } from 'node:crypto';
import type { Inbound } from '@hyde/core';
import { describe, expect, it } from 'vitest';
import { parseWebhook, verifyChallenge, verifySignature, WhatsAppGateway } from './index.ts';

const body = {
  entry: [
    {
      changes: [
        {
          value: {
            contacts: [{ wa_id: '911234567890', profile: { name: 'Asha' } }],
            messages: [
              { id: 'wamid.1', from: '911234567890', type: 'text', text: { body: 'Please change the logo' } },
              { id: 'wamid.2', from: '15550000000', type: 'text', text: { body: 'spam' } },
              { id: 'wamid.3', from: '911234567890', type: 'image', image: {} },
            ],
          },
        },
      ],
    },
  ],
};
const sign = (raw: string) => `sha256=${createHmac('sha256', 'app-secret').update(raw).digest('hex')}`;

describe('WhatsApp intake', () => {
  it('verifies the webhook handshake and signatures', () => {
    expect(verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'v', 'hub.challenge': '42' }, 'v')).toBe('42');
    expect(verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'x', 'hub.challenge': '42' }, 'v')).toBeNull();
    expect(verifySignature('{}', sign('{}'), 'app-secret')).toBe(true);
    expect(verifySignature('{}', sign('{"a":1}'), 'app-secret')).toBe(false);
    expect(verifySignature('{}', undefined, 'app-secret')).toBe(false);
  });

  it('parses text messages with sender names', () => {
    expect(parseWebhook(body)).toEqual([
      { id: 'wamid.1', from: '911234567890', name: 'Asha', text: 'Please change the logo' },
      { id: 'wamid.2', from: '15550000000', text: 'spam' },
    ]);
  });

  it('turns known clients\' messages into client commands and ignores everyone else', async () => {
    const seen: Inbound[] = [];
    const g = new WhatsAppGateway({ token: 't', phoneNumberId: 'p', verifyToken: 'v', appSecret: 'app-secret', clients: ['911234567890'] });
    await g.start(async (i) => void seen.push(i));
    const raw = JSON.stringify(body);
    expect(await g.handleWebhook(raw, 'sha256=bad')).toBe(false);
    expect(await g.handleWebhook(raw, sign(raw))).toBe(true);
    expect(seen).toEqual([
      { command: { kind: 'client', text: 'Asha (+911234567890) wrote on WhatsApp:\n\nPlease change the logo' }, userId: 'wa:911234567890', gateway: 'whatsapp', chatId: '', commandId: 'wa:wamid.1' },
    ]);
  });

  it('sends text through the Graph API', async () => {
    const calls: { url: string; body: string }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const g = new WhatsAppGateway({ token: 't', phoneNumberId: 'p1', verifyToken: 'v', appSecret: 's', clients: [], fetch: fake });
    await g.send('911', { text: 'T-1 is done' });
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v21.0/p1/messages');
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ to: '911', text: { body: 'T-1 is done' } });
  });
});
