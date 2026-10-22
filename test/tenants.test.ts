// Many churches on one server: self sign-up, isolation, plans, the Flockwise team panel and billing.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.WEB_URL = 'https://app.example';
process.env.API_PUBLIC_URL = 'https://api.example';
process.env.CHURCH_ID = 'ch_main';
process.env.CHURCH_NAME = 'First Church';
process.env.CHURCH_SLUG = 'first';
process.env.OWNER_EMAIL = 'owner@first.test';
process.env.PLATFORM_ADMINS = 'team@flockwise.test';
process.env.BILLING_RAZORPAY_KEY_ID = 'rzp_test_billing';
process.env.BILLING_RAZORPAY_KEY_SECRET = 'billing-secret';
process.env.BILLING_RAZORPAY_WEBHOOK_SECRET = 'billing-wh';

const { createApp } = await import('../src/app.js');
const { buildServer, bootstrap } = await import('../src/server.js');

const calls: { url: string; body: any }[] = [];
globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
  const u = new URL(url);
  const body = init.body ? JSON.parse(String(init.body)) : null;
  calls.push({ url: u.pathname, body });
  if (u.pathname === '/v1/payments') return new Response('{}', { status: String(init.headers && (init.headers as Record<string, string>).Authorization).includes(Buffer.from('rzp_test_good1234:goodsecret123').toString('base64')) ? 200 : 401 });
  const out: Record<string, unknown> = {
    '/v1/plans': { id: 'plan_b1' },
    '/v1/subscriptions': { id: 'sub_b1', short_url: 'https://rzp.io/i/plan', status: 'created' },
    '/v1/payment_links': { id: 'plink_9', short_url: 'https://rzp.io/i/gift', status: 'created' },
  };
  return new Response(JSON.stringify(out[u.pathname] ?? {}), { status: 200 });
}) as typeof fetch;

const server = buildServer();
bootstrap(server);
const codes = new Map<string, string>();
server.hooks.sendOtpEmail = async (to, code) => void codes.set(to, code);
const app = createApp(server);

const req = (method: string, path: string, body?: unknown, opts: { token?: string; church?: string } = {}) =>
  app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}), ...(opts.church ? { 'X-Church': opts.church } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ok = async (res: Response, status = 200) => {
  const text = await res.text();
  assert.equal(res.status, status, text);
  return text ? JSON.parse(text) : undefined;
};

let grace: any;
let team = '';

test('a new church signs up, gets a 30-day trial and is signed straight in', async () => {
  const slug = await ok(await req('GET', '/v1/signup/slug?slug=first&name=First'));
  assert.equal(slug.available, false);
  assert.equal((await ok(await req('GET', '/v1/signup/slug?slug=admin'))).available, false);
  assert.equal((await ok(await req('GET', '/v1/signup/slug?slug=grace-hyd'))).available, true);

  const start = await ok(await req('POST', '/v1/signup/start', { email: 'Pastor@Grace.test' }));
  const bad = await req('POST', '/v1/signup/complete', { requestId: start.requestId, code: '000000', churchName: 'Grace Fellowship', ownerName: 'Pastor Ravi', slug: 'grace-hyd', city: 'Hyderabad' });
  assert.equal(bad.status, 422);
  grace = await ok(await req('POST', '/v1/signup/complete', { requestId: start.requestId, code: codes.get('pastor@grace.test'), churchName: 'Grace Fellowship', ownerName: 'Pastor Ravi', slug: 'grace-hyd', city: 'Hyderabad', phone: '+91 90000 00000' }));
  assert.equal(grace.church.slug, 'grace-hyd');
  assert.equal(grace.session.staff.role, 'owner');
  assert.equal(grace.session.church.name, 'Grace Fellowship');
  assert.equal(server.tenants.size, 2);

  const billing = await ok(await req('GET', '/v1/admin/billing', undefined, { token: grace.session.accessToken }));
  assert.equal(billing.subscription.status, 'trial');
  assert.equal(billing.plan, 'cathedral');
  assert.equal(billing.trialDaysLeft, 30);
  assert.equal(billing.currency, 'INR');
  // The code cannot be used twice.
  assert.equal((await req('POST', '/v1/signup/complete', { requestId: start.requestId, code: codes.get('pastor@grace.test'), churchName: 'Again', ownerName: 'X' })).status, 422);
});

test('each church sees only its own data, by token or by the church address', async () => {
  const added = await ok(await req('POST', '/v1/admin/people', { firstName: 'Anita', lastName: 'Rao', email: 'anita@grace.test' }, { token: grace.session.accessToken }));
  const mainOwner = await (async () => {
    const r = await ok(await req('POST', '/v1/auth/otp/request', { email: 'owner@first.test', audience: 'admin' }));
    return ok(await req('POST', '/v1/auth/otp/verify', { requestId: r.requestId, code: codes.get('owner@first.test') }));
  })();
  const mainPeople = await ok(await req('GET', '/v1/admin/people', undefined, { token: mainOwner.accessToken }));
  assert.ok(!mainPeople.data.some((p: any) => p.id === added.id));
  // A Grace token stays in Grace even if the client names another church.
  const gracePeople = await ok(await req('GET', '/v1/admin/people', undefined, { token: grace.session.accessToken, church: 'first' }));
  assert.ok(gracePeople.data.some((p: any) => p.id === added.id));
  // The Grace owner is not staff at First Church.
  assert.equal((await req('POST', '/v1/auth/otp/request', { email: 'pastor@grace.test', audience: 'admin' }, { church: 'first' })).status, 404);
  // Members sign in to the church named by its address.
  const r = await ok(await req('POST', '/v1/auth/otp/request', { email: 'anita@grace.test' }, { church: 'grace-hyd' }));
  const anita = await ok(await req('POST', '/v1/auth/otp/verify', { requestId: r.requestId, code: codes.get('anita@grace.test') }, { church: 'grace-hyd' }));
  assert.equal(anita.member.id, added.id);
  assert.equal(anita.church.name, 'Grace Fellowship');
  assert.equal((await req('GET', '/v1/auth/otp/request', undefined, { church: 'no-such-church' })).status, 404);
  const pub = await ok(await req('GET', '/v1/churches/grace-hyd'));
  assert.equal(pub.name, 'Grace Fellowship');
  assert.equal(pub.isDefault, false);
});

test('find my church emails the list without saying who is a member', async () => {
  const res = await ok(await req('POST', '/v1/churches/find', { email: 'anita@grace.test' }));
  assert.deepEqual(res, { sent: true });
  const none = await ok(await req('POST', '/v1/churches/find', { email: 'nobody@x.test' }));
  assert.deepEqual(none, { sent: true });
});

test('plans: features and limits follow the plan, the trial ends on Seed', async () => {
  const t = [...server.tenants.values()].find((x) => x.id === grace.church.id)!;
  const { getSubscription, saveSubscription } = await import('../src/core/plans.js');
  // Trial over: Seed.
  saveSubscription(t.db, { ...getSubscription(t.db), trialEndsAt: new Date(Date.now() - 1000).toISOString() });
  const tok = grace.session.accessToken;
  const gated = await req('GET', '/v1/admin/volunteers/teams', undefined, { token: tok });
  assert.equal(gated.status, 402);
  assert.equal((await gated.json()).error.code, 'plan_required');
  assert.equal((await req('GET', '/v1/admin/workflows', undefined, { token: tok })).status, 402);
  assert.equal((await req('GET', '/v1/admin/people', undefined, { token: tok })).status, 200);
  const sms = await req('POST', '/v1/admin/messages', { channel: 'sms', audience: { type: 'everyone', ids: [] }, body: 'Hi', send: true }, { token: tok });
  assert.equal(sms.status, 402);
  // Seed allows 2 office logins: the owner plus one.
  await ok(await req('POST', '/v1/admin/staff', { name: 'Asha', email: 'asha@grace.test', role: 'admin' }, { token: tok }));
  const third = await req('POST', '/v1/admin/staff', { name: 'Ben', email: 'ben@grace.test', role: 'leader' }, { token: tok });
  assert.equal(third.status, 402);
  assert.equal((await third.json()).error.code, 'plan_limit');
  // Seed has room for 100 people (plus 10% grace).
  const rows = Array.from({ length: 120 }, (_, i) => ({ firstName: `P${i}`, lastName: 'Test', phone: `+9198${String(i).padStart(8, '0')}` }));
  assert.equal((await req('POST', '/v1/admin/people/import', { rows }, { token: tok })).status, 402);
  // The founding church has no limits.
  const main = server.tenants.get('ch_main')!;
  assert.equal(getSubscription(main.db).founding, true);
});

test('upgrading starts a Razorpay subscription and the webhook turns the plan on', async () => {
  const tok = grace.session.accessToken;
  const out = await ok(await req('POST', '/v1/admin/billing/checkout', { plan: 'grow', interval: 'yearly' }, { token: tok }));
  assert.equal(out.checkoutUrl, 'https://rzp.io/i/plan');
  const plan = calls.find((c) => c.url === '/v1/plans')!;
  assert.equal(plan.body.period, 'yearly');
  assert.equal(plan.body.item.amount, 1_499_000);
  const sub = calls.find((c) => c.url === '/v1/subscriptions')!;
  assert.equal(sub.body.notes.church_id, grace.church.id);

  const raw = JSON.stringify({ event: 'subscription.charged', payload: { subscription: { entity: { id: 'sub_b1', current_end: Math.floor(Date.now() / 1000) + 365 * 86400, notes: sub.body.notes } } } });
  const bad = await app.request('/v1/webhooks/billing', { method: 'POST', body: raw, headers: { 'x-razorpay-signature': 'nope' } });
  assert.equal(bad.status, 400);
  await ok(await app.request('/v1/webhooks/billing', { method: 'POST', body: raw, headers: { 'x-razorpay-signature': createHmac('sha256', 'billing-wh').update(raw).digest('hex') } }));
  const billing = await ok(await req('GET', '/v1/admin/billing', undefined, { token: tok }));
  assert.equal(billing.plan, 'grow');
  assert.equal(billing.subscription.status, 'active');
  assert.equal((await req('GET', '/v1/admin/volunteers/teams', undefined, { token: tok })).status, 200);
  assert.equal((await req('GET', '/v1/admin/workflows', undefined, { token: tok })).status, 402);
});

test('a church connects its own Razorpay; gifts and webhooks use its keys', async () => {
  const tok = grace.session.accessToken;
  const rejected = await req('POST', '/v1/admin/settings/payments/razorpay', { keyId: 'rzp_test_wrong1234', keySecret: 'badsecret123', webhookSecret: 'whsecret' }, { token: tok });
  assert.equal(rejected.status, 422);
  const status = await ok(await req('POST', '/v1/admin/settings/payments/razorpay', { keyId: 'rzp_test_good1234', keySecret: 'goodsecret123', webhookSecret: 'grace-wh' }, { token: tok }));
  assert.equal(status.connected, true);
  assert.equal(status.mode, 'test');
  assert.equal(status.webhookPath, `/v1/webhooks/razorpay/${grace.church.id}`);
  const r = await ok(await req('POST', '/v1/auth/otp/request', { email: 'anita@grace.test' }, { church: 'grace-hyd' }));
  const anita = await ok(await req('POST', '/v1/auth/otp/verify', { requestId: r.requestId, code: codes.get('anita@grace.test') }, { church: 'grace-hyd' }));
  const intent = await ok(await req('POST', '/v1/giving/intents', { fundId: 'fd_tithe', amount: 50000, currency: 'INR', frequency: 'once', donorCitizenship: 'IN' }, { token: anita.accessToken }), 201);
  assert.equal(intent.checkoutUrl, 'https://rzp.io/i/gift');
  const link = calls.filter((c) => c.url === '/v1/payment_links').pop()!;
  assert.equal(link.body.notes.church_id, grace.church.id);
  assert.match(link.body.callback_url, /church=/);
  const raw = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'plink_9', reference_id: intent.donationId, status: 'paid' } }, payment: { entity: { id: 'pay_g1', amount: 50000, currency: 'INR', method: 'upi' } } } });
  const sig = (s: string) => createHmac('sha256', s).update(raw).digest('hex');
  assert.equal((await app.request(`/v1/webhooks/razorpay/${grace.church.id}`, { method: 'POST', body: raw, headers: { 'x-razorpay-signature': sig('wrong') } })).status, 400);
  await ok(await app.request(`/v1/webhooks/razorpay/${grace.church.id}`, { method: 'POST', body: raw, headers: { 'x-razorpay-signature': sig('grace-wh') } }));
  const t = server.tenants.get(grace.church.id)!;
  assert.equal(t.db.get('donations', intent.donationId)!.status, 'succeeded');
  // The secrets are stored sealed.
  const rec = t.db.get('integrations', 'razorpay') as any;
  assert.ok(!JSON.stringify(rec).includes('goodsecret123'));
});

test('the Flockwise team panel: sign-in, overview, plan changes, pausing and support access', async () => {
  assert.equal((await req('POST', '/v1/platform/auth/request', { email: 'pastor@grace.test' })).status, 403);
  const r = await ok(await req('POST', '/v1/platform/auth/request', { email: 'team@flockwise.test' }));
  const s = await ok(await req('POST', '/v1/platform/auth/verify', { requestId: r.requestId, code: codes.get('team@flockwise.test') }));
  team = s.token;
  assert.equal((await req('GET', '/v1/platform/overview')).status, 401);
  const ov = await ok(await req('GET', '/v1/platform/overview', undefined, { token: team }));
  assert.equal(ov.churches, 2);
  assert.equal(ov.paying, 1);
  assert.equal(ov.mrr.INR, Math.round(1_499_000 / 12));
  const list = await ok(await req('GET', '/v1/platform/churches?q=grace', undefined, { token: team }));
  assert.equal(list.length, 1);
  assert.equal(list[0].plan, 'grow');
  assert.ok(list[0].people >= 1);

  const changed = await ok(await req('POST', `/v1/platform/churches/${grace.church.id}/subscription`, { plan: 'thrive', trialDays: 14 }, { token: team }));
  assert.equal(changed.subscription.status, 'trial');
  assert.equal(changed.plan, 'thrive');
  assert.equal((await req('GET', '/v1/admin/workflows', undefined, { token: grace.session.accessToken })).status, 200);

  const opened = await ok(await req('POST', `/v1/platform/churches/${grace.church.id}/open`, { reason: 'Help with import' }, { token: team }));
  assert.equal(opened.session.staff.role, 'owner');
  const t = server.tenants.get(grace.church.id)!;
  assert.ok(t.db.all('audit').some((a) => a.action === 'support_access' && a.summary.includes('Help with import')));

  await ok(await req('PATCH', `/v1/platform/churches/${grace.church.id}`, { status: 'suspended', notes: 'Payment dispute' }, { token: team }));
  const paused = await req('GET', '/v1/admin/people', undefined, { token: grace.session.accessToken });
  assert.equal(paused.status, 403);
  assert.equal((await paused.json()).error.code, 'church_suspended');
  await ok(await req('PATCH', `/v1/platform/churches/${grace.church.id}`, { status: 'active' }, { token: team }));
  assert.equal((await req('GET', '/v1/admin/people', undefined, { token: grace.session.accessToken })).status, 200);

  const detail = await ok(await req('GET', `/v1/platform/churches/${grace.church.id}`, undefined, { token: team }));
  assert.equal(detail.notes, 'Payment dispute');
  assert.ok(detail.team.some((m: any) => m.email === 'pastor@grace.test'));
  assert.ok(detail.teamLog.length >= 3);
});

test('API keys name their church and reach only it', async () => {
  const t = server.tenants.get(grace.church.id)!;
  const { saveSubscription, getSubscription } = await import('../src/core/plans.js');
  saveSubscription(t.db, { ...getSubscription(t.db), plan: 'cathedral', status: 'active' });
  const key = await ok(await req('POST', '/v1/admin/api-keys', { name: 'Zapier', access: 'read' }, { token: grace.session.accessToken }));
  assert.match(key.secret, new RegExp(`^fw_live_${grace.church.id}\\.`));
  const people = await ok(await req('GET', '/v1/admin/people', undefined, { token: key.secret }));
  assert.ok(people.data.some((p: any) => p.email === 'anita@grace.test'));
  const mcp = await ok(await app.request(`/mcp/${key.secret}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) }));
  assert.match(mcp.result.instructions, /Grace Fellowship/);
});
