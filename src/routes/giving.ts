import { Hono } from 'hono';

import { requireMember, requireStaff, type AuthEnv } from '../auth.js';
import { config } from '../config.js';
import { ApiError } from '../errors.js';
import { accountFor, createIntent, type GiveIntentInput } from '../giving.js';
import { verifyLinkCallback } from '../razorpay.js';
import type { Donation, Store } from '../store/types.js';

const PAGE = 50;

/** Member-facing shape from docs/API.md. */
const publicDonation = (d: Donation) => ({
  id: d.id,
  fundName: d.fundName,
  amount: d.amount,
  currency: d.currency,
  frequency: d.frequency,
  status: d.status,
  createdAt: d.createdAt,
  receiptUrl: null,
});

/** Admin shape from docs/API-ADMIN.md. */
const adminDonation = (d: Donation) => ({
  ...publicDonation(d),
  donorId: d.memberId,
  donorName: d.donorName,
  fundId: d.fundId,
  method: d.method ?? 'upi',
  pan: d.pan,
  donorCitizenship: d.donorCitizenship,
  fcra: d.fcra,
});

export function givingRoutes(store: Store) {
  const app = new Hono<AuthEnv>();

  // Razorpay sends the donor back here after paying a payment link. The webhook is what
  // actually records the gift; this only shows the donor the right screen.
  app.get('/giving/return', async (c) => {
    const q = c.req.query();
    const linkId = q.razorpay_payment_link_id ?? '';
    const d = linkId ? await store.findByProviderRef(linkId) : null;
    const acct = d ? accountFor(d.donorCitizenship).acct : null;
    const ok =
      !!acct &&
      q.razorpay_payment_link_status === 'paid' &&
      verifyLinkCallback(
        { linkId, referenceId: q.razorpay_payment_link_reference_id ?? '', status: q.razorpay_payment_link_status, paymentId: q.razorpay_payment_id ?? '', signature: q.razorpay_signature ?? '' },
        acct.keySecret,
      );
    return c.redirect(`${config.webUrl}/app/give?payment=${ok ? 'success' : 'cancelled'}`);
  });

  app.use('/giving/*', requireMember);

  app.get('/giving/funds', async (c) => {
    const funds = await store.listFunds(config.church.id);
    return c.json(funds.filter((f) => f.active).map(({ id, name, description, taxDeductible }) => ({ id, name, description, taxDeductible })));
  });

  app.post('/giving/intents', async (c) => {
    const body = await c.req.json<GiveIntentInput>().catch(() => {
      throw new ApiError(400, 'bad_json', 'The request was not valid JSON.');
    });
    return c.json(await createIntent(store, c.get('user'), body), 201);
  });

  app.get('/giving/donations', async (c) => {
    const offset = Number(c.req.query('cursor') ?? 0) || 0;
    const { rows, total } = await store.listDonations({ churchId: config.church.id, memberId: c.get('user').sub, offset, limit: PAGE });
    return c.json({ data: rows.map(publicDonation), nextCursor: offset + PAGE < total ? String(offset + PAGE) : null });
  });

  app.use('/admin/giving/*', requireMember, requireStaff('finance'));

  app.get('/admin/giving/donations', async (c) => {
    const q = c.req.query();
    const offset = Number(q.cursor ?? 0) || 0;
    const { rows, total, totalAmount } = await store.listDonations({ churchId: config.church.id, fundId: q.fundId, from: q.from, to: q.to, q: q.q, offset, limit: PAGE });
    return c.json({ data: rows.map(adminDonation), nextCursor: offset + PAGE < total ? String(offset + PAGE) : null, total, totalAmount });
  });

  app.get('/admin/giving/funds', async (c) => {
    const funds = await store.listFunds(config.church.id);
    return c.json(funds.map((f) => ({ ...f, raisedThisYear: 0 })));
  });

  return app;
}
