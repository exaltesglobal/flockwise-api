// Razorpay checkouts for gifts and event tickets, and recording the result from webhooks.
import { randomBytes } from 'node:crypto';

import { config, type RazorpayAccount } from './config.js';
import { razorpayConfig, type Db, type Env } from './core/index.js';
import type { RazorpaySealed } from './core/types.js';
import { ApiError } from './errors.js';
import { cancelSubscription, createPaymentLink, createPlan, createSubscription, pauseSubscription, resumeSubscription } from './razorpay.js';
import type { Donation, PaymentMethod, Store } from './store/types.js';

export const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`;

/** A church's Razorpay accounts: the ones it connected in Settings, else (for the server's own church) the env keys. */
export function churchAccounts(t: { db: Db; env: Env; isDefault: boolean }): { main: RazorpayAccount | null; fcra: RazorpayAccount | null } {
  const c = razorpayConfig(t);
  const open = (a: RazorpaySealed | null | undefined): RazorpayAccount | null => (a ? { keyId: a.keyId, keySecret: t.env.unseal(a.keySecretSealed), webhookSecret: t.env.unseal(a.webhookSecretSealed) } : null);
  if (c) return { main: open(c.main), fcra: open(c.fcra) };
  return t.isDefault ? { main: config.razorpay.main, fcra: config.razorpay.fcra } : { main: null, fcra: null };
}

/** env.subscriptions for the engine: a giver pausing, resuming or cancelling a monthly gift. */
export function razorpaySubscriptions(t: { db: Db; env: Env; isDefault: boolean }): NonNullable<Env['subscriptions']> {
  const acct = (fcra: boolean) => {
    const { main, fcra: f } = churchAccounts(t);
    const a = fcra ? f : main;
    if (!a) throw new ApiError(409, 'no_keys', 'This church’s Razorpay account is not connected, so the gift cannot be changed here. Please contact the church office.');
    return a;
  };
  return {
    pause: async (ref, fcra) => void (await pauseSubscription(acct(fcra), ref)),
    resume: async (ref, fcra) => void (await resumeSubscription(acct(fcra), ref)),
    cancel: async (ref, fcra) => void (await cancelSubscription(acct(fcra), ref, false)),
  };
}

/** Gifts from foreign citizens / OCI holders to an Indian church must go to its FCRA account. */
export function accountFor(t: { db: Db; env: Env; isDefault: boolean }, donorCitizenship: 'IN' | 'OTHER'): { acct: RazorpayAccount | null; fcra: boolean } {
  const { main, fcra: fcraAcct } = churchAccounts(t);
  const fcra = (t.db.get('settings', 'church')?.country ?? 'IN') === 'IN' && donorCitizenship === 'OTHER';
  if (!fcra) return { acct: main, fcra };
  if (!fcraAcct && main)
    throw new ApiError(422, 'fcra_not_registered', 'This church cannot accept gifts from foreign citizens or OCI holders online yet. Please contact the church office.');
  return { acct: fcraAcct, fcra };
}

/** env.checkout for the engine: creates the Razorpay page for a pending donation. */
export function razorpayCheckout(t: { id: string; db: Db; env: Env; isDefault: boolean; store: Store }): Env['checkout'] {
  return async (d, opts) => {
    const store = t.store;
    const { acct } = accountFor(t, d.donorCitizenship);
    if (!acct) {
      // No Razorpay keys yet: the built-in test checkout lets you try the whole flow.
      return { checkoutUrl: `${config.apiPublicUrl}/v1/dev/checkout/${d.id}?church=${encodeURIComponent(t.id)}`, providerRef: d.frequency === 'monthly' ? `test_sub_${d.id}` : null, provider: 'fake' };
    }
    const notes = { donation_id: d.id, church_id: t.id, fund: d.fundName, member_id: d.donorId ?? '' };
    if (d.frequency === 'once') {
      const link = await createPaymentLink(acct, {
        amount: d.amount,
        currency: d.currency,
        description: opts.description,
        referenceId: d.id,
        callbackUrl: `${config.apiPublicUrl}/v1/giving/return?church=${encodeURIComponent(t.id)}${d.eventId ? '&kind=ticket' : ''}`,
        customer: { name: d.donorName, email: d.donorEmail, contact: d.donorPhone?.replace(/\s/g, '') },
        notes,
      });
      return { checkoutUrl: link.short_url, providerRef: link.id, provider: 'razorpay' };
    }
    const planKey = `${d.fcra ? 'fcra' : 'main'}:${d.currency}:${d.amount}`;
    let planId = await store.getPlanId(planKey);
    if (!planId) {
      planId = (await createPlan(acct, { amount: d.amount, currency: d.currency, name: `Monthly gift ${d.amount / 100} ${d.currency}` })).id;
      await store.savePlanId(planKey, planId);
    }
    const sub = await createSubscription(acct, { planId, notes: opts.pledgeId ? { ...notes, pledge_id: opts.pledgeId } : notes, totalCount: opts.totalCount });
    return { checkoutUrl: sub.short_url, providerRef: sub.id, provider: 'razorpay' };
  };
}

const METHODS: Record<string, PaymentMethod> = { upi: 'upi', card: 'card', netbanking: 'netbanking', wallet: 'wallet', emandate: 'netbanking', nach: 'netbanking' };

type RzpPayment = { id: string; amount: number; currency: string; method?: string; status?: string };
type RzpEvent = {
  event: string;
  payload: {
    payment?: { entity: RzpPayment };
    payment_link?: { entity: { id: string; reference_id?: string; status: string } };
    subscription?: { entity: { id: string; status: string } };
  };
};

/** Applies a verified Razorpay webhook. Safe to call more than once for the same event. */
export async function applyWebhook(store: Store, evt: RzpEvent) {
  const payment = evt.payload.payment?.entity;
  const now = new Date().toISOString();

  switch (evt.event) {
    case 'payment_link.paid': {
      const link = evt.payload.payment_link!.entity;
      const d = (link.reference_id && (await store.findDonation(link.reference_id))) || (await store.findByProviderRef(link.id));
      if (!d || d.status === 'succeeded') return;
      await store.updateDonation(d.id, { status: 'succeeded', providerPaymentId: payment?.id ?? null, method: METHODS[payment?.method ?? ''] ?? null, paidAt: now });
      return;
    }
    case 'payment_link.expired':
    case 'payment_link.cancelled': {
      const d = await store.findByProviderRef(evt.payload.payment_link!.entity.id);
      if (d && d.status === 'pending') await store.updateDonation(d.id, { status: 'failed' });
      return;
    }
    case 'subscription.charged': {
      const sub = evt.payload.subscription!.entity;
      if (!payment || (await store.findByPaymentId(payment.id))) return;
      const first = await store.findByProviderRef(sub.id);
      if (!first) return;
      if (first.status === 'pending') {
        // First charge completes the row created with the checkout.
        await store.updateDonation(first.id, { status: 'succeeded', providerPaymentId: payment.id, method: METHODS[payment.method ?? ''] ?? null, paidAt: now });
      } else {
        // Every later month is a new gift with the same details.
        await store.insertDonation({ ...first, id: newId('dn'), status: 'succeeded', amount: payment.amount, providerPaymentId: payment.id, method: METHODS[payment.method ?? ''] ?? first.method, createdAt: now, paidAt: now, receiptNumber: null });
      }
      return;
    }
    case 'subscription.halted':
    case 'subscription.cancelled': {
      const first = await store.findByProviderRef(evt.payload.subscription!.entity.id);
      if (first && first.status === 'pending') await store.updateDonation(first.id, { status: 'failed' });
      return;
    }
    case 'payment.failed':
      // Razorpay lets the donor retry on the same link, so a failed attempt does not fail the gift.
      return;
  }
}

export type { Donation };
