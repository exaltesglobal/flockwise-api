// AI helpers with the scripted demo model: writer, translate, assistant tool loop, briefing,
// sermon tools, worship set and the monthly allowance.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const env = createDemoEnv();
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience: 'admin' }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown) => engine.handle({ method, path, body, auth }) as Promise<any>;

test('ai: writer, translate, assistant, briefing, sermon, set list and allowance', async () => {
  const a = await signIn('pastor@gracechurch.in');
  const st = await call(a, 'GET', '/admin/ai/status');
  assert.equal(st.enabled, true);
  assert.equal(st.used, 0);

  const d = await call(a, 'POST', '/admin/ai/write', { purpose: 'message', channel: 'whatsapp', brief: 'Youth night on Friday' });
  assert.match(d.text, /\{\{firstName\}\}/);
  await assert.rejects(call(a, 'POST', '/admin/ai/write', { brief: '' }), /what the message/);

  const t = await call(a, 'POST', '/admin/ai/translate', { text: 'Welcome {{firstName}}', to: 'hi' });
  assert.match(t.text, /Hindi/);

  const ans = await call(a, 'POST', '/admin/ai/ask', { question: 'Who has a birthday soon?' });
  assert.deepEqual(ans.toolsUsed, ['upcoming_celebrations']);
  assert.match(ans.answer, /demo answer/);

  const b = await call(a, 'POST', '/admin/ai/briefing', {});
  assert.deepEqual(b.toolsUsed, ['church_overview', 'upcoming_celebrations']);

  const s = await call(a, 'POST', '/admin/ai/sermon', { kind: 'discussion', title: 'The Good Shepherd', passage: 'John 10:1-18' });
  assert.match(s.text, /Good Shepherd/);

  const set = await call(a, 'POST', '/admin/ai/setlist', { theme: 'Grace', count: 3 });
  assert.equal(set.songs.length, 3);
  assert.ok(set.songs.every((x: any) => db.get('songs', x.songId)));

  assert.equal((await call(a, 'GET', '/admin/ai/status')).used, 8);
  db.put('settings', { ...db.get('settings', 'church')!, aiMonthlyLimit: 8 });
  await assert.rejects(call(a, 'POST', '/admin/ai/translate', { text: 'x', to: 'ta' }), /used all 8/);
});

test('ai: off when the host has no AI provider', async () => {
  const env2 = createDemoEnv();
  delete (env2 as any).ai;
  const db2 = new Db();
  seedDemo(db2, env2);
  const e2 = createChurchEngine(db2, env2);
  const otp = (await e2.handle({ method: 'POST', path: '/auth/otp/request', body: { email: 'pastor@gracechurch.in', audience: 'admin' }, auth: null })) as any;
  const s = (await e2.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  const auth = JSON.parse(atob(s.accessToken.slice(5)));
  assert.equal(((await e2.handle({ method: 'GET', path: '/admin/ai/status', auth })) as any).enabled, false);
  await assert.rejects(e2.handle({ method: 'POST', path: '/admin/ai/translate', body: { text: 'x', to: 'hi' }, auth }), /not switched on/);
});
