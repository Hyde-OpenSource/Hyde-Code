import { pathToFileURL } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import type { ChatGateway, Registry } from '@hyde/core';
import type { AdapterFactory } from './agents.ts';
import type { HubConfig } from './config.ts';

// Plugin registry (docs/plan.md Phase 4): a plugin is a module exporting
// `register({ adapters, gateways, config })`. Adapters added here become usable in agent
// profiles by their kind name; gateways are started with the built-in ones.

export interface PluginRegistries {
  adapters: Registry<AdapterFactory>;
  gateways: Registry<(config: HubConfig) => ChatGateway | undefined>;
  config: HubConfig;
}

export async function loadPlugins(paths: string[], registries: PluginRegistries, log: (msg: string) => void): Promise<string[]> {
  const loaded: string[] = [];
  for (const path of paths) {
    const file = isAbsolute(path) ? path : resolve(registries.config.configDir, path);
    const mod = (await import(pathToFileURL(file).href)) as { register?: (r: PluginRegistries) => void | Promise<void>; name?: string };
    if (typeof mod.register !== 'function') throw new Error(`Plugin ${path} has no register() export`);
    await mod.register(registries);
    loaded.push(mod.name ?? path);
    log(`plugin loaded: ${mod.name ?? path}`);
  }
  return loaded;
}
