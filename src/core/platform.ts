// Many churches on one server: the church directory, self sign-up, "find my church", and the
// Flockwise team panel (/platform). Browser-safe like the rest of the engine, so the web demo
// runs the same code. Its own records (the directory, team sign-in codes and sessions, team
// actions) live in a separate database that the host persists like a church's.
import { bootstrapChurch } from './bootstrap.js';
import type { Db } from './db.js';
import type { Env, Request } from './engine.js';
import { ApiError } from './errors.js';
import type { createChurchEngine } from './index.js';
import { activePeople } from './modules/people.js';
import { createNetworks } from './network.js';
import { songTeamRoute, storedSongs } from './catalog/team.js';
import { SETUP_FEE, teamReadDoc, teamSetupRow, teamUpdateSetup } from './modules/razorpay-setup.js';
import { effectivePlan, getSubscription, monthlyValue, PLAN_ORDER, PLANS, saveSubscription, startTrial, type PlanId, type Subscription } from './plans.js';
import type { Currency, Session } from './types.js';

type ChurchEngine = ReturnType<typeof createChurchEngine>;

export type ChurchEntry = {
  id: string;
  slug: string;
  name: string;
  city: string;
  country: string;
  currency: Currency;
  ownerEmail: string;
  ownerName: string;
  createdAt: string;
  status: 'active' | 'suspended';
  source: 'signup' | 'founding' | 'team';
  notes: string;
};

/** What the host provides: every church's engine, and a way to make a new, persisted one. */
export type TenantHost = {
  defaultId: string;
  get(id: string): ChurchEngine | undefined;
  create(id: string): Promise<ChurchEngine>;
};

export type PlatformOpts = { db: Db; env: Env; host: TenantHost; admins: string[] };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const RESERVED = new Set(['admin', 'app', 'api', 'www', 'platform', 'start', 'signup', 'sign-in', 'login', 'flockwise', 'church', 'churches', 'help', 'support', 'legal', 'forms', 'present', 'mail', 'static', 'assets', 'demo', 'test', 'c']);
const CODE_TTL = 10 * 60_000;
const TEAM_SESSION_HOURS = 12;
const DAY = 86_400_000;

export const slugify = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();

export function createPlatform({ db, env, host, admins }: PlatformOpts) {
  const adminSet = new Set(admins.map(norm).filter(Boolean));
  const now = () => env.now();

  // ----- the church directory -----
  const entries = () =>
    db
      .all('meta')
      .filter((m) => m.id.startsWith('church:'))
      .map((m) => JSON.parse(m.value) as ChurchEntry);
  const entry = (id: string) => {
    const m = db.get('meta', `church:${id}`);
    return m ? (JSON.parse(m.value) as ChurchEntry) : undefined;
  };
  const putEntry = (e: ChurchEntry) => db.put('meta', { id: `church:${e.id}`, value: JSON.stringify(e) });
  const bySlug = (slug: string) => entries().find((e) => e.slug === slug);

  /** Finds a church by slug or id. */
  function lookup(ref: string | null | undefined) {
    const r = norm(ref);
    if (!r) return undefined;
    return entry(r) ?? bySlug(r);
  }

  function slugProblem(slug: string): string | null {
    if (!SLUG_RE.test(slug)) return 'Use 3 to 40 lowercase letters, numbers and dashes.';
    if (RESERVED.has(slug)) return 'That address is reserved. Try another.';
    if (bySlug(slug)) return 'Another church already uses that address.';
    return null;
  }

  function suggestSlug(name: string, city = '') {
    const base = slugify(name) || 'church';
    for (const cand of [base, slugify(`${name} ${city}`), ...Array.from({ length: 50 }, (_, i) => `${base}-${i + 2}`)]) if (cand && !slugProblem(cand)) return cand;
    return `${base}-${env.random(5, 'abcdefghijkmnpqrstuvwxyz23456789')}`;
  }

  /** Adds the server's own church (set up by environment variables) to the directory. */
  function ensureChurch(e: Omit<ChurchEntry, 'createdAt' | 'status' | 'notes' | 'source'> & Partial<ChurchEntry>) {
    const existing = entry(e.id);
    if (existing) return existing;
    let slug = e.slug && !slugProblem(e.slug) ? e.slug : suggestSlug(e.name, e.city);
    if (bySlug(slug)) slug = suggestSlug(e.name, e.city);
    const full: ChurchEntry = { createdAt: now().toISOString(), status: 'active', notes: '', source: 'founding', ...e, slug };
    putEntry(full);
    return full;
  }

  /** The church a request is for: the signed-in church, else the one named by the client, else the server's own. */
  function resolve(ref: string | null | undefined): { entry: ChurchEntry | undefined; engine: ChurchEngine } {
    const e = ref ? lookup(ref) : entry(host.defaultId);
    if (ref && !e) throw new ApiError(404, 'church_not_found', 'We could not find that church on Flockwise. Check the church address.');
    const id = e?.id ?? host.defaultId;
    if (e?.status === 'suspended') throw new ApiError(403, 'church_suspended', 'This church account is paused. The church owner can contact hello@flockwise.church.');
    const engine = host.get(id);
    if (!engine) throw new ApiError(404, 'church_not_found', 'We could not find that church on Flockwise.');
    return { entry: e, engine };
  }

  // ----- one-time codes (sign-up and the Flockwise team) -----
  async function sendCode(email: string, audience: 'admin' | 'member', label: string) {
    const hourAgo = new Date(now().getTime() - 3600_000).toISOString();
    for (const o of db.all('otps')) if (o.expiresAt < hourAgo) db.del('otps', o.id);
    if (db.all('otps').filter((o) => o.email === email && o.createdAt > hourAgo).length >= 5 && !env.demo) throw new ApiError(429, 'too_many_codes', 'Too many codes requested. Please wait a few minutes and try again.');
    const code = env.demo ? '123456' : env.random(6, '0123456789');
    const rec = db.put('otps', { id: env.newId('otp'), email, codeHash: env.hash(`${email}:${code}`), audience, createdAt: now().toISOString(), expiresAt: new Date(now().getTime() + CODE_TTL).toISOString(), attempts: 0, used: false });
    if (!env.demo) await env.sendOtpEmail(email, code, label);
    return { requestId: rec.id, channel: 'email' as const, expiresInSeconds: CODE_TTL / 1000 };
  }

  function useCode(requestId: unknown, code: unknown, audience: 'admin' | 'member') {
    const otp = db.get('otps', String(requestId ?? ''));
    if (!otp || otp.used || otp.audience !== audience || otp.expiresAt < now().toISOString()) throw new ApiError(422, 'code_expired', 'This code has expired. Please request a new one.');
    if (otp.attempts >= 5) throw new ApiError(429, 'too_many_attempts', 'Too many wrong codes. Please request a new one.');
    if (env.hash(`${otp.email}:${String(code ?? '').trim()}`) !== otp.codeHash) {
      db.put('otps', { ...otp, attempts: otp.attempts + 1 });
      throw new ApiError(422, 'invalid_code', env.demo ? 'That code is not right. In demo mode use 123456.' : 'That code is not right. Please check the email and try again.');
    }
    return { otp, done: () => db.put('otps', { ...otp, used: true }) };
  }

  /** Signs someone in to a church office without a second code (after sign-up, or for support). */
  async function churchSession(engine: ChurchEngine, email: string): Promise<Session> {
    const code = env.random(10, '0123456789');
    const t = now();
    const id = env.newId('otp');
    engine.db.put('otps', { id, email, codeHash: env.hash(`${email}:${code}`), audience: 'admin', createdAt: t.toISOString(), expiresAt: new Date(t.getTime() + 60_000).toISOString(), attempts: 0, used: false });
    return (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: id, code }, auth: null })) as Session;
  }

  // ----- church networks and dioceses (network.ts) -----
  const networks = createNetworks({
    db,
    env,
    engine: (id) => host.get(id),
    entry: (id) => entry(id),
    sendCode: (email, label) => sendCode(email, 'member', label),
    useCode: (requestId, code) => {
      const { otp, done } = useCode(requestId, code, 'member');
      return { email: otp.email, done };
    },
  });

  // ----- the Flockwise team -----
  function teamSession(token: string | null | undefined) {
    if (!token) throw new ApiError(401, 'unauthorized', 'Please sign in to the Flockwise team panel.');
    const m = db.get('meta', `ps:${env.hash(token)}`);
    const s = m ? (JSON.parse(m.value) as { email: string; expiresAt: string }) : null;
    if (!s || s.expiresAt < now().toISOString() || (!env.demo && !adminSet.has(s.email))) throw new ApiError(401, 'unauthorized', 'Please sign in to the Flockwise team panel.');
    return s;
  }

  function teamLog(email: string, action: string, churchId: string | null, summary: string) {
    db.put('audit', { id: env.newId('au'), at: now().toISOString(), actorId: email, actorName: email, action, entity: 'church', entityId: churchId, summary });
  }

  function churchRow(e: ChurchEntry) {
    const engine = host.get(e.id);
    const sub: Subscription = engine ? getSubscription(engine.db) : { plan: 'seed', status: 'expired', interval: 'monthly', trialEndsAt: null, currentPeriodEnd: null, providerRef: null, updatedAt: '' };
    const t = now();
    const staff = engine?.db.all('staff') ?? [];
    const lastActiveAt = staff.map((s) => s.lastActiveAt ?? '').sort().pop() || null;
    return {
      ...e,
      plan: effectivePlan(sub, t),
      subscription: sub,
      people: engine ? activePeople(engine.db) : 0,
      staff: staff.length,
      lastActiveAt,
      mrr: monthlyValue(sub, e.currency, t),
      priceCurrency: e.currency === 'INR' ? 'INR' : 'USD',
    };
  }

  function overview() {
    const t = now();
    const rows = entries().map(churchRow);
    const month = t.toISOString().slice(0, 7);
    const mrr = { INR: 0, USD: 0 };
    for (const r of rows) mrr[r.priceCurrency as 'INR' | 'USD'] += r.mrr;
    const weeks = Array.from({ length: 12 }, (_, i) => {
      const end = new Date(t.getTime() - i * 7 * DAY);
      const start = new Date(end.getTime() - 7 * DAY);
      return { weekStart: start.toISOString().slice(0, 10), signups: rows.filter((r) => r.createdAt > start.toISOString() && r.createdAt <= end.toISOString()).length };
    }).reverse();
    let aiCredits = 0;
    let messages = 0;
    for (const r of rows) {
      const eng = host.get(r.id);
      if (!eng) continue;
      aiCredits += Number(eng.db.get('meta', `ai:${month}`)?.value ?? 0);
      messages += eng.db.all('messages').filter((m) => m.sentAt?.startsWith(month)).reduce((n, m) => n + m.stats.sent, 0);
    }
    const in7 = new Date(t.getTime() + 7 * DAY).toISOString();
    return {
      churches: rows.length,
      activeLast30: rows.filter((r) => r.lastActiveAt && r.lastActiveAt > new Date(t.getTime() - 30 * DAY).toISOString()).length,
      newLast30: rows.filter((r) => r.createdAt > new Date(t.getTime() - 30 * DAY).toISOString()).length,
      trials: rows.filter((r) => r.subscription.status === 'trial' && r.plan !== 'seed').length,
      paying: rows.filter((r) => r.mrr > 0).length,
      pastDue: rows.filter((r) => r.subscription.status === 'past_due').map((r) => ({ id: r.id, name: r.name, plan: r.subscription.plan })),
      trialsEnding: rows.filter((r) => r.subscription.status === 'trial' && r.subscription.trialEndsAt && r.subscription.trialEndsAt > t.toISOString() && r.subscription.trialEndsAt < in7).map((r) => ({ id: r.id, name: r.name, trialEndsAt: r.subscription.trialEndsAt })),
      mrr,
      arr: { INR: mrr.INR * 12, USD: mrr.USD * 12 },
      byPlan: PLAN_ORDER.map((p) => ({ plan: p, name: PLANS[p].name, churches: rows.filter((r) => r.plan === p).length })),
      people: rows.reduce((n, r) => n + r.people, 0),
      aiCredits,
      messages,
      signups: weeks,
      razorpaySetupsOpen: rows.filter((r) => ['paid', 'in_progress'].includes(host.get(r.id) ? (teamSetupRow(host.get(r.id)!.db)?.status ?? '') : '')).length,
    };
  }

  function teamRoute(method: string, parts: string[], body: Record<string, unknown>, query: Record<string, string | undefined>, email: string): unknown {
    const [a, id, b] = parts;
    if (method === 'GET' && a === 'me') return { email };
    if (method === 'GET' && a === 'overview') return overview();
    if (method === 'GET' && a === 'audit') return db.all('audit').sort((x, y) => y.at.localeCompare(x.at)).slice(0, 200);
    if (method === 'GET' && a === 'plans') return PLAN_ORDER.map((p) => PLANS[p]);
    if (a === 'razorpay-setups') return setupRoute(method, id, b, parts[3], body, email);
    if (a !== 'churches') throw new ApiError(404, 'not_found', 'Not found.');
    if (method === 'GET' && !id) {
      const q = norm(query.q);
      return entries()
        .map(churchRow)
        .filter((r) => !q || [r.name, r.slug, r.city, r.ownerEmail].some((v) => norm(v).includes(q)))
        .filter((r) => !query.plan || r.plan === query.plan)
        .filter((r) => !query.status || (query.status === 'suspended' ? r.status === 'suspended' : r.subscription.status === query.status))
        .sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    }
    const e = entry(String(id));
    if (!e) throw new ApiError(404, 'not_found', 'Church not found.');
    const engine = host.get(e.id);
    if (method === 'GET' && !b) {
      return {
        ...churchRow(e),
        team: engine?.db.all('staff').map((s) => ({ id: s.id, name: s.name, email: s.email, role: s.role, status: s.status, lastActiveAt: s.lastActiveAt })) ?? [],
        activity: engine?.db.all('audit').sort((x, y) => y.at.localeCompare(x.at)).slice(0, 25) ?? [],
        teamLog: db.all('audit').filter((x) => x.entityId === e.id).sort((x, y) => y.at.localeCompare(x.at)).slice(0, 25),
      };
    }
    if (method === 'PATCH' && !b) {
      const next = { ...e };
      if (body.status === 'active' || body.status === 'suspended') next.status = body.status;
      if (typeof body.notes === 'string') next.notes = body.notes.slice(0, 4000);
      if (typeof body.name === 'string' && body.name.trim()) next.name = body.name.trim().slice(0, 120);
      if (typeof body.slug === 'string' && body.slug !== e.slug) {
        const problem = slugProblem(body.slug);
        if (problem) throw new ApiError(422, 'invalid', problem, { slug: problem });
        next.slug = body.slug;
      }
      putEntry(next);
      if (next.status !== e.status) teamLog(email, next.status === 'suspended' ? 'suspended' : 'restored', e.id, `${next.status === 'suspended' ? 'Paused' : 'Restored'} ${e.name}`);
      else teamLog(email, 'updated', e.id, `Updated ${e.name}`);
      return churchRow(next);
    }
    if (method === 'POST' && b === 'subscription') {
      if (!engine) throw new ApiError(409, 'not_loaded', 'That church is not loaded on this server.');
      const sub = getSubscription(engine.db);
      const t = now();
      const next: Subscription = { ...sub, updatedAt: t.toISOString() };
      if (body.plan && PLAN_ORDER.includes(body.plan as PlanId)) next.plan = body.plan as PlanId;
      if (typeof body.founding === 'boolean') next.founding = body.founding;
      if (body.peopleLimit !== undefined) next.peopleLimit = body.peopleLimit ? Math.max(1, Number(body.peopleLimit)) : null;
      if (body.status && ['trial', 'active', 'past_due', 'cancelled', 'expired'].includes(String(body.status))) next.status = body.status as Subscription['status'];
      if (body.trialDays !== undefined) {
        const days = Math.min(365, Math.max(1, Number(body.trialDays) || 0));
        const from = next.status === 'trial' && next.trialEndsAt && next.trialEndsAt > t.toISOString() ? new Date(next.trialEndsAt) : t;
        next.status = 'trial';
        next.trialEndsAt = new Date(from.getTime() + days * DAY).toISOString();
      }
      if (body.periodEnd) next.currentPeriodEnd = new Date(String(body.periodEnd)).toISOString();
      saveSubscription(engine.db, next);
      teamLog(email, 'plan', e.id, `Set ${e.name} to ${PLANS[next.plan].name} (${next.founding ? 'founding' : next.status})${body.trialDays ? `, trial +${body.trialDays} days` : ''}`);
      return churchRow(e);
    }
    throw new ApiError(404, 'not_found', 'Not found.');
  }

  /** Assisted Razorpay setups across every church: the KYC work queue. */
  function setupRoute(method: string, id: string | undefined, b: string | undefined, docId: string | undefined, body: Record<string, unknown>, email: string): unknown {
    if (method === 'GET' && !id) {
      const rows = entries().flatMap((e) => {
        const eng = host.get(e.id);
        const row = eng ? teamSetupRow(eng.db) : null;
        return row ? [{ ...row, churchId: e.id, churchName: e.name, city: e.city, ownerEmail: e.ownerEmail, docs: row.docs, stored: row.docs.filter((d) => !!eng!.db.get('kycFiles', d.id)).map((d) => d.id) }] : [];
      });
      const order = ['paid', 'in_progress', 'pending_payment', 'done', 'refunded'];
      rows.sort((x, y) => order.indexOf(x.status) - order.indexOf(y.status) || (x.paidAt ?? x.createdAt).localeCompare(y.paidAt ?? y.createdAt));
      return {
        price: SETUP_FEE,
        open: rows.filter((r) => r.status === 'paid' || r.status === 'in_progress').length,
        earned: rows.filter((r) => r.paidAt && r.status !== 'refunded').reduce((n, r) => n + r.amount, 0),
        rows,
      };
    }
    const e = entry(String(id));
    const eng = e ? host.get(e.id) : undefined;
    if (!e || !eng) throw new ApiError(404, 'not_found', 'Church not found.');
    if (method === 'GET' && b === 'docs' && docId) {
      const out = teamReadDoc(eng.db, docId, env.unseal);
      teamLog(email, 'kyc_doc', e.id, `Opened ${out.fileName} from ${e.name}`);
      return out;
    }
    if (method === 'PATCH' && !b) {
      const next = teamUpdateSetup(eng.db, body, now().toISOString());
      teamLog(email, 'kyc', e.id, `Razorpay setup for ${e.name}: ${next.status}${next.teamNote ? ` (${next.teamNote})` : ''}`);
      return { ...teamSetupRow(eng.db), churchId: e.id, churchName: e.name };
    }
    throw new ApiError(404, 'not_found', 'Not found.');
  }

  /** Requests under /platform, /signup and /churches. `token` is a Flockwise team session. */
  async function handle(req: Request & { token?: string | null }): Promise<unknown> {
    const method = req.method.toUpperCase();
    const path = req.path.replace(/\/+$/, '');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const query = req.query ?? {};
    const parts = path.split('/').filter(Boolean);

    // ----- public: church lookup, find my church, sign-up -----
    if (parts[0] === 'churches') {
      if (method === 'POST' && parts[1] === 'find') {
        const email = norm(body.email);
        if (!EMAIL_RE.test(email)) throw new ApiError(422, 'invalid', 'Enter a valid email address.', { email: 'Enter a valid email address' });
        const found = entries()
          .filter((e) => e.status === 'active')
          .filter((e) => {
            const eng = host.get(e.id);
            return !!eng && (eng.db.all('staff').some((s) => norm(s.email) === email) || eng.db.all('people').some((p) => norm(p.email) === email));
          });
        if (env.demo) return { sent: true, churches: found.map((e) => ({ slug: e.slug, name: e.name, city: e.city })) };
        if (found.length) {
          const lines = found.map((e) => `${e.name}${e.city ? `, ${e.city}` : ''}\n  Church office: ${env.webUrl}/c/${e.slug}/admin\n  Member app: ${env.webUrl}/c/${e.slug}/app`);
          await env.deliver('email', [{ to: email, name: email, subject: 'Your churches on Flockwise', text: `Here are the churches on Flockwise that use this email address:\n\n${lines.join('\n\n')}\n\nFlockwise` }]).catch(() => undefined);
        }
        return { sent: true };
      }
      if (method === 'GET' && parts[1]) {
        const e = lookup(parts[1]);
        if (!e || e.status !== 'active') throw new ApiError(404, 'church_not_found', 'We could not find that church on Flockwise.');
        const s = host.get(e.id)?.db.get('settings', 'church');
        return { id: e.id, slug: e.slug, name: s?.name ?? e.name, city: s?.city ?? e.city, logoUrl: s?.logoUrl ?? null, isDefault: e.id === host.defaultId };
      }
    }

    if (parts[0] === 'signup') {
      if (method === 'GET' && parts[1] === 'slug') {
        const slug = norm(query.slug);
        const problem = slug ? slugProblem(slug) : 'Enter an address.';
        return { slug, available: !problem, problem, suggestion: problem ? suggestSlug(String(query.name ?? slug), String(query.city ?? '')) : slug };
      }
      if (method === 'POST' && parts[1] === 'start') {
        const email = norm(body.email);
        if (!EMAIL_RE.test(email)) throw new ApiError(422, 'invalid', 'Enter a valid email address.', { email: 'Enter a valid email address' });
        return sendCode(email, 'member', 'Flockwise');
      }
      if (method === 'POST' && parts[1] === 'complete') {
        const name = String(body.churchName ?? '').trim();
        const ownerName = String(body.ownerName ?? '').trim();
        const country = String(body.country ?? 'IN').toUpperCase().slice(0, 2) || 'IN';
        const city = String(body.city ?? '').trim().slice(0, 80);
        const fields: Record<string, string> = {};
        if (name.length < 3) fields.churchName = 'Enter the church name';
        if (!ownerName) fields.ownerName = 'Enter your name';
        const slug = norm(body.slug) || suggestSlug(name, city);
        const problem = slugProblem(slug);
        if (problem) fields.slug = problem;
        if (Object.keys(fields).length) throw new ApiError(422, 'invalid', Object.values(fields)[0], fields);
        const { otp, done } = useCode(body.requestId, body.code, 'member');
        done();
        const id = `ch_${env.random(10, 'abcdefghijkmnpqrstuvwxyz23456789')}`;
        const currency: Currency = country === 'IN' ? 'INR' : ((['USD', 'GBP', 'EUR', 'AED', 'SGD', 'AUD', 'CAD'].includes(String(body.currency)) ? body.currency : 'USD') as Currency);
        const engine = await host.create(id);
        bootstrapChurch(engine.db, engine.env, { id, name: name.slice(0, 120), country, currency, city, ownerEmail: otp.email, ownerName: ownerName.slice(0, 80) });
        const phone = String(body.phone ?? '').trim();
        if (phone) {
          const s = engine.db.get('settings', 'church')!;
          engine.db.put('settings', { ...s, phone: phone.slice(0, 30), email: otp.email });
        }
        startTrial(engine.db, now());
        const e: ChurchEntry = { id, slug, name: name.slice(0, 120), city, country, currency, ownerEmail: otp.email, ownerName, createdAt: now().toISOString(), status: 'active', source: 'signup', notes: '' };
        putEntry(e);
        teamLog('signup', 'signup', id, `${ownerName} (${otp.email}) started ${e.name}${city ? `, ${city}` : ''}`);
        const session = await churchSession(engine, otp.email);
        void env
          .deliver('email', [{ to: otp.email, name: ownerName, subject: `Welcome to Flockwise, ${e.name}`, text: `Hi ${ownerName},\n\n${e.name} is set up on Flockwise, with every feature free for 30 days.\n\nYour church office: ${env.webUrl}/c/${slug}/admin\nYour member app (share with the church): ${env.webUrl}/c/${slug}/app\n\nGood first steps:\n1. Import your people from Excel (People › Import)\n2. Add your Sunday service and events\n3. Invite your office team (Settings › Team)\n\nReply to this email if you need a hand.\n\nFlockwise by Agape Labs` }])
          .catch(() => undefined);
        return { church: { id, slug, name: e.name }, session };
      }
    }

    if (parts[0] === 'networks') return networks.handle(method, parts.slice(1), body, req.token);

    if (parts[0] !== 'platform') throw new ApiError(404, 'not_found', `No endpoint for ${method} ${path}.`);
    const rest = parts.slice(1);

    if (method === 'POST' && rest[0] === 'auth' && rest[1] === 'request') {
      const email = norm(body.email);
      if (!EMAIL_RE.test(email)) throw new ApiError(422, 'invalid', 'Enter a valid email address.', { email: 'Enter a valid email address' });
      if (!env.demo && !adminSet.has(email)) throw new ApiError(403, 'not_team', 'This email is not on the Flockwise team.');
      return sendCode(email, 'admin', 'Flockwise team');
    }
    if (method === 'POST' && rest[0] === 'auth' && rest[1] === 'verify') {
      const { otp, done } = useCode(body.requestId, body.code, 'admin');
      if (!env.demo && !adminSet.has(otp.email)) throw new ApiError(403, 'not_team', 'This email is not on the Flockwise team.');
      done();
      const token = env.random(40, 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789');
      const expiresAt = new Date(now().getTime() + TEAM_SESSION_HOURS * 3600_000).toISOString();
      db.put('meta', { id: `ps:${env.hash(token)}`, value: JSON.stringify({ email: otp.email, expiresAt }) });
      teamLog(otp.email, 'signed_in', null, `${otp.email} signed in to the team panel`);
      return { token, email: otp.email, expiresAt };
    }
    if (method === 'POST' && rest[0] === 'auth' && rest[1] === 'sign-out') {
      if (req.token) db.del('meta', `ps:${env.hash(req.token)}`);
      return undefined;
    }

    const team = teamSession(req.token);
    // Support: open a church office as its owner. Every visit is written to the church's own activity log.
    if (method === 'POST' && rest[0] === 'churches' && rest[2] === 'open') {
      const e = entry(rest[1]);
      const engine = e && host.get(e.id);
      if (!e || !engine) throw new ApiError(404, 'not_found', 'Church not found.');
      const owner = engine.db.all('staff').find((s) => s.role === 'owner') ?? engine.db.all('staff')[0];
      if (!owner) throw new ApiError(409, 'no_owner', 'This church has no office login yet.');
      const session = await churchSession(engine, norm(owner.email));
      engine.db.put('audit', { id: env.newId('au'), at: now().toISOString(), actorId: team.email, actorName: `Flockwise support (${team.email})`, action: 'support_access', entity: 'church', entityId: e.id, summary: `Flockwise support opened the church office${body.reason ? `: ${String(body.reason).slice(0, 200)}` : ''}` });
      teamLog(team.email, 'support_access', e.id, `Opened ${e.name} as ${owner.name}${body.reason ? ` (${String(body.reason).slice(0, 200)})` : ''}`);
      return { church: { id: e.id, slug: e.slug, name: e.name }, session };
    }
    // The shared song database (public-domain songs every church can add).
    if (rest[0] === 'songs') return songTeamRoute(db, env, method, rest, body, query, (action, summary) => teamLog(team.email, action, null, summary));
    return teamRoute(method, rest, body, query, team.email);
  }

  /** Runs every church's scheduled messages and automations, and ends lapsed trials. */
  async function tickAll() {
    for (const e of entries()) {
      if (e.status !== 'active') continue;
      const eng = host.get(e.id);
      if (!eng) continue;
      await eng.tick().catch((err: unknown) => console.error(`Automations failed for ${e.id}`, err));
    }
  }

  return { handle, resolve, lookup, ensureChurch, entries, entry, tickAll, slugProblem, suggestSlug, db, networks, songs: () => storedSongs(db) };
}

export type Platform = ReturnType<typeof createPlatform>;
