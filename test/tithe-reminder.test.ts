// Salary-day tithe reminder: a member picks the day, the daily tick nudges them that morning,
// and the nudge stays quiet while a monthly gift is running.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { titheDayIsToday } from '../src/core/modules/tithe.js';
import { seedDemo } from '../src/core/seed.js';

// Church time is IST; 05:00Z is 10:30 am, after the daily jobs' 8 am gate.
let clock = Date.parse('2026-11-01T05:00:00.000Z');
const env = createDemoEnv({ now: () => new Date(clock) });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(audience: 'admin' | 'member', email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown) => engine.handle({ method, path, body, auth }) as Promise<any>;
const fails = async (p: Promise<unknown>, status: number) => { const e: any = await p.then(() => null, (err) => err); assert.ok(e, `expected ${status}`); assert.equal(e.status, status, e.message); };
const reminders = (from: number) => env.outbox.slice(from).filter((o) => /tithe day/i.test(o.subject) || /set aside for your tithe/i.test(o.text));

test('day 31 means the last day of a short month', () => {
  assert.ok(titheDayIsToday(31, '2026-02-28'));
  assert.ok(titheDayIsToday(30, '2026-02-28'));
  assert.ok(!titheDayIsToday(28, '2026-02-27'));
  assert.ok(titheDayIsToday(1, '2026-11-01'));
  assert.ok(!titheDayIsToday(31, '2026-11-30') === false);
});

test('Priya picks the 1st, is nudged that morning, and not while autopay runs', async () => {
  const priya = await signIn('member', 'priya@example.com');
  const owner = await signIn('admin', 'pastor@gracechurch.in');

  const before = await call(priya, 'GET', '/me/preferences');
  assert.equal(before.titheDay, null);
  await fails(call(priya, 'PATCH', '/me/preferences', { titheDay: 32 }), 422);
  const set = await call(priya, 'PATCH', '/me/preferences', { titheDay: 1, titheAmount: 500000 });
  assert.equal(set.titheDay, 1);
  assert.equal(set.titheAmount, 500000);

  // The office sees the kind in the catalog and turns WhatsApp on for it.
  const cat = await call(owner, 'GET', '/admin/notifications');
  assert.ok(cat.rules.some((c: any) => c.kind === 'tithe.reminder'), 'in the catalog');

  // The demo gives Priya a monthly gift already; stop it so the reminder applies.
  const priyaId = db.all('people').find((p) => p.email === 'priya@example.com')!.id;
  for (const r of db.all('recurring').filter((r) => r.donorId === priyaId)) db.put('recurring', { ...r, status: 'cancelled' });

  // 1 Nov, 10:30 am church time: the nudge goes out once.
  let from = env.outbox.length;
  await engine.tick();
  let sent = reminders(from);
  assert.ok(sent.length >= 1, 'Priya is nudged');
  assert.ok(sent.some((o) => /5,000/.test(o.text)), 'with the amount she set aside');
  assert.ok(sent.some((o) => /\/app\/give/.test(o.text)), 'links to the give page');

  // Next day: nothing.
  clock += 86_400_000; from = env.outbox.length;
  await engine.tick();
  assert.equal(reminders(from).length, 0);

  // 1 Dec with a monthly gift running: quiet.
  const rec = db.all('recurring').find((r) => r.donorId === priyaId);
  if (rec) db.put('recurring', { ...rec, status: 'active' });
  else db.put('recurring', { id: 'rec_test', donorId: priyaId, donorName: 'Priya', fundId: db.all('funds')[0].id, fundName: 'General', amount: 100000, currency: 'INR', status: 'active', providerSubscriptionId: null, provider: 'razorpay', frequency: 'monthly', createdAt: new Date(clock).toISOString(), nextChargeAt: null, lastChargeAt: null, failures: 0, pan: null, method: 'upi', cancelledAt: null, pausedAt: null } as any);
  clock = Date.parse('2026-12-01T05:00:00.000Z'); from = env.outbox.length;
  await engine.tick();
  assert.equal(reminders(from).length, 0, 'quiet while autopay runs');

  // Turned off: 1 Jan is quiet too.
  for (const r of db.all('recurring').filter((r) => r.donorId === priyaId)) db.put('recurring', { ...r, status: 'cancelled' });
  const off = await call(priya, 'PATCH', '/me/preferences', { titheDay: null });
  assert.equal(off.titheDay, null);
  clock = Date.parse('2027-01-01T05:00:00.000Z'); from = env.outbox.length;
  await engine.tick();
  assert.equal(reminders(from).length, 0);
});
