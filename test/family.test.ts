// Family accounts: a parent manages the household and checks the children in from the phone.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

let clock = new Date();
const env = createDemoEnv({ now: () => clock });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(email: string, audience = 'member') {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown) => engine.handle({ method, path, body, auth }) as Promise<any>;

test('a parent sees the household, edits a child and adds a baby', async () => {
  const m = await signIn('priya@example.com');
  const f = await call(m, 'GET', '/me/family');
  assert.equal(f.householdName, 'Thomas family');
  assert.equal(f.members[0].isMe, true);
  const kid = f.members.find((x: any) => x.isChild);
  assert.ok(kid.editable && kid.roomName);
  const spouse = f.members.find((x: any) => !x.isChild && !x.isMe);
  if (spouse?.hasLogin) await assert.rejects(call(m, 'PATCH', `/me/family/members/${spouse.id}`, { allergies: 'x' }), /own sign-in/);

  const upd = await call(m, 'PATCH', `/me/family/members/${kid.id}`, { allergies: 'Peanuts, dairy', medicalNotes: 'Inhaler in bag' });
  assert.equal(upd.allergies, 'Peanuts, dairy');
  await assert.rejects(call(m, 'PATCH', `/me/family/members/${kid.id}`, { birthDate: '2999-01-01' }), /future/);
  const outsider = db.all('people').find((p) => p.householdName && p.householdName !== 'Thomas family')!;
  await assert.rejects(call(m, 'PATCH', `/me/family/members/${outsider.id}`, { allergies: 'x' }), /not in your family/);

  await assert.rejects(call(m, 'POST', '/me/family/members', { firstName: 'Baby' }), /date of birth/);
  const baby = await call(m, 'POST', '/me/family/members', { firstName: 'Hannah', lastName: '', birthDate: new Date(clock.getTime() - 400 * 86_400_000).toISOString().slice(0, 10) });
  assert.equal(baby.lastName, 'Thomas');
  assert.equal(baby.isChild, true);
  assert.equal((await call(m, 'GET', '/me/family')).members.length, f.members.length + 1);
});

test('a parent checks the family in from the phone and sees the pickup code', async () => {
  const m = await signIn('priya@example.com');
  const ev = db.get('events', 'ev_1')!;
  clock = new Date(Date.parse(ev.startsAt) - 2 * 3_600_000);
  let list = await call(m, 'GET', '/me/family/checkin');
  let item = list.find((e: any) => e.id === 'ev_1');
  assert.equal(item.open, false);
  await assert.rejects(call(m, 'POST', '/me/family/checkin/ev_1', { personIds: [item.members[0].id] }), /opens an hour/);

  clock = new Date(Date.parse(ev.startsAt) - 30 * 60_000);
  list = await call(m, 'GET', '/me/family/checkin');
  item = list.find((e: any) => e.id === 'ev_1');
  assert.equal(item.open, true);
  const kids = item.members.filter((x: any) => x.isChild && x.roomName).map((x: any) => x.id);
  const res = await call(m, 'POST', '/me/family/checkin/ev_1', { personIds: [...kids, 'p_not_mine'] });
  assert.match(res.securityCode, /^[A-Z0-9]{4}$/);
  assert.deepEqual(res.checkedIn.sort(), [...kids].sort());
  assert.ok(res.event.members.filter((x: any) => kids.includes(x.id)).every((x: any) => x.checkedIn && x.securityCode === res.securityCode));
  const c = db.all('checkins').find((x) => x.personId === kids[0] && x.eventId === 'ev_1')!;
  assert.equal(c.method, 'app');

  // Asking again shows the same code instead of making a new one.
  const again = await call(m, 'POST', '/me/family/checkin/ev_1', { personIds: kids });
  assert.equal(again.securityCode, res.securityCode);
  assert.deepEqual(again.checkedIn, []);

  // The desk prints labels from the code.
  const a = await signIn('pastor@gracechurch.in', 'admin');
  const labels = await call(a, 'POST', '/admin/checkin/ev_1/reprint', { securityCode: res.securityCode });
  assert.equal(labels.labels.filter((l: any) => l.kind === 'child').length, kids.length);
});

test('the office can turn phone check-in off', async () => {
  const a = await signIn('pastor@gracechurch.in', 'admin');
  assert.equal((await call(a, 'GET', '/admin/checkin-settings')).phoneCheckin, true);
  await call(a, 'PUT', '/admin/checkin-settings', { phoneCheckin: false });
  const m = await signIn('priya@example.com');
  const item = (await call(m, 'GET', '/me/family/checkin')).find((e: any) => e.id === 'ev_1');
  assert.equal(item.open, false);
  const adult = item.members.find((x: any) => !x.isChild);
  await assert.rejects(call(m, 'POST', '/me/family/checkin/ev_1', { personIds: [adult.id] }), /welcome desk/);
  await call(a, 'PUT', '/admin/checkin-settings', { phoneCheckin: true });
});
