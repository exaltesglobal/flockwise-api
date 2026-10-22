import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { assertConfig, config } from './config.js';
import { memoryStore } from './store/memory.js';
import { mysqlStore } from './store/mysql.js';

assertConfig();
const store = config.db ? mysqlStore(config.db) : memoryStore(config.church.id);

serve({ fetch: createApp(store).fetch, port: config.port }, (info) => {
  console.log(`Flockwise API on :${info.port} · payments: ${config.razorpay.main ? 'Razorpay' : 'test checkout'} · store: ${config.db ? 'MySQL' : 'memory'}`);
});
