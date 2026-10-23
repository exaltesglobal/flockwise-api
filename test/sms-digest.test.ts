// Weekly SMS digest: members without the app get one text a week in their own script with the
// service time, the week's events, the bulletin verse and the office number; sent once per week
// by the daily tick on the chosen day and hour, or by hand from the office.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

let clock = Date.parse('2026-11-02T05:00:00.000Z'); // Monday, 10:30 am IST
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
const fails = async (p: Promise<unknown>, status: number) => { const e: any = await p.then(() => null, (err) => err); assert.ok(e, `expected ${status}`); assert.equal(e.status, status, e.message); };

test('the weekly text in local script: who gets it, what it says, when it goes', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const priya = await signIn('member', 'priya@example.com');
  await fails(call(priya, 'GET', '/admin/messages/sms-digest'), 403);

  // Off by default; the office sees who would get it and a sample in a non-English script.
  let st = await call(owner, 'GET', '/admin/messages/sms-digest');
  assert.equal(st.settings.enabled, false);
  assert.equal(st.nextAt, null);
  assert.ok(st.recipients > 0);
  assert.ok(st.channelReady);
  assert.ok(Object.keys(st.byLanguage).length >= 2, 'more than one language among recipients');
  const total = Object.values(st.byLanguage as Record<string, number>).reduce((a, b) => a + b, 0);
  assert.equal(total, st.recipients);

  // Priya has the app on her phone, so by default she is left out; "everyone" brings her in.
  await call(priya, 'POST', '/me/devices', { token: 'tok-priya', platform: 'android', app: 'member' });
  st = await call(owner, 'GET', '/admin/messages/sms-digest');
  const before = st.recipients;
  const everyone = await call(owner, 'PUT', '/admin/messages/automations', { smsDigest: { audience: 'everyone' } });
  assert.equal(everyone.smsDigest.audience, 'everyone');
  st = await call(owner, 'GET', '/admin/messages/sms-digest');
  assert.equal(st.recipients, before + 1);
  await call(owner, 'PUT', '/admin/messages/automations', { smsDigest: { audience: 'no_app' } });

  // The preview: church name, Sunday time, blessing; Hindi is in Devanagari and costs more segments.
  const en = await call(owner, 'GET', '/admin/messages/sms-digest/preview?personId=p_priya&language=en');
  assert.match(en.text, /^This week at Grace Community Church/);
  assert.match(en.text, /Sunday service: /);
  assert.match(en.text, /God bless you!$/);
  assert.ok(en.segments >= 1 && en.chars > 40);
  const hi = await call(owner, 'GET', '/admin/messages/sms-digest/preview?personId=p_priya&language=hi');
  assert.match(hi.text, /[ऀ-ॿ]/, 'Devanagari');
  assert.match(hi.text, /रविवार आराधना/);
  assert.ok(hi.segments > 1, 'Unicode text takes 70-char segments');
  await fails(call(owner, 'GET', '/admin/messages/sms-digest/preview?language=xx'), 422);

  // The office note goes in; validation clamps day and hour.
  const saved = await call(owner, 'PUT', '/admin/messages/automations', { smsDigest: { enabled: true, day: 6, hour: 25, note: 'Bring a friend this Sunday.' } });
  assert.equal(saved.smsDigest.hour, 21);
  await call(owner, 'PUT', '/admin/messages/automations', { smsDigest: { hour: 17 } });
  const noted = await call(owner, 'GET', '/admin/messages/sms-digest/preview?language=en');
  assert.match(noted.text, /Bring a friend this Sunday\./);
  st = await call(owner, 'GET', '/admin/messages/sms-digest');
  assert.equal(st.nextAt, '2026-11-07T17:00', 'coming Saturday 5 pm IST');

  // Send now: one text per person in their language, one record in the office's sent list.
  let n = env.outbox.length;
  const sent = await call(owner, 'POST', '/admin/messages/sms-digest/send');
  assert.equal(sent.recipients, st.recipients);
  assert.equal(sent.sent, st.recipients);
  const texts = env.outbox.slice(n).filter((o) => o.channel === 'sms');
  assert.equal(texts.length, st.recipients);
  assert.ok(texts.some((o) => /^This week at Grace/.test(o.text)), 'English texts');
  assert.ok(texts.some((o) => /[ऀ-ॿ]/.test(o.text)), 'Hindi texts');
  assert.ok(texts.some((o) => /[ఀ-౿]/.test(o.text)), 'Telugu texts');
  assert.ok(texts.every((o) => /Bring a friend/.test(o.text)));
  const msg = db.get('messages', sent.messageId)!;
  assert.equal(msg.source, 'automation'); assert.equal(msg.channel, 'sms'); assert.equal(msg.stats.recipients, st.recipients);
  st = await call(owner, 'GET', '/admin/messages/sms-digest');
  assert.ok(st.lastSentAt);

  // The tick: nothing on Friday, nothing on Saturday morning, once at 5 pm, not again that evening.
  clock = Date.parse('2026-11-06T12:00:00.000Z'); // Friday 5:30 pm IST
  n = env.outbox.length;
  await engine.tick();
  assert.equal(env.outbox.slice(n).filter((o) => o.channel === 'sms' && /This week at|इस सप्ताह|ఈ వారం/.test(o.text)).length, 0, 'not Friday');
  clock = Date.parse('2026-11-07T04:00:00.000Z'); // Saturday 9:30 am IST
  await engine.tick();
  assert.equal(env.outbox.slice(n).filter((o) => o.channel === 'sms' && /This week at|इस सप्ताह|ఈ వారం/.test(o.text)).length, 0, 'not before 5 pm');
  clock = Date.parse('2026-11-07T12:00:00.000Z'); // Saturday 5:30 pm IST
  await engine.tick();
  const went = env.outbox.slice(n).filter((o) => o.channel === 'sms' && /This week at|इस सप्ताह|ఈ వారం/.test(o.text)).length;
  assert.equal(went, st.recipients, 'sent at 5 pm');
  clock = Date.parse('2026-11-07T14:00:00.000Z'); // Saturday 7:30 pm IST
  await engine.tick();
  assert.equal(env.outbox.slice(n).filter((o) => o.channel === 'sms' && /This week at|इस सप्ताह|ఈ వారం/.test(o.text)).length, went, 'only once');

  // WhatsApp instead of SMS: the same words on the other channel.
  await call(owner, 'PUT', '/admin/messages/automations', { smsDigest: { channel: 'whatsapp' } });
  n = env.outbox.length;
  const wa = await call(owner, 'POST', '/admin/messages/sms-digest/send');
  assert.ok(wa.recipients > 0);
  assert.ok(env.outbox.slice(n).every((o) => o.channel === 'whatsapp'));
});
