import { Hono } from 'hono';

import { config } from '../config.js';
import { applyBillingEvent, applyRecurringEvent, botConfig, handleBotMessage, markSetupPaid, SETUP_KIND, type BillingInterval, type PlanId } from '../core/index.js';
import { applyWebhook, churchAccounts } from '../giving.js';
import { verifyChitthi, verifyWebhook } from '../razorpay.js';
import type { Hub, Tenant } from '../server.js';

type RzpNotes = { church_id?: string; kind?: string; plan?: string; interval?: string };

export function webhookRoutes(hub: Hub) {
  const app = new Hono();

  async function giving(raw: string, t: Tenant) {
    try {
      const evt = JSON.parse(raw);
      await applyWebhook(t.store, evt);
      // Keep the recurring gift (UPI AutoPay) in step: status, charges, next charge date.
      const sub = evt.payload?.subscription?.entity;
      if (typeof evt.event === 'string' && evt.event.startsWith('subscription.') && sub?.id) {
        const pay = evt.payload?.payment?.entity;
        applyRecurringEvent(t.engine.systemCtx(), { event: evt.event, ref: sub.id, currentEnd: sub.current_end ?? null, amount: pay?.amount, method: pay?.method === 'upi' ? 'upi' : pay?.method === 'card' ? 'card' : pay?.method ? 'netbanking' : null });
      }
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

  // The WhatsApp assistant: Chitthi forwards message.received for a church's WhatsApp number.
  app.post('/webhooks/chitthi/:church', async (c) => {
    const t = hub.tenants.get(c.req.param('church'));
    if (!t) return c.json({ error: { code: 'not_found', message: 'Unknown church' } }, 410); // 410 tells Chitthi to unsubscribe
    const cfg = botConfig({ db: t.db });
    if (!cfg?.enabled || !cfg.secretSealed) return c.json({ error: { code: 'off', message: 'The assistant is off' } }, 410);
    const raw = await c.req.text();
    if (!verifyChitthi(raw, c.req.header('chitthi-signature') ?? null, t.env.unseal(cfg.secretSealed))) return c.json({ error: { code: 'bad_signature', message: 'Invalid signature' } }, 400);
    const evt = JSON.parse(raw) as { event?: string; data?: { contact?: { phone?: string; name?: string | null }; text?: string; type?: string } };
    const phone = evt.data?.contact?.phone;
    if (evt.event !== 'message.received' || !phone) return c.json({ ok: true, ignored: true });
    await handleBotMessage(t.engine.systemCtx(), { phone, name: evt.data?.contact?.name ?? '', text: evt.data?.text ?? '', type: evt.data?.type });
    return c.json({ ok: true });
  });

  // Churches paying Flockwise for their plan (Flockwise's own Razorpay account).
  app.post('/webhooks/billing', async (c) => {
    const raw = await c.req.text();
    if (!config.billing || !verifyWebhook(raw, c.req.header('x-razorpay-signature'), config.billing.webhookSecret)) return c.json({ error: { code: 'bad_signature', message: 'Invalid signature' } }, 400);
    const evt = JSON.parse(raw) as { event: string; payload: { subscription?: { entity: { id: string; current_end?: number | null; notes?: RzpNotes } }; payment_link?: { entity: { id: string; notes?: RzpNotes } } } };
    // One-time payments to Flockwise, e.g. assisted Razorpay setup.
    const link = evt.payload.payment_link?.entity;
    if (evt.event === 'payment_link.paid' && link) {
      const lt = link.notes?.kind === SETUP_KIND ? hub.tenants.get(link.notes.church_id ?? '') : undefined;
      if (lt) markSetupPaid(lt.engine.systemCtx(), link.id);
      return c.json({ ok: true, ...(lt ? {} : { ignored: true }) });
    }
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
