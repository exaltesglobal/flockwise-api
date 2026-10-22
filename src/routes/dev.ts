// Test checkout used only while no Razorpay keys are configured. Lets you try the full
// give -> pay -> record flow from the web or mobile app before the Razorpay account is ready.
import { Hono } from 'hono';
import { html } from 'hono/html';

import { applyRecurringEvent } from '../core/index.js';
import type { Hub } from '../server.js';
import { returnPath } from './giving.js';

export function devRoutes(hub: Hub) {
  const app = new Hono();
  const tenant = (c: { req: { query(k: string): string | undefined } }) => hub.tenants.get(c.req.query('church') ?? '') ?? hub.main;

  app.get('/dev/checkout/:id', async (c) => {
    const t = tenant(c);
    const d = await t.store.findDonation(c.req.param('id'));
    if (!d || d.provider !== 'fake') return c.text('Not found', 404);
    const amount = new Intl.NumberFormat('en-IN', { style: 'currency', currency: d.currency }).format(d.amount / 100);
    return c.html(html`<!doctype html>
      <html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Test checkout</title>
      <style>body{font-family:system-ui,sans-serif;background:#F4F7F6;color:#14211F;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}
      .c{background:#fff;border-radius:16px;padding:28px;max-width:380px;width:100%;box-shadow:0 2px 12px rgba(0,0,0,.08)}h1{font-size:20px;margin:0 0 4px}
      .tag{display:inline-block;background:#F2A93B;padding:2px 8px;border-radius:99px;font-size:12px;font-weight:600;margin-bottom:12px}
      .amt{font-size:32px;font-weight:700;margin:12px 0}button{width:100%;height:46px;border-radius:10px;border:0;font-size:15px;font-weight:600;cursor:pointer;margin-top:8px}
      .pay{background:#1F6B5C;color:#fff}.fail{background:#fff;border:1px solid #DDE5E3;color:#B42318}p{color:#5B6B68;font-size:14px;margin:0}</style></head>
      <body><form class="c" method="post"><span class="tag">Test mode, no real money</span><h1>${t.db.get('settings', 'church')?.name ?? 'Church'}</h1><p>${d.fundName}${d.frequency === 'monthly' ? ' · monthly' : ''}</p>
      <div class="amt">${amount}</div><button class="pay" name="result" value="paid">Pay with UPI (test)</button><button class="fail" name="result" value="failed">Simulate a failed payment</button>
      <p style="margin-top:14px">Add Razorpay keys to the API to replace this page with the real Razorpay checkout.</p></form></body></html>`);
  });

  app.post('/dev/checkout/:id', async (c) => {
    const t = tenant(c);
    const d = await t.store.findDonation(c.req.param('id'));
    if (!d || d.provider !== 'fake') return c.text('Not found', 404);
    const form = await c.req.parseBody();
    const paid = form.result === 'paid';
    if (d.status === 'pending')
      await t.store.updateDonation(d.id, paid ? { status: 'succeeded', method: 'upi', providerPaymentId: `fake_${d.id}`, paidAt: new Date().toISOString() } : { status: 'failed' });
      if (d.providerRef?.startsWith('test_sub_')) applyRecurringEvent(t.engine.systemCtx(), { event: paid ? 'subscription.charged' : 'subscription.cancelled', ref: d.providerRef, method: 'upi', currentEnd: paid ? Math.floor(Date.now() / 1000) + 30 * 86400 : null });
    return c.redirect(`${t.env.webUrl}${returnPath(d)}payment=${paid ? 'success' : 'cancelled'}`);
  });

  return app;
}
