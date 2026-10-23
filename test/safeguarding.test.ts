// Safeguarding: kids' workers need checks; status follows expiry; the rota warns, or refuses when told to.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const clock = Date.parse('2026-10-23T05:00:00.000Z');
const env = createDemoEnv({ now: () => new Date(clock), webUrl: 'https://app.example.church' });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience: 'admin' }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown, query: Record<string, string> = {}) => engine.handle({ method, path, body, auth, query }) as Promise<any>;

test('kids team members are in scope, checks clear them, expiry is tracked, and the rota warns or blocks', async () => {
  const owner = await signIn('pastor@gracechurch.in');
  let h = await call(owner, 'GET', '/admin/safeguarding');
  assert.deepEqual(h.settings.teamIds, ['tm_kids'], 'kids team picked by name');
  assert.ok(h.people.length > 0);
  assert.equal(h.counts.cleared, 0);
  const kid = db.get('teams', 'tm_kids')!;
  const person = kid.members[0].personId;
  const row = h.people.find((p: any) => p.personId === person);
  assert.equal(row.status, 'missing');
  assert.ok(row.roles.includes("Kids' Church"));

  // Police check two years ago (36 months valid), training 23 months ago (24 months → expiring), declaration last week.
  await call(owner, 'POST', `/admin/safeguarding/${person}/checks`, { kind: 'police', issuedOn: '2024-11-01', reference: 'TS-PCC-12345' });
  await call(owner, 'POST', `/admin/safeguarding/${person}/checks`, { kind: 'training', issuedOn: '2024-11-20' });
  let v = await call(owner, 'POST', `/admin/safeguarding/${person}/checks`, { kind: 'declaration', issuedOn: '2026-10-15' });
  assert.equal(v.status, 'expiring');
  assert.equal(v.items.find((i: any) => i.kind === 'training').expiresOn, '2026-11-20');
  assert.equal(v.items.find((i: any) => i.kind === 'police').state, 'cleared');
  // Renewed training clears them.
  v = await call(owner, 'POST', `/admin/safeguarding/${person}/checks`, { kind: 'training', issuedOn: '2026-10-20' });
  assert.equal(v.status, 'cleared');
  // A future date and a bad expiry are refused.
  await assert.rejects(call(owner, 'POST', `/admin/safeguarding/${person}/checks`, { kind: 'police', issuedOn: '2027-01-01' }), /future/);
  await assert.rejects(call(owner, 'POST', `/admin/safeguarding/${person}/checks`, { kind: 'police', issuedOn: '2026-01-01', expiresOn: '2025-01-01' }), /after/);

  // Rota: an uncleared member shows a reason but can still be scheduled while blocking is off.
  const other = kid.members.find((m) => m.personId !== person)!;
  const ev = db.all('events').filter((e) => e.startsAt > new Date(clock).toISOString()).sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
  const posId = other.positionIds[0];
  const avail = await call(owner, 'GET', `/admin/volunteers/schedule/${ev.id}/available`, undefined, { teamId: 'tm_kids', positionId: posId });
  const o = avail.find((a: any) => a.personId === other.personId);
  if (o) assert.match(o.reason ?? '', /Not cleared|can't|already|away|serving/i);
  const a = await call(owner, 'POST', '/admin/volunteers/assignments', { eventId: ev.id, teamId: 'tm_kids', positionId: posId, personId: other.personId, force: true });
  assert.ok(a.id);
  h = await call(owner, 'GET', '/admin/safeguarding');
  assert.ok(h.atRisk >= 1, 'scheduled without clearance shows as at risk');

  // Turn blocking on: the same assignment is refused, the cleared person is fine.
  h = await call(owner, 'PATCH', '/admin/safeguarding/settings', { blockRota: true });
  assert.equal(h.settings.blockRota, true);
  const third = kid.members.find((m) => m.personId !== person && m.personId !== other.personId)!;
  await assert.rejects(call(owner, 'POST', '/admin/volunteers/assignments', { eventId: ev.id, teamId: 'tm_kids', positionId: third.positionIds[0], personId: third.personId, force: true }), /not cleared/i);
  const ok = await call(owner, 'POST', '/admin/volunteers/assignments', { eventId: ev.id, teamId: 'tm_kids', positionId: kid.members[0].positionIds[0], personId: person, force: true });
  assert.ok(ok.id);
  // Worship is not a safeguarded team.
  const w = db.get('teams', 'tm_worship')!.members.find((m) => !db.get('safeguarding', m.personId))!;
  const wa = await call(owner, 'POST', '/admin/volunteers/assignments', { eventId: ev.id, teamId: 'tm_worship', positionId: w.positionIds[0], personId: w.personId, force: true });
  assert.ok(wa.id);

  // Removing a check brings the status back.
  const rec = db.get('safeguarding', person)!;
  const train = rec.checks.filter((c) => c.kind === 'training');
  for (const c of train) v = await call(owner, 'DELETE', `/admin/safeguarding/${person}/checks/${c.id}`);
  assert.equal(v.status, 'missing');
});
