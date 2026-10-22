// Builds the engine with the server's hooks (JWT, email, SMS, WhatsApp, Razorpay).
import { randomBytes } from 'node:crypto';

import { hashSecret, randomString, signAccess } from './auth.js';
import { config } from './config.js';
import { bootstrapChurch, createChurchEngine, Db, type Env } from './core/index.js';
import type { Currency } from './core/types.js';
import { razorpayCheckout } from './giving.js';
import { channelStatus, deliver, sendOtpEmail } from './providers.js';
import { coreStore } from './store/core-store.js';
import type { Store } from './store/types.js';

export function buildServer(db = new Db()) {
  let store: Store | null = null;
  const env: Env = {
    demo: false,
    now: () => new Date(),
    newId: (prefix) => `${prefix}_${randomBytes(9).toString('base64url')}`,
    random: randomString,
    hash: hashSecret,
    signAccess,
    sendOtpEmail,
    deliver,
    channels: channelStatus,
    checkout: (d, o) => razorpayCheckout(store!)(d, o),
    webUrl: config.webUrl,
  };
  const engine = createChurchEngine(db, env);
  store = coreStore(engine);
  return { engine, store, env, db };
}

export function bootstrap(server: ReturnType<typeof buildServer>) {
  bootstrapChurch(server.db, server.env, {
    id: config.church.id,
    name: config.church.name,
    country: config.church.country,
    currency: config.church.currency as Currency,
    city: config.church.city,
    ownerEmail: config.owner.email,
    ownerName: config.owner.name,
  });
}
