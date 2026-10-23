// Export everything: the office downloads the whole church as CSV sheets and one JSON file; secrets stay out.
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

async function signIn(audience: 'admin' | 'member', email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown) => engine.handle({ method, path, body, auth, query: {} }) as Promise<any>;
async function fails(p: Promise<unknown>, status: number) {
  try { await p; } catch (e: any) { assert.equal(e.status, status); return; }
  assert.fail('expected failure');
}

test('the summary counts what will be exported and only settings staff may export', async () => {
  const admin = await signIn('admin', 'pastor@gracechurch.in');
  const s = await call(admin, 'GET', '/admin/export');
  assert.equal(s.people, db.count('people'));
  assert.equal(s.attendance, db.count('checkins'));
  assert.ok(s.gifts > 0);
  assert.ok(s.counts.people && s.counts.gifts && s.counts.groups);
  assert.equal(s.counts.refreshTokens, undefined);
  await fails(call(await signIn('member', 'priya@example.com'), 'POST', '/admin/export'), 403);
});

test('the bundle has readable sheets, every table and a JSON copy, without secrets', async () => {
  const admin = await signIn('admin', 'pastor@gracechurch.in');
  const b = await call(admin, 'POST', '/admin/export');
  assert.equal(b.church, 'Grace Community Church');
  const names = b.files.map((f: any) => f.name);
  assert.ok(names.includes('people.csv') && names.includes('gifts.csv') && names.includes('attendance.csv') && names.includes('flockwise-data.json') && names.includes('tables/groups.csv'));
  assert.ok(!names.some((n: string) => /token|otp|login|apiKey|ballot|integration/i.test(n)));
  const people = b.files.find((f: any) => f.name === 'people.csv');
  const lines = people.csv.split('\r\n');
  assert.equal(lines.length, db.count('people') + 1);
  assert.ok(lines[0].startsWith('ID,First name,Last name,Mobile,Email,Status'));
  const priya = lines.find((l: string) => l.includes('priya@example.com'));
  assert.ok(priya && priya.includes('Thomas'));
  const gifts = b.files.find((f: any) => f.name === 'gifts.csv');
  assert.ok(/,\d+\.\d\d,INR,/.test(gifts.csv)); // rupees with two decimals
  const json = JSON.parse(b.files.find((f: any) => f.name === 'flockwise-data.json').csv);
  assert.equal(json.format, 'flockwise-export-1');
  assert.equal(json.data.refreshTokens, undefined);
  assert.equal(json.data.teamLogins, undefined);
  assert.equal(json.data.ballots, undefined);
  assert.equal(json.data.people.length, db.count('people'));
  assert.ok(json.data.people.every((p: any) => p.checkinCode)); // the record as stored
  assert.ok(b.readme.includes('people.csv'));
  assert.ok(db.all('audit').some((a) => a.action === 'exported'));
});
