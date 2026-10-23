// Sunday transport matcher: a household asks for a lift, a driver in the zone offers seats, the
// office matches by zone, both sides are told, the day-before reminder, and a driver dropping out.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { familyKey } from '../src/core/modules/zones.js';
import { seedDemo } from '../src/core/seed.js';

// Thursday 29 Oct 2026, 10:30 am IST (after the daily jobs' 8 am gate). Next Sunday is 1 Nov.
let clock = Date.parse('2026-10-29T05:00:00.000Z');
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

test('Priya asks for a lift, a neighbour drives, the office matches by zone', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const priya = await signIn('member', 'priya@example.com');

  let mine = await call(priya, 'GET', '/me/rides');
  assert.equal(mine.sunday, '2026-11-01');
  assert.equal(mine.sundays.length, 4);
  assert.equal(mine.request, null);
  await fails(call(priya, 'POST', '/me/rides/request', { sunday: '2026-11-02' }), 422);

  mine = await call(priya, 'POST', '/me/rides/request', { people: 3, weekly: true, note: 'Two kids, one car seat' });
  assert.equal(mine.request.status, 'waiting');
  assert.equal(mine.request.people, 3);
  await fails(call(priya, 'POST', '/me/rides/request', { people: 1 }), 409);

  // A driver from the same zone, put on the board by the office.
  const priyaP = db.all('people').find((p) => p.email === 'priya@example.com')!;
  const zoneId = priyaP.zoneId ?? db.all('zones')[0].id;
  if (!priyaP.zoneId) db.put('people', { ...priyaP, zoneId });
  let driver = db.all('people').find((p) => p.status !== 'inactive' && p.id !== priyaP.id && familyKey(p) !== familyKey(priyaP) && p.zoneId === zoneId);
  if (!driver) { driver = db.all('people').find((p) => p.status !== 'inactive' && familyKey(p) !== familyKey(priyaP))!; db.put('people', { ...driver, zoneId }); }
  const offer = await call(owner, 'POST', '/admin/rides/offers', { personId: driver.id, seats: 4, sunday: '2026-11-01' });
  assert.equal(offer.seatsLeft, 4);
  assert.equal(offer.zoneName, db.get('zones', zoneId)!.name);

  // A household from another zone, too big for the car.
  const other = db.all('people').find((p) => p.status !== 'inactive' && p.zoneId && p.zoneId !== zoneId && familyKey(p) !== familyKey(priyaP) && p.id !== driver!.id)!;
  await call(owner, 'POST', '/admin/rides/requests', { personId: other.id, people: 5 });

  let hub = await call(owner, 'GET', '/admin/rides');
  assert.equal(hub.waiting, 2);
  assert.equal(hub.serviceTime, '09:00');

  const before = env.outbox.length;
  hub = await call(owner, 'POST', '/admin/rides/match', { sunday: '2026-11-01' });
  assert.equal(hub.made, 1, 'only the one that fits in the zone');
  const mineRow = hub.requests.find((q: any) => q.familyKey === familyKey(priyaP));
  assert.equal(mineRow.driver.name, `${driver.firstName} ${driver.lastName}`.trim());
  assert.equal(hub.offers[0].seatsLeft, 1);
  const told = env.outbox.slice(before);
  assert.ok(told.some((o) => /will pick you up/.test(o.text)), 'the household is told');
  assert.ok(told.some((o) => /ride with you/.test(o.text)), 'the driver is told');

  mine = await call(priya, 'GET', '/me/rides');
  assert.equal(mine.request.status, 'matched');
  assert.equal(mine.request.driver.id, offer.id);

  // The week after, the one-off driver no longer applies, so the weekly request waits again.
  const next = await call(owner, 'GET', '/admin/rides?sunday=2026-11-08');
  assert.equal(next.requests.find((q: any) => q.familyKey === familyKey(priyaP)).status, 'waiting');
  assert.equal(next.offers.length, 0);

  // Saturday: both are reminded.
  clock = Date.parse('2026-10-31T05:00:00.000Z');
  const b2 = env.outbox.length;
  await engine.tick();
  const rem = env.outbox.slice(b2);
  assert.ok(rem.some((o) => /picks you up tomorrow/.test(o.text)), 'rider reminded');
  assert.ok(rem.some((o) => /Tomorrow you drive/.test(o.text)), 'driver reminded');

  // The driver drops out: Priya goes back to waiting and is told.
  const b3 = env.outbox.length;
  await call(owner, 'DELETE', `/admin/rides/offers/${offer.id}`);
  assert.ok(env.outbox.slice(b3).some((o) => /no longer give you a lift/.test(o.text)));
  hub = await call(owner, 'GET', '/admin/rides?sunday=2026-11-01');
  assert.equal(hub.waiting, 2);
  assert.equal(hub.offers.length, 0);

  // Priya offers to drive instead, then withdraws her own request.
  mine = await call(priya, 'DELETE', '/me/rides/request');
  assert.equal(mine.request, null);
  mine = await call(priya, 'POST', '/me/rides/offer', { seats: 2 });
  assert.equal(mine.offer.seats, 2);
  mine = await call(priya, 'DELETE', '/me/rides/offer');
  assert.equal(mine.offer, null);
});
