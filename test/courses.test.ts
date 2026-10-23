// Classes and courses: start from a template, add people, mark attendance, complete with a tag, and let members sign up.
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
const fails = async (p: Promise<unknown>, status: number) => { const e: any = await p.then(() => null, (err) => err); assert.ok(e, `expected ${status}`); assert.equal(e.status, status, e.message); };

test('a baptism class runs from template to completion, and members sign up from the app', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const hub = await call(owner, 'GET', '/admin/courses');
  assert.equal(hub.courses.length, 0);
  assert.deepEqual(hub.templates.map((t: any) => t.id), ['baptism', 'membership', 'premarital', 'alpha']);

  let c = await call(owner, 'POST', '/admin/courses', { template: 'baptism', capacity: 3 });
  assert.equal(c.name, 'Baptism class');
  assert.equal(c.sessions.length, 4);
  assert.equal(c.minAttendance, 3);
  assert.equal(c.completeTag, 'Baptism class done');

  // Dates on the sessions give a "next session".
  c = await call(owner, 'PATCH', `/admin/courses/${c.id}`, { sessions: c.sessions.map((s: any, i: number) => ({ ...s, date: `2026-11-0${i + 1}T10:00` })) });
  assert.equal(c.nextSession.title, 'The good news');
  const ids = c.sessions.map((s: any) => s.id);

  const people = db.all('people').filter((p) => p.email !== 'priya@example.com').slice(0, 2).map((p) => p.id);
  c = await call(owner, 'POST', `/admin/courses/${c.id}/enroll`, { personIds: people });
  assert.equal(c.enrolled, 2);
  // Adding the same person twice is harmless.
  c = await call(owner, 'POST', `/admin/courses/${c.id}/enroll`, { personIds: [people[0]] });
  assert.equal(c.enrolled, 2);

  // Three sessions for the first person completes them and tags them; the second came once.
  for (const sid of ids.slice(0, 3)) c = await call(owner, 'POST', `/admin/courses/${c.id}/attendance`, { sessionId: sid, present: sid === ids[0] ? people : [people[0]] });
  const row = (pid: string) => c.roster.find((r: any) => r.personId === pid);
  assert.equal(row(people[0]).status, 'completed');
  assert.equal(row(people[1]).status, 'enrolled');
  assert.ok(db.get('people', people[0])!.tags.includes('Baptism class done'));
  assert.equal(c.completed, 1);
  // Un-marking a session drops them back below the bar.
  c = await call(owner, 'POST', `/admin/courses/${c.id}/attendance`, { sessionId: ids[2], present: [] });
  assert.equal(row(people[0]).status, 'enrolled');
  // Marking complete by hand (a make-up session) counts every session.
  c = await call(owner, 'POST', `/admin/courses/${c.id}/enrollments/${row(people[1]).id}/complete`);
  assert.equal(row(people[1]).status, 'completed');
  assert.equal(row(people[1]).attended.length, 4);
  await fails(call(owner, 'POST', `/admin/courses/${c.id}/attendance`, { sessionId: 'nope', present: [] }), 422);

  // Member: sees the open class, signs up, fills it, and a fourth person would be refused.
  const priya = await signIn('member', 'priya@example.com');
  let mine = await call(priya, 'GET', '/me/courses');
  assert.equal(mine.courses.length, 1);
  assert.equal(mine.courses[0].mine, null);
  mine = await call(priya, 'POST', `/me/courses/${c.id}/enroll`);
  assert.equal(mine.courses[0].mine.status, 'enrolled');
  assert.equal(mine.courses[0].full, true);
  const extra = db.all('people').find((p) => ![...people, mine.courses[0].id].includes(p.id) && p.email !== 'priya@example.com')!;
  await fails(call(owner, 'POST', `/admin/courses/${c.id}/enroll`, { personIds: [extra.id] }), 409);
  c = await call(owner, 'GET', `/admin/courses/${c.id}`);
  assert.equal(c.roster.find((r: any) => r.name === 'Priya Thomas').via, 'app');
  // Leaving frees the seat.
  mine = await call(priya, 'DELETE', `/me/courses/${c.id}`);
  assert.equal(mine.courses[0].mine, null);

  // Closed sign-up hides it from members who are not in it and refuses a sign-up.
  await call(owner, 'PATCH', `/admin/courses/${c.id}`, { openToEnroll: false });
  mine = await call(priya, 'GET', '/me/courses');
  assert.equal(mine.courses.length, 0);
  await fails(call(priya, 'POST', `/me/courses/${c.id}/enroll`), 409);

  // A custom course needs sessions; a named one with sessions works.
  await fails(call(owner, 'POST', '/admin/courses', { template: 'custom', name: 'Discipleship' }), 422);
  const custom = await call(owner, 'POST', '/admin/courses', { template: 'custom', name: 'Discipleship 101', sessions: [{ title: 'Prayer' }, { title: 'Scripture' }] });
  assert.equal(custom.minAttendance, 2);
  assert.equal(custom.completeTag, null);
});
