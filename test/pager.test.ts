// Parent pager: the kids' team messages a checked-in child's parents.
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
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown, query?: Record<string, string>) => engine.handle({ method, path, body, auth, query }) as Promise<any>;

test('paging a child’s parents sends them a message with the room and code', async () => {
  const a = await signIn('pastor@gracechurch.in');
  const fams = await call(a, 'GET', '/admin/checkin/ev_1/search', undefined, { q: 'Thomas' });
  const thomas = fams.find((f: any) => f.householdName === 'Thomas family');
  const res = await call(a, 'POST', '/admin/checkin/ev_1', { personIds: thomas.people.map((p: any) => p.id) });
  const kid = res.checkins.find((c: any) => c.isChild);
  const parents = await call(a, 'GET', `/admin/checkin/checkins/${kid.id}/parents`);
  assert.ok(parents.some((p: any) => p.name === 'Priya Thomas'));

  const before = env.outbox.length;
  const page = await call(a, 'POST', `/admin/checkin/checkins/${kid.id}/page`, { reason: 'pickup' });
  assert.equal(page.sentTo.length, parents.length);
  assert.ok(page.sentTo.every((s: any) => s.ok));
  assert.match(page.text, new RegExp(`code ${res.securityCode}`));
  assert.match(page.text, /pick them up/);
  assert.equal(env.outbox.length - before, parents.length);

  await assert.rejects(call(a, 'POST', `/admin/checkin/checkins/${kid.id}/page`, { reason: 'custom' }), /Type the message/);
  const adult = res.checkins.find((c: any) => !c.isChild);
  await assert.rejects(call(a, 'POST', `/admin/checkin/checkins/${adult.id}/page`, {}), /Only children/);

  let list = await call(a, 'GET', '/admin/checkin/ev_1/pages');
  assert.equal(list.length, 1);
  await call(a, 'POST', `/admin/checkin/pages/${page.id}/resolve`);
  list = await call(a, 'GET', '/admin/checkin/ev_1/pages');
  assert.ok(list[0].resolvedAt);
});
