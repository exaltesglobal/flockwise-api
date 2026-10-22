import { Hono } from 'hono';

import { config } from '../config.js';
import { applyBillingEvent, type BillingInterval, type PlanId } from '../core/index.js';
import { applyWebhook, churchAccounts } from '../giving.js';
import { verifyWebhook } from '../razorpay.js';
import type { Hub, Tenant } from '../server.js';

type RzpNotes = { church_id?: string; kind?: string; plan?: string; interval?: string };

export function webhookRoutes(hub: Hub) {
  const app = new Hono();

  async function giving(raw: string, t: Tenant) {
    try {
      await applyWebhook(t.store, JSON.parse(raw));
    } catch (e) {
      console.error('Webhook handling failed', e);
      return false;
    }
    return true;
  }

  // Each church points its own Razorpay webhook here: /v1/webhooks/razorpay/<church id>.
  app.post('/webhooks/razorpay/:church', async (c) => {
    const t = hub.tenants.get(c.req.param('church'));
    if (!t) return c.json({ error: { code: 'not_found', message: 'Unknown church' } }, 404);
    const raw = await c.req.text(); // signature is over the exact bytes Razorpay sent
    const { main, fcra } = churchAccounts(t);
    const secrets = [main?.webhookSecret, fcra?.webhookSecret].filter((s): s is string => !!s);
    if (!secrets.some((s) => verifyWebhook(raw, c.req.header('x-razorpay-signature'), s))) return c.json({ error: { code: 'bad_signature', message: 'Invalid signature' } }, 400);
    return (await giving(raw, t)) ? c.json({ ok: true }) : c.json({ ok: false }, 500); // Razorpay retries non-2xx responses
  });

  // The server's original church (keys in environment variables).
  app.post('/webhooks/razorpay', async (c) => {
    const raw = await c.req.text();
    const t = hub.main;
    const { main, fcra } = churchAccounts(t);
    const secrets = [main?.webhookSecret, fcra?.webhookSecret].filter((s): s is string => !!s);
    if (!secrets.some((s) => verifyWebhook(raw, c.req.header('x-razorpay-signature'), s))) return c.json({ error: { code: 'bad_signature', message: 'Invalid signature' } }, 400);
    return (await giving(raw, t)) ? c.json({ ok: true }) : c.json({ ok: false }, 500);
  });

  // Churches paying Flockwise for their plan (Flockwise's own Razorpay account).
  app.post('/webhooks/billing', async (c) => {
    const raw = await c.req.text();
    if (!config.billing || !verifyWebhook(raw, c.req.header('x-razorpay-signature'), config.billing.webhookSecret)) return c.json({ error: { code: 'bad_signature', message: 'Invalid signature' } }, 400);
    const evt = JSON.parse(raw) as { event: string; payload: { subscription?: { entity: { id: string; current_end?: number | null; notes?: RzpNotes } } } };
    const sub = evt.payload.subscription?.entity;
    const notes = sub?.notes ?? {};
    const t = sub && notes.kind === 'flockwise_plan' ? hub.tenants.get(notes.church_id ?? '') : undefined;
    if (!sub || !t) return c.json({ ok: true, ignored: true });
    const type = evt.event === 'subscription.charged' || evt.event === 'subscription.activated' ? 'charged' : evt.event === 'subscription.halted' ? 'halted' : ['subscription.cancelled', 'subscription.completed'].includes(evt.event) ? 'cancelled' : null;
    if (type)
      applyBillingEvent(t.engine.systemCtx(), {
        type,
        plan: notes.plan as PlanId,
        interval: notes.interval as BillingInterval,
        providerRef: sub.id,
        periodEnd: sub.current_end ? new Date(sub.current_end * 1000).toISOString() : null,
      });
    return c.json({ ok: true });
  });

  return app;
}
