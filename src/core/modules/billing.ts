// Plan and billing for the church office: what the church is on, what it uses, and changing plan.
// The church pays Flockwise through the host's billing hook (Razorpay subscriptions on the server).
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import { AI_PACK, aiExtra, CHITTHI_ADDON, chitthiIncluded, effectivePlan, getSubscription, limitsFor, PLAN_ORDER, PLANS, priceFor, saveSubscription, type BillingInterval, type PlanId } from '../plans.js';
import { churchId, settings } from '../util.js';
import { cancelChitthiSetup, getChitthiSetup, requestChitthiSetup } from './chitthi-setup.js';
import { activePeople } from './people.js';
import { getSetup, SETUP_FEE } from './razorpay-setup.js';

export function billingView(ctx: Ctx) {
  const sub = getSubscription(ctx.db);
  const s = settings(ctx);
  const currency = s.currency === 'INR' ? 'INR' : 'USD';
  const limits = limitsFor(ctx.db, ctx.now);
  const month = ctx.now.toISOString().slice(0, 7);
  const plan = effectivePlan(sub, ctx.now);
  return {
    subscription: sub,
    plan,
    currency,
    trialDaysLeft: sub.status === 'trial' && sub.trialEndsAt ? Math.max(0, Math.ceil((new Date(sub.trialEndsAt).getTime() - ctx.now.getTime()) / 86_400_000)) : null,
    usage: { people: activePeople(ctx.db), staff: ctx.db.count('staff'), campuses: Math.max(1, ctx.db.count('campuses')), aiCredits: Number(ctx.db.get('meta', `ai:${month}`)?.value ?? 0) },
    limits,
    plans: PLAN_ORDER.map((id) => ({ ...PLANS[id], prices: { monthly: priceFor(id, currency, 'monthly').amount, yearly: priceFor(id, currency, 'yearly').amount } })),
    online: !!ctx.env.billing,
    addons: {
      // Extra AI credits for this month, on top of the plan's allowance.
      ai: { credits: AI_PACK.credits, price: AI_PACK.price[currency], extraThisMonth: aiExtra(ctx.db, month), packsThisMonth: Math.round(aiExtra(ctx.db, month) / AI_PACK.credits), online: !!ctx.env.billing?.oneTime || !!ctx.env.demo },
      // Flockwise's team opens the church's Razorpay account and does its KYC (India only).
      razorpaySetup: { price: SETUP_FEE, currency: 'INR' as const, status: getSetup(ctx.db)?.status ?? null, available: currency === 'INR' },
      // WhatsApp by Chitthi on the same invoice; our team sets the workspace up and connects it.
      chitthi: {
        price: CHITTHI_ADDON.price[currency],
        includedFrom: CHITTHI_ADDON.includedFrom,
        included: chitthiIncluded(plan),
        on: !!sub.chitthi || chitthiIncluded(plan),
        setup: getChitthiSetup(ctx.db),
        connected: !!ctx.db.get('integrations', 'chitthi'),
      },
    },
  };
}

/** A paid AI pack adds its credits to this month's allowance. */
export function markAiPackPaid(ctx: Ctx, providerRef: string) {
  const pending = ctx.db.get('meta', `ai-pack:${providerRef}`);
  if (!pending) return false;
  ctx.db.del('meta', `ai-pack:${providerRef}`);
  const month = ctx.now.toISOString().slice(0, 7);
  ctx.db.put('meta', { id: `ai-extra:${month}`, value: String(aiExtra(ctx.db, month) + AI_PACK.credits) });
  ctx.audit('paid', 'billing', null, `Bought ${AI_PACK.credits} extra AI credits for ${month}`);
  return true;
}

export function registerBilling(r: Router) {
  r.get('/admin/billing', { staff: true }, (ctx) => billingView(ctx));

  // Add-on: a pack of extra AI credits for the current month.
  r.post('/admin/billing/ai-pack', { perm: 'settings' }, async (ctx) => {
    const s = settings(ctx);
    const currency = s.currency === 'INR' ? 'INR' : 'USD';
    if (ctx.env.demo && !ctx.env.billing?.oneTime) {
      const month = ctx.now.toISOString().slice(0, 7);
      ctx.db.put('meta', { id: `ai-extra:${month}`, value: String(aiExtra(ctx.db, month) + AI_PACK.credits) });
      ctx.audit('paid', 'billing', null, `Bought ${AI_PACK.credits} extra AI credits for ${month}`);
      return { activated: true, billing: billingView(ctx) };
    }
    if (!ctx.env.billing?.oneTime) throw new ApiError(503, 'billing_off', 'Online payment for add-ons is not switched on yet. Write to hello@flockwise.church and we will add the credits.');
    const out = await ctx.env.billing.oneTime({
      churchId: churchId(ctx), kind: AI_PACK.kind, amount: AI_PACK.price[currency], description: `${AI_PACK.credits} extra AI credits for ${s.name}`,
      email: ctx.staff?.email ?? s.email, name: ctx.staff?.name ?? s.name, returnUrl: `${ctx.env.webUrl}/admin/settings#billing`,
    });
    ctx.db.put('meta', { id: `ai-pack:${out.providerRef}`, value: ctx.now.toISOString() });
    ctx.audit('created', 'billing', null, 'Started paying for an AI credit pack');
    return { activated: false, checkoutUrl: out.url };
  });

  r.post('/admin/billing/checkout', { perm: 'settings' }, (ctx) => checkout(ctx, String(ctx.body.plan) as PlanId, ctx.body.interval === 'yearly' ? 'yearly' : 'monthly', ctx.body.chitthi === undefined ? !!getSubscription(ctx.db).chitthi : !!ctx.body.chitthi));

  // WhatsApp by Chitthi: on (asks our team to set the workspace up; billed with the plan unless the plan includes it) or off.
  r.post('/admin/billing/chitthi', { perm: 'settings' }, async (ctx) => {
    const sub = getSubscription(ctx.db);
    const plan = effectivePlan(sub, ctx.now);
    if (ctx.body.on === false) {
      cancelChitthiSetup(ctx);
      if (!sub.chitthi || chitthiIncluded(plan)) return { activated: true, billing: billingView(ctx) };
      if (ctx.env.billing && sub.providerRef) return checkout(ctx, sub.plan, sub.interval, false);
      saveSubscription(ctx.db, { ...sub, chitthi: false, updatedAt: ctx.now.toISOString() });
      ctx.audit('updated', 'billing', null, 'Removed WhatsApp by Chitthi from the plan');
      return { activated: true, billing: billingView(ctx) };
    }
    if (sub.founding || chitthiIncluded(plan) || sub.chitthi) {
      requestChitthiSetup(ctx, ctx.body);
      return { activated: true, billing: billingView(ctx) };
    }
    if (plan === 'seed') throw new ApiError(409, 'plan', 'WhatsApp by Chitthi comes with the Grow plan and above. Move up first.');
    // Remember the number and name, then bill the add-on with the plan.
    requestChitthiSetup(ctx, ctx.body);
    return checkout(ctx, sub.plan, sub.interval, true);
  });

  async function checkout(ctx: Ctx, plan: PlanId, interval: BillingInterval, chitthi: boolean) {
    if (!PLAN_ORDER.includes(plan)) throw new ApiError(422, 'invalid', 'Choose a plan.');
    const sub = getSubscription(ctx.db);
    if (sub.founding) throw new ApiError(409, 'founding', 'Your church is a founding church and already has every feature.');
    if (plan === 'seed') {
      if (sub.providerRef && ctx.env.billing) await ctx.env.billing.cancel(sub.providerRef);
      saveSubscription(ctx.db, { ...sub, plan: 'seed', status: 'active', interval: 'monthly', providerRef: null, currentPeriodEnd: null, chitthi: false, updatedAt: ctx.now.toISOString() });
      ctx.audit('updated', 'billing', null, 'Moved to the free Seed plan');
      return { activated: true, billing: billingView(ctx) };
    }
    const s = settings(ctx);
    const withChitthi = chitthi && !chitthiIncluded(plan);
    const price = priceFor(plan, s.currency, interval, withChitthi);
    const label = `${PLANS[plan].name} plan (${interval})${withChitthi ? ' with WhatsApp by Chitthi' : ''}`;
    if (!ctx.env.billing) {
      if (!ctx.env.demo) throw new ApiError(503, 'billing_off', 'Online plan payments are not switched on yet. Write to hello@flockwise.church and we will set up your plan.');
      // Demo: the plan starts at once.
      const end = new Date(ctx.now.getTime() + (interval === 'yearly' ? 365 : 30) * 86_400_000).toISOString();
      saveSubscription(ctx.db, { ...sub, plan, interval, status: 'active', trialEndsAt: null, currentPeriodEnd: end, providerRef: `demo_${ctx.id('sub')}`, chitthi: withChitthi, updatedAt: ctx.now.toISOString() });
      ctx.audit('updated', 'billing', null, `Moved to the ${label}`);
      return { activated: true, billing: billingView(ctx) };
    }
    const out = await ctx.env.billing.checkout({ churchId: churchId(ctx), churchName: s.name, plan, interval, currency: price.currency, amount: price.amount, email: ctx.staff?.email ?? s.email, name: ctx.staff?.name ?? s.name, addons: withChitthi ? ['chitthi'] : [] });
    ctx.audit('updated', 'billing', null, `Started checkout for the ${label}`);
    return { activated: false, checkoutUrl: out.url };
  }

  r.post('/admin/billing/cancel', { perm: 'settings' }, async (ctx) => {
    const sub = getSubscription(ctx.db);
    if (sub.founding || sub.status !== 'active' || sub.plan === 'seed') throw new ApiError(409, 'nothing_to_cancel', 'There is no paid plan to cancel.');
    if (sub.providerRef && ctx.env.billing) await ctx.env.billing.cancel(sub.providerRef);
    saveSubscription(ctx.db, { ...sub, status: 'cancelled', updatedAt: ctx.now.toISOString() });
    ctx.audit('updated', 'billing', null, `Cancelled the ${PLANS[sub.plan].name} plan; it stays on until the end of the paid period`);
    return billingView(ctx);
  });
}

/** Applies a confirmed payment event from the billing provider to a church. */
export function applyBillingEvent(ctx: Ctx, e: { type: 'charged' | 'halted' | 'cancelled'; plan?: PlanId; interval?: BillingInterval; providerRef: string; periodEnd?: string | null; chitthi?: boolean }) {
  const sub = getSubscription(ctx.db);
  const now = ctx.now.toISOString();
  if (e.type === 'charged') {
    const interval = e.interval ?? sub.interval;
    const end = e.periodEnd ?? new Date(ctx.now.getTime() + (interval === 'yearly' ? 365 : 31) * 86_400_000).toISOString();
    // A new subscription replaces the old one at the provider; the old one is cancelled so the church is not charged twice.
    if (sub.providerRef && sub.providerRef !== e.providerRef && ctx.env.billing) void ctx.env.billing.cancel(sub.providerRef).catch(() => undefined);
    saveSubscription(ctx.db, { ...sub, founding: false, plan: e.plan ?? sub.plan, interval, status: 'active', trialEndsAt: null, currentPeriodEnd: end, providerRef: e.providerRef, chitthi: e.chitthi ?? sub.chitthi, updatedAt: now });
    ctx.audit('updated', 'billing', null, `Payment received for the ${PLANS[e.plan ?? sub.plan].name} plan${e.chitthi ? ' with WhatsApp by Chitthi' : ''}`);
  } else if (sub.providerRef === e.providerRef) {
    saveSubscription(ctx.db, { ...sub, status: e.type === 'halted' ? 'past_due' : 'cancelled', updatedAt: now });
    ctx.audit('updated', 'billing', null, e.type === 'halted' ? 'Plan renewal payment failed' : 'Plan cancelled');
  }
}
