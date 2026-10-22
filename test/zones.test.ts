// Zones / prayer cells and pastoral home visits.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const env = createDemoEnv();
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(audience: 'admin' | 'member', email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown, query?: Record<string, string>) => engine.handle({ method, path, body, auth, query }) as Promise<any>;

test('zones: households move together, units roll up, delete keeps people', async () => {
  const a = await signIn('admin', 'pastor@gracechurch.in');
  const zones = await call(a, 'GET', '/admin/zones');
  assert.ok(zones.length >= 4 && zones.every((z: any) => z.families > 0));

  const area = await call(a, 'POST', '/admin/zones', { name: 'Old City', meetingDay: 'Saturday 6 pm' });
  const unit = await call(a, 'POST', '/admin/zones', { name: 'Charminar unit', parentId: area.id });
  await assert.rejects(call(a, 'PATCH', `/admin/zones/${area.id}`, { parentId: unit.id }), /inside itself/);

  const dad = await call(a, 'POST', '/admin/people', { firstName: 'Ravi', lastName: 'Zone', householdName: 'Zone family', address: 'Charminar' });
  const kid = await call(a, 'POST', '/admin/people', { firstName: 'Kiran', lastName: 'Zone', householdName: 'Zone family', birthDate: '2015-01-01' });
  const added = await call(a, 'POST', `/admin/zones/${unit.id}/members`, { personIds: [dad.id] });
  assert.deepEqual(added, { families: 1, people: 2 });
  assert.equal(db.get('people', kid.id)!.zoneId, unit.id);
  await call(a, 'PATCH', `/admin/zones/${unit.id}`, { leaderIds: [dad.id] });

  const detail = await call(a, 'GET', `/admin/zones/${area.id}`);
  assert.equal(detail.zone.families, 1, 'unit families count in the area');
  assert.equal(detail.units[0].leaders[0].name, 'Ravi Zone');
  assert.equal(detail.families[0].people.length, 2);

  const inZone = await call(a, 'GET', '/admin/people', undefined, { zoneId: unit.id });
  assert.equal(inZone.total, 2);

  await call(a, 'DELETE', `/admin/zones/${unit.id}`);
  assert.equal(db.get('people', dad.id)!.zoneId, area.id, 'people move up to the area');
  await call(a, 'DELETE', `/admin/zones/${area.id}/families/${encodeURIComponent('h:Zone family')}`);
  assert.equal(db.get('people', dad.id)!.zoneId, null);
});

test('visits: plan, log, due list, confidentiality and report', async () => {
  const a = await signIn('admin', 'pastor@gracechurch.in');
  const year = new Date().getUTCFullYear();
  const due = await call(a, 'GET', '/admin/visits/due');
  assert.ok(due.families.length > 0);
  const fam = due.families[0];
  const person = fam.people[0];

  const planned = await call(a, 'POST', '/admin/visits', { personId: person.id, date: `${year}-12-20`, purpose: 'home' });
  assert.equal(planned.status, 'planned');
  assert.equal(planned.familyKey, fam.key);
  assert.ok(planned.visitors.includes('Pastor Samuel Raj'));
  const list = await call(a, 'GET', '/admin/visits', undefined, { status: 'planned' });
  assert.ok(list.some((v: any) => v.id === planned.id));

  const logged = await call(a, 'PATCH', `/admin/visits/${planned.id}`, { status: 'done', date: `${year}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}-01`, notes: 'Mother unwell, pray for healing.', confidential: true });
  assert.equal(logged.status, 'done');
  const due2 = await call(a, 'GET', '/admin/visits/due');
  assert.ok(!due2.families.some((f: any) => f.key === fam.key), 'visited family drops off the due list');
  await assert.rejects(call(a, 'DELETE', `/admin/visits/${planned.id}`), /stays on record/);

  // A group leader sees the visit but not its confidential notes.
  const leaderEmail = 'leader-zone@example.com';
  await call(a, 'POST', '/admin/staff', { name: 'Cell Leader', email: leaderEmail, role: 'leader' });
  const l = await signIn('admin', leaderEmail);
  const seen = (await call(l, 'GET', '/admin/visits', undefined, { familyKey: fam.key })).find((v: any) => v.id === planned.id);
  assert.equal(seen.notes, null);
  await assert.rejects(call(l, 'PATCH', `/admin/visits/${planned.id}`, { notes: 'x' }), /confidential/);

  const rep = await call(a, 'GET', '/admin/zones/report');
  assert.ok(rep.rows.length >= 4);
  assert.ok(rep.rows.every((r: any) => r.percent >= 0 && r.percent <= 100 && r.visited <= r.families));
});
