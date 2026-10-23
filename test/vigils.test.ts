// Prayer vigils and fasting chains: slots from the times, sign-ups from the app and the office, coverage, reminders.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

let clock = Date.parse('2026-10-23T05:00:00.000Z');
const env = createDemoEnv({ now: () => new Date(clock) });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(audience: 'admin' | 'member', email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown, query: Record<string, string> = {}) => engine.handle({ method, path, body, auth, query }) as Promise<any>;
const fails = async (p: Promise<unknown>, status: number) => { const e: any = await p.then(() => null, (err) => err); assert.ok(e, `expected ${status}`); assert.equal(e.status, status, e.message); };
const pushes = (from: number) => env.outbox.slice(from).filter((o) => o.channel === 'push' && /Prayer chain|Fast/.test(o.subject ?? ''));

test('a 24-hour prayer chain fills from the app and the office, and each person is reminded once', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  // Tomorrow 6 pm to the day after 6 pm IST: 24 one-hour slots, at most two per slot.
  let v = await call(owner, 'POST', '/admin/vigils', { name: 'Prayer chain for the convention', purpose: 'The gospel convention in November', startsAt: '2026-10-24T12:30:00.000Z', endsAt: '2026-10-25T12:30:00.000Z', perSlot: 2 });
  assert.equal(v.slots, 24);
  assert.equal(v.slotMinutes, 60);
  assert.equal(v.covered, 0);
  assert.equal(v.nextGap, '2026-10-24T12:30:00.000Z');
  await fails(call(owner, 'POST', '/admin/vigils', { name: 'Too many', startsAt: '2026-10-24T00:00:00.000Z', endsAt: '2026-11-24T00:00:00.000Z', slotMinutes: 15 }), 422);
  await fails(call(owner, 'POST', '/admin/vigils', { name: 'Backwards', startsAt: '2026-10-24T00:00:00.000Z', endsAt: '2026-10-23T00:00:00.000Z' }), 422);

  const priya = await signIn('member', 'priya@example.com');
  await call(priya, 'POST', '/me/devices', { token: 'ExponentPushToken[priya-phone]', platform: 'android', app: 'member' });
  let my = await call(priya, 'GET', '/me/vigils');
  assert.equal(my.vigils.length, 1);
  my = await call(priya, 'POST', `/me/vigils/${v.id}/slots`, { slotStart: '2026-10-24T12:30:00.000Z' });
  my = await call(priya, 'POST', `/me/vigils/${v.id}/slots`, { slotStart: '2026-10-25T02:30:00.000Z' });
  assert.equal(my.vigils[0].slots.filter((s: any) => s.mine).length, 2);
  await fails(call(priya, 'POST', `/me/vigils/${v.id}/slots`, { slotStart: '2026-10-24T12:45:00.000Z' }), 422);

  // The office fills the first slot (two per slot), and a third is refused.
  const others = db.all('people').filter((p) => p.email !== 'priya@example.com').slice(0, 2);
  v = await call(owner, 'POST', `/admin/vigils/${v.id}/signups`, { personId: others[0].id, slotStart: '2026-10-24T12:30:00.000Z' });
  await fails(call(owner, 'POST', `/admin/vigils/${v.id}/signups`, { personId: others[1].id, slotStart: '2026-10-24T12:30:00.000Z' }), 409);
  assert.equal(v.covered, 2);
  assert.equal(v.people, 2);
  assert.equal(v.nextGap, '2026-10-24T13:30:00.000Z');
  assert.equal(v.slotList[0].people.length, 2);
  assert.equal((await call(priya, 'GET', '/me/vigils')).vigils[0].slots[0].full, true);

  // 6 pm slot: nothing at 5 pm the day before; 20 minutes before, one push; not again.
  clock = Date.parse('2026-10-24T11:30:00.000Z');
  let from = env.outbox.length;
  await engine.tick();
  assert.equal(pushes(from).length, 0);
  clock = Date.parse('2026-10-24T12:10:00.000Z');
  await engine.tick();
  await engine.tick();
  const got = pushes(from).filter((o) => o.to === 'ExponentPushToken[priya-phone]');
  assert.equal(got.length, 1);
  assert.match(got[0].text, /6:00 pm/i);
  assert.match(got[0].text, /convention/);

  // Leaving a slot frees it; a past slot cannot be taken.
  my = await call(priya, 'DELETE', `/me/vigils/${v.id}/slots`, undefined, { slotStart: '2026-10-25T02:30:00.000Z' });
  assert.equal(my.vigils[0].slots.filter((s: any) => s.mine).length, 1);
  clock = Date.parse('2026-10-24T14:00:00.000Z');
  await fails(call(priya, 'POST', `/me/vigils/${v.id}/slots`, { slotStart: '2026-10-24T12:30:00.000Z' }), 409);

  // A 21-day fast: one slot a day; changing the times drops sign-ups that no longer fit.
  let fast = await call(owner, 'POST', '/admin/vigils', { name: 'January fast', kind: 'fasting', startsAt: '2026-12-31T18:30:00.000Z', endsAt: '2027-01-21T18:30:00.000Z' });
  assert.equal(fast.slotMinutes, 1440);
  assert.equal(fast.slots, 21);
  await call(priya, 'POST', `/me/vigils/${fast.id}/slots`, { slotStart: '2027-01-20T18:30:00.000Z' });
  fast = await call(owner, 'PATCH', `/admin/vigils/${fast.id}`, { endsAt: '2027-01-14T18:30:00.000Z' });
  assert.equal(fast.slots, 14);
  assert.equal(fast.people, 0);
  // Closed vigils leave the app for those not in them.
  await call(owner, 'PATCH', `/admin/vigils/${fast.id}`, { status: 'closed' });
  assert.ok(!(await call(priya, 'GET', '/me/vigils')).vigils.some((x: any) => x.id === fast.id));
});
