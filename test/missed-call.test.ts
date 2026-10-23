// The missed-call line: a call from a known phone during the service marks attendance (and the
// household's adults), outside it asks for prayer, unknown numbers wait for the office to link.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

let clock = Date.parse('2026-11-02T05:00:00.000Z'); // Monday, 10:30 am IST
const outbox: { channel: string; to: string; text: string }[] = [];
const env = createDemoEnv({ now: () => new Date(clock), webUrl: 'https://app.example.church' });
const base = env.deliver;
env.deliver = async (channel, batch) => { for (const m of batch) outbox.push({ channel, to: m.to, text: m.text }); return base(channel, batch); };
(env as { webhookBase?: string }).webhookBase = 'https://api.example.church/v1/webhooks';
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(audience: 'admin' | 'member', email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown) => engine.handle({ method, path, body, auth, query: {} }) as Promise<any>;
const pub = (method: string, path: string, body?: unknown, query: Record<string, string> = {}) => engine.handle({ method, path, body: body ?? null, auth: null, query }) as Promise<any>;
const fails = async (p: Promise<unknown>, status: number, code?: string) => { const e: any = await p.then(() => null, (err) => err); assert.ok(e, `expected ${status}`); assert.equal(e.status, status, e.message); if (code) assert.equal(e.code, code); };

test('set the line up, then calls mark attendance during the service and ask for prayer otherwise', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const priya = await signIn('member', 'priya@example.com');
  await fails(call(priya, 'GET', '/admin/missed-call'), 403);

  let hub = await call(owner, 'GET', '/admin/missed-call');
  assert.equal(hub.settings.enabled, false);
  assert.equal(hub.webhookUrl, null, 'no key until saved');
  await fails(call(owner, 'PUT', '/admin/missed-call', { enabled: true }), 422);
  hub = await call(owner, 'PUT', '/admin/missed-call', { enabled: true, attendanceNumber: '080 4567 8900', prayerNumber: '080 4567 8901', provider: 'Exotel' });
  assert.equal(hub.settings.enabled, true);
  assert.equal(hub.settings.key.length, 20);
  assert.ok(hub.webhookUrl!.endsWith(`/missed-call/ch_demo/${hub.settings.key}`));
  const key = hub.settings.key;
  await fails(pub('POST', '/public/missed-call/wrongkey', { CallFrom: '09876543210' }), 404);

  // Monday morning: no service, so the attendance number says so and the prayer number asks a pastor to call back.
  let r = await pub('POST', `/public/missed-call/${key}`, { CallFrom: '09876543210', CallTo: '08045678900', CallSid: 'x1' });
  assert.equal(r.action, 'no_service');
  assert.ok(r.reply.includes('Priya'), r.reply);
  assert.equal(outbox.at(-1)?.channel, 'sms');
  assert.equal(outbox.at(-1)?.to, '+91 98765 43210');
  r = await pub('GET', `/public/missed-call/${key}`, null, { caller_id: '+919876543210', dispnumber: '08045678901' });
  assert.equal(r.action, 'prayer');
  const prayers = await call(owner, 'GET', '/admin/prayer');
  assert.ok(prayers.data.some((p: any) => p.personId === 'p_priya' && p.source === 'phone'), 'a prayer request for the pastors');

  // A stranger: logged for the office, told to give their name.
  r = await pub('POST', `/public/missed-call/${key}`, { From: '07000011111', To: '08045678901' });
  assert.equal(r.action, 'unknown');
  // The same stranger again within two minutes is the provider repeating itself.
  r = await pub('POST', `/public/missed-call/${key}`, { From: '07000011111', To: '08045678901' });
  assert.equal(r.action, 'duplicate');

  // Sunday 8:30 am IST: the 9 am service is on; Priya's call marks her and Arun present.
  clock = Date.parse('2026-11-08T03:00:00.000Z');
  const sent = outbox.length;
  r = await pub('POST', `/public/missed-call/${key}`, { CallFrom: '09876543210', CallTo: '08045678900' });
  assert.equal(r.action, 'checked_in', r.reply);
  assert.ok(r.reply.includes('Sunday Worship'), r.reply);
  assert.ok(r.reply.includes('1 more'), r.reply);
  assert.equal(outbox.length, sent + 1);
  // Again: already marked.
  clock += 3 * 60 * 1000;
  r = await pub('POST', `/public/missed-call/${key}`, { CallFrom: '09876543210', CallTo: '08045678900' });
  assert.equal(r.action, 'already');

  hub = await call(owner, 'GET', '/admin/missed-call');
  assert.ok(hub.serviceNow, 'a service is on');
  assert.equal(hub.stats.checkedIn, 2);
  assert.equal(hub.stats.prayer, 1);
  assert.equal(hub.stats.unknown, 1);
  assert.equal(hub.unknown.length, 1);
  assert.equal(hub.recent[0].action, 'already');

  // The office recognises the stranger: the number goes on the record and, with the service on, they are present.
  const newcomer = await call(owner, 'POST', '/admin/people', { firstName: 'Daniel', lastName: 'Kumar', status: 'visitor' });
  const linked = await call(owner, 'POST', `/admin/missed-call/${hub.unknown[0].id}/link`, { personId: newcomer.id });
  assert.equal(linked.personName, 'Daniel Kumar');
  const person = await call(owner, 'GET', `/admin/people/${newcomer.id}`);
  assert.equal(person.phone, '+91 70000 11111');
  hub = await call(owner, 'GET', '/admin/missed-call');
  assert.equal(hub.unknown.length, 0);

  // "Try it" never texts anyone and is kept out of the counts.
  const before = outbox.length;
  const t = await call(owner, 'POST', '/admin/missed-call/try', { from: '98480 12345' });
  assert.equal(t.test, true);
  assert.equal(t.personName, 'Samuel Raj');
  assert.equal(outbox.length, before);
  hub = await call(owner, 'GET', '/admin/missed-call');
  assert.equal(hub.stats.total, 5, 'tests and repeats are not counted');
});
