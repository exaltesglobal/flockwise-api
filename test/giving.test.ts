// The HTTP server: email sign-in, Razorpay checkouts and webhooks, through the real app.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.RAZORPAY_KEY_ID = 'rzp_test_x';
process.env.RAZORPAY_KEY_SECRET = 'key-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'wh-secret';
process.env.WEB_URL = 'https://app.example';
process.env.API_PUBLIC_URL = 'https://api.example';
process.env.CHURCH_ID = 'ch_1';
process.env.OWNER_EMAIL = 'owner@church.test';

const { createApp } = await import('../src/app.js');
const { buildServer, bootstrap } = await import('../src/server.js');
const { verifyLinkCallback } = await import('../src/razorpay.js');

const calls: { path: string; body: any }[] = [];
globalThis.fetch = (async (url: string, init: RequestInit) => {
  const path = new URL(url).pathname.replace('/v1', '');
  const body = init.body ? JSON.parse(String(init.body)) : null;
  calls.push({ path, body });
  const out: Record<string, unknown> = {
    '/payment_links': { id: 'plink_1', short_url: 'https://rzp.io/i/abc', status: 'created' },
    '/plans': { id: 'plan_1' },
    '/subscriptions': { id: 'sub_1', short_url: 'https://rzp.io/i/sub', status: 'created' },
  };
  return new Response(JSON.stringify(out[path] ?? {}), { status: 200 });
}) as typeof fetch;

const server = buildServer();
bootstrap(server);
const codes = new Map<string, string>();
server.hooks.sendOtpEmail = async (to, code) => void codes.set(to, code);
const app = createApp(server);

const json = (method: string, body?: unknown, token?: string) => ({
  method,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
async function signIn(email: string, audience: 'admin' | 'member') {
  const r = await (await app.request('/v1/auth/otp/request', json('POST', { email, audience }))).json();
  const res = await app.request('/v1/auth/otp/verify', json('POST', { requestId: r.requestId, code: codes.get(email) }));
  assert.equal(res.status, 200);
  return res.json();
}
const hook = (body: object) => {
  const raw = JSON.stringify(body);
  return app.request('/v1/webhooks/razorpay', { method: 'POST', body: raw, headers: { 'x-razorpay-signature': createHmac('sha256', 'wh-secret').update(raw).digest('hex') } });
};

let member: any;
let owner: any;

test('link callback signature matches the example in Razorpay docs', () => {
  assert.ok(verifyLinkCallback({ linkId: 'plink_IH3cNucfVEgV68', referenceId: 'TSsd1989', status: 'paid', paymentId: 'pay_IH3d0ara9bSsjQ', signature: '07ae18789e35093e51d0a491eb9922646f3f82773547e5b0f67ee3f2d3bf7d5b' }, 'EnLs21M47BllR3X8PSFtjtbd'));
});

test('email sign-in: phone numbers refused, wrong code counted, newcomers become visitors', async () => {
  const phone = await app.request('/v1/auth/otp/request', json('POST', { identifier: '+919876543210' }));
  assert.equal(phone.status, 422);
  assert.equal((await phone.json()).error.code, 'email_required');
  const notStaff = await app.request('/v1/auth/otp/request', json('POST', { email: 'random@x.test', audience: 'admin' }));
  assert.equal(notStaff.status, 404);
  const r = await (await app.request('/v1/auth/otp/request', json('POST', { email: 'new@person.test' }))).json();
  assert.equal(r.channel, 'email');
  const bad = await app.request('/v1/auth/otp/verify', json('POST', { requestId: r.requestId, code: '000000' }));
  assert.equal(bad.status, 422);
  member = await signIn('new@person.test', 'member');
  assert.equal(member.member.email, 'new@person.test');
  owner = await signIn('owner@church.test', 'admin');
  assert.equal(owner.staff.role, 'owner');
});

test('requires a token', async () => {
  assert.equal((await app.request('/v1/giving/funds')).status, 401);
  assert.equal((await app.request('/v1/admin/people', json('GET', undefined, member.accessToken))).status, 403);
  assert.equal((await app.request('/v1/admin/people', json('GET', undefined, owner.accessToken))).status, 200);
});

test('refresh rotates the token', async () => {
  const res = await app.request('/v1/auth/refresh', json('POST', { refreshToken: member.refreshToken }));
  assert.equal(res.status, 200);
  const again = await app.request('/v1/auth/refresh', json('POST', { refreshToken: member.refreshToken }));
  assert.equal(again.status, 401);
  member = await res.json();
});

let firstId = '';
test('one-time gift creates a Razorpay payment link and the webhook records it once', async () => {
  const res = await app.request('/v1/giving/intents', json('POST', { fundId: 'fd_tithe', amount: 100000, currency: 'INR', frequency: 'once', donorCitizenship: 'IN', pan: 'ABCDE1234F' }, member.accessToken));
  assert.equal(res.status, 201);
  const intent = await res.json();
  firstId = intent.donationId;
  assert.equal(intent.checkoutUrl, 'https://rzp.io/i/abc');
  const linkCall = calls.find((c) => c.path === '/payment_links')!;
  assert.equal(linkCall.body.amount, 100000);
  assert.equal(linkCall.body.reference_id, intent.donationId);

  const evt = { event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'plink_1', reference_id: intent.donationId, status: 'paid' } }, payment: { entity: { id: 'pay_1', amount: 100000, currency: 'INR', method: 'upi' } } } };
  assert.equal((await hook(evt)).status, 200);
  assert.equal((await hook(evt)).status, 200); // a retry is harmless
  const d = server.db.get('donations', intent.donationId)!;
  assert.equal(d.status, 'succeeded');
  assert.equal(d.method, 'upi');
  assert.ok(d.receiptNumber, 'gets an 80G receipt number');

  const hist = await (await app.request('/v1/giving/donations', json('GET', undefined, member.accessToken))).json();
  assert.equal(hist.data.length, 1);
});

test('rejects webhooks with a bad signature', async () => {
  const res = await app.request('/v1/webhooks/razorpay', { method: 'POST', body: '{}', headers: { 'x-razorpay-signature': 'deadbeef' } });
  assert.equal(res.status, 400);
});

test('monthly gift creates a subscription; each charge becomes one donation', async () => {
  const res = await app.request('/v1/giving/intents', json('POST', { fundId: 'fd_building', amount: 250000, currency: 'INR', frequency: 'monthly', donorCitizenship: 'IN' }, member.accessToken));
  const intent = await res.json();
  assert.equal(intent.checkoutUrl, 'https://rzp.io/i/sub');
  const charge = (pay: string) => ({ event: 'subscription.charged', payload: { subscription: { entity: { id: 'sub_1', status: 'active' } }, payment: { entity: { id: pay, amount: 250000, currency: 'INR', method: 'upi' } } } });
  await hook(charge('pay_m1'));
  await hook(charge('pay_m2'));
  await hook(charge('pay_m2'));
  const rows = server.db.all('donations').filter((d) => d.fundId === 'fd_building');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.status === 'succeeded'));
});

test('foreign donor is refused when the church has no FCRA registration', async () => {
  const res = await app.request('/v1/giving/intents', json('POST', { fundId: 'fd_tithe', amount: 50000, currency: 'INR', frequency: 'once', donorCitizenship: 'OTHER' }, member.accessToken));
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error.code, 'fcra_not_registered');
});

test('validates input', async () => {
  const res = await app.request('/v1/giving/intents', json('POST', { fundId: 'fd_tithe', amount: 5, currency: 'INR', frequency: 'once', donorCitizenship: 'IN', pan: 'bad' }, member.accessToken));
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.ok(body.error.fields.amount && body.error.fields.pan);
});

test('admin list includes totals', async () => {
  const page = await (await app.request('/v1/admin/giving/donations', json('GET', undefined, owner.accessToken))).json();
  assert.equal(page.total, 3);
  assert.equal(page.totalAmount, 100000 + 250000 * 2);
});

test('return page redirects to the web app', async () => {
  const q = new URLSearchParams({ razorpay_payment_link_id: 'plink_1', razorpay_payment_link_reference_id: firstId, razorpay_payment_link_status: 'paid', razorpay_payment_id: 'pay_1', razorpay_signature: 'nope' });
  const res = await app.request(`/v1/giving/return?${q}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://app.example/app/give?payment=cancelled');
});

test('http: API keys, MCP endpoint and sealed Chitthi key', async () => {
  const owner = (await signIn('owner@church.test', 'admin')).accessToken;
  const made = await (await app.request('/v1/admin/api-keys', json('POST', { name: 'Claude', access: 'full' }, owner))).json();
  assert.match(made.secret, /^fw_live_/);
  const me = await app.request('/v1/admin/settings', json('GET', undefined, made.secret));
  assert.equal(me.status, 200);
  const bad = await app.request('/v1/admin/settings', json('GET', undefined, 'fw_live_nope'));
  assert.equal(bad.status, 401);
  const init = await (await app.request('/mcp', json('POST', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, made.secret))).json();
  assert.equal(init.result.serverInfo.name, 'flockwise');
  const note = await app.request(`/mcp/${made.secret}`, json('POST', { jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(note.status, 202);
  const tools = await (await app.request(`/mcp/${made.secret}`, json('POST', { jsonrpc: '2.0', id: 2, method: 'tools/list' }))).json();
  assert.ok(tools.result.tools.length > 10);
  const anon = await app.request('/mcp', json('POST', { jsonrpc: '2.0', id: 1, method: 'initialize' }));
  assert.equal(anon.status, 401);
  // Chitthi: the test fetch answers 200 for anything, so the key is accepted; it must be stored sealed.
  const st = await (await app.request('/v1/admin/integrations/chitthi', json('POST', { apiKey: 'chk_live_realkey1234567890' }, owner))).json();
  assert.equal(st.connected, true);
  const rec = server.db.get('integrations', 'chitthi') as import('../src/core/types.js').ChitthiConfig;
  assert.ok(!rec.apiKeySealed.includes('realkey'));
  assert.equal(server.env.unseal(rec.apiKeySealed), 'chk_live_realkey1234567890');
});
