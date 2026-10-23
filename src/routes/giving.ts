import { Hono } from 'hono';

import { config } from '../config.js';
import { accountFor } from '../giving.js';
import { verifyLinkCallback } from '../razorpay.js';
import type { Hub } from '../server.js';

export function givingRoutes(hub: Hub) {
  const app = new Hono();

  // Razorpay sends the donor back here after paying a payment link. The webhook is what
  // records the payment; this only shows the donor the right screen.
  app.get('/giving/return', async (c) => {
    const q = c.req.query();
    const linkId = q.razorpay_payment_link_id ?? '';
    const t = hub.tenants.get(q.church ?? '') ?? hub.main;
    const d = linkId && t ? await t.store.findByProviderRef(linkId) : null;
    let ok = false;
    try {
      const acct = d && t ? accountFor(t, d.donorCitizenship).acct : null;
      ok =
        !!acct &&
        q.razorpay_payment_link_status === 'paid' &&
        verifyLinkCallback(
          { linkId, referenceId: q.razorpay_payment_link_reference_id ?? '', status: q.razorpay_payment_link_status, paymentId: q.razorpay_payment_id ?? '', signature: q.razorpay_signature ?? '' },
          acct.keySecret,
        );
    } catch {
      ok = false;
    }
    return c.redirect(`${t?.env.webUrl ?? config.webUrl}${returnPath(d)}payment=${ok ? 'success' : 'cancelled'}`);
  });

  return app;
}

/** Where the payer lands after checkout: the registration, the event, or giving. */
export function returnPath(d: { eventId: string | null; formResponseId?: string | null; rentalId?: string | null } | null | undefined) {
  if (d?.rentalId) return `/rent/return?rental=${d.rentalId}&`;
  if (d?.formResponseId) return `/forms/return?response=${d.formResponseId}&`;
  return `${d?.eventId ? `/app/events/${d.eventId}` : '/app/give'}?`;
}
