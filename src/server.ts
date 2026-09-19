import { serve } from '@hono/node-server';
import { createRuntime } from './runtime.js';

const { app, config } = createRuntime();
serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' });
console.info(`Demo server listening on port ${config.port}`);
