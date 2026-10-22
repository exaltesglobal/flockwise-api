// Missions: missionaries, commitments, money in and out, field reports to supporters.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const env = createDemoEnv({ webUrl: 'https://app.example' });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(email: string, audience: 'admin' | 'member' = 'admin') {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown, query?: Record<string, string>) => engine.handle({ method, path, body, auth, query }) as Promise<any>;

test('missionaries, commitments and who is behind', async () => {
  const owner = await signIn('pastor@gracechurch.in');
  const ov = await call(owner, 'GET', '/admin/missions');
  assert.equal(ov.missionaries.length, 3);
  const kujur = ov.missionaries.find((m: any) => m.id === 'ms_kujur');
  assert.ok(kujur.committed > 1_000_000 && kujur.receivedFy > 0 && kujur.sentFy > 0);
  assert.equal(kujur.gap, Math.max(0, kujur.monthlyNeed - kujur.committed));
  assert.ok(ov.behind.some((b: any) => b.missionaryId === 'ms_kujur'), 'a supporter who stopped giving is behind');
  assert.ok(!ov.behind.some((b: any) => b.missionaryId === 'ms_lalrem'));

  const d = await call(owner, 'GET', '/admin/missions/ms_kujur');
  assert.equal(d.months.length, 12);
  assert.equal(d.support[0].status, 'behind');
  assert.ok(d.support.some((s: any) => s.status === 'church'));

  // New missionary gets their own fund; a new commitment this month is not behind yet.
  const m = await call(owner, 'POST', '/admin/missions', { name: 'Grace Bible College', field: 'Dimapur, Nagaland', monthlyNeed: 1_000_000 });
  assert.equal(m.fundName, 'Missions · Grace Bible College');
  const p = db.all('people').find((x) => x.status === 'member' && !db.all('missionSupport').some((s) => s.personId === x.id))!;
  const withS = await call(owner, 'POST', `/admin/missions/${m.id}/support`, { personId: p.id, amount: 200000 });
  assert.equal(withS.support[0].status, 'on_track');
  assert.equal(withS.gap, 800000);
  await assert.rejects(call(owner, 'POST', `/admin/missions/${m.id}/support`, { personId: p.id, amount: 100000 }), /already supports/);

  const paid = await call(owner, 'POST', `/admin/missions/${m.id}/payouts`, { amount: 500000, method: 'upi', reference: 'UTR123' });
  assert.equal(paid.balance, -500000);
  await assert.rejects(call(owner, 'DELETE', `/admin/missions/${m.id}`), /ended instead/);
  const renamed = await call(owner, 'PATCH', `/admin/missions/${m.id}`, { name: 'Grace Bible College, Dimapur' });
  assert.equal(renamed.fundName, 'Missions · Grace Bible College, Dimapur');

  // Finance can read; a pastor without giving access cannot.
  const pastor = await signIn('mercy@gracechurch.in');
  await assert.rejects(call(pastor, 'GET', '/admin/missions'), /role/);
});

test('field reports reach supporters, and members commit from the app', async () => {
  const owner = await signIn('pastor@gracechurch.in');
  const before = env.outbox.length;
  const res = await call(owner, 'POST', '/admin/missions/ms_kujur/reports', { title: 'Tuition centre teacher found', body: 'Sunita from Gumla joins in June.', prayerPoints: 'Her settling in', send: true });
  assert.ok(res.delivery.sent > 0);
  assert.equal(env.outbox.length - before, res.delivery.sent);
  assert.ok(env.outbox.slice(before).some((o) => /Please pray/.test(o.text)));
  assert.equal(res.reports[0].sentCount, res.delivery.sent);

  const priya = await signIn('priya@example.com', 'member');
  const list = await call(priya, 'GET', '/missions');
  const k = list.find((m: any) => m.id === 'ms_kujur');
  assert.ok(k.mine, 'Priya already supports the Kujurs');
  assert.equal(k.reports[0].title, 'Tuition centre teacher found');
  const ash = await call(priya, 'PUT', '/missions/ms_ashadeep/support', { amount: 50000 });
  assert.equal(ash.mine.amount, 50000);
  const again = await call(priya, 'PUT', '/missions/ms_ashadeep/support', { amount: 75000 });
  assert.equal(again.mine.amount, 75000);
  assert.equal(db.all('missionSupport').filter((s) => s.personId === 'p_priya' && s.missionaryId === 'ms_ashadeep').length, 1);
  const stopped = await call(priya, 'DELETE', '/missions/ms_ashadeep/support');
  assert.equal(stopped.mine, null);
});
