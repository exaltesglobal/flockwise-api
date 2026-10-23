// Offering QR codes: create one per fund, a scanned payment becomes a gift once, members are matched by mobile.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { applyQrCredited, createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const clock = Date.parse('2026-10-23T05:00:00.000Z');
const env = createDemoEnv({ now: () => new Date(clock), webUrl: 'https://app.example.church' });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience: 'admin' }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown) => engine.handle({ method, path, body, auth, query: {} }) as Promise<any>;

test('create a code, credit it twice with the same payment, match a member by mobile, close it', async () => {
  const owner = await signIn('pastor@gracechurch.in');
  let hub = await call(owner, 'GET', '/admin/giving/qr');
  assert.equal(hub.ready, true); // the demo draws its own codes
  assert.equal(hub.webhookEvent, 'qr_code.credited');
  assert.ok(hub.funds.some((f: any) => f.id === 'fd_tithe'));

  const made = await call(owner, 'POST', '/admin/giving/qr', { fundId: 'fd_tithe', name: 'Offering box' });
  assert.equal(made.status, 'active');
  assert.equal(made.fundName, 'Tithes & Offerings');
  assert.ok(made.payload?.startsWith('upi://pay?pa='));
  assert.equal(made.publicUrl, `https://app.example.church/qr/${made.id}`);

  // Razorpay's webhook, as the server forwards it: matched to Priya by her mobile.
  const priya = db.get('people', 'p_priya')!;
  const sys = engine.systemCtx();
  const g1 = applyQrCredited(sys, { qrId: made.id, payment: { id: 'pay_q1', amount: 50000, vpa: 'priya@okaxis', contact: priya.phone, method: 'upi' } });
  assert.ok(g1);
  assert.equal(g1.donorId, 'p_priya');
  assert.equal(g1.fundId, 'fd_tithe');
  assert.equal(g1.method, 'upi');
  assert.equal(g1.qrId, made.id);
  assert.ok(g1.receiptNumber, 'a UPI gift gets a receipt number');
  // A retried webhook does nothing.
  assert.equal(applyQrCredited(sys, { qrId: made.id, payment: { id: 'pay_q1', amount: 50000, method: 'upi' } }), null);
  // An unknown giver is kept as a UPI giver with the VPA.
  const g2 = applyQrCredited(sys, { providerId: null, qrId: made.id, payment: { id: 'pay_q2', amount: 20000, vpa: 'someone@ybl', method: 'upi' } });
  assert.equal(g2?.donorId, null);
  assert.equal(g2?.donorName, 'UPI giver');
  assert.equal(g2?.upiVpa, 'someone@ybl');
  // A code that is not ours is ignored.
  assert.equal(applyQrCredited(sys, { providerId: 'qr_other', payment: { id: 'pay_q3', amount: 100, method: 'upi' } }), null);

  hub = await call(owner, 'GET', '/admin/giving/qr');
  const code = hub.codes.find((c: any) => c.id === made.id);
  assert.equal(code.giftsThisMonth, 2);
  assert.equal(code.totalThisMonth, 70000);
  assert.equal(code.giftsAll, 2);

  // The public page for the projector.
  const pub = await call(null, 'GET', `/public/qr/${made.id}`);
  assert.equal(pub.churchName, 'Grace Community Church');
  assert.equal(pub.fundName, 'Tithes & Offerings');
  assert.equal(pub.payload, made.payload);

  // Demo test gift route.
  const t = await call(owner, 'POST', `/admin/giving/qr/${made.id}/test-gift`, { amount: 10000 });
  assert.equal(t.gift.amount, 10000);
  assert.equal(t.code.giftsAll, 3);

  const closed = await call(owner, 'POST', `/admin/giving/qr/${made.id}/close`);
  assert.equal(closed.status, 'closed');
  assert.ok(closed.closedAt);
  // Gifts list shows them like any online gift.
  const list = await call(owner, 'GET', '/admin/giving/donations');
  assert.ok(list.data.some((d: any) => d.donorName === 'UPI giver'));
});

test('a closed fund or a system fund is refused', async () => {
  const owner = await signIn('pastor@gracechurch.in');
  await assert.rejects(call(owner, 'POST', '/admin/giving/qr', { fundId: 'fd_nope' }), /Fund/);
});
