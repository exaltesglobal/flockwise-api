// Discipleship: pairs with a rhythm, meetings from the office and the mentor's app, overdue nudges, new people with no mentor.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

let clock = Date.parse('2026-10-23T05:00:00.000Z');
const env = createDemoEnv({ now: () => new Date(clock) });
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
const nudges = (from: number) => env.outbox.slice(from).filter((o) => o.channel === 'push' && /time to meet/.test(o.subject ?? ''));

test('a mentor walks with a new believer: meetings, overdue nudges and the app', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const priya = db.all('people').find((p) => p.email === 'priya@example.com')!;
  // A newcomer who joined last week has nobody yet.
  const newbie = db.put('people', { ...db.all('people').find((p) => p.id !== priya.id && p.status === 'visitor')!, joinedAt: '2026-10-16T10:00:00.000Z', status: 'visitor' });
  let hub = await call(owner, 'GET', '/admin/discipleship');
  assert.ok(hub.needMentor.some((n: any) => n.personId === newbie.id));

  let pair = await call(owner, 'POST', '/admin/discipleship', { mentorId: priya.id, menteeId: newbie.id, focus: 'new_believer', goal: 'Read Mark together', everyDays: 7 });
  assert.equal(pair.dueOn, '2026-10-30');
  assert.equal(pair.overdue, false);
  await fails(call(owner, 'POST', '/admin/discipleship', { mentorId: priya.id, menteeId: newbie.id }), 409);
  await fails(call(owner, 'POST', '/admin/discipleship', { mentorId: priya.id, menteeId: priya.id }), 422);
  hub = await call(owner, 'GET', '/admin/discipleship');
  assert.ok(!hub.needMentor.some((n: any) => n.personId === newbie.id));
  assert.equal(hub.counts.active, 1);

  // The mentor sees them in the app and logs a meeting; the mentee sees their mentor.
  const me = await signIn('member', 'priya@example.com');
  await call(me, 'POST', '/me/devices', { token: 'ExponentPushToken[priya-phone]', platform: 'android', app: 'member' });
  let mine = await call(me, 'GET', '/me/mentoring');
  assert.equal(mine.mentees.length, 1);
  mine = await call(me, 'POST', `/me/mentoring/${pair.id}/meetings`, { topic: 'Mark 1', date: '2026-10-22' });
  assert.equal(mine.mentees[0].lastMet, '2026-10-22');
  assert.equal(mine.mentees[0].dueOn, '2026-10-29');
  await fails(call(me, 'POST', `/me/mentoring/${pair.id}/meetings`, { date: '2026-12-01' }), 422);

  // Nine days later (past the 7 + 3 grace), the pair is overdue and the mentor gets one nudge.
  clock = Date.parse('2026-11-02T05:00:00.000Z');
  const from = env.outbox.length;
  await engine.tick();
  pair = await call(owner, 'GET', `/admin/discipleship/${pair.id}`);
  assert.equal(pair.overdue, true);
  assert.equal(nudges(from).length, 1);
  clock += 86_400_000;
  await engine.tick();
  assert.equal(nudges(from).length, 1, 'once per due date');

  // The office logs a meeting; overdue clears. Completing ends it.
  pair = await call(owner, 'POST', `/admin/discipleship/${pair.id}/meetings`, { topic: 'Prayer', note: 'Doing well' });
  assert.equal(pair.overdue, false);
  assert.equal(pair.meetings, 2);
  assert.equal((await call(owner, 'GET', '/admin/discipleship')).counts.meetingsThisMonth, 1);
  pair = await call(owner, 'PATCH', `/admin/discipleship/${pair.id}`, { status: 'completed' });
  assert.equal(pair.endedOn, '2026-11-03');
  assert.equal((await call(me, 'GET', '/me/mentoring')).mentees.length, 0);
  await fails(call(me, 'POST', `/me/mentoring/${pair.id}/meetings`, {}), 403);
});
