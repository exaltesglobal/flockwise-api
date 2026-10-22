// The server's churches. Each church has its own in-memory database and engine; the platform
// (directory, sign-up, Flockwise team panel) sits above them. Hooks: JWT, email, SMS, WhatsApp,
// Razorpay for gifts and for Flockwise plans.
import { randomBytes } from 'node:crypto';

import { hashSecret, randomString, seal, signAccess, unseal } from './auth.js';
import { aiConfigured, claude } from './ai.js';
import { config } from './config.js';
import { bootstrapChurch, createChurchEngine, createPlatform, Db, type Env } from './core/index.js';
import type { Currency } from './core/types.js';
import { razorpayCheckout, razorpaySubscriptions } from './giving.js';
import { channelStatus, deliver, sendOtpEmail } from './providers.js';
import { cancelSubscription, checkKeys, createPaymentLink, createPlan, createSubscription, getPaymentLink } from './razorpay.js';
import { coreStore } from './store/core-store.js';
import type { Store } from './store/types.js';

export type Tenant = { id: string; isDefault: boolean; db: Db; env: Env; engine: ReturnType<typeof createChurchEngine>; store: Store };

const PLATFORM_ID = '_platform';

export function createHub() {
  const tenants = new Map<string, Tenant>();
  /** Replaceable in tests. */
  const hooks = {
    sendOtpEmail,
    /** Starts saving a new church's database (MySQL or file); set by index.ts. */
    persist: null as null | ((id: string, db: Db) => Promise<unknown>),
  };
  let platform: ReturnType<typeof createPlatform>;

  function makeEnv(churchId: string, isDefault: boolean, getTenant: () => Tenant | undefined): Env {
    const env: Env = {
      demo: false,
      now: () => new Date(),
      newId: (prefix) => `${prefix}_${randomBytes(9).toString('base64url')}`,
      random: randomString,
      hash: hashSecret,
      signAccess: (claims) => signAccess(claims, churchId),
      sendOtpEmail: (to, code, name) => hooks.sendOtpEmail(to, code, name),
      // The server's SMS and WhatsApp accounts serve its original church only; other churches
      // send WhatsApp through their own Chitthi workspace. Email works for every church.
      deliver: (channel, batch) => (isDefault || channel === 'email' ? deliver(channel, batch) : Promise.resolve(batch.map(() => ({ ok: false, error: 'Connect Chitthi in Settings › Integrations to send this.' })))),
      channels: () => {
        const ch = channelStatus();
        return isDefault ? ch : { ...ch, sms: { configured: false, provider: 'not connected' }, whatsapp: { configured: false, provider: 'Connect Chitthi' } };
      },
      checkout: (d, o) => razorpayCheckout(getTenant()!)(d, o),
      subscriptions: {
        pause: (ref, fcra) => razorpaySubscriptions(getTenant()!).pause(ref, fcra),
        resume: (ref, fcra) => razorpaySubscriptions(getTenant()!).resume(ref, fcra),
        cancel: (ref, fcra) => razorpaySubscriptions(getTenant()!).cancel(ref, fcra),
      },
      webUrl: config.webUrl,
      chitthi: async (apiKey, req) => {
        const res = await fetch(`${config.chitthiUrl}${req.path}`, {
          method: req.method,
          headers: { Authorization: `Bearer ${apiKey}`, ...(req.body ? { 'Content-Type': 'application/json' } : {}) },
          body: req.body ? JSON.stringify(req.body) : undefined,
          signal: AbortSignal.timeout(15_000),
        });
        return { status: res.status, data: await res.json().catch(() => null) };
      },
      seal,
      unseal,
      verifyRazorpay: checkKeys,
      serverPaymentKeys: isDefault && !!config.razorpay.main,
      razorpayPartnerUrl: config.razorpayPartnerUrl,
      webhookBase: `${config.apiPublicUrl}/v1/webhooks`,
      ...(config.billing ? { billing: billingHooks() } : {}),
      ...(aiConfigured() ? { ai: claude } : {}),
    };
    if (!isDefault) {
      // Links in messages carry the church's address so they open the right church.
      Object.defineProperty(env, 'webUrl', { get: () => `${config.webUrl}/c/${platform?.entry(churchId)?.slug ?? churchId}`, enumerable: true });
    }
    return env;
  }

  function billingHooks(): NonNullable<Env['billing']> {
    const acct = config.billing!;
    return {
      async checkout(input) {
        const key = `bplan:${input.plan}:${input.interval}:${input.currency}:${input.amount}`;
        let planId = platform.db.get('meta', key)?.value;
        if (!planId) {
          planId = (await createPlan(acct, { amount: input.amount, currency: input.currency, name: `Flockwise ${input.plan} (${input.interval})`, period: input.interval })).id;
          platform.db.put('meta', { id: key, value: planId });
        }
        const sub = await createSubscription(acct, { planId, totalCount: input.interval === 'yearly' ? 10 : 120, notes: { kind: 'flockwise_plan', church_id: input.churchId, plan: input.plan, interval: input.interval } });
        return { url: sub.short_url, providerRef: sub.id };
      },
      async cancel(ref) {
        if (!ref.startsWith('sub_')) return;
        await cancelSubscription(acct, ref);
      },
      async oneTime(input) {
        const link = await createPaymentLink(acct, {
          amount: input.amount,
          currency: 'INR',
          description: input.description,
          referenceId: `${input.kind}-${input.churchId}-${Date.now().toString(36)}`.slice(0, 40),
          callbackUrl: input.returnUrl,
          customer: { name: input.name, email: input.email },
          notes: { kind: input.kind, church_id: input.churchId },
        });
        return { url: link.short_url, providerRef: link.id };
      },
      async linkPaid(ref) {
        return (await getPaymentLink(acct, ref)).status === 'paid';
      },
    };
  }

  function addTenant(id: string, db = new Db()): Tenant {
    const isDefault = id === config.church.id;
    let tenant: Tenant | undefined;
    const env = makeEnv(id, isDefault, () => tenant);
    const engine = createChurchEngine(db, env);
    tenant = { id, isDefault, db, env, engine, store: coreStore(engine) };
    tenants.set(id, tenant);
    return tenant;
  }

  const platformDb = new Db();
  platform = createPlatform({
    db: platformDb,
    env: makeEnv(PLATFORM_ID, false, () => undefined),
    admins: config.platformAdmins,
    host: {
      defaultId: config.church.id,
      get: (id) => tenants.get(id)?.engine,
      async create(id) {
        if (tenants.has(id)) throw new Error(`Church ${id} already exists`);
        const db = new Db();
        if (hooks.persist) await hooks.persist(id, db);
        return addTenant(id, db).engine;
      },
    },
  });

  return {
    tenants,
    platform,
    platformDb,
    hooks,
    addTenant,
    /** The server's original church (set up from environment variables). */
    get main() {
      return tenants.get(config.church.id)!;
    },
    tenantOf: (engine: Tenant['engine']) => [...tenants.values()].find((t) => t.engine === engine),
  };
}

export type Hub = ReturnType<typeof createHub>;

/** Creates the server's own church from the environment variables and lists it in the directory. */
export function bootstrap(hub: Hub) {
  const main = hub.tenants.get(config.church.id) ?? hub.addTenant(config.church.id);
  bootstrapChurch(main.db, main.env, {
    id: config.church.id,
    name: config.church.name,
    country: config.church.country,
    currency: config.church.currency as Currency,
    city: config.church.city,
    ownerEmail: config.owner.email,
    ownerName: config.owner.name,
  });
  const s = main.db.get('settings', 'church')!;
  hub.platform.ensureChurch({ id: config.church.id, slug: config.church.slug, name: s.name, city: s.city, country: s.country, currency: s.currency, ownerEmail: config.owner.email, ownerName: config.owner.name });
  return main;
}

/** A hub with just the server's own church in memory (tests and local runs). */
export function buildServer() {
  const hub = createHub();
  const main = hub.addTenant(config.church.id);
  return Object.assign(hub, { engine: main.engine, store: main.store, env: main.env, db: main.db });
}
