// The dashboard's getting-started checklist ticks itself from the records of a brand-new church.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bootstrapChurch } from '../src/core/bootstrap.js';
import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';

const clock = Date.parse('2026-10-23T05:00:00.000Z');
const env = createDemoEnv({ now: () => new Date(clock), webUrl: 'https://app.example.church' });
const db = new Db();
bootstrapChurch(db, env, { id: 'ch_new', name: 'New Life Fellowship', country: 'IN', currency: 'INR', city: 'Vizag', ownerName: 'Pastor John', ownerEmail: 'john@newlife.test' });
const engine = createChurchEngine(db, env);

async function signIn(email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience: 'admin' }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown) => engine.handle({ method, path, body, auth, query: {} }) as Promise<any>;

test('a new church starts with almost nothing ticked, and steps tick as records appear', async () => {
  const owner = await signIn('john@newlife.test');
  let g = await call(owner, 'GET', '/admin/getting-started');
  assert.equal(g.total, 8);
  assert.ok(g.done <= 1, `done ${g.done}`);
  assert.equal(g.dismissed, false);
  assert.ok(g.trialDaysLeft === null || g.trialDaysLeft <= 30);
  const by = (id: string) => g.steps.find((s: any) => s.id === id);
  assert.equal(by('people').done, false);
  assert.equal(by('members').done, false);
  assert.equal(by('service').done, false);
  assert.equal(by('people').link, '/admin/import');
  // Import ten people, post an announcement and add a service.
  const rows = Array.from({ length: 10 }, (_, i) => ({ firstName: `Member${i}`, lastName: 'Test', phone: `+91 98765 000${String(i).padStart(2, '0')}` }));
  await call(owner, 'POST', '/admin/people/import', { rows, source: 'csv', dedupeBy: 'phone' });
  await call(owner, 'POST', '/admin/announcements', { title: 'Welcome to the app', body: 'Sign in with your mobile number.' });
  await call(owner, 'POST', '/admin/events', { title: 'Sunday Worship', kind: 'service', startsAt: '2026-10-25T03:30:00.000Z', endsAt: '2026-10-25T05:30:00.000Z', location: 'Main hall' });
  g = await call(owner, 'GET', '/admin/getting-started');
  assert.equal(by('people').done, true);
  assert.equal(by('members').done, true);
  assert.equal(by('service').done, true);
  assert.ok(g.done >= 3);
});

test('the office can hide the checklist and bring it back', async () => {
  const owner = await signIn('john@newlife.test');
  let g = await call(owner, 'POST', '/admin/getting-started/dismiss', {});
  assert.equal(g.dismissed, true);
  g = await call(owner, 'GET', '/admin/getting-started');
  assert.equal(g.dismissed, true);
  g = await call(owner, 'POST', '/admin/getting-started/dismiss', { undo: true });
  assert.equal(g.dismissed, false);
});
