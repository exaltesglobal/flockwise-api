import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { assertConfig, config } from './config.js';
import { seedDemo } from './core/seed.js';
import { filePersistence, mysqlPersistence } from './persist.js';
import { channelStatus } from './providers.js';
import { bootstrap, buildServer } from './server.js';

// No top-level await: Hostinger starts apps through Passenger, which require()s the entry file.
assertConfig();
const server = buildServer();
main().catch((e) => {
  console.error('Flockwise API failed to start', e);
  process.exit(1);
});

async function main() {
  const persistence = config.db ? await mysqlPersistence(config.db, config.church.id, server.db) : config.dataFile ? filePersistence(config.dataFile, server.db) : null;

  if (config.seedDemo && !server.db.count('people')) {
    seedDemo(server.db, server.env);
    console.log('Loaded the sample church (SEED_DEMO=true).');
  }
  bootstrap(server);
  if (!server.db.count('staff')) console.warn('No church office login yet. Set OWNER_EMAIL and restart, then sign in at /admin with that email.');

  // Scheduled messages and daily automations.
  const tick = () => server.engine.tick().catch((e) => console.error('Automations failed', e));
  setInterval(tick, 60_000).unref();
  setTimeout(tick, 5_000).unref();

  serve({ fetch: createApp(server.engine, server.store).fetch, port: config.port }, (info) => {
    const ch = channelStatus();
    console.log(
      `Flockwise API on :${info.port} · data: ${config.db ? 'MySQL' : config.dataFile ? config.dataFile : 'memory (lost on restart)'} · payments: ${config.razorpay.main ? 'Razorpay' : 'test checkout'} · email: ${ch.email.provider} · SMS: ${ch.sms.provider} · WhatsApp: ${ch.whatsapp.provider}`,
    );
  });

  for (const sig of ['SIGTERM', 'SIGINT'] as const)
    process.on(sig, async () => {
      await persistence?.settle().catch(() => undefined);
      await persistence?.close().catch(() => undefined);
      process.exit(0);
    });
}
