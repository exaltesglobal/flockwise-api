// Offering QR codes: one reusable Razorpay UPI QR per fund for the offering box, the projector
// and the bulletin. Each scan-and-pay arrives as a `qr_code.credited` webhook and becomes a gift
// against that fund, matched to a member by mobile or email when Razorpay shares them.
import { ApiError } from '../errors.js';
import type { Ctx, Router } from '../engine.js';
import type { Collections, OfferingQr, OfferingQrHub, OfferingQrView, PublicOfferingQr } from '../types.js';
import { church, churchId, find, fullName, normEmail, normPhone, settings } from '../util.js';
import { onDonationSucceeded } from './giving.js';
import { paymentsStatus } from './integrations.js';

const active = (ctx: Ctx) => ctx.db.all('qrCodes').filter((q) => q.status === 'active');

function view(ctx: Ctx, q: OfferingQr): OfferingQrView {
  const gifts = ctx.db.all('donations').filter((d) => d.qrId === q.id && d.status === 'succeeded');
  const monthStart = new Date(Date.UTC(ctx.now.getUTCFullYear(), ctx.now.getUTCMonth(), 1)).toISOString();
  const month = gifts.filter((d) => (d.paidAt ?? d.createdAt) >= monthStart);
  const sum = (xs: Collections['donations'][]) => xs.reduce((a, d) => a + d.amount, 0);
  const last = gifts.map((d) => d.paidAt ?? d.createdAt).sort().at(-1) ?? null;
  return { ...q, giftsThisMonth: month.length, totalThisMonth: sum(month), giftsAll: gifts.length, totalAll: sum(gifts), lastGiftAt: last, publicUrl: `${ctx.env.webUrl}/qr/${q.id}` };
}

export function offeringQrHub(ctx: Ctx): OfferingQrHub {
  const live = !!ctx.env.qrCodes; // the demo draws its own codes
  const pay = paymentsStatus(ctx);
  const ready = live ? pay.connected : true;
  return {
    ready,
    reason: ready ? null : 'Connect the church’s Razorpay account in Settings › Giving first. Flockwise creates the QR codes there, so the money goes straight to the church.',
    webhookEvent: 'qr_code.credited',
    codes: ctx.db
      .all('qrCodes')
      .sort((a, b) => (a.status === b.status ? b.createdAt.localeCompare(a.createdAt) : a.status === 'active' ? -1 : 1))
      .map((q) => view(ctx, q)),
    funds: ctx.db.all('funds').filter((f) => f.active && !f.system).map((f) => ({ id: f.id, name: f.name })),
  };
}

async function createQr(ctx: Ctx): Promise<OfferingQrView> {
  const b = ctx.body as { fundId?: string; name?: string };
  const fund = find(ctx, 'funds', String(b.fundId ?? ''), 'Fund');
  if (!fund.active || fund.system) throw new ApiError(422, 'invalid', 'Choose a fund that is open for gifts.', { fundId: 'Choose a fund' });
  const name = String(b.name ?? '').trim().slice(0, 40) || `${fund.name} offering`;
  if (active(ctx).length >= 12) throw new ApiError(409, 'too_many', 'Twelve live QR codes is plenty. Close one you no longer use first.');
  const c = church(ctx);
  const id = ctx.id('qr');
  let providerId: string | null = null;
  let imageUrl: string | null = null;
  let payload: string | null = null;
  if (ctx.env.qrCodes) {
    if (!paymentsStatus(ctx).connected) throw new ApiError(409, 'no_keys', 'Connect the church’s Razorpay account in Settings › Giving first.');
    const made = await ctx.env.qrCodes.create({ name: `${c.name} · ${name}`.slice(0, 40), description: `${fund.name} — ${c.name}`, notes: { church_id: churchId(ctx), qr_id: id, fund_id: fund.id, kind: 'offering_qr' } });
    providerId = made.id;
    imageUrl = made.imageUrl;
  } else {
    // Demo: a plain UPI intent so the code scans in any UPI app.
    const pa = `${c.name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20) || 'church'}@upi`;
    payload = `upi://pay?pa=${encodeURIComponent(pa)}&pn=${encodeURIComponent(c.name.slice(0, 40))}&tn=${encodeURIComponent(`${fund.name} (${id})`.slice(0, 60))}&cu=${c.currency}`;
  }
  const q = ctx.db.put('qrCodes', { id, providerId, fundId: fund.id, fundName: fund.name, name, imageUrl, payload, status: 'active', createdAt: ctx.now.toISOString(), createdBy: ctx.staff?.name ?? 'Office', closedAt: null });
  ctx.audit('qr.created', 'qrCodes', q.id, `Offering QR “${name}” for ${fund.name}`);
  return view(ctx, q);
}

async function closeQr(ctx: Ctx): Promise<OfferingQrView> {
  const q = find(ctx, 'qrCodes', ctx.params[0], 'QR code');
  if (q.status === 'closed') return view(ctx, q);
  if (ctx.env.qrCodes && q.providerId) await ctx.env.qrCodes.close(q.providerId);
  const next = ctx.db.put('qrCodes', { ...q, status: 'closed', closedAt: ctx.now.toISOString() });
  ctx.audit('qr.closed', 'qrCodes', q.id, `Offering QR “${q.name}” closed`);
  return view(ctx, next);
}

export type QrCreditedPayment = { id: string; amount: number; vpa?: string | null; contact?: string | null; email?: string | null; method?: string | null; createdAt?: string | null };

/**
 * A payment scanned from one of the church's QR codes (Razorpay `qr_code.credited`). Keyed by the
 * Razorpay payment id, so a retried webhook cannot count a gift twice. Returns the gift, or null
 * when the code is not ours or the payment is already recorded.
 */
export function applyQrCredited(ctx: Ctx, input: { qrId?: string | null; providerId?: string | null; payment: QrCreditedPayment }): Collections['donations'] | null {
  const q = (input.qrId && ctx.db.get('qrCodes', input.qrId)) || ctx.db.all('qrCodes').find((x) => x.providerId && x.providerId === input.providerId) || null;
  if (!q) return null;
  const p = input.payment;
  if (!p?.id || !(p.amount > 0)) return null;
  if (ctx.db.all('donations').some((d) => d.providerPaymentId === p.id)) return null;
  const fund = ctx.db.get('funds', q.fundId);
  const phone = p.contact ? normPhone(p.contact) : '';
  const email = p.email ? normEmail(p.email) : '';
  const donor = ctx.db.all('people').find((x) => (phone && x.phone && normPhone(x.phone) === phone) || (email && x.email && normEmail(x.email) === email)) ?? null;
  const at = p.createdAt ?? ctx.now.toISOString();
  const d = ctx.db.put('donations', {
    id: ctx.id('dn'),
    donorId: donor?.id ?? null,
    donorName: donor ? fullName(donor) : 'UPI giver',
    donorEmail: donor?.email ?? (email || null),
    donorPhone: donor?.phone ?? (p.contact ? String(p.contact) : null),
    fundId: q.fundId,
    fundName: fund?.name ?? q.fundName,
    amount: Math.round(p.amount),
    currency: settings(ctx).currency,
    frequency: 'once',
    status: 'succeeded',
    method: 'upi',
    pan: null,
    donorCitizenship: 'IN',
    fcra: false,
    provider: 'razorpay',
    providerRef: q.providerId ?? q.id,
    providerPaymentId: p.id,
    createdAt: at,
    paidAt: at,
    eventId: null,
    receiptNumber: null,
    batchId: null,
    qrId: q.id,
    upiVpa: p.vpa ?? null,
  });
  const done = onDonationSucceeded(ctx, d);
  ctx.audit('qr.credited', 'donations', done.id, `UPI gift via “${q.name}” for ${done.fundName}${donor ? ` from ${done.donorName}` : ''}`);
  return done;
}

export function registerOfferingQr(r: Router) {
  r.get('/admin/giving/qr', { perm: 'giving.view' }, (ctx) => offeringQrHub(ctx));
  r.post('/admin/giving/qr', { perm: 'giving.edit' }, (ctx) => createQr(ctx));
  r.post('/admin/giving/qr/:id/close', { perm: 'giving.edit' }, (ctx) => closeQr(ctx));
  // Demo and test only: pretend someone scanned the code. The server never registers this (Razorpay sends the webhook instead).
  r.post('/admin/giving/qr/:id/test-gift', { perm: 'giving.edit' }, (ctx) => {
    if (ctx.env.qrCodes) throw new ApiError(404, 'not_found', 'Not available on a live server.');
    const q = find(ctx, 'qrCodes', ctx.params[0], 'QR code');
    const b = ctx.body as { amount?: number; contact?: string };
    const amount = Math.round(Number(b.amount ?? 50000));
    if (!(amount >= 100)) throw new ApiError(422, 'invalid', 'Enter an amount of at least 1.', { amount: 'At least 1' });
    const gift = applyQrCredited(ctx, { qrId: q.id, payment: { id: `pay_demo_${ctx.id('x')}`, amount, vpa: 'giver@upi', contact: b.contact ?? null, method: 'upi' } });
    return { gift, code: view(ctx, q) };
  });
  // The projector and a printed poster point here; no sign-in, nothing private.
  r.get('/public/qr/:id', { public: true }, (ctx): PublicOfferingQr => {
    const q = find(ctx, 'qrCodes', ctx.params[0], 'QR code');
    const c = church(ctx);
    return { id: q.id, name: q.name, fundName: q.fundName, churchName: c.name, logoUrl: c.logoUrl ?? null, imageUrl: q.imageUrl, payload: q.payload, status: q.status, currency: c.currency };
  });
}
