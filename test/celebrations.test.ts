// Birthdays and anniversaries: office list, greetings, the member wall and the staff digest.
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

test('celebrations: upcoming list, office greeting, member wishes', async () => {
  const a = await signIn('admin', 'pastor@gracechurch.in');
  const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(5, 10);
  const p = await call(a, 'POST', '/admin/people', { firstName: 'Ruth', lastName: 'Celebrate', birthDate: `1980-${soon}`, anniversary: `2005-${soon}`, status: 'member', email: 'ruth@example.com', consent: { email: true, sms: true, whatsapp: true, directory: true } });

  const list = await call(a, 'GET', '/admin/celebrations', undefined, { days: '7' });
  const bday = list.find((c: any) => c.personId === p.id && c.kind === 'birthday');
  assert.ok(bday, 'birthday listed');
  assert.ok(bday.years === 46 || bday.years === 47);
  assert.equal(bday.greeted, false);
  assert.ok(list.some((c: any) => c.personId === p.id && c.kind === 'anniversary'));

  await call(a, 'POST', '/admin/celebrations/greet', { personId: p.id, kind: 'birthday', channel: 'email', body: 'Happy birthday Ruth!' });
  const after = await call(a, 'GET', '/admin/celebrations', undefined, { days: '7', kind: 'birthday' });
  assert.equal(after.find((c: any) => c.personId === p.id).greeted, true);
  assert.ok(after.every((c: any) => c.kind === 'birthday'));

  const m = await signIn('member', 'priya@example.com');
  const wall = await call(m, 'GET', '/celebrations');
  const mine = wall.upcoming.find((c: any) => c.personId === p.id && c.kind === 'birthday');
  assert.ok(mine && !mine.wishedByMe);
  await call(m, 'POST', `/celebrations/${p.id}/wish`, { kind: 'birthday', message: 'Many happy returns!' });
  await call(m, 'POST', `/celebrations/${p.id}/wish`, { kind: 'birthday', message: 'Edited wish' }); // one wish per person, updated
  const wall2 = await call(m, 'GET', '/celebrations');
  const w = wall2.upcoming.find((c: any) => c.personId === p.id && c.kind === 'birthday');
  assert.equal(w.wishedByMe, true);
  assert.equal(w.wishes, 1);
  await assert.rejects(call(m, 'POST', `/celebrations/${m.sub}/wish`, { kind: 'birthday' }), /yourself/);

  const r = await signIn('member', 'ruth@example.com');
  const ruth = await call(r, 'GET', '/celebrations');
  assert.equal(ruth.myWishes[0].message, 'Edited wish');
  assert.equal(ruth.myWishes[0].fromName, 'Priya Thomas');
});

test('celebrations: automations include the staff digest with defaults', async () => {
  const a = await signIn('admin', 'pastor@gracechurch.in');
  const auto = await call(a, 'GET', '/admin/messages/automations');
  assert.deepEqual(auto.staffDigest, { enabled: true, daysAhead: 7 });
  const next = await call(a, 'PUT', '/admin/messages/automations', { staffDigest: { daysAhead: 14 } });
  assert.equal(next.staffDigest.daysAhead, 14);
});
