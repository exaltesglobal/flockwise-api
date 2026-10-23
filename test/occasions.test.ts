// Pastoral services: member requests, scheduling, checklist and the day-before reminder.
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
const pushes = (from: number, re: RegExp) => env.outbox.slice(from).filter((o) => o.channel === 'push' && re.test(`${o.subject} ${o.text}`));

test('a member asks for a wedding, the office confirms it and the pastor is reminded', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  let h = await call(owner, 'GET', '/admin/occasions');
  assert.ok(h.pastors.length >= 1);
  const pastor = h.pastors[0];
  await call(owner, 'POST', '/me/devices', { token: 'ExponentPushToken[pastor-phone]', platform: 'android', app: 'team' }).catch(() => null);

  const priya = await signIn('member', 'priya@example.com');
  await call(priya, 'POST', '/me/devices', { token: 'ExponentPushToken[priya-phone]', platform: 'android', app: 'member' });
  await fails(call(priya, 'POST', '/me/occasions', { kind: 'wedding', date: '2026-01-01' }), 422);
  const before = env.outbox.length;
  let my = await call(priya, 'POST', '/me/occasions', { kind: 'wedding', date: '2026-12-12', place: 'Grace Church main hall', note: 'We would like Pastor Samuel please' });
  assert.equal(my.occasions.length, 1);
  assert.equal(my.occasions[0].status, 'requested');
  assert.match(my.occasions[0].title, /Wedding/);

  h = await call(owner, 'GET', '/admin/occasions');
  assert.equal(h.counts.requests, 1);
  const req = h.requests[0];
  assert.equal(req.requestNote, 'We would like Pastor Samuel please');
  assert.ok(req.total >= 6, 'wedding checklist filled in');
  assert.equal(req.via, 'app');

  // Confirming with a date and pastor schedules it and tells the member.
  const o = await call(owner, 'PATCH', `/admin/occasions/${req.id}`, { pastorId: pastor.id, time: '11:00' });
  assert.equal(o.status, 'scheduled');
  assert.equal(o.pastorName, pastor.name);
  assert.equal(pushes(before, /confirmed/).length, 1);

  // Checklist: tick, add and remove.
  let c = await call(owner, 'POST', `/admin/occasions/${o.id}/checklist`, { toggle: o.checklist[0].id });
  assert.equal(c.done, 1);
  c = await call(owner, 'POST', `/admin/occasions/${o.id}/checklist`, { label: 'Book the photographer' });
  assert.equal(c.total, o.total + 1);
  c = await call(owner, 'POST', `/admin/occasions/${o.id}/checklist`, { remove: c.checklist.at(-1).id });
  assert.equal(c.total, o.total);
  await fails(call(owner, 'PATCH', `/admin/occasions/${o.id}`, { status: 'scheduled', date: '' }), 422);

  // The day before, the pastor gets one reminder with the open items.
  clock = Date.parse('2026-12-11T04:00:00.000Z');
  const mark = env.outbox.length;
  await engine.tick();
  await engine.tick();
  const rem = env.outbox.slice(mark).filter((x) => /Tomorrow: Wedding/.test(x.subject));
  assert.ok(rem.length >= 1, 'reminder sent');
  assert.equal(new Set(rem.map((x) => x.channel)).size, rem.length, 'one per channel, not repeated');
  assert.match(rem[0].text, /Still open/);

  // A member can withdraw only a waiting request.
  await fails(call(priya, 'DELETE', `/me/occasions/${o.id}`), 403);
  my = await call(priya, 'POST', '/me/occasions', { kind: 'house_blessing', place: 'Flat 4B, Madhapur' });
  const hb = my.occasions.find((x: any) => x.kind === 'house_blessing');
  my = await call(priya, 'DELETE', `/me/occasions/${hb.id}`);
  assert.equal(my.occasions.some((x: any) => x.id === hb.id), false);

  // The office can record a funeral straight from a phone call.
  const f = await call(owner, 'POST', '/admin/occasions', { kind: 'funeral', title: 'Funeral of Mr. Joseph', date: '2026-12-15', time: '15:00', place: 'Christian cemetery, Secunderabad', contactName: 'Ruth Joseph', contactPhone: '+91 90000 11111' });
  assert.equal(f.status, 'scheduled');
  assert.ok(f.checklist.some((t: any) => /burial/i.test(t.label)));
  h = await call(owner, 'GET', '/admin/occasions');
  assert.equal(h.upcoming.length, 2);
  assert.equal(h.counts.thisYear.wedding, 1);
});
