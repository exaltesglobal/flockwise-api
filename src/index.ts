import { readdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { assertConfig, config } from './config.js';
import type { Db } from './core/index.js';
import { seedDemo } from './core/seed.js';
import { churchIds, filePersistence, mysqlPersistence, openPool } from './persist.js';
import { channelStatus } from './providers.js';
import { bootstrap, createHub } from './server.js';

// No top-level await: Hostinger starts apps through Passenger, which require()s the entry file.
assertConfig();
const hub = createHub();
main().catch((e) => {
  console.error('Flockwise API failed to start', e);
  process.exit(1);
});

async function main() {
  const saving: { settle(): Promise<void> }[] = [];
  let closePool: (() => Promise<void>) | null = null;
  let persist: ((id: string, db: Db) => Promise<unknown>) | null = null;
  let ids: string[] = [];

  if (config.db) {
    const pool = await openPool(config.db);
    closePool = () => pool.end();
    persist = async (id, db) => saving.push(await mysqlPersistence(pool, id, db));
    ids = await churchIds(pool);
  } else if (config.dataFile) {
    // Local development: the server's church in DATA_FILE, others beside it (data.<church>.json).
    const file = (id: string) => (id === config.church.id ? config.dataFile : config.dataFile.replace(/(\.json)?$/, `.${id}.json`));
    persist = async (id, db) => saving.push(filePersistence(file(id), db));
    const stem = basename(config.dataFile).replace(/\.json$/, '');
    try {
      ids = readdirSync(dirname(config.dataFile) || '.')
        .map((f) => new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(.+)\\.json$`).exec(f)?.[1])
        .filter((x): x is string => !!x);
    } catch {
      ids = [];
    }
  }

  // The directory and team panel first, then every church.
  if (persist) await persist('_platform', hub.platformDb);
  for (const id of new Set([config.church.id, ...ids])) {
    if (id === '_platform') continue;
    const t = hub.addTenant(id);
    if (persist) await persist(id, t.db);
  }
  hub.hooks.persist = persist;

  const main = hub.main;
  if (config.seedDemo && !main.db.count('people')) {
    seedDemo(main.db, main.env);
    console.log('Loaded the sample church (SEED_DEMO=true).');
  }
  bootstrap(hub);
  if (!main.db.count('staff')) console.warn('No church office login yet. Set OWNER_EMAIL and restart, then sign in at /admin with that email.');

  // Scheduled messages and daily automations, for every church.
  const tick = () => hub.platform.tickAll().catch((e) => console.error('Automations failed', e));
  setInterval(tick, 60_000).unref();
  setTimeout(tick, 5_000).unref();

  serve({ fetch: createApp(hub).fetch, port: config.port }, (info) => {
    const ch = channelStatus();
    console.log(
      `Flockwise API on :${info.port} · churches: ${hub.tenants.size} · data: ${config.db ? 'MySQL' : config.dataFile ? config.dataFile : 'memory (lost on restart)'} · payments: ${config.razorpay.main ? 'Razorpay' : 'test checkout'} · plans: ${config.billing ? 'Razorpay' : 'off'} · email: ${ch.email.provider} · SMS: ${ch.sms.provider} · WhatsApp: ${ch.whatsapp.provider}`,
    );
  });

  for (const sig of ['SIGTERM', 'SIGINT'] as const)
    process.on(sig, async () => {
      await Promise.all(saving.map((s) => s.settle().catch(() => undefined)));
      await closePool?.().catch(() => undefined);
      process.exit(0);
    });
}
