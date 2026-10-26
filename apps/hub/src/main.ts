import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { ClaudeCodeAdapter } from '@hyde/adapter-claude-code';
import { EventStore, type OutboundMessage } from '@hyde/core';
import { TelegramGateway } from '@hyde/gateway-telegram';
import { HOOK_MARKER, prePushHook } from '@hyde/policy';
import { installPrePushHook } from '@hyde/workspace';
import { loadConfig, persistedSecret } from './config.ts';
import { createApi } from './http.ts';
import { Orchestrator } from './orchestrator.ts';

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const config = loadConfig();

const adapter = new ClaudeCodeAdapter();
const detected = await adapter.detect();
if (!detected.installed) throw new Error('Claude Code (claude) is not installed on this machine.');
if (!detected.signedIn) throw new Error('Claude Code is not signed in. Run `claude` once and sign in with your subscription.');
log(`claude ${detected.version} signed in (${detected.account})`);

for (const project of config.projects) {
  const result = await installPrePushHook(project.path, prePushHook(), HOOK_MARKER);
  log(`#${project.id}: protected-branch pre-push hook ${result}`);
  if (result === 'skipped-existing-hook') {
    log(`#${project.id}: WARNING: a pre-push hook already exists, so the guard was not installed. Add GitHub branch protection.`);
  }
}

const store = new EventStore(join(config.dataDir, 'events.db'));
const gateway = config.telegram
  ? new TelegramGateway({
      token: config.telegram.token,
      allowedUserIds: config.telegram.allowedUserIds,
      callbackSecret: config.callbackSecret,
      pairingFile: join(config.dataDir, 'telegram-paired.json'),
      log,
    })
  : undefined;

const notify = async (chatId: string | undefined, message: OutboundMessage) => {
  if (gateway && chatId) await gateway.send(chatId, message);
  else log(`[notify] ${message.text.replaceAll('\n', ' | ')}`);
};

const hubUrl = `http://127.0.0.1:${config.port}`;
const orchestrator = new Orchestrator({ config, store, adapter, notify, hubUrl, log });
const ownerToken = persistedSecret(join(config.dataDir, 'owner-token'));
const server = serve({ fetch: createApi(orchestrator, ownerToken).fetch, hostname: '127.0.0.1', port: config.port });
log(`hub API on ${hubUrl}`);

if (gateway) {
  await gateway.start((inbound) => orchestrator.handle(inbound));
  const code = gateway.issuePairingCode();
  if (code) log(`telegram: no allowed users yet. Send this to your bot to pair: /pair ${code}`);
} else {
  log('telegram: TELEGRAM_BOT_TOKEN not set; use the CLI (pnpm hyde ...) instead');
}

orchestrator.start();

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  log('shutting down: interrupting runs');
  await orchestrator.stop();
  await gateway?.stop();
  server.close();
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
