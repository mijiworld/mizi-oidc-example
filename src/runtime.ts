import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { DynamoStore } from './dynamo-store.js';
import { MiziOidcProvider } from './oidc.js';
import { MemoryStore } from './store.js';

export function createRuntime() {
  const config = loadConfig();
  const store = config.sessionTable ? new DynamoStore(config.sessionTable) : new MemoryStore();
  return { config, app: createApp(config, store, new MiziOidcProvider(config)) };
}
