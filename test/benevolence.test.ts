// Benevolence fund: a member asks quietly, pastors are told, the request is approved for an
// amount, paid as a voucher against the benevolence head, and the member is kept informed.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const clock = Date.parse('2026-11-03T05:00:00.000Z');
const env = createDemoEnv({ now: () => new Date(clock) });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(audience: 'admin' | 'member', email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown) => { const [p, qs] = path.split('?'); return engine.handle({ method, path: p, body, auth, query: qs ? Object.fromEntries(new URLSearchParams(qs)) : {} }) as Promise<any>; };
const fails = async (p: Promise<unknown>, status: number) => { const e: any = await p.then(() => null, (err) => err); assert.ok(e, `expected ${status}`); assert.equal(e.status, status, e.message); };

test('Priya asks for help with a hospital bill; the pastors approve, pay and record it', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const priya = await signIn('member', 'priya@example.com');

  let my = await call(priya, 'GET', '/me/aid');
  assert.deepEqual(my.requests, []);
  assert.ok(my.kinds.includes('medical'));
  await fails(call(priya, 'POST', '/me/aid', { kind: 'medical', amount: 2500000 }), 422);

  const before = env.outbox.length;
  my = await call(priya, 'POST', '/me/aid', { kind: 'medical', amount: 2500000, reason: 'Hospital bill after my father\'s surgery' });
  assert.equal(my.requests[0].status, 'requested');
  assert.ok(env.outbox.slice(before).some((o) => /request for help/i.test(o.subject) && /25,000/.test(o.text)), 'pastors are told');
  assert.ok(!env.outbox.slice(before).some((o) => /Priya/.test(o.text)), 'without the name');
  await fails(call(priya, 'POST', '/me/aid', { kind: 'rent', amount: 100, reason: 'again' }), 409);

  let hub = await call(owner, 'GET', '/admin/benevolence');
  assert.equal(hub.summary.open, 1);
  assert.equal(hub.requests.length, 1);
  const id = hub.requests[0].id;
  assert.equal(hub.requests[0].personName, 'Priya Thomas');

  // Point the fund at a giving fund so the balance means something.
  const fund = db.all('funds')[0];
  const summary = await call(owner, 'PUT', '/admin/benevolence/settings', { fundId: fund.id });
  assert.equal(summary.fundId, fund.id);
  assert.ok(summary.received > 0);

  await call(owner, 'PATCH', `/admin/benevolence/${id}`, { status: 'reviewing' });
  await call(owner, 'POST', `/admin/benevolence/${id}/notes`, { text: 'Spoke to the family; hospital confirmed the bill.' });
  await fails(call(owner, 'POST', `/admin/benevolence/${id}/pay`, { via: 'upi' }), 409);

  const b2 = env.outbox.length;
  const approved = await call(owner, 'PATCH', `/admin/benevolence/${id}`, { status: 'approved', approved: 1500000, note: 'Half now; the rest once the final bill comes.' });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approved, 1500000);
  assert.equal(approved.notes.length, 1);
  assert.ok(env.outbox.slice(b2).some((o) => /we can help/i.test(o.subject) && /15,000/.test(o.text)), 'Priya is told');
  await fails(call(owner, 'PATCH', `/admin/benevolence/${id}`, { status: 'declined' }), 409);

  const paid = await call(owner, 'POST', `/admin/benevolence/${id}/pay`, { via: 'upi', reference: 'UPI/9988' });
  assert.equal(paid.status, 'paid');
  assert.equal(paid.paidVia, 'upi');
  const expense = db.get('expenses', paid.expenseId)!;
  assert.equal(expense.status, 'paid');
  assert.equal(expense.amount, 1500000);
  assert.match(expense.voucherNumber!, /^PV\//);
  assert.equal(db.get('accountHeads', expense.headId)!.name, 'Benevolence and welfare');

  hub = await call(owner, 'GET', '/admin/benevolence?status=paid');
  assert.equal(hub.summary.paid, 1500000);
  assert.equal(hub.summary.balance, hub.summary.received - 1500000);
  assert.equal(hub.summary.open, 0);

  my = await call(priya, 'GET', '/me/aid');
  assert.equal(my.requests[0].status, 'paid');
  assert.equal(my.requests[0].approved, 1500000);
  assert.ok(!('notes' in my.requests[0]), 'office notes stay in the office');

  // A second request can be made, and withdrawn while it is still open.
  my = await call(priya, 'POST', '/me/aid', { kind: 'education', amount: 800000, reason: 'School fees for two children' });
  const second = my.requests.find((a: any) => a.status === 'requested');
  my = await call(priya, 'DELETE', `/me/aid/${second.id}`);
  assert.equal(my.requests.find((a: any) => a.id === second.id).status, 'withdrawn');

  // Declined path, from the office on someone's behalf.
  const other = db.all('people').find((p) => p.status !== 'inactive' && p.email !== 'priya@example.com')!;
  const req = await call(owner, 'POST', '/admin/benevolence', { personId: other.id, kind: 'rent', amount: 1200000, reason: 'Three months behind' });
  const declined = await call(owner, 'PATCH', `/admin/benevolence/${req.id}`, { status: 'declined', note: 'Referred to the district welfare scheme' });
  assert.equal(declined.status, 'declined');
  hub = await call(owner, 'GET', '/admin/benevolence?status=closed');
  assert.ok(hub.requests.some((a: any) => a.id === req.id));

  // Her export mentions the help, without the office notes.
  const exp = await call(priya, 'GET', '/me/privacy/export');
  assert.equal(exp.helpRequests.length, 2);
});
