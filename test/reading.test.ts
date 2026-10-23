// Bible reading plan: the office starts the Gospels in 30 days, Priya joins, gets the morning push
// in her language, ticks days, keeps a streak, and the church-wide bar moves.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { localizeReading, spreadChapters, BOOKS } from '../src/core/bible.js';
import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { streakOf } from '../src/core/modules/reading.js';
import { seedDemo } from '../src/core/seed.js';

let clock = Date.parse('2026-11-02T05:00:00.000Z'); // 10:30 am IST
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
const pushes = (from: number) => env.outbox.slice(from).filter((o) => o.channel === 'push' && /day \d+ of/.test(o.subject ?? ''));

test('book table and helpers', () => {
  assert.equal(BOOKS.length, 66);
  assert.equal(BOOKS.reduce((s, b) => s + b.chapters, 0), 1189);
  for (const b of BOOKS) for (const l of ['hi', 'ta', 'te', 'ml', 'kn'] as const) assert.ok(b[l].length > 0, `${b.en} ${l}`);
  assert.equal(localizeReading('Genesis 1-3; Psalms 1', 'hi'), 'उत्पत्ति 1-3; भजन संहिता 1');
  assert.equal(localizeReading('Psalm 23', 'ta'), 'சங்கீதம் 23');
  assert.equal(localizeReading('Song of Solomon 2', 'te'), 'పరమగీతము 2');
  assert.equal(localizeReading('Genesis 1', 'en'), 'Genesis 1');
  assert.equal(localizeReading('Not a book 1', 'kn'), 'Not a book 1');
  assert.deepEqual(spreadChapters(BOOKS.slice(39, 43), 30).slice(0, 2), ['Matthew 1-2', 'Matthew 3-5']);
  assert.equal(streakOf([1, 2, 3], 3), 3);
  assert.equal(streakOf([1, 2, 3], 4), 3, 'yesterday still counts');
  assert.equal(streakOf([1, 2], 4), 0);
  assert.equal(streakOf([5], null), 0);
});

test('the Gospels in 30 days: start, join, tick, church bar, reminders, archive', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const priya = await signIn('member', 'priya@example.com');

  let hub = await call(owner, 'GET', '/admin/reading');
  assert.deepEqual(hub.plans, []);
  assert.equal(hub.templates.length, 5);
  await fails(call(owner, 'POST', '/admin/reading', { template: 'custom', readings: 'Luke 1' }), 422);
  await fails(call(owner, 'POST', '/admin/reading', { template: 'gospels30', startsOn: '1/11/2026' }), 422);

  const plan = await call(owner, 'POST', '/admin/reading', { template: 'gospels30', startsOn: '2026-11-01', description: 'Advent together' });
  assert.equal(plan.name, 'The Gospels in 30 days');
  assert.equal(plan.totalDays, 30);
  assert.equal(plan.endsOn, '2026-11-30');
  assert.equal(plan.today, 2);
  assert.equal(plan.participants, 0);
  const custom = await call(owner, 'POST', '/admin/reading', { template: 'custom', name: 'Advent Isaiah', startsOn: '2026-12-01', readings: 'Isaiah 7\nIsaiah 9\n\nIsaiah 11\n' });
  assert.deepEqual(custom.readings, ['Isaiah 7', 'Isaiah 9', 'Isaiah 11']);
  assert.equal(custom.today, null, 'not started yet');

  // Priya sees both plans, in her language, and joins the Gospels.
  let my = await call(priya, 'GET', '/me/reading');
  assert.equal(my.plans.length, 2);
  const g = my.plans.find((p: any) => p.id === plan.id);
  assert.equal(g.joined, false);
  assert.equal(g.today, 2);
  assert.equal(g.readings[1].ref, 'Matthew 3-5');
  assert.equal(g.readings[1].on, '2026-11-02');
  const priyaId = db.all('people').find((p) => p.email === 'priya@example.com')!.id;
  db.put('people', { ...db.get('people', priyaId)!, language: 'ta' });
  my = await call(priya, 'GET', '/me/reading');
  assert.equal(my.plans.find((p: any) => p.id === plan.id).readings[1].local, 'மத்தேயு 3-5');
  await fails(call(priya, 'POST', `/me/reading/${plan.id}/done`, { day: 2 }), 409);
  my = await call(priya, 'POST', `/me/reading/${plan.id}/join`);
  const mine = () => my.plans.find((p: any) => p.id === plan.id);
  assert.equal(mine().joined, true);
  assert.equal(my.plans[0].id, plan.id, 'joined plans first');
  assert.equal(mine().church.participants, 1);

  // Tick today and yesterday; not tomorrow.
  my = await call(priya, 'POST', `/me/reading/${plan.id}/done`, { day: 2 });
  assert.equal(mine().todayDone, true);
  assert.equal(mine().streak, 1);
  assert.equal(mine().church.readToday, 1);
  assert.equal(mine().church.percent, 50, 'one of two days so far');
  my = await call(priya, 'POST', `/me/reading/${plan.id}/done`, { day: 1 });
  assert.deepEqual(mine().done, [1, 2]);
  assert.equal(mine().streak, 2);
  assert.equal(mine().church.percent, 100);
  await fails(call(priya, 'POST', `/me/reading/${plan.id}/done`, { day: 3 }), 422);
  await fails(call(priya, 'POST', `/me/reading/${plan.id}/done`, { day: 99 }), 422);
  my = await call(priya, 'POST', `/me/reading/${plan.id}/done`, { day: 2, done: false });
  assert.deepEqual(mine().done, [1]);
  assert.equal(mine().streak, 1, 'yesterday keeps the streak alive');

  hub = await call(owner, 'GET', '/admin/reading');
  const pv = hub.plans.find((p: any) => p.id === plan.id);
  assert.equal(pv.participants, 1);
  assert.equal(pv.readToday, 0);
  assert.equal(pv.percent, 50);
  const readers = await call(owner, 'GET', `/admin/reading/${plan.id}/readers`);
  assert.equal(readers.length, 1);
  assert.equal(readers[0].name, 'Priya Thomas');
  assert.equal(readers[0].doneCount, 1);

  // The morning tick pushes day 3's reading in Tamil, once, to Priya's phone.
  await call(priya, 'POST', '/me/devices', { token: 'ExponentPushToken[priya-phone]', platform: 'android', app: 'member' });
  clock += 86_400_000;
  let from = env.outbox.length;
  await engine.tick();
  let got = pushes(from);
  assert.equal(got.length, 1, 'one push for Priya');
  assert.match(got[0].subject, /day 3 of 30/);
  assert.match(got[0].text, /மத்தேயு 6-8/);
  await engine.tick();
  assert.equal(pushes(from).length, 1, 'not repeated');
  from = env.outbox.length;
  clock += 86_400_000;
  await engine.tick();
  assert.match(pushes(from)[0].subject, /day 4 of 30/);

  // Leave, and the bar drops; archive, and the plan leaves the app.
  my = await call(priya, 'DELETE', `/me/reading/${plan.id}`);
  assert.equal(mine().joined, false);
  assert.equal(mine().church.participants, 0);
  const archived = await call(owner, 'PATCH', `/admin/reading/${plan.id}`, { status: 'archived', name: 'Gospels, autumn 2026' });
  assert.equal(archived.status, 'archived');
  assert.equal(archived.name, 'Gospels, autumn 2026');
  my = await call(priya, 'GET', '/me/reading');
  assert.equal(my.plans.length, 1);
  await fails(call(priya, 'POST', `/me/reading/${plan.id}/join`), 409);
  assert.equal((await call(owner, 'GET', '/admin/reading')).plans.length, 1);
  assert.equal((await call(owner, 'GET', '/admin/reading?status=all')).plans.length, 2);
  await fails(call(priya, 'GET', '/admin/reading'), 403);
});
