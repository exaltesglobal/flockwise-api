// Online registration: a family registers from the public link, the office sees possible duplicates and approves them into People as one household.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const env = createDemoEnv({ now: () => new Date('2026-10-24T05:00:00.000Z') });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(audience: 'admin' | 'member', email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown) => engine.handle({ method, path, body, auth, query: {} }) as Promise<any>;

const family = {
  householdName: 'Mathew family', phone: '98450 11223', email: 'joel.mathew@example.com', address: '12 Church Street', area: 'Indiranagar',
  previousChurch: 'St Thomas, Kottayam', agree: true, consent: { whatsapp: true, email: true, directory: true },
  members: [
    { firstName: 'Joel', lastName: 'Mathew', relation: 'head', gender: 'male', birthDate: '1985-04-02', baptised: true },
    { firstName: 'Anita', lastName: 'Mathew', relation: 'spouse', gender: 'female', phone: '98450 99887' },
    { firstName: 'Riya', lastName: 'Mathew', relation: 'child', gender: 'female', birthDate: '2016-08-11' },
  ],
};

test('public form, validation, duplicates, approve into one household', async () => {
  const form = await call(null, 'GET', '/public/registration');
  assert.equal(form.enabled, true);
  assert.ok(form.privacyNotice.length > 20);

  await assert.rejects(call(null, 'POST', '/public/registration', { ...family, agree: false }), (e: any) => e.status === 422 && !!e.fields?.agree);
  await assert.rejects(call(null, 'POST', '/public/registration', { ...family, phone: '', email: '' }), (e: any) => e.status === 422 && !!e.fields?.phone);
  await assert.rejects(call(null, 'POST', '/public/registration', { ...family, members: [{ firstName: 'Joel', lastName: '' }] }), (e: any) => e.status === 422 && !!e.fields?.['members.0.lastName']);
  // The hidden field bots fill in: accepted quietly, nothing saved.
  await call(null, 'POST', '/public/registration', { ...family, website: 'spam.example' });

  const ok = await call(null, 'POST', '/public/registration', family);
  assert.equal(ok.count, 3);

  const owner = await signIn('admin', 'pastor@gracechurch.in');
  let hub = await call(owner, 'GET', '/admin/registrations');
  assert.equal(hub.pending.length, 1);
  const x = hub.pending[0];
  assert.equal(x.members.length, 3);
  assert.deepEqual(x.matches, []);

  const before = db.all('people').length;
  const done = await call(owner, 'POST', `/admin/registrations/${x.id}/approve`, {});
  assert.equal(done.status, 'approved');
  assert.equal(done.personIds.length, 3);
  const joel = await call(owner, 'GET', `/admin/people/${done.personIds[0]}`);
  assert.equal(joel.householdName, 'Mathew family');
  assert.equal(joel.phone, '98450 11223');
  assert.equal(joel.email, 'joel.mathew@example.com');
  assert.ok(joel.tags.includes('Registered online'));
  assert.equal(joel.status, 'regular');
  const riya = await call(owner, 'GET', `/admin/people/${done.personIds[2]}`);
  assert.equal(riya.phone, null);
  assert.equal(riya.householdName, 'Mathew family');
  const after = db.all('people').length;
  assert.equal(after, before + 3);
  await assert.rejects(call(owner, 'POST', `/admin/registrations/${x.id}/approve`, {}), (e: any) => e.status === 409);

  // The same family again: the office is warned and links instead of duplicating.
  await call(null, 'POST', '/public/registration', { ...family, members: [family.members[0]] });
  hub = await call(owner, 'GET', '/admin/registrations');
  const again = hub.pending[0];
  assert.equal(again.matches[0].personId, done.personIds[0]);
  assert.equal(again.matches[0].why, 'phone');
  const linked = await call(owner, 'POST', `/admin/registrations/${again.id}/approve`, { link: { 0: done.personIds[0] } });
  assert.deepEqual(linked.personIds, [done.personIds[0]]);
  assert.equal(db.all('people').length, after);

  // Closed: the form says so and refuses.
  await call(owner, 'PUT', '/admin/registration-settings', { enabled: false, intro: 'Hello' });
  assert.equal((await call(null, 'GET', '/public/registration')).enabled, false);
  await assert.rejects(call(null, 'POST', '/public/registration', family), (e: any) => e.status === 403);

  // Members cannot see the list.
  const m = await signIn('member', 'priya@example.com');
  await assert.rejects(call(m, 'GET', '/admin/registrations'), (e: any) => e.status === 403 || e.status === 401);
});
