// The pastor's visitation diary by voice: a spoken account becomes a diary entry, prayer points
// and action items; the visit keeps the spoken words; action items are a to-do list.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const env = createDemoEnv({ now: () => new Date('2026-11-02T05:00:00.000Z') });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(audience: 'admin' | 'member', email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown) => { const [p, qs] = path.split('?'); return engine.handle({ method, path: p, body, auth, query: qs ? Object.fromEntries(new URLSearchParams(qs)) : {} }) as Promise<any>; };
const fails = async (p: Promise<unknown>, status: number) => { const e: any = await p.then(() => null, (err) => err); assert.ok(e, `expected ${status}`); assert.equal(e.status, status, e.message); };

test('spoken visit notes become a diary entry with prayer points and action items', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const priya = await signIn('member', 'priya@example.com');
  await fails(call(priya, 'POST', '/admin/ai/visit-notes', { transcript: 'x' }), 403);
  await fails(call(owner, 'POST', '/admin/ai/visit-notes', { transcript: 'too short' }), 400);

  const transcript = 'Um so I visited the Thomas family this evening. Arun is back in hospital for his knee surgery on Friday, you know, and Priya is worried about the hospital fees. We prayed for Arun\'s surgery and for peace for Priya. I will call the welfare committee about the fees next week. The children are doing well in Sunday school. I should visit again after the surgery.';
  const notes = await call(owner, 'POST', '/admin/ai/visit-notes', { transcript, familyName: 'Thomas family', date: '2026-11-02' });
  assert.ok(notes.summary.length > 40 && !/\bum\b/i.test(notes.summary), notes.summary);
  assert.equal(notes.purpose, 'hospital');
  assert.ok(notes.prayerPoints.length >= 1 && /surgery/i.test(notes.prayerPoints[0]), JSON.stringify(notes.prayerPoints));
  assert.ok(notes.actions.length >= 2, JSON.stringify(notes.actions));
  assert.ok(notes.actions.some((a: any) => /welfare committee/i.test(a.text) && a.due), 'the call has a due date');
  assert.ok(notes.actions.some((a: any) => /visit again/i.test(a.text)));
  assert.equal(notes.confidential, true, 'surgery and fees are sensitive');
  assert.ok(notes.concerns.some((c: any) => /Money|Health/.test(c)));
  assert.equal((await call(owner, 'GET', '/admin/ai/status')).used, 1);

  // The visit is filed with the structured notes and the spoken words.
  const v = await call(owner, 'POST', '/admin/visits', {
    personId: 'p_priya', status: 'done', date: '2026-11-02', purpose: notes.purpose, notes: notes.summary, prayerPoints: notes.prayerPoints.join('\n'),
    followUp: notes.actions.map((a: any) => a.text).join('; '), confidential: notes.confidential, voiceNote: transcript, actions: notes.actions,
  });
  assert.equal(v.status, 'done'); assert.equal(v.purpose, 'hospital'); assert.equal(v.confidential, true);
  assert.equal(v.voiceNote, transcript); assert.equal(v.actions.length, notes.actions.length); assert.equal(v.actions[0].done, false);

  // The to-do list: open items, soonest due first; tick one off; it leaves the open list.
  let todo = await call(owner, 'GET', '/admin/visits/actions');
  const mine = todo.filter((a: any) => a.visitId === v.id);
  assert.equal(mine.length, notes.actions.length);
  assert.equal(mine[0].familyName, v.familyName);
  assert.ok(mine[0].due && (!mine[1].due || mine[0].due <= mine[1].due), 'dated first');
  const ticked = v.actions.map((a: any, i: number) => (i === mine[0].index ? { ...a, done: true } : a));
  const v2 = await call(owner, 'PATCH', `/admin/visits/${v.id}`, { actions: ticked });
  assert.equal(v2.actions.filter((a: any) => a.done).length, 1);
  todo = await call(owner, 'GET', '/admin/visits/actions');
  assert.equal(todo.filter((a: any) => a.visitId === v.id).length, notes.actions.length - 1);
  const all = await call(owner, 'GET', '/admin/visits/actions?all=1');
  assert.equal(all.filter((a: any) => a.visitId === v.id).length, notes.actions.length);

  // A confidential visit's actions stay with pastors and the visitors: a volunteer with people.view only sees nothing.
  await fails(call(priya, 'GET', '/admin/visits/actions'), 403);
});
