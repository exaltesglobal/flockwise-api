// Minimal Razorpay REST client (no SDK). Docs: https://razorpay.com/docs/api/
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { RazorpayAccount } from './config.js';
import { ApiError } from './errors.js';

const BASE = 'https://api.razorpay.com/v1';

async function call<T>(acct: RazorpayAccount, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${acct.keyId}:${acct.keySecret}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { description?: string; code?: string } };
  if (!res.ok) {
    console.error('Razorpay error', res.status, json.error);
    throw new ApiError(502, 'payment_provider_error', json.error?.description ?? 'The payment provider could not start this payment. Please try again.');
  }
  return json as T;
}

export type PaymentLink = { id: string; short_url: string; status: string };
export type Subscription = { id: string; short_url: string; status: string };

/** One-time gift: a hosted Razorpay page (UPI, cards, netbanking, wallets). */
export function createPaymentLink(
  acct: RazorpayAccount,
  input: { amount: number; currency: string; description: string; referenceId: string; callbackUrl: string; customer: { name: string; email?: string | null; contact?: string | null }; notes: Record<string, string> },
) {
  return call<PaymentLink>(acct, 'POST', '/payment_links', {
    amount: input.amount,
    currency: input.currency,
    accept_partial: false,
    description: input.description.slice(0, 2048),
    reference_id: input.referenceId,
    customer: { name: input.customer.name, ...(input.customer.email ? { email: input.customer.email } : {}), ...(input.customer.contact ? { contact: input.customer.contact } : {}) },
    notify: { sms: false, email: false },
    reminder_enable: false,
    notes: input.notes,
    callback_url: input.callbackUrl,
    callback_method: 'get',
    expire_by: Math.floor(Date.now() / 1000) + 24 * 3600,
  });
}

export function createPlan(acct: RazorpayAccount, input: { amount: number; currency: string; name: string; period?: 'monthly' | 'yearly' }) {
  return call<{ id: string }>(acct, 'POST', '/plans', { period: input.period ?? 'monthly', interval: 1, item: { name: input.name, amount: input.amount, currency: input.currency } });
}

export function getPaymentLink(acct: RazorpayAccount, id: string) {
  return call<PaymentLink>(acct, 'GET', `/payment_links/${encodeURIComponent(id)}`);
}

/** Plans end at the close of the paid period; a giver's monthly gift stops at once (`atCycleEnd` false). */
export function cancelSubscription(acct: RazorpayAccount, id: string, atCycleEnd = true) {
  return call<Subscription>(acct, 'POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: atCycleEnd ? 1 : 0 });
}

export function pauseSubscription(acct: RazorpayAccount, id: string) {
  return call<Subscription>(acct, 'POST', `/subscriptions/${encodeURIComponent(id)}/pause`, { pause_at: 'now' });
}

export function resumeSubscription(acct: RazorpayAccount, id: string) {
  return call<Subscription>(acct, 'POST', `/subscriptions/${encodeURIComponent(id)}/resume`, { resume_at: 'now' });
}

/** True when Razorpay accepts the keys (a harmless read). */
export async function checkKeys(keyId: string, keySecret: string) {
  const res = await fetch(`${BASE}/payments?count=1`, { headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  return !!res && res.status !== 401;
}

/** Monthly gift: a Razorpay subscription. In India the donor approves UPI AutoPay or an e-mandate once. */
export function createSubscription(acct: RazorpayAccount, input: { planId: string; notes: Record<string, string>; totalCount?: number }) {
  return call<Subscription>(acct, 'POST', '/subscriptions', {
    plan_id: input.planId,
    total_count: input.totalCount ?? 120, // ten years; the donor can cancel any time from their UPI app or bank
    quantity: 1,
    customer_notify: 1,
    notes: input.notes,
  });
}

function safeEqualHex(a: string, b: string) {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** X-Razorpay-Signature = HMAC-SHA256(raw body, webhook secret), hex. */
export function verifyWebhook(rawBody: string, signature: string | undefined, secret: string) {
  if (!signature || !secret) return false;
  return safeEqualHex(createHmac('sha256', secret).update(rawBody).digest('hex'), signature);
}

/** Payment link callback: HMAC-SHA256("link_id|reference_id|status|payment_id", key secret). */
export function verifyLinkCallback(p: { linkId: string; referenceId: string; status: string; paymentId: string; signature: string }, keySecret: string) {
  const payload = `${p.linkId}|${p.referenceId}|${p.status}|${p.paymentId}`;
  return safeEqualHex(createHmac('sha256', keySecret).update(payload).digest('hex'), p.signature);
}

/** Chitthi signs webhooks as `t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. Rejects anything older than five minutes. */
export function verifyChitthi(rawBody: string, header: string | null, secret: string, toleranceSec = 300) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=', 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1 || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  return safeEqualHex(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'), parts.v1);
}
