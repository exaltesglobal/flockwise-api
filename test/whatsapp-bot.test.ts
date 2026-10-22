// The WhatsApp assistant: what it understands, what it replies and what it records.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db, handleBotMessage } from '../src/core/index.js';
import { intentOf } from '../src/core/modules/whatsapp-bot.js';
import { seedDemo } from '../src/core/seed.js';

const env = createDemoEnv({ webUrl: 'https://app.example' });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience: 'admin' }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown) => engine.handle({ method, path, body, auth }) as Promise<any>;

test('intentOf understands menu numbers and everyday words', () => {
  assert.equal(intentOf('Hi'), 'menu');
  assert.equal(intentOf('Praise the Lord!'), 'menu');
  assert.equal(intentOf('1'), 'services');
  assert.equal(intentOf('what time is service on sunday?'), 'services');
  assert.equal(intentOf('2'), 'events');
  assert.equal(intentOf('3'), 'prayer_ask');
  assert.equal(intentOf('I want to give my tithe'), 'give');
  assert.equal(intentOf('5'), 'sermon');
  assert.equal(intentOf("I'm new here"), 'new');
  assert.equal(intentOf('can the pastor call me'), 'talk');
  assert.equal(intentOf('STOP'), 'stop');
  assert.equal(intentOf('asdfgh'), 'unknown');
});

test('the assistant needs Chitthi, answers messages, takes prayer requests and welcomes newcomers', async () => {
  const owner = await signIn('pastor@gracechurch.in');
  const off = await call(owner, 'GET', '/admin/integrations/whatsapp-bot');
  assert.equal(off.enabled, false);
  const ctx = engine.systemCtx();
  assert.equal(await handleBotMessage(ctx, { phone: '+919876500001', name: 'Ravi Kumar', text: 'hi' }), null);

  if (!off.chitthiConnected) await call(owner, 'POST', '/admin/integrations/chitthi', { apiKey: 'chk_live_abcdefgh12345678' });
  const on = await call(owner, 'POST', '/admin/integrations/whatsapp-bot', { welcome: 'Welcome to Grace! 🙏' });
  assert.equal(on.enabled, true);
  assert.equal(on.welcome, 'Welcome to Grace! 🙏');

  const tried = await call(owner, 'POST', '/admin/integrations/whatsapp-bot/try', { text: '4' });
  assert.equal(tried.intent, 'give');
  assert.match(tried.reply, /https:\/\/app\.example\/app\/give/);

  const before = env.outbox.length;
  const menu = await handleBotMessage(engine.systemCtx(), { phone: '+919876500001', name: 'Ravi Kumar', text: 'hello' });
  assert.equal(menu!.intent, 'menu');
  assert.equal(menu!.sent, true);
  assert.match(env.outbox[before].text, /Welcome to Grace/);
  assert.equal(env.outbox[before].to, '+919876500001');

  // "3" then the request itself.
  const prayers = db.all('prayer').length;
  assert.equal((await handleBotMessage(engine.systemCtx(), { phone: '+919876500001', name: 'Ravi Kumar', text: '3' }))!.intent, 'prayer_ask');
  const pr = await handleBotMessage(engine.systemCtx(), { phone: '+919876500001', name: 'Ravi Kumar', text: 'Please pray for my mother’s surgery on Friday' });
  assert.equal(pr!.intent, 'prayer');
  assert.equal(db.all('prayer').length, prayers + 1);
  const req = db.all('prayer').find((p) => p.text.includes('surgery'))!;
  assert.equal(req.visibility, 'pastors');

  // A newcomer becomes a visitor with a follow-up.
  const people = db.all('people').length;
  const nw = await handleBotMessage(engine.systemCtx(), { phone: '+919876500001', name: 'Ravi Kumar', text: '6' });
  assert.equal(nw!.intent, 'new');
  assert.equal(db.all('people').length, people + 1);
  const ravi = db.get('people', nw!.personId!)!;
  assert.equal(ravi.status, 'visitor');
  assert.deepEqual(ravi.tags, ['WhatsApp']);
  assert.ok(db.all('care').some((c) => c.personId === ravi.id && c.title.includes('newcomer')));

  // Stop turns off WhatsApp consent.
  await handleBotMessage(engine.systemCtx(), { phone: '+919876500001', name: 'Ravi Kumar', text: 'stop' });
  assert.equal(db.get('people', ravi.id)!.consent.whatsapp, false);

  const st = await call(owner, 'GET', '/admin/integrations/whatsapp-bot');
  assert.equal(st.last30.prayers, 1);
  assert.equal(st.last30.newcomers, 1);
  assert.equal(st.last30.people, 1);
  assert.ok(st.recent.length >= 5);

  const gone = await call(owner, 'DELETE', '/admin/integrations/whatsapp-bot');
  assert.equal(gone.enabled, false);
  assert.equal(await handleBotMessage(engine.systemCtx(), { phone: '+919876500001', name: 'Ravi', text: 'hi' }), null);
});
