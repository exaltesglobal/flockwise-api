// Flockwise subscription plans: prices, limits and which features each plan opens.
// Change prices and limits here; the church office, the sign-up page and the Flockwise
// team panel all read this one table.
import type { Db } from './db.js';
import { ApiError } from './errors.js';

export type PlanId = 'seed' | 'grow' | 'thrive' | 'cathedral';
export type BillingInterval = 'monthly' | 'yearly';
export type SubscriptionStatus = 'trial' | 'active' | 'past_due' | 'cancelled' | 'expired';

export type Plan = {
  id: PlanId;
  name: string;
  tagline: string;
  /** Prices in the smallest unit (paise, cents). Seed is free. */
  price: { INR: { monthly: number; yearly: number }; USD: { monthly: number; yearly: number } };
  limits: { people: number; staff: number; campuses: number; aiCredits: number };
  highlights: string[];
};

export const PLAN_ORDER: PlanId[] = ['seed', 'grow', 'thrive', 'cathedral'];
export const TRIAL_DAYS = 30;
const UNLIMITED = 1_000_000;

export const PLANS: Record<PlanId, Plan> = {
  seed: {
    id: 'seed',
    name: 'Seed',
    tagline: 'House churches and church plants',
    price: { INR: { monthly: 0, yearly: 0 }, USD: { monthly: 0, yearly: 0 } },
    limits: { people: 100, staff: 2, campuses: 1, aiCredits: 20 },
    highlights: ['People, households and directory', 'Member app in 6 languages', 'Events, announcements and prayer wall', 'Online giving with no platform fee', 'Email messages and birthday greetings'],
  },
  grow: {
    id: 'grow',
    name: 'Grow',
    tagline: 'Growing local churches',
    price: { INR: { monthly: 149_900, yearly: 1_499_000 }, USD: { monthly: 2_900, yearly: 29_000 } },
    limits: { people: 500, staff: 10, campuses: 1, aiCredits: 200 },
    highlights: ['Kids check-in, kiosk and labels', 'Volunteer rotas and groups', 'Forms, registrations and paid tickets', '80G receipts, pledges and statements', 'SMS and WhatsApp at cost, automations', 'Care, prayer and sermons library'],
  },
  thrive: {
    id: 'thrive',
    name: 'Thrive',
    tagline: 'Mid-sized and multi-service churches',
    price: { INR: { monthly: 399_900, yearly: 3_999_000 }, USD: { monthly: 7_900, yearly: 79_000 } },
    limits: { people: 2_500, staff: 30, campuses: 3, aiCredits: 1_000 },
    highlights: ['Worship planning, chord charts and CCLI', 'Lyrics on the projector, stage display and studio', 'Follow-up workflows and custom fields', 'Calendar with room booking', 'Insights and AI assistant'],
  },
  cathedral: {
    id: 'cathedral',
    name: 'Cathedral',
    tagline: 'Mega churches, dioceses and networks',
    price: { INR: { monthly: 999_900, yearly: 9_999_000 }, USD: { monthly: 19_900, yearly: 199_000 } },
    limits: { people: 10_000, staff: UNLIMITED, campuses: UNLIMITED, aiCredits: 5_000 },
    highlights: ['Unlimited campuses and logins', 'API access, MCP and integrations', 'Weekly AI pastor briefing', 'Priority support and data migration'],
  },
};

/** The lowest plan that opens each part of the church office. Paths not listed are on every plan. */
const GATES: [RegExp, PlanId][] = [
  [/^\/admin\/api-keys/, 'cathedral'],
  [/^\/admin\/ai\/briefing/, 'cathedral'],
  [/^\/admin\/(services|songs|workflows|workflow-cards|people-fields|bookings|resources|calendar|insights|presentation|ai\/(?!status))/, 'thrive'],
  [/^\/admin\/(checkin|volunteers|groups|forms|care|sermons|integrations|registers|zones|visits|accounts|expenses)/, 'grow'],
  [/^\/admin\/giving\/(pledges|receipts|batches|statements|10bd|form)/, 'grow'],
  [/^\/admin\/offerings/, 'grow'],
  [/^\/admin\/sunday-school/, 'grow'],
  [/^\/admin\/missions/, 'grow'],
  [/^\/admin\/livestream/, 'grow'],
];

export type Subscription = {
  plan: PlanId;
  status: SubscriptionStatus;
  interval: BillingInterval;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  /** The payment provider's subscription id. */
  providerRef: string | null;
  /** Churches set up before plans existed (or given it by the Flockwise team) have every feature. */
  founding?: boolean;
  /** A per-church people limit set by the Flockwise team (custom deals). */
  peopleLimit?: number | null;
  updatedAt: string;
};

const META_ID = 'subscription';

/** The church's subscription. A church with none is a founding church with everything open. */
export function getSubscription(db: Db): Subscription {
  const raw = db.get('meta', META_ID)?.value;
  if (raw) {
    try {
      return JSON.parse(raw) as Subscription;
    } catch {
      /* fall through */
    }
  }
  return { plan: 'cathedral', status: 'active', interval: 'yearly', trialEndsAt: null, currentPeriodEnd: null, providerRef: null, founding: true, updatedAt: '' };
}

export function saveSubscription(db: Db, sub: Subscription) {
  db.put('meta', { id: META_ID, value: JSON.stringify(sub) });
  return sub;
}

export function startTrial(db: Db, now: Date) {
  return saveSubscription(db, { plan: 'cathedral', status: 'trial', interval: 'monthly', trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * 86_400_000).toISOString(), currentPeriodEnd: null, providerRef: null, updatedAt: now.toISOString() });
}

/** The plan whose features apply right now: an ended trial or lapsed subscription falls back to Seed. */
export function effectivePlan(sub: Subscription, now: Date): PlanId {
  if (sub.founding) return sub.plan;
  if (sub.status === 'trial') return sub.trialEndsAt && sub.trialEndsAt > now.toISOString() ? sub.plan : 'seed';
  if (sub.status === 'active') return sub.plan;
  // A failed renewal keeps the plan for a week's grace from the period end.
  if (sub.status === 'past_due') return sub.currentPeriodEnd && new Date(sub.currentPeriodEnd).getTime() + 7 * 86_400_000 > now.getTime() ? sub.plan : 'seed';
  if (sub.status === 'cancelled') return sub.currentPeriodEnd && sub.currentPeriodEnd > now.toISOString() ? sub.plan : 'seed';
  return 'seed';
}

export const atLeast = (plan: PlanId, min: PlanId) => PLAN_ORDER.indexOf(plan) >= PLAN_ORDER.indexOf(min);

export function limitsFor(db: Db, now: Date) {
  const sub = getSubscription(db);
  const plan = effectivePlan(sub, now);
  const limits = { ...PLANS[plan].limits };
  if (sub.founding) return { people: UNLIMITED, staff: UNLIMITED, campuses: UNLIMITED, aiCredits: limits.aiCredits };
  if (sub.peopleLimit) limits.people = sub.peopleLimit;
  return limits;
}

/** The plan a path needs, or null when every plan has it. */
export function planNeeded(path: string, method: string, body: unknown): PlanId | null {
  for (const [re, plan] of GATES) if (re.test(path)) return plan;
  // SMS and WhatsApp messages start on Grow; email is on every plan.
  if (method === 'POST' && path === '/admin/messages') {
    const ch = (body as { channel?: string } | null)?.channel;
    if (ch && ch !== 'email') return 'grow';
  }
  return null;
}

/** Throws a clear "upgrade" error when the church's plan does not include this path. */
export function checkPlan(db: Db, now: Date, path: string, method: string, body: unknown) {
  const need = planNeeded(path, method, body);
  if (!need) return;
  const plan = effectivePlan(getSubscription(db), now);
  if (atLeast(plan, need)) return;
  throw new ApiError(402, 'plan_required', `This is part of the ${PLANS[need].name} plan. Upgrade in Settings › Plan and billing to use it.`, { plan: need });
}

/** Throws when adding `adding` more of something would go past the plan's limit (people get 10% grace). */
export function checkLimit(db: Db, now: Date, what: 'people' | 'staff' | 'campuses', current: number, adding = 1) {
  const limits = limitsFor(db, now);
  const max = what === 'people' ? Math.floor(limits[what] * 1.1) : limits[what];
  if (current + adding <= max) return;
  const label = { people: 'people', staff: 'office logins', campuses: 'campuses' }[what];
  throw new ApiError(402, 'plan_limit', `Your plan includes up to ${limits[what].toLocaleString('en-IN')} ${label}. Upgrade in Settings › Plan and billing to add more.`, { limit: String(limits[what]) });
}

export function priceFor(plan: PlanId, currency: string, interval: BillingInterval) {
  const cur = currency === 'INR' ? 'INR' : 'USD';
  return { currency: cur, amount: PLANS[plan].price[cur][interval] } as const;
}

/** Monthly recurring revenue of a subscription in its currency's smallest unit. */
export function monthlyValue(sub: Subscription, currency: string, now: Date) {
  if (sub.founding || sub.status !== 'active' || effectivePlan(sub, now) === 'seed') return 0;
  const p = priceFor(sub.plan, currency, sub.interval);
  return sub.interval === 'yearly' ? Math.round(p.amount / 12) : p.amount;
}
