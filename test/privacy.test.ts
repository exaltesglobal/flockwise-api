// DPDP Act: consent history, data download, and correction and erasure requests.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const env = createDemoEnv();
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(email: string, audience: 'admin' | 'member' = 'admin') {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown) => engine.handle({ method, path, body, auth }) as Promise<any>;

test('consent changes are recorded and members can download their data', async () => {
  const priya = await signIn('priya@example.com', 'member');
  await call(priya, 'PATCH', '/me/preferences', { consent: { sms: false } });
  await call(priya, 'PATCH', '/me/preferences', { consent: { sms: true, whatsapp: false } });
  const mine = await call(priya, 'GET', '/me/privacy');
  assert.deepEqual(mine.log.map((l: any) => `${l.purpose}:${l.granted}`).sort(), ['sms:false', 'sms:true', 'whatsapp:false']);
  assert.equal(mine.log[0].source, 'member');
  assert.ok(mine.notice.includes('Grace'));
  const data = await call(priya, 'GET', '/me/privacy/export');
  assert.equal(data.profile.firstName, 'Priya');
  assert.equal(data.profile.checkinCode, undefined);
  assert.ok(data.giving.length > 0);
  assert.equal(data.consentHistory.length, 3);

  const owner = await signIn('pastor@gracechurch.in');
  const staffLog = await call(owner, 'GET', `/admin/people/${mine.log[0].personId}/consent`);
  assert.equal(staffLog.length, 3);
});

test('a member asks to be erased and an admin carries it out, keeping gift records', async () => {
  const owner = await signIn('pastor@gracechurch.in');
  const priya = await signIn('priya@example.com', 'member');
  await assert.rejects(call(priya, 'POST', '/me/privacy/requests', { kind: 'correction' }), /what you would like/);
  const fix = await call(priya, 'POST', '/me/privacy/requests', { kind: 'correction', details: 'My birthday is wrong' });
  assert.equal(fix.status, 'open');
  assert.ok(fix.dueAt > fix.createdAt);

  let ov = await call(owner, 'GET', '/admin/privacy');
  assert.equal(ov.open, 1);
  assert.ok(ov.optedOut.whatsapp >= 1);
  await assert.rejects(call(owner, 'PATCH', `/admin/privacy/requests/${fix.id}`, { status: 'declined' }), /Say why/);
  await call(owner, 'PATCH', `/admin/privacy/requests/${fix.id}`, { status: 'done', response: 'Fixed, thank you.' });

  const settings = await call(owner, 'PUT', '/admin/privacy/settings', { officerName: 'Ruth George', officerEmail: 'privacy@gracechurch.in' });
  assert.equal(settings.settings.officerName, 'Ruth George');
  assert.equal((await call(priya, 'GET', '/me/privacy')).officer.name, 'Ruth George');

  // Erase a regular member who gave.
  const giver = db.all('donations').find((d) => d.donorId && d.donorId !== 'p_priya' && !db.all('staff').some((s) => s.personId === d.donorId))!;
  const req = await call(owner, 'POST', '/admin/privacy/requests', { personId: giver.donorId, kind: 'erasure' });
  const done = await call(owner, 'POST', `/admin/privacy/requests/${req.id}/erase`);
  assert.equal(done.status, 'done');
  assert.equal(db.get('people', giver.donorId!), undefined);
  const kept = db.get('donations', giver.id)!;
  assert.equal(kept.donorId, null);
  assert.equal(kept.donorName, giver.donorName);
  assert.equal(db.all('checkins').filter((c) => c.personId === giver.donorId).length, 0);

  const accounts = await signIn('accounts@gracechurch.in');
  const r2 = await call(owner, 'POST', '/admin/privacy/requests', { personName: 'Walk-in visitor', kind: 'erasure' });
  await assert.rejects(call(accounts, 'POST', `/admin/privacy/requests/${r2.id}/erase`), /owner or an admin|permission/i);
  ov = await call(owner, 'GET', '/admin/privacy');
  assert.equal(ov.requests.filter((r: any) => r.status === 'open').length, 1);
});
