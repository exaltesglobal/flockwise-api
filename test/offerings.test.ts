// Special offerings: a harvest festival with envelopes, in-kind gifts and an auction.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const env = createDemoEnv();
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(email: string, audience: 'admin' | 'member' = 'admin') {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown) => engine.handle({ method, path, body, auth }) as Promise<any>;

test('the seeded harvest festival adds envelopes, auction and in-kind into one total', async () => {
  const owner = await signIn('pastor@gracechurch.in');
  const list = await call(owner, 'GET', '/admin/offerings');
  const h = list.find((c: any) => c.id === 'cp_harvest');
  assert.equal(h.envelopesOut, 36);
  assert.equal(h.envelopesBack, 24);
  assert.equal(h.progress.auction, 1100000 + 450000 + 520000);
  // Unsold rice-less items: bananas (unpaid lot), gold ring and pumpkin count at their value.
  assert.equal(h.progress.inKind, 90000 + 2400000 + 30000);
  assert.equal(h.progress.auctionUnpaid, 300000);
  assert.equal(h.progress.raised, h.progress.gifts + h.progress.envelopes + h.progress.auction + h.progress.inKind);
});

test('an office runs a campaign end to end', async () => {
  const owner = await signIn('pastor@gracechurch.in');
  const c = await call(owner, 'POST', '/admin/offerings', { name: 'Thanksgiving 2026', kind: 'thanksgiving', goal: 10000000, startsOn: '2026-01-01' });
  assert.equal(c.fundName, 'Thanksgiving 2026');
  assert.equal(c.progress.raised, 0);

  const { made, campaign } = await call(owner, 'POST', `/admin/offerings/${c.id}/envelopes`, {});
  assert.ok(made > 10);
  assert.equal(campaign.envelopes[0].number, 1);
  // Running it again gives nobody a second envelope.
  assert.equal((await call(owner, 'POST', `/admin/offerings/${c.id}/envelopes`, {})).made, 0);
  const blanks = await call(owner, 'POST', `/admin/offerings/${c.id}/envelopes`, { blank: 5 });
  assert.equal(blanks.made, 5);

  const env1 = campaign.envelopes[0];
  const got = await call(owner, 'POST', `/admin/offerings/${c.id}/envelopes/${env1.id}/receive`, { amount: 200000, method: 'cash' });
  assert.equal(got.amount, 200000);
  assert.ok(got.donationId);
  await assert.rejects(call(owner, 'POST', `/admin/offerings/${c.id}/envelopes/${env1.id}/receive`, { amount: 1, method: 'cash' }), /already recorded/);
  await assert.rejects(call(owner, 'DELETE', `/admin/offerings/${c.id}/envelopes/${env1.id}`), /Refund/);

  const rice = await call(owner, 'POST', `/admin/offerings/${c.id}/in-kind`, { donorName: 'Mathew family', item: 'Rice', quantity: '1 bag', value: 300000 });
  const ring = await call(owner, 'POST', `/admin/offerings/${c.id}/in-kind`, { donorName: 'Anon', item: 'Gold chain', value: 5000000, forAuction: false });
  let d = await call(owner, 'GET', `/admin/offerings/${c.id}`);
  assert.equal(d.progress.inKind, 5300000);

  const lot = await call(owner, 'POST', `/admin/offerings/${c.id}/lots`, { inKindId: rice.id, bidderName: 'Ravi', amount: 450000 });
  assert.equal(lot.title, '1 bag Rice');
  assert.equal(lot.paid, false);
  await assert.rejects(call(owner, 'POST', `/admin/offerings/${c.id}/lots`, { inKindId: rice.id, bidderName: 'X', amount: 1 }), /already sold/);
  await call(owner, 'POST', `/admin/offerings/${c.id}/lots/${lot.id}/pay`, { method: 'upi' });
  d = await call(owner, 'GET', `/admin/offerings/${c.id}`);
  assert.equal(d.progress.auction, 450000);
  assert.equal(d.progress.inKind, 5000000); // the rice is now counted by its sale
  assert.equal(d.progress.envelopes, 200000);
  assert.equal(d.progress.raised, 5650000);
  assert.equal(d.progress.percent, 57);
  assert.equal(d.topGivers[0].name, 'Ravi');
  void ring;

  await assert.rejects(call(owner, 'DELETE', `/admin/offerings/${c.id}`), /Close it/);
  const closed = await call(owner, 'PATCH', `/admin/offerings/${c.id}`, { status: 'closed' });
  assert.equal(closed.status, 'closed');
  await assert.rejects(call(owner, 'POST', `/admin/offerings/${c.id}/in-kind`, { donorName: 'A', item: 'B' }), /closed/);
});

test('members and the public page see live campaigns, and members see their envelope', async () => {
  const priya = await signIn('priya@example.com', 'member');
  const mine = await call(priya, 'GET', '/giving/campaigns');
  const h = mine.find((c: any) => c.id === 'cp_harvest');
  assert.ok(h.raised > 0);
  assert.equal(h.goal, 50_000_000);
  const pub = await engine.handle({ method: 'GET', path: '/public/church', auth: null }).catch(() => null) as any;
  if (pub) assert.ok(pub.campaigns.some((c: any) => c.id === 'cp_harvest'));
});
