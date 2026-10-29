import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { EventStore, Registry, type ChatGateway } from '@hyde/core';
import { DiscordGateway } from '@hyde/gateway-discord';
import { SlackGateway } from '@hyde/gateway-slack';
import { TelegramGateway } from '@hyde/gateway-telegram';
import { WhatsAppGateway } from '@hyde/gateway-whatsapp';
import { HOOK_MARKER, prePushHook } from '@hyde/policy';
import { installPrePushHook, LocalHost } from '@hyde/workspace';
import { AgentPool, defaultAdapters } from './agents.ts';
import { loadConfig, persistedSecret, type HubConfig } from './config.ts';
import { detectAll } from './detect.ts';
import { createApi } from './http.ts';
import { NodeHub } from './nodes.ts';
import { Notifier } from './notifier.ts';
import { Orchestrator } from './orchestrator.ts';
import { loadPlugins } from './plugins.ts';
import { startSchedules } from './schedules.ts';

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);
const hydeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const config = loadConfig();
const store = new EventStore(join(config.dataDir, 'events.db'));

// ------------------------------------------------------------ registries and plugins

const adapters = defaultAdapters();
const gatewayFactories = new Registry<(c: HubConfig) => ChatGateway | undefined>('gateway')
  .register('telegram', (c) =>
    c.gateways.telegram && c.secrets.telegramToken
      ? new TelegramGateway({
          token: c.secrets.telegramToken,
          allowedUserIds: c.secrets.telegramAllowedUserIds,
          callbackSecret: c.callbackSecret,
          pairingFile: join(c.dataDir, 'telegram-paired.json'),
          log,
        })
      : undefined,
  )
  .register('slack', (c) =>
    c.gateways.slack && c.secrets.slackBotToken && c.secrets.slackAppToken
      ? new SlackGateway({ botToken: c.secrets.slackBotToken, appToken: c.secrets.slackAppToken, allowedUserIds: c.secrets.slackAllowedUserIds, callbackSecret: c.callbackSecret, log })
      : undefined,
  )
  .register('discord', (c) =>
    c.gateways.discord && c.secrets.discordToken
      ? new DiscordGateway({ token: c.secrets.discordToken, allowedUserIds: c.secrets.discordAllowedUserIds, callbackSecret: c.callbackSecret, log })
      : undefined,
  )
  .register('whatsapp', (c) =>
    c.gateways.whatsapp && c.secrets.whatsappToken && c.secrets.whatsappPhoneId && c.secrets.whatsappVerifyToken && c.secrets.whatsappAppSecret
      ? new WhatsAppGateway({
          token: c.secrets.whatsappToken,
          phoneNumberId: c.secrets.whatsappPhoneId,
          verifyToken: c.secrets.whatsappVerifyToken,
          appSecret: c.secrets.whatsappAppSecret,
          clients: c.secrets.whatsappClients,
          log,
        })
      : undefined,
  );
await loadPlugins(config.plugins, { adapters, gateways: gatewayFactories, config }, log);

// ------------------------------------------------------------ nodes, agents, hosts

const nodeHub = config.nodes.enabled ? new NodeHub(config, store, NodeHub.parseTokens(process.env.HYDE_NODE_TOKENS), log) : undefined;
const pool = new AgentPool(config, adapters, hydeRoot, (profile) => nodeHub?.adapter(profile));
const localHost = new LocalHost();
const host = (node: string) => (node === 'local' || !nodeHub ? localHost : nodeHub.host(node));

await pool.refreshHealth();
for (const p of pool.profiles()) {
  const h = pool.health.get(p.name);
  log(`agent ${p.name} (${p.adapter}${p.model ? `, ${p.model}` : ''}): ${h?.installed && h.signedIn ? `ready${h.version ? ` v${h.version}` : ''}${h.account ? ` as ${h.account}` : ''}` : `unavailable: ${h?.problem ?? 'unknown'}`}`);
}
if (!pool.profiles().some((p) => pool.usable(p.name))) log('WARNING: no enabled agent is usable yet. Run `pnpm hyde setup` or open Settings in the dashboard.');

for (const project of config.projects) {
  const result = await installPrePushHook(project.path, prePushHook(), HOOK_MARKER);
  log(`#${project.id}: protected-branch pre-push hook ${result}`);
  if (result === 'skipped-existing-hook') {
    log(`#${project.id}: WARNING: a pre-push hook already exists, so the guard was not installed. Rely on GitHub branch protection.`);
  }
}

// ------------------------------------------------------------ gateways and orchestrator

const gateways = new Map<string, ChatGateway>();
for (const [name, make] of gatewayFactories.entries()) {
  const g = make(config);
  if (g) gateways.set(name, g);
}
const notifier = new Notifier({
  gateways,
  ...(config.notifications.ownerChat && { ownerChat: config.notifications.ownerChat }),
  ...(config.notifications.quietHours && { quietHours: config.notifications.quietHours }),
  digestMinutes: config.notifications.digestMinutes,
  log,
});

const hubUrl = `http://127.0.0.1:${config.port}`;
const orchestrator = new Orchestrator({
  config,
  store,
  pool,
  notifier,
  host,
  hubUrl,
  hydeRoot,
  tsxLoader: import.meta.resolve('tsx/esm'),
  log,
});

const ownerToken = persistedSecret(join(config.dataDir, 'owner-token'));
const whatsapp = gateways.get('whatsapp') as WhatsAppGateway | undefined;
const app = createApi({
  orchestrator,
  store,
  config,
  pool,
  host,
  ownerToken,
  detect: detectAll,
  ...(whatsapp && { whatsapp }),
  webDir: join(hydeRoot, 'apps', 'web', 'dist'),
  reload: async () => {
    // Settings saved from the dashboard: swap the config in place (same object everywhere).
    const next = loadConfig(config.configFile);
    Object.assign(config, next);
    pool.reset();
    await pool.refreshHealth();
    log('config reloaded');
  },
});
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.port });
nodeHub?.attach(server as never);
log(`hub API and dashboard on ${hubUrl} (run \`pnpm hyde dashboard\` for a login link)`);

for (const [name, gateway] of gateways) {
  try {
    await gateway.start((inbound) => orchestrator.handle(inbound));
  } catch (err) {
    log(`${name}: failed to start: ${(err as Error).message}`);
    gateways.delete(name);
  }
}
const telegram = gateways.get('telegram') as TelegramGateway | undefined;
const code = telegram?.issuePairingCode();
if (code) log(`telegram: no allowed users yet. Send this to your bot to pair: /pair ${code}`);
if (!gateways.size) log('no chat gateway configured; use the dashboard or `pnpm hyde ...`');

const stopSchedules = startSchedules(config.schedules, (inbound) => orchestrator.handle(inbound), log);
orchestrator.start();

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  log('shutting down: interrupting runs');
  stopSchedules();
  await orchestrator.stop();
  await orchestrator.drain();
  for (const g of gateways.values()) await g.stop().catch(() => undefined);
  server.close();
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
