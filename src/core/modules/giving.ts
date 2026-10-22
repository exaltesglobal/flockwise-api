// Funds, gifts, pledges, statements and 80G receipts. Online payments go through
// env.checkout (Razorpay on the server); the payment webhook calls onDonationSucceeded.
import { ApiError } from '../errors.js';
import type { Ctx, Router } from '../engine.js';
import type { Collections, Donation, GivingStatement, PaymentMethod, PledgeView } from '../types.js';
import {
  adminDonation,
  dateOnly,
  donationsSorted,
  eligible80g,
  find,
  fiscalYearRange,
  fullName,
  fundView,
  giftDate,
  nextReceiptNumber,
  page,
  pick,
  requireFields,
  settings,
} from '../util.js';
import { onTicketPaid } from './church.js';
import { onFormPaid } from './forms.js';
import { monthsLeft, startRecurring } from './recurring.js';

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

const publicDonation = (d: Collections['donations']): Donation => ({
  id: d.id,
  fundName: d.fundName,
  amount: d.amount,
  currency: d.currency,
  frequency: d.frequency,
  status: d.status,
  createdAt: giftDate(d),
  receiptUrl: null,
});

/** Called once when a gift is confirmed (webhook, demo checkout, or office entry). */
export function onDonationSucceeded(ctx: Ctx, d: Collections['donations']) {
  let next = d;
  if (!d.receiptNumber && !d.eventId && !d.formResponseId) next = ctx.db.put('donations', { ...d, receiptNumber: nextReceiptNumber(ctx) });
  if (next.formResponseId) onFormPaid(ctx, next);
  else onTicketPaid(ctx, next);
  return next;
}

/** Creates a pending gift and its checkout. Monthly gifts also start a recurring gift (UPI AutoPay). */
async function giftIntent(ctx: Ctx, input: Record<string, any>, extra: { pledgeId?: string; totalCount?: number } = {}) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const me = find(ctx, 'people', ctx.me(), 'Profile');
  const s = settings(ctx);
  const fields: Record<string, string> = {};
  if (!Number.isInteger(input.amount) || input.amount < 100) fields.amount = 'Enter an amount of at least 1.';
  if (input.amount > 1_00_00_000_00) fields.amount = 'For gifts above 1 crore please contact the church office.';
  if (input.frequency !== 'once' && input.frequency !== 'monthly') fields.frequency = 'Choose one time or monthly.';
  if (input.pan && !PAN_RE.test(input.pan)) fields.pan = 'PAN should look like ABCDE1234F.';
  if (input.currency !== s.currency) fields.currency = `This church accepts ${s.currency}.`;
  if (Object.keys(fields).length) throw new ApiError(422, 'invalid', 'Please check the highlighted fields.', fields);
  const fund = ctx.db.get('funds', input.fundId);
  if (!fund || !fund.active || fund.system) throw new ApiError(404, 'fund_not_found', 'That fund is not accepting gifts right now.');
  const fcra = s.country === 'IN' && input.donorCitizenship === 'OTHER';
  if (fcra && !s.fcra.registered) throw new ApiError(422, 'fcra_not_registered', 'This church cannot accept gifts from foreign citizens or OCI holders.');
  const d: Collections['donations'] = {
    id: ctx.id('dn'),
    donorId: me.id,
    donorName: fullName(me),
    donorEmail: me.email,
    donorPhone: me.phone,
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
    provider: 'demo',
    providerRef: null,
    providerPaymentId: null,
    createdAt: ctx.now.toISOString(),
    paidAt: null,
    eventId: null,
    receiptNumber: null,
  };
  const co = await ctx.env.checkout(d, { description: `${fund.name} · ${s.name}`, fundTaxDeductible: fund.taxDeductible, ...extra });
  const saved = ctx.db.put('donations', {
    ...d,
    provider: co.provider,
    providerRef: co.providerRef,
    status: co.status ?? 'pending',
    paidAt: co.status === 'succeeded' ? ctx.now.toISOString() : null,
    method: co.status === 'succeeded' ? 'upi' : null,
  });
  if (saved.status === 'succeeded') onDonationSucceeded(ctx, saved);
  const recurring = saved.frequency === 'monthly' && (saved.providerRef || saved.status === 'succeeded') ? startRecurring(ctx, saved, extra) : null;
  return { donation: saved, checkoutUrl: co.checkoutUrl, recurring };
}

function pledgeView(ctx: Ctx, p: Collections['pledges']): PledgeView {
  const given = ctx.db
    .all('donations')
    .filter((d) => d.donorId === p.personId && d.fundId === p.fundId && d.status === 'succeeded' && dateOnly(giftDate(d)) >= p.startDate && dateOnly(giftDate(d)) <= p.endDate)
    .reduce((s, d) => s + d.amount, 0);
  const g = ctx.db.all('recurring').find((x) => x.pledgeId === p.id && x.status !== 'cancelled');
  return { ...p, given, currency: settings(ctx).currency, autopay: g ? { id: g.id, status: g.status, amount: g.amount } : null };
}

function statement(ctx: Ctx, personId: string, fy?: string): GivingStatement {
  const p = find(ctx, 'people', personId, 'Person');
  const s = settings(ctx);
  const range = fiscalYearRange(ctx, fy);
  const gifts = ctx.db
    .all('donations')
    .filter((d) => d.donorId === p.id && d.status === 'succeeded' && !d.eventId && new Date(giftDate(d)) >= range.from && new Date(giftDate(d)) < range.to)
    .sort((x, y) => giftDate(x).localeCompare(giftDate(y)));
  const rows = gifts.map((d) => ({ id: d.id, date: giftDate(d), fundName: d.fundName, amount: d.amount, method: d.method, receiptNumber: d.receiptNumber, eligible80g: eligible80g(ctx, d) }));
  return {
    church: { name: s.name, address: s.address, logoUrl: s.logoUrl ?? null, pan: s.receipts80g.pan, registration80g: s.receipts80g.enabled ? s.receipts80g.registrationNumber : null },
    donor: { id: p.id, name: fullName(p), pan: gifts.map((g) => g.pan).find(Boolean) ?? null, address: p.address },
    financialYear: range.label,
    currency: s.currency,
    gifts: rows,
    total: rows.reduce((t, g) => t + g.amount, 0),
    eligible80g: rows.filter((g) => g.eligible80g).reduce((t, g) => t + g.amount, 0),
  };
}

/** Records a gift given in person (cash, cheque, bank transfer or UPI to the church's account). */
export function recordGift(ctx: Ctx, b: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  requireFields(b, ['donorName', 'fundId', 'amount', 'method']);
  const fund = find(ctx, 'funds', b.fundId, 'Fund');
  const method = b.method as PaymentMethod;
  if (!['cash', 'cheque', 'bank_transfer', 'upi', 'card', 'netbanking'].includes(method)) throw new ApiError(422, 'invalid', 'Choose how it was given.', { method: 'Required' });
  if (!(Number(b.amount) > 0)) throw new ApiError(422, 'invalid', 'Enter the amount.', { amount: 'Required' });
  if (b.pan && !PAN_RE.test(b.pan)) throw new ApiError(422, 'invalid', 'PAN should look like ABCDE1234F.', { pan: 'Invalid PAN' });
  const donor = b.donorId ? ctx.db.get('people', b.donorId) : undefined;
  const batch = b.batchId ? find(ctx, 'batches', String(b.batchId), 'Batch') : null;
  if (batch && batch.status !== 'open') throw new ApiError(409, 'batch_committed', `The batch “${batch.name}” is committed. Reopen it to add gifts.`);
  const at = b.receivedAt ? new Date(b.receivedAt).toISOString() : ctx.now.toISOString();
  const d = ctx.db.put('donations', {
    id: ctx.id('dn'),
    donorId: donor?.id ?? null,
    donorName: String(b.donorName),
    donorEmail: donor?.email ?? null,
    donorPhone: donor?.phone ?? null,
    fundId: fund.id,
    fundName: fund.name,
    amount: Math.round(Number(b.amount)),
    currency: settings(ctx).currency,
    frequency: 'once',
    status: 'succeeded',
    method,
    pan: b.pan || null,
    donorCitizenship: b.donorCitizenship === 'OTHER' ? 'OTHER' : 'IN',
    fcra: b.donorCitizenship === 'OTHER',
    provider: 'offline',
    providerRef: null,
    providerPaymentId: null,
    createdAt: at,
    paidAt: at,
    eventId: null,
    receiptNumber: null,
    batchId: batch?.id ?? null,
  });
  const saved = onDonationSucceeded(ctx, d);
  ctx.audit('recorded', 'donation', d.id, `Recorded ${method} gift from ${d.donorName}`);
  return saved;
}

export function registerGiving(r: Router) {
  // ----- member -----
  r.get('/giving/funds', {}, (ctx) =>
    ctx.db
      .all('funds')
      .filter((f) => f.active && !f.system)
      .map(({ id, name, description, taxDeductible }) => ({ id, name, description, taxDeductible })),
  );
  r.post('/giving/intents', {}, async (ctx) => {
    const out = await giftIntent(ctx, ctx.body);
    return { donationId: out.donation.id, checkoutUrl: out.checkoutUrl };
  });
  r.get('/giving/donations', {}, (ctx) => {
    const me = ctx.me();
    const res = page(
      donationsSorted(ctx).filter((d) => d.donorId === me && d.status !== 'pending'),
      ctx.query.cursor,
    );
    return { data: res.data.map(publicDonation), nextCursor: res.nextCursor };
  });
  r.get('/giving/statement', {}, (ctx) => statement(ctx, ctx.me(), ctx.query.financialYear));
  r.get('/giving/pledges', {}, (ctx) => {
    const me = ctx.me();
    return ctx.db.all('pledges').filter((p) => p.personId === me).map((p) => pledgeView(ctx, p));
  });
  r.post('/giving/pledges', {}, async (ctx) => {
    const me = find(ctx, 'people', ctx.me(), 'Profile');
    requireFields(ctx.body, ['fundId', 'amount', 'endDate']);
    const fund = find(ctx, 'funds', ctx.body.fundId, 'Fund');
    const amount = Math.round(Number(ctx.body.amount));
    if (!(amount >= 100)) throw new ApiError(422, 'invalid', 'Enter an amount.', { amount: 'Required' });
    const p = ctx.db.put('pledges', { id: ctx.id('pl'), personId: me.id, personName: fullName(me), fundId: fund.id, fundName: fund.name, amount, startDate: String(ctx.body.startDate ?? dateOnly(ctx.now)).slice(0, 10), endDate: String(ctx.body.endDate).slice(0, 10), createdAt: ctx.now.toISOString() });
    if (!ctx.body.autopay) return pledgeView(ctx, p);
    // Pay the pledge in equal monthly AutoPay instalments until its end date.
    const months = monthsLeft(ctx.now, p.startDate, p.endDate);
    const monthly = Math.ceil(p.amount / months / 100) * 100;
    try {
      const out = await giftIntent(ctx, { amount: monthly, currency: settings(ctx).currency, fundId: fund.id, frequency: 'monthly', pan: ctx.body.pan, donorCitizenship: ctx.body.donorCitizenship }, { pledgeId: p.id, totalCount: months });
      return { ...pledgeView(ctx, p), checkoutUrl: out.checkoutUrl, monthly, months };
    } catch (e) {
      ctx.db.del('pledges', p.id);
      throw e;
    }
  });
  r.del('/giving/pledges/:id', {}, (ctx) => {
    const p = find(ctx, 'pledges', ctx.params[0], 'Pledge');
    if (p.personId !== ctx.me()) throw new ApiError(403, 'forbidden', 'Not your pledge.');
    if (ctx.db.all('recurring').some((g) => g.pledgeId === p.id && ['pending', 'active', 'failing', 'paused'].includes(g.status)))
      throw new ApiError(409, 'autopay_on', 'Cancel the AutoPay for this pledge first.');
    ctx.db.del('pledges', p.id);
    return undefined;
  });

  // ----- admin -----
  r.get('/admin/giving/donations', { perm: 'giving.view' }, (ctx) => {
    const { fundId, from, to } = ctx.query;
    const q = String(ctx.query.q ?? '').toLowerCase();
    const list = donationsSorted(ctx)
      .filter((d) => d.status !== 'pending' || ctx.query.status === 'pending')
      .filter((d) => !fundId || d.fundId === fundId)
      .filter((d) => !from || dateOnly(giftDate(d)) >= from)
      .filter((d) => !to || dateOnly(giftDate(d)) <= to)
      .filter((d) => !q || d.donorName.toLowerCase().includes(q) || (d.pan ?? '').toLowerCase().includes(q) || (d.receiptNumber ?? '').toLowerCase().includes(q));
    const totalAmount = list.filter((d) => d.status === 'succeeded').reduce((s, d) => s + d.amount, 0);
    const res = page(list, ctx.query.cursor);
    return { ...res, data: res.data.map(adminDonation), totalAmount };
  });
  r.post('/admin/giving/donations', { perm: 'giving.edit' }, (ctx) => adminDonation(recordGift(ctx, ctx.body)));
  r.post('/admin/giving/donations/:id/refund', { perm: 'giving.edit' }, (ctx) => {
    const d = find(ctx, 'donations', ctx.params[0], 'Gift');
    if (d.status !== 'succeeded') throw new ApiError(422, 'invalid', 'Only completed gifts can be marked refunded.');
    if (d.batchId && ctx.db.get('batches', d.batchId)?.status === 'committed') throw new ApiError(409, 'batch_committed', 'This gift is in a committed batch. Reopen the batch first.');
    ctx.audit('refunded', 'donation', d.id, `Marked gift from ${d.donorName} as refunded`);
    return adminDonation(ctx.db.put('donations', { ...d, status: 'refunded' }));
  });
  r.get('/admin/giving/funds', { perm: 'giving.view' }, (ctx) => ctx.db.all('funds').filter((f) => !f.system).map((f) => fundView(ctx, f)));
  r.post('/admin/giving/funds', { perm: 'giving.edit' }, (ctx) => {
    requireFields(ctx.body, ['name']);
    const f = ctx.db.put('funds', { description: '', taxDeductible: true, active: true, goal: null, ...pick<Collections['funds']>(ctx.body, ['description', 'taxDeductible', 'active', 'goal']), name: String(ctx.body.name), id: ctx.id('fd') });
    ctx.audit('created', 'fund', f.id, `Created fund ${f.name}`);
    return fundView(ctx, f);
  });
  r.patch('/admin/giving/funds/:id', { perm: 'giving.edit' }, (ctx) => {
    const f = find(ctx, 'funds', ctx.params[0], 'Fund');
    const next = ctx.db.put('funds', { ...f, ...pick<Collections['funds']>(ctx.body, ['name', 'description', 'taxDeductible', 'active', 'goal']) });
    ctx.audit('updated', 'fund', f.id, `Updated fund ${next.name}`);
    return fundView(ctx, next);
  });
  r.get('/admin/giving/receipts-80g', { perm: 'giving.view' }, (ctx) => {
    const range = fiscalYearRange(ctx, ctx.query.financialYear);
    const eligible = ctx.db.all('donations').filter((d) => eligible80g(ctx, d) && new Date(giftDate(d)) >= range.from && new Date(giftDate(d)) < range.to);
    const byDonor = new Map<string, { donorId: string | null; name: string; pan: string | null; total: number; count: number; modes: PaymentMethod[] }>();
    for (const d of eligible) {
      const key = d.pan ?? `nopan:${d.donorId ?? d.donorName}`;
      const row = byDonor.get(key) ?? { donorId: d.donorId, name: d.donorName, pan: d.pan, total: 0, count: 0, modes: [] };
      row.total += d.amount;
      row.count++;
      if (d.method && !row.modes.includes(d.method)) row.modes.push(d.method);
      byDonor.set(key, row);
    }
    return { financialYear: range.label, donors: [...byDonor.values()].sort((x, y) => y.total - x.total) };
  });
  r.get('/admin/giving/statements/:personId', { perm: 'giving.view' }, (ctx) => statement(ctx, ctx.params[0], ctx.query.financialYear));
  r.get('/admin/giving/pledges', { perm: 'giving.view' }, (ctx) =>
    ctx.db
      .all('pledges')
      .map((p) => pledgeView(ctx, p))
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt)),
  );
  r.post('/admin/giving/pledges', { perm: 'giving.edit' }, (ctx) => {
    requireFields(ctx.body, ['personId', 'fundId', 'amount', 'endDate']);
    const p = find(ctx, 'people', ctx.body.personId, 'Person');
    const fund = find(ctx, 'funds', ctx.body.fundId, 'Fund');
    const pl = ctx.db.put('pledges', { id: ctx.id('pl'), personId: p.id, personName: fullName(p), fundId: fund.id, fundName: fund.name, amount: Math.round(Number(ctx.body.amount)), startDate: String(ctx.body.startDate ?? dateOnly(ctx.now)).slice(0, 10), endDate: String(ctx.body.endDate).slice(0, 10), createdAt: ctx.now.toISOString() });
    ctx.audit('created', 'pledge', pl.id, `Recorded pledge from ${pl.personName} to ${fund.name}`);
    return pledgeView(ctx, pl);
  });
  r.del('/admin/giving/pledges/:id', { perm: 'giving.edit' }, (ctx) => {
    const p = find(ctx, 'pledges', ctx.params[0], 'Pledge');
    ctx.db.del('pledges', p.id);
    ctx.audit('deleted', 'pledge', p.id, `Removed pledge from ${p.personName}`);
    return undefined;
  });
}
