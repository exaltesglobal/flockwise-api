// Offline check-in: the desk works from a downloaded pack and the server replays its queue later.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { offlineCheckIn, offlineSearch } from '../src/core/offline-checkin.js';
import { seedDemo } from '../src/core/seed.js';

const env = createDemoEnv();
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience: 'admin' }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown, query?: Record<string, string>) => engine.handle({ method, path, body, auth, query }) as Promise<any>;

test('a desk checks a family in from the pack and the sync records it once', async () => {
  const a = await signIn('pastor@gracechurch.in');
  const pack = await call(a, 'GET', '/admin/checkin/ev_1/offline');
  assert.equal(pack.event.id, 'ev_1');
  assert.ok(pack.people.length > 10);
  const priya = pack.people.find((p: any) => p.name === 'Priya Thomas');
  assert.ok(priya.phone4 && priya.phone4.length === 4);

  const checkedIn = new Set<string>(pack.checkedIn);
  const fams = offlineSearch(pack, 'thomas', checkedIn);
  const thomas = fams.find((f) => f.householdName === 'Thomas family')!;
  assert.ok(thomas.people.some((p) => p.isChild));
  assert.deepEqual(offlineSearch(pack, priya.phone4, checkedIn).map((f) => f.householdName).includes('Thomas family'), true);
  if (priya.code) assert.equal(offlineSearch(pack, `FW1:${priya.code}`, checkedIn)[0].householdName, 'Thomas family');

  const ids = thomas.people.map((p) => p.id);
  const { item, result } = offlineCheckIn(pack, ids, 'staff', checkedIn, new Date());
  assert.ok(result.securityCode);
  assert.ok(result.labels.some((l) => l.kind === 'guardian' && l.securityCode === result.securityCode));
  ids.forEach((id) => checkedIn.add(id));
  assert.ok(offlineSearch(pack, 'thomas', checkedIn).find((f) => f.householdName === 'Thomas family')!.people.every((p) => p.checkedIn));

  const first = await call(a, 'POST', '/admin/checkin/ev_1/sync', { items: [item] });
  assert.equal(first.results[0].ok, true);
  assert.equal(first.results[0].checkins.length, ids.length);
  // The children keep the code printed on their labels.
  assert.ok(first.results[0].checkins.filter((c: any) => c.isChild).every((c: any) => c.securityCode === result.securityCode));

  // A retry after a dropped response changes nothing.
  const again = await call(a, 'POST', '/admin/checkin/ev_1/sync', { items: [item] });
  assert.equal(again.results[0].checkins.length, ids.length);
  const summary = await call(a, 'GET', '/admin/checkin/ev_1');
  assert.equal(summary.checkins.filter((c: any) => ids.includes(c.personId)).length, ids.length);
});

test('people checked in elsewhere come back as skipped, and future times are clamped', async () => {
  const a = await signIn('pastor@gracechurch.in');
  const pack = await call(a, 'GET', '/admin/checkin/ev_1/offline');
  const fam = offlineSearch(pack, 'kumar', new Set()).find((f) => f.people.length > 1) ?? offlineSearch(pack, 'reddy', new Set())[0];
  const ids = fam.people.filter((p) => !p.checkedIn).map((p) => p.id);
  assert.ok(ids.length >= 2);
  // Another desk, still online, checks the first person in.
  await call(a, 'POST', '/admin/checkin/ev_1', { personIds: [ids[0]] });
  const { item } = offlineCheckIn(pack, ids, 'kiosk', new Set(pack.checkedIn), new Date(Date.now() + 5 * 3_600_000));
  const res = (await call(a, 'POST', '/admin/checkin/ev_1/sync', { items: [item] })).results[0];
  assert.equal(res.ok, true);
  assert.deepEqual(res.skipped.map((s: any) => s.personId), [ids[0]]);
  assert.equal(res.checkins.length, ids.length - 1);
  assert.ok(Date.parse(res.checkins[0].at) <= Date.now());
  assert.equal(res.checkins[0].method, 'kiosk');

  const bad = (await call(a, 'POST', '/admin/checkin/ev_1/sync', { items: [{ personIds: ids }] })).results[0];
  assert.equal(bad.ok, false);
});

test('a room that filled up while offline does not block the sync', async () => {
  const a = await signIn('pastor@gracechurch.in');
  const pack = await call(a, 'GET', '/admin/checkin/ev_1/offline');
  const checkedIn = new Set<string>(pack.checkedIn);
  const kid = pack.people.find((p: any) => p.isChild && p.roomId && !checkedIn.has(p.id));
  const room = db.get('rooms', kid.roomId)!;
  const inRoom = (await call(a, 'GET', '/admin/checkin/ev_1')).checkins.filter((c: any) => c.roomId === room.id && !c.checkedOutAt).length;
  db.put('rooms', { ...room, capacity: Math.max(1, inRoom) });
  if (!inRoom) {
    const other = pack.people.find((p: any) => p.isChild && p.roomId === room.id && p.id !== kid.id && !checkedIn.has(p.id));
    await call(a, 'POST', '/admin/checkin/ev_1', { personIds: [other.id] });
  }
  await assert.rejects(call(a, 'POST', '/admin/checkin/ev_1', { personIds: [kid.id] }), /full/);
  const { item } = offlineCheckIn(pack, [kid.id], 'staff', checkedIn, new Date());
  const res = (await call(a, 'POST', '/admin/checkin/ev_1/sync', { items: [item] })).results[0];
  assert.equal(res.ok, true);
  assert.equal(res.checkins[0].roomId, room.id);
});
