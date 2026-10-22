import { Hono } from 'hono';

import { config } from '../config.js';
import { applyWebhook } from '../giving.js';
import { verifyWebhook } from '../razorpay.js';
import type { Store } from '../store/types.js';

export function webhookRoutes(store: Store) {
  const app = new Hono();

  app.post('/webhooks/razorpay', async (c) => {
    const raw = await c.req.text(); // signature is over the exact bytes Razorpay sent
    const sig = c.req.header('x-razorpay-signature');
    const secrets = [config.razorpay.main?.webhookSecret, config.razorpay.fcra?.webhookSecret].filter((s): s is string => !!s);
    if (!secrets.some((s) => verifyWebhook(raw, sig, s))) return c.json({ error: { code: 'bad_signature', message: 'Invalid signature' } }, 400);
    try {
      await applyWebhook(store, JSON.parse(raw));
    } catch (e) {
      console.error('Webhook handling failed', e);
      return c.json({ ok: false }, 500); // Razorpay retries non-2xx responses
    }
    return c.json({ ok: true });
  });

  return app;
}
