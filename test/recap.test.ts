// "Sunday in 60 seconds": the facts come from the records, the AI writes the words, the office
// edits and publishes, members and the public share page see only published recaps.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

let clock = Date.parse('2026-11-02T05:00:00.000Z'); // Monday, 10:30 am IST; last Sunday was 1 Nov
const env = createDemoEnv({ now: () => new Date(clock) });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(audience: 'admin' | 'member', email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown) => { const [p, qs] = path.split('?'); return engine.handle({ method, path: p, body, auth, query: qs ? Object.fromEntries(new URLSearchParams(qs)) : {} }) as Promise<any>; };
const fails = async (p: Promise<unknown>, status: number, code?: string) => { const e: any = await p.then(() => null, (err) => err); assert.ok(e, `expected ${status}`); assert.equal(e.status, status, e.message); if (code) assert.equal(e.code, code); };

test('facts come from the records, not the model', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const sundays = await call(owner, 'GET', '/admin/recaps/sundays');
  assert.ok(sundays.length >= 1);
  const last = sundays.find((s: any) => s.eventId === 'ev_7');
  assert.equal(last.date, '2026-11-01');
  assert.equal(last.recapId, 'rc_1');

  const f = await call(owner, 'GET', '/admin/recaps/facts?eventId=ev_7');
  assert.equal(f.attendance, 846);
  assert.equal(f.sermon.title, 'Hope that does not disappoint');
  assert.equal(f.sermon.scripture, 'Romans 5:1-5');
  assert.ok(f.songs.length >= 3);
  assert.equal(f.giving, null, 'money stays out unless asked for');
  const withGiving = await call(owner, 'GET', '/admin/recaps/facts?eventId=ev_7&includeGiving=1');
  assert.equal(typeof withGiving.giving, 'number');
  assert.ok(f.nextEvents.length >= 1 && f.nextEvents.every((e: any) => e.startsAt > '2026-11-01'));
  await fails(call(owner, 'POST', '/admin/recaps', { eventId: 'ev_1' }), 409, 'not_yet');
});

test('write, edit, publish: members and the share page see only published recaps', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const priya = await signIn('member', 'priya@example.com');
  await fails(call(priya, 'POST', '/admin/recaps', {}), 403);

  const before = (await call(owner, 'GET', '/admin/ai/status')).used;
  const rec = await call(owner, 'POST', '/admin/recaps', { eventId: 'ev_7', language: 'en' });
  assert.equal(rec.status, 'draft');
  assert.equal(rec.slides.length, 5);
  assert.ok(rec.headline && rec.caption.includes('846'));
  assert.equal(rec.stats.attendance, 846);
  assert.equal((await call(owner, 'GET', '/admin/ai/status')).used, before + 1, 'one AI request');

  const mine = await call(priya, 'GET', '/me/recaps');
  assert.deepEqual(mine.map((r: any) => r.id), ['rc_1'], 'the draft is hidden');
  assert.equal(mine[0].church.name, 'Grace Community Church');
  assert.equal((mine[0] as any).facts, undefined, 'members do not get the facts block');
  await fails(engine.handle({ method: 'GET', path: `/public/recaps/${rec.id}`, auth: null, body: null, query: {} }) as Promise<unknown>, 404);

  const edited = await call(owner, 'PATCH', `/admin/recaps/${rec.id}`, { headline: 'Hope that holds', slides: [...rec.slides.slice(0, 4), { title: 'See you Sunday', text: 'Bring a friend.', stat: null }] });
  assert.equal(edited.headline, 'Hope that holds');
  assert.equal(edited.slides[4].title, 'See you Sunday');
  await fails(call(owner, 'PATCH', `/admin/recaps/${rec.id}`, { slides: [] }), 400);

  await call(priya, 'POST', '/me/devices', { token: 'ExponentPushToken[priya]', platform: 'android', app: 'member' });
  env.outbox.length = 0;
  const pub = await call(owner, 'POST', `/admin/recaps/${rec.id}/publish`);
  assert.equal(pub.status, 'published');
  assert.ok(pub.notified > 0);
  const push = env.outbox.find((o) => o.channel === 'push' && o.to === 'ExponentPushToken[priya]');
  assert.ok(push, 'Priya gets a push');
  assert.equal(push!.subject, 'Hope that holds');
  assert.ok(/Sunday in 60 seconds/.test(push!.text));

  const now = await call(priya, 'GET', '/me/recaps');
  assert.equal(now[0].id, rec.id);
  const shared = await engine.handle({ method: 'GET', path: `/public/recaps/${rec.id}`, auth: null, body: null, query: {} }) as any;
  assert.equal(shared.headline, 'Hope that holds');
  assert.equal(shared.church.brand.primary, '#7a2e2e');

  await call(owner, 'DELETE', `/admin/recaps/${rec.id}`);
  assert.deepEqual((await call(priya, 'GET', '/me/recaps')).map((r: any) => r.id), ['rc_1']);
});
