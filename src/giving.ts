// Giving: create a checkout for a gift, and record the result when Razorpay tells us.
import { randomBytes } from 'node:crypto';

import type { Claims } from './auth.js';
import { config, type RazorpayAccount } from './config.js';
import { ApiError } from './errors.js';
import { createPaymentLink, createPlan, createSubscription } from './razorpay.js';
import type { Donation, PaymentMethod, Store } from './store/types.js';

export const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export type GiveIntentInput = {
  fundId: string;
  amount: number;
  currency: string;
  frequency: 'once' | 'monthly';
  donorCitizenship: 'IN' | 'OTHER';
  pan?: string;
};

/** Gifts from foreign citizens / OCI holders to an Indian church must go to its FCRA account. */
export function accountFor(donorCitizenship: 'IN' | 'OTHER'): { acct: RazorpayAccount | null; fcra: boolean } {
  const fcra = config.church.country === 'IN' && donorCitizenship === 'OTHER';
  if (!fcra) return { acct: config.razorpay.main, fcra };
  if (!config.razorpay.fcra && config.razorpay.main)
    throw new ApiError(422, 'fcra_not_registered', 'This church cannot accept gifts from foreign citizens or OCI holders online yet. Please contact the church office.');
  return { acct: config.razorpay.fcra, fcra };
}

export async function createIntent(store: Store, user: Claims, input: GiveIntentInput) {
  const fields: Record<string, string> = {};
  if (!Number.isInteger(input.amount) || input.amount < 100) fields.amount = 'Enter an amount of at least 1.';
  if (input.amount > 1_00_00_000_00) fields.amount = 'For gifts above 1 crore please contact the church office.';
  if (input.frequency !== 'once' && input.frequency !== 'monthly') fields.frequency = 'Choose one time or monthly.';
  if (input.pan && !PAN_RE.test(input.pan)) fields.pan = 'PAN should look like ABCDE1234F.';
  if (input.currency !== config.church.currency) fields.currency = `This church accepts ${config.church.currency}.`;
  if (Object.keys(fields).length) throw new ApiError(422, 'invalid', 'Please check the highlighted fields.', fields);

  const fund = await store.getFund(config.church.id, input.fundId);
  if (!fund || !fund.active) throw new ApiError(404, 'fund_not_found', 'That fund is not accepting gifts right now.');

  const { acct, fcra } = accountFor(input.donorCitizenship === 'OTHER' ? 'OTHER' : 'IN');
  const donation: Donation = {
    id: newId('dn'),
    churchId: config.church.id,
    memberId: user.sub,
    donorName: user.name,
    donorEmail: user.email ?? null,
    donorPhone: user.phone ?? null,
    fundId: fund.id,
    fundName: fund.name,
    amount: input.amount,
    currency: input.currency,
    frequency: input.frequency,
    status: 'pending',
    method: null,
    pan: input.pan && fund.taxDeductible && !fcra ? input.pan : null,
    donorCitizenship: fcra ? 'OTHER' : 'IN',
    fcra,
    provider: acct ? 'razorpay' : 'fake',
    providerRef: null,
    providerPaymentId: null,
    createdAt: new Date().toISOString(),
    paidAt: null,
  };
  const notes = { donation_id: donation.id, church_id: config.church.id, fund: fund.name, member_id: user.sub };

  if (!acct) {
    // No Razorpay keys yet: hand back the built-in test checkout so the whole flow can be tried.
    await store.insertDonation(donation);
    return { donationId: donation.id, checkoutUrl: `${config.apiPublicUrl}/v1/dev/checkout/${donation.id}` };
  }

  if (input.frequency === 'once') {
    const link = await createPaymentLink(acct, {
      amount: input.amount,
      currency: input.currency,
      description: `${fund.name} · ${config.church.name}`,
      referenceId: donation.id,
      callbackUrl: `${config.apiPublicUrl}/v1/giving/return`,
      customer: { name: user.name, email: user.email, contact: user.phone },
      notes,
    });
    donation.providerRef = link.id;
    await store.insertDonation(donation);
    return { donationId: donation.id, checkoutUrl: link.short_url };
  }

  const planKey = `${fcra ? 'fcra' : 'main'}:${input.currency}:${input.amount}`;
  let planId = await store.getPlanId(planKey);
  if (!planId) {
    planId = (await createPlan(acct, { amount: input.amount, currency: input.currency, name: `Monthly gift ${input.amount / 100} ${input.currency}` })).id;
    await store.savePlanId(planKey, planId);
  }
  const sub = await createSubscription(acct, { planId, notes });
  donation.providerRef = sub.id;
  await store.insertDonation(donation);
  return { donationId: donation.id, checkoutUrl: sub.short_url };
}

const METHODS: Record<string, PaymentMethod> = { upi: 'upi', card: 'card', netbanking: 'netbanking', wallet: 'wallet', emandate: 'netbanking', nach: 'netbanking' };

type RzpPayment = { id: string; amount: number; currency: string; method?: string; status?: string; email?: string; contact?: string; notes?: Record<string, string> | [] };
type RzpEvent = {
  event: string;
  payload: {
    payment?: { entity: RzpPayment };
    payment_link?: { entity: { id: string; reference_id?: string; status: string } };
    subscription?: { entity: { id: string; status: string; notes?: Record<string, string> | [] } };
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
        // First charge completes the row created with the intent.
        await store.updateDonation(first.id, { status: 'succeeded', providerPaymentId: payment.id, method: METHODS[payment.method ?? ''] ?? null, paidAt: now });
      } else {
        // Every later month is a new gift with the same details.
        await store.insertDonation({ ...first, id: newId('dn'), status: 'succeeded', amount: payment.amount, providerPaymentId: payment.id, method: METHODS[payment.method ?? ''] ?? first.method, createdAt: now, paidAt: now });
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
