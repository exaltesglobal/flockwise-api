// Custom roles: the church makes a role, gives it to a person from their record with a zone, and that login sees only its zone.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const env = createDemoEnv();
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience: 'admin' }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return { auth: JSON.parse(atob(s.accessToken.slice(5))), session: s };
}
const call = (auth: any, method: string, path: string, body?: unknown, query?: Record<string, string>) => engine.handle({ method, path, body, auth, query }) as Promise<any>;
const fails = async (p: Promise<unknown>, status: number) => { try { await p; assert.fail('expected an error'); } catch (e: any) { assert.equal(e.status, status, e.message); } };

test('a church makes its own role, gives it to a zone leader, and that leader sees only their zone', async () => {
  const { auth: owner } = await signIn('pastor@gracechurch.in');
  const roles = await call(owner, 'GET', '/admin/roles');
  assert.ok(roles.some((r: any) => r.id === 'role_zone'), 'the demo has a Zone leader role');

  // Make a role.
  await fails(call(owner, 'POST', '/admin/roles', { name: 'Nothing', permissions: [] }), 422);
  const usher = await call(owner, 'POST', '/admin/roles', { name: 'Usher captain', description: 'Runs the door team', permissions: ['people.view', 'checkin', 'volunteers', 'bogus'], scope: 'team' });
  assert.deepEqual(usher.permissions, ['people.view', 'checkin', 'volunteers']);
  assert.equal(usher.scope, 'team');
  await fails(call(owner, 'POST', '/admin/roles', { name: 'usher captain', permissions: ['checkin'] }), 409);

  // A zone with two people in it and one outside.
  const ctx = engine.systemCtx();
  const people = db.all('people').filter((p) => p.status === 'member' && p.email);
  const [leader, a, b, outside] = people;
  const zone = db.put('zones', { id: 'zn_roles', name: 'Roles zone', parentId: null, leaderIds: [leader.id], meetingDay: null, area: null, notes: null, active: true, createdAt: ctx.now.toISOString() });
  for (const p of [leader, a, b]) db.put('people', { ...p, zoneId: zone.id });
  db.put('people', { ...outside, zoneId: null });

  // Give the leader office access from their record.
  const before = await call(owner, 'GET', `/admin/people/${leader.id}/access`);
  assert.equal(before.staffId, null);
  await fails(call(owner, 'PUT', `/admin/people/${leader.id}/access`, { roleId: 'role_zone', scopeIds: [] }), 422);
  const access = await call(owner, 'PUT', `/admin/people/${leader.id}/access`, { roleId: 'role_zone', scopeIds: [zone.id] });
  assert.equal(access.role, 'custom');
  assert.equal(access.roleName, 'Zone leader');
  assert.deepEqual(access.scopeIds, [zone.id]);
  assert.equal(access.status, 'invited');
  const staffRow = (await call(owner, 'GET', '/admin/staff')).find((s: any) => s.personId === leader.id);
  assert.equal(staffRow.roleName, 'Zone leader');
  assert.deepEqual(staffRow.scopeNames, ['Roles zone']);

  // The role cannot be deleted while someone holds it.
  await fails(call(owner, 'DELETE', '/admin/roles/role_zone'), 409);
  await call(owner, 'DELETE', `/admin/roles/${usher.id}`);

  // The leader signs in: the session carries the role's permissions and scope.
  const { auth: lead, session } = await signIn(leader.email!);
  assert.equal(session.staff.roleName, 'Zone leader');
  assert.deepEqual(session.staff.permissions, ['people.view', 'care', 'groups']);
  assert.deepEqual(session.staff.scope, { kind: 'zone', ids: [zone.id] });

  // People list is their zone only; a person outside is refused; giving is not theirs to see.
  const list = await call(lead, 'GET', '/admin/people');
  const ids = list.data.map((p: any) => p.id);
  assert.ok(ids.includes(a.id) && ids.includes(b.id) && ids.includes(leader.id));
  assert.ok(!ids.includes(outside.id));
  await call(lead, 'GET', `/admin/people/${a.id}`);
  await fails(call(lead, 'GET', `/admin/people/${outside.id}`), 403);
  await fails(call(lead, 'GET', '/admin/giving/funds'), 403);
  const zones = await call(lead, 'GET', '/admin/zones');
  assert.deepEqual(zones.map((z: any) => z.id), [zone.id]);
  const cel = await call(lead, 'GET', '/admin/celebrations', undefined, { days: '366' });
  assert.ok(cel.every((c: any) => [leader.id, a.id, b.id].includes(c.personId)));

  // Taking access away removes the login.
  const gone = await call(owner, 'PUT', `/admin/people/${leader.id}/access`, { role: null });
  assert.equal(gone.staffId, null);
  await fails(call(lead, 'GET', '/admin/people'), 403);
});
