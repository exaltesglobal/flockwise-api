import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

process.env.JWT_SECRET = 'test-secret';
process.env.RAZORPAY_KEY_ID = 'rzp_test_x';
process.env.RAZORPAY_KEY_SECRET = 'key-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'wh-secret';
process.env.WEB_URL = 'https://app.example';
process.env.API_PUBLIC_URL = 'https://api.example';

const { createApp } = await import('../src/app.js');
const { memoryStore } = await import('../src/store/memory.js');
const { signToken } = await import('../src/auth.js');
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

const store = memoryStore('ch_1');
const app = createApp(store);
const token = signToken({ sub: 'p_1', church: 'ch_1', name: 'Priya Thomas', email: 'priya@example.com', phone: '+919876543210' });
const staff = signToken({ sub: 'st_1', church: 'ch_1', name: 'Vinod', staffRole: 'finance' });
const auth = (t = token) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });
const hook = (body: object) => {
  const raw = JSON.stringify(body);
  return app.request('/v1/webhooks/razorpay', { method: 'POST', body: raw, headers: { 'x-razorpay-signature': createHmac('sha256', 'wh-secret').update(raw).digest('hex') } });
};

test('link callback signature matches the example in Razorpay docs', () => {
  assert.ok(verifyLinkCallback({ linkId: 'plink_IH3cNucfVEgV68', referenceId: 'TSsd1989', status: 'paid', paymentId: 'pay_IH3d0ara9bSsjQ', signature: '07ae18789e35093e51d0a491eb9922646f3f82773547e5b0f67ee3f2d3bf7d5b' }, 'EnLs21M47BllR3X8PSFtjtbd'));
});

test('requires a token', async () => {
  const res = await app.request('/v1/giving/funds');
  assert.equal(res.status, 401);
});

test('one-time gift creates a Razorpay payment link and the webhook records it once', async () => {
  const res = await app.request('/v1/giving/intents', { method: 'POST', headers: auth(), body: JSON.stringify({ fundId: 'fd_tithe', amount: 100000, currency: 'INR', frequency: 'once', donorCitizenship: 'IN', pan: 'ABCDE1234F' }) });
  assert.equal(res.status, 201);
  const intent = await res.json();
  assert.equal(intent.checkoutUrl, 'https://rzp.io/i/abc');
  const linkCall = calls.find((c) => c.path === '/payment_links')!;
  assert.equal(linkCall.body.amount, 100000);
  assert.equal(linkCall.body.reference_id, intent.donationId);

  const evt = { event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'plink_1', reference_id: intent.donationId, status: 'paid' } }, payment: { entity: { id: 'pay_1', amount: 100000, currency: 'INR', method: 'upi' } } } };
  assert.equal((await hook(evt)).status, 200);
  assert.equal((await hook(evt)).status, 200); // retry is harmless
  const d = await store.findDonation(intent.donationId);
  assert.equal(d?.status, 'succeeded');
  assert.equal(d?.method, 'upi');

  const hist = await (await app.request('/v1/giving/donations', { headers: auth() })).json();
  assert.equal(hist.data.length, 1);
  assert.equal(hist.data[0].status, 'succeeded');
});

test('rejects webhooks with a bad signature', async () => {
  const res = await app.request('/v1/webhooks/razorpay', { method: 'POST', body: '{}', headers: { 'x-razorpay-signature': 'deadbeef' } });
  assert.equal(res.status, 400);
});

test('monthly gift creates a subscription; each charge becomes one donation', async () => {
  const res = await app.request('/v1/giving/intents', { method: 'POST', headers: auth(), body: JSON.stringify({ fundId: 'fd_building', amount: 250000, currency: 'INR', frequency: 'monthly', donorCitizenship: 'IN' }) });
  const intent = await res.json();
  assert.equal(intent.checkoutUrl, 'https://rzp.io/i/sub');
  const charge = (pay: string) => ({ event: 'subscription.charged', payload: { subscription: { entity: { id: 'sub_1', status: 'active' } }, payment: { entity: { id: pay, amount: 250000, currency: 'INR', method: 'upi' } } } });
  await hook(charge('pay_m1'));
  await hook(charge('pay_m2'));
  await hook(charge('pay_m2'));
  const { rows } = await store.listDonations({ churchId: 'ch_1', fundId: 'fd_building' });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.status === 'succeeded'));
});

test('foreign donor is refused when no FCRA account is configured', async () => {
  const res = await app.request('/v1/giving/intents', { method: 'POST', headers: auth(), body: JSON.stringify({ fundId: 'fd_tithe', amount: 50000, currency: 'INR', frequency: 'once', donorCitizenship: 'OTHER' }) });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error.code, 'fcra_not_registered');
});

test('validates input', async () => {
  const res = await app.request('/v1/giving/intents', { method: 'POST', headers: auth(), body: JSON.stringify({ fundId: 'fd_tithe', amount: 5, currency: 'INR', frequency: 'once', donorCitizenship: 'IN', pan: 'bad' }) });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.ok(body.error.fields.amount && body.error.fields.pan);
});

test('admin list is staff only and includes totals', async () => {
  assert.equal((await app.request('/v1/admin/giving/donations', { headers: auth() })).status, 403);
  const res = await app.request('/v1/admin/giving/donations', { headers: auth(staff) });
  const page = await res.json();
  assert.equal(page.total, 3);
  assert.equal(page.totalAmount, 100000 + 250000 * 2);
});

test('return page redirects to the web app', async () => {
  const q = new URLSearchParams({ razorpay_payment_link_id: 'plink_1', razorpay_payment_link_reference_id: 'x', razorpay_payment_link_status: 'paid', razorpay_payment_id: 'pay_1', razorpay_signature: 'nope' });
  const res = await app.request(`/v1/giving/return?${q}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://app.example/app/give?payment=cancelled');
});
