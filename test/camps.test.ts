// Camps and retreats: family sign-up, rooms, buses, payments.
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
const call = (auth: any, method: string, path: string, body?: unknown) => engine.handle({ method, path, body, auth, query: {} }) as Promise<any>;
const fails = async (p: Promise<unknown>, status: number) => { const e: any = await p.then(() => null, (err) => err); assert.ok(e, `expected ${status}`); assert.equal(e.status, status, e.message); };
const pushes = (from: number, re: RegExp) => env.outbox.slice(from).filter((o) => o.channel === 'push' && re.test(`${o.subject} ${o.text}`));

test('a family signs up for camp, rooms and buses fill themselves, and payments are tracked', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  await fails(call(owner, 'POST', '/admin/camps', { name: 'Youth camp', startsOn: '2026-12-28', endsOn: '2026-12-20' }), 422);
  let c = await call(owner, 'POST', '/admin/camps', {
    name: 'Family retreat', startsOn: '2026-12-28', endsOn: '2026-12-30', place: 'Vikarabad', fee: 1500, capacity: 8,
    rooms: [{ name: 'Cottage 1', beds: 4, for: 'family' }, { name: 'Men dorm', beds: 3, for: 'male' }, { name: 'Women dorm', beds: 3, for: 'female' }],
    buses: [{ name: 'Bus A', seats: 5 }],
  });
  assert.equal(c.rooms.length, 3);

  const priya = await signIn('member', 'priya@example.com');
  let my = await call(priya, 'GET', '/me/camps');
  assert.equal(my.camps.length, 1);
  assert.equal(my.camps[0].family.length, 4);
  const ids = my.camps[0].family.map((f: any) => f.personId);
  await fails(call(priya, 'POST', `/me/camps/${c.id}`, { personIds: ids }), 422); // emergency phone needed
  await fails(call(priya, 'POST', `/me/camps/${c.id}`, { personIds: ['p_samuel'], emergencyPhone: '9' }), 422); // not family
  my = await call(priya, 'POST', `/me/camps/${c.id}`, { personIds: ids, emergencyName: 'Mary', emergencyPhone: '+91 90000 22222', needsBus: true, medical: { p_joel: 'Peanut allergy, carries EpiPen' } });
  assert.equal(my.camps[0].family.filter((f: any) => f.signupId).length, 4);

  // The office adds two men; auto-assign puts the family in the cottage and the men in the dorm.
  c = await call(owner, 'POST', `/admin/camps/${c.id}/signups`, { personIds: ['p_samuel'], needsBus: false });
  const other = db.all('people').find((p) => p.gender === 'male' && !p.householdName?.includes('Thomas') && p.id !== 'p_samuel')!;
  c = await call(owner, 'POST', `/admin/camps/${c.id}/signups`, { personIds: [other.id] });
  assert.equal(c.going, 6);
  assert.equal(c.roomless, 6);
  c = await call(owner, 'POST', `/admin/camps/${c.id}/assign`);
  const cottage = c.rooms.find((r: any) => r.name === 'Cottage 1');
  const dorm = c.rooms.find((r: any) => r.name === 'Men dorm');
  assert.equal(c.signups.filter((s: any) => s.roomId === cottage.id).length, 4);
  assert.equal(c.signups.filter((s: any) => s.roomId === dorm.id).length, 2);
  assert.equal(c.roomless, 0);
  // Five seats on the bus: the family of four rides together; Samuel did not need the bus.
  assert.equal(c.signups.filter((s: any) => s.busId).length, 5);
  assert.equal(c.busless, 0);
  assert.equal(c.signups.find((s: any) => s.personId === 'p_joel').medical, 'Peanut allergy, carries EpiPen');

  // A full room refuses a sixth bed; payments roll up.
  const sam = c.signups.find((s: any) => s.personId === 'p_samuel');
  await fails(call(owner, 'PATCH', `/admin/camps/${c.id}/signups/${sam.id}`, { roomId: cottage.id }), 409);
  c = await call(owner, 'PATCH', `/admin/camps/${c.id}/signups/${sam.id}`, { paid: 1500 });
  assert.equal(c.collected, 1500);
  assert.equal(c.due, 1500 * 5);
  assert.equal(c.paidUp, 1);

  // Capacity, member cancel, and paid places need the office.
  my = await call(priya, 'GET', '/me/camps');
  assert.equal(my.camps[0].family.find((f: any) => f.personId === 'p_joel').room, 'Cottage 1');
  my = await call(priya, 'DELETE', `/me/camps/${c.id}/p_anna`);
  assert.equal(my.camps[0].family.find((f: any) => f.personId === 'p_anna').signupId, null);
  await fails(call(owner, 'DELETE', `/admin/camps/${c.id}`), 409);
  c = await call(owner, 'PATCH', `/admin/camps/${c.id}`, { capacity: 5 });
  await fails(call(priya, 'POST', `/me/camps/${c.id}`, { personIds: ['p_anna'], emergencyPhone: '+91 90000 22222' }), 409);
  // Removing the bus frees its seats.
  c = await call(owner, 'PATCH', `/admin/camps/${c.id}`, { buses: [] });
  assert.equal(c.signups.filter((s: any) => s.busId).length, 0);
});
