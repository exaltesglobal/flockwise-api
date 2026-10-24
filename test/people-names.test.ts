// People with no surname (blank in a form, or saved as null by older code) must not break the people list.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const env = createDemoEnv({ now: () => new Date('2026-10-24T05:00:00.000Z') });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience: 'admin' }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown, query: Record<string, string> = {}) => engine.handle({ method, path, body, auth, query }) as Promise<any>;

test('the people list loads when someone has no surname', async () => {
  const owner = await signIn('pastor@gracechurch.in');
  await assert.rejects(call(owner, 'POST', '/admin/people', { firstName: 'Ravi', lastName: null }), (e: any) => e.status === 422 && e.fields?.lastName === 'Required');
  const added = await call(owner, 'POST', '/admin/people', { firstName: ' Ravi ', lastName: ' Kumar ' });
  assert.equal(added.lastName, 'Kumar');
  await assert.rejects(call(owner, 'PATCH', `/admin/people/${added.id}`, { lastName: '  ' }), (e: any) => e.status === 422);
  // An older record saved with a null surname straight in the database.
  const old = db.all('people')[0];
  db.put('people', { ...old, lastName: null as unknown as string });
  const list = await call(owner, 'GET', '/admin/people');
  assert.ok(list.data.length > 0);
  const found = await call(owner, 'GET', '/admin/people', undefined, { q: 'Ravi' });
  assert.ok(found.data.some((p: any) => p.firstName === 'Ravi'));
});
