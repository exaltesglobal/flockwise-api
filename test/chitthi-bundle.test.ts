// WhatsApp by Chitthi bought with the plan, and the Flockwise team connecting the workspace.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { teamUpdateChitthi } from '../src/core/modules/chitthi-setup.js';
import { CHITTHI_ADDON, getSubscription, PLANS, priceFor, saveSubscription } from '../src/core/plans.js';
import { seedDemo } from '../src/core/seed.js';

const env = createDemoEnv({ now: () => new Date('2026-10-22T05:00:00.000Z') });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function owner() {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email: 'pastor@gracechurch.in', audience: 'admin' }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const fails = async (p: Promise<unknown>, status: number) => { const e: any = await p.then(() => null, (err) => err); assert.ok(e, `expected ${status}`); assert.equal(e.status, status, e.message); };

test('prices: the add-on is billed with Grow and Thrive, ten months a year, and included on Cathedral', () => {
  assert.equal(priceFor('grow', 'INR', 'monthly', true).amount, PLANS.grow.price.INR.monthly + CHITTHI_ADDON.price.INR);
  assert.equal(priceFor('grow', 'INR', 'yearly', true).amount, PLANS.grow.price.INR.yearly + CHITTHI_ADDON.price.INR * 10);
  assert.equal(priceFor('thrive', 'USD', 'monthly', true).amount, PLANS.thrive.price.USD.monthly + CHITTHI_ADDON.price.USD);
  assert.equal(priceFor('cathedral', 'INR', 'monthly', true).amount, PLANS.cathedral.price.INR.monthly);
  assert.equal(priceFor('grow', 'INR', 'monthly').amount, PLANS.grow.price.INR.monthly);
});

test('a Grow church adds WhatsApp by Chitthi: the team sees the request, pastes the key, the church is connected', async () => {
  const auth = await owner();
  const call = (method: string, path: string, body?: unknown) => engine.handle({ method, path, body, auth }) as Promise<any>;
  // Start from a paid Grow plan (the demo church is a founding church).
  saveSubscription(db, { ...getSubscription(db), founding: false, plan: 'grow', status: 'active', interval: 'monthly', providerRef: 'demo_sub_1', chitthi: false, currentPeriodEnd: '2026-11-20T00:00:00.000Z' });
  let b = await call('GET', '/admin/billing');
  assert.equal(b.addons.chitthi.on, false);
  assert.equal(b.addons.chitthi.included, false);
  assert.equal(b.addons.chitthi.price, CHITTHI_ADDON.price.INR);

  await fails(call('POST', '/admin/billing/chitthi', { on: true, phone: '12', businessName: 'Grace' }), 422);
  const out = await call('POST', '/admin/billing/chitthi', { on: true, phone: '+91 98765 00000', businessName: 'Grace Community Church' });
  assert.equal(out.activated, true, 'demo: the add-on starts at once');
  b = out.billing;
  assert.equal(b.subscription.chitthi, true);
  assert.equal(b.addons.chitthi.on, true);
  assert.equal(b.addons.chitthi.setup.status, 'requested');
  assert.equal(b.addons.chitthi.setup.phone, '+91 98765 00000');
  assert.equal(b.addons.chitthi.connected, false);

  // The Flockwise team pastes the workspace key: Chitthi gets connected and the setup is ready.
  const ctx = engine.systemCtx();
  const row = await teamUpdateChitthi(ctx, { apiKey: 'chk_live_demo12345678', teamNote: 'Number verified with Meta' });
  assert.equal(row.status, 'ready');
  assert.equal(row.connected, true);
  const integ = await call('GET', '/admin/integrations');
  assert.equal(integ.chitthi.connected, true);
  b = await call('GET', '/admin/billing');
  assert.equal(b.addons.chitthi.setup.teamNote, 'Number verified with Meta');

  // Turning it off drops the add-on; the connected workspace stays until the office disconnects it.
  const off = await call('POST', '/admin/billing/chitthi', { on: false });
  assert.equal(off.billing.subscription.chitthi, false);
  assert.equal(off.billing.addons.chitthi.on, false);
  assert.equal(off.billing.addons.chitthi.connected, true);
});

test('Seed cannot add it; Cathedral has it included and only asks for setup', async () => {
  const auth = await owner();
  const call = (method: string, path: string, body?: unknown) => engine.handle({ method, path, body, auth }) as Promise<any>;
  saveSubscription(db, { ...getSubscription(db), founding: false, plan: 'seed', status: 'active', interval: 'monthly', providerRef: null, chitthi: false });
  await fails(call('POST', '/admin/billing/chitthi', { on: true, phone: '+91 98765 00000', businessName: 'Grace' }), 409);

  saveSubscription(db, { ...getSubscription(db), plan: 'cathedral', status: 'active', providerRef: 'demo_sub_2' });
  db.del('integrations', 'chitthiSetup');
  const b = (await call('POST', '/admin/billing/chitthi', { on: true, phone: '+91 98765 00000', businessName: 'Grace' })).billing;
  assert.equal(b.addons.chitthi.included, true);
  assert.equal(b.addons.chitthi.on, true);
  assert.equal(b.subscription.chitthi, false, 'nothing extra is billed');
  assert.equal(b.addons.chitthi.setup.status, 'requested');

  // A plan checkout can carry the add-on too.
  const grow = await call('POST', '/admin/billing/checkout', { plan: 'grow', interval: 'yearly', chitthi: true });
  assert.equal(grow.billing.subscription.plan, 'grow');
  assert.equal(grow.billing.subscription.chitthi, true);
});
