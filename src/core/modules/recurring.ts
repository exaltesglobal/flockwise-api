// Recurring gifts: monthly giving and pledge instalments on Razorpay subscriptions. The giver approves
// once (UPI AutoPay in their UPI app, a card, or a bank e-mandate) and Razorpay charges each month.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { DonationRecord, PaymentMethod, RecurringGift, RecurringStatus, RecurringSummary } from '../types.js';
import { settings } from '../util.js';

const addMonth = (d: Date) => {
  const n = new Date(d);
  n.setUTCMonth(n.getUTCMonth() + 1);
  return n.toISOString();
};

/** Months from the later of today and `start`, up to and including the month of `end`. */
export function monthsLeft(now: Date, start: string, end: string) {
  const from = new Date(Math.max(now.getTime(), new Date(`${start}T00:00:00Z`).getTime()));
  const to = new Date(`${end}T00:00:00Z`);
  return Math.max(1, (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth()) + 1);
}

/** Records a new monthly gift after its checkout is created. The demo approves it at once. */
export function startRecurring(ctx: Ctx, d: DonationRecord, opts: { pledgeId?: string | null; totalCount?: number | null } = {}) {
  const paid = d.status === 'succeeded';
  return ctx.db.put('recurring', {
    id: ctx.id('rg'),
    donorId: d.donorId,
    donorName: d.donorName,
    fundId: d.fundId,
    fundName: d.fundName,
    amount: d.amount,
    currency: d.currency,
    status: paid ? 'active' : 'pending',
    providerRef: d.providerRef,
    fcra: d.fcra,
    method: paid ? d.method : null,
    pledgeId: opts.pledgeId ?? null,
    totalCount: opts.totalCount ?? null,
    chargedCount: paid ? 1 : 0,
    totalGiven: paid ? d.amount : 0,
    lastChargedAt: paid ? ctx.now.toISOString() : null,
    nextChargeAt: paid ? addMonth(ctx.now) : null,
    createdAt: ctx.now.toISOString(),
    endedAt: null,
  });
}

export type RecurringEvent = { event: string; ref: string; amount?: number; method?: PaymentMethod | null; currentEnd?: number | null; paymentId?: string | null };

/** Applies a verified Razorpay subscription event. Safe to repeat: charges are counted from donations. */
export function applyRecurringEvent(ctx: Ctx, e: RecurringEvent) {
  const g = ctx.db.all('recurring').find((x) => x.providerRef === e.ref);
  if (!g) return null;
  const next: RecurringGift = { ...g };
  const now = ctx.now.toISOString();
  const end = (status: RecurringStatus) => {
    next.status = status;
    next.endedAt = g.endedAt ?? now;
  };
  switch (e.event) {
    case 'subscription.authenticated':
    case 'subscription.activated':
    case 'subscription.resumed':
      if (!['cancelled', 'completed'].includes(g.status)) next.status = 'active';
      break;
    case 'subscription.charged': {
      const gifts = ctx.db.all('donations').filter((d) => d.providerRef === g.providerRef && d.status === 'succeeded');
      next.chargedCount = gifts.length;
      next.totalGiven = gifts.reduce((s, d) => s + d.amount, 0);
      next.lastChargedAt = now;
      if (e.method) next.method = e.method;
      if (!['cancelled', 'completed', 'paused'].includes(g.status)) next.status = 'active';
      break;
    }
    case 'subscription.pending':
      next.status = 'failing';
      break;
    case 'subscription.halted':
      next.status = 'halted';
      break;
    case 'subscription.paused':
      next.status = 'paused';
      break;
    case 'subscription.cancelled':
      end('cancelled');
      break;
    case 'subscription.completed':
      end('completed');
      break;
    default:
      return g;
  }
  if (e.currentEnd) next.nextChargeAt = new Date(e.currentEnd * 1000).toISOString();
  if (['cancelled', 'completed', 'halted'].includes(next.status)) next.nextChargeAt = null;
  if (next.status !== g.status) ctx.audit('updated', 'recurring gift', g.id, `${g.donorName}'s monthly gift to ${g.fundName}: ${LABELS[next.status]}`);
  return ctx.db.put('recurring', next);
}

export const LABELS: Record<RecurringStatus, string> = {
  pending: 'waiting for approval',
  active: 'active',
  failing: 'payment failing, Razorpay is retrying',
  paused: 'paused',
  halted: 'stopped after failed payments',
  cancelled: 'cancelled',
  completed: 'completed',
};

function summary(ctx: Ctx): RecurringSummary {
  const all = ctx.db.all('recurring');
  const live = all.filter((g) => g.status === 'active' || g.status === 'failing');
  return {
    active: live.length,
    monthly: live.reduce((s, g) => s + g.amount, 0),
    failing: all.filter((g) => g.status === 'failing' || g.status === 'halted').length,
    pending: all.filter((g) => g.status === 'pending').length,
    currency: settings(ctx).currency,
  };
}

async function change(ctx: Ctx, g: RecurringGift, action: 'pause' | 'resume' | 'cancel') {
  const allowed: Record<typeof action, RecurringStatus[]> = {
    pause: ['active', 'failing'],
    resume: ['paused'],
    cancel: ['pending', 'active', 'failing', 'paused', 'halted'],
  };
  if (!allowed[action].includes(g.status)) throw new ApiError(409, 'invalid_state', `This gift is ${LABELS[g.status]}.`);
  // Test-checkout gifts (test_sub_…) have nothing at Razorpay to change.
  if (ctx.env.subscriptions && g.providerRef && !g.providerRef.startsWith('test_')) await ctx.env.subscriptions[action](g.providerRef, g.fcra);
  const status: RecurringStatus = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'cancelled';
  const next = ctx.db.put('recurring', { ...g, status, endedAt: action === 'cancel' ? ctx.now.toISOString() : g.endedAt, nextChargeAt: action === 'resume' ? g.nextChargeAt : null });
  ctx.audit('updated', 'recurring gift', g.id, `${action === 'pause' ? 'Paused' : action === 'resume' ? 'Resumed' : 'Cancelled'} ${g.donorName}'s monthly gift to ${g.fundName}`);
  return next;
}

export function registerRecurring(r: Router) {
  r.get('/giving/recurring', {}, (ctx) => {
    const me = ctx.me();
    return ctx.db.all('recurring').filter((g) => g.donorId === me && g.status !== 'pending').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
  for (const action of ['pause', 'resume', 'cancel'] as const) {
    r.post(`/giving/recurring/:id/${action}`, {}, async (ctx) => {
      const g = ctx.db.get('recurring', ctx.params[0]);
      if (!g || g.donorId !== ctx.me()) throw new ApiError(404, 'not_found', 'Monthly gift not found.');
      return change(ctx, g, action);
    });
  }

  r.get('/admin/giving/recurring', { perm: 'giving.view' }, (ctx) => {
    const status = ctx.query.status;
    const rows = ctx.db
      .all('recurring')
      .filter((g) => !status || (status === 'attention' ? g.status === 'failing' || g.status === 'halted' : g.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { summary: summary(ctx), rows };
  });
  r.post('/admin/giving/recurring/:id/cancel', { perm: 'giving.edit' }, async (ctx) => {
    const g = ctx.db.get('recurring', ctx.params[0]);
    if (!g) throw new ApiError(404, 'not_found', 'Monthly gift not found.');
    return change(ctx, g, 'cancel');
  });
}
