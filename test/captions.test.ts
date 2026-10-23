// Live sermon captions: the media desk's browser hears the preacher and posts each line; the
// engine translates it and the screens pick the last lines up with their next poll.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const clock = Date.parse('2026-11-08T04:00:00.000Z'); // Sunday 9:30 am IST
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
const fails = async (p: Promise<unknown>, status: number, code?: string) => { const e: any = await p.then(() => null, (err) => err); assert.ok(e, `expected ${status}`); assert.equal(e.status, status, e.message); if (code) assert.equal(e.code, code); };

test('switch captions on, post what was heard, and the projector shows the translation', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const priya = await signIn('member', 'priya@example.com');
  await fails(call(priya, 'POST', '/admin/services/ev_1/captions', { text: 'hello' }), 403);

  let v = await call(owner, 'GET', '/admin/services/ev_1/presentation');
  assert.equal(v.captions.on, false);
  assert.equal(v.captions.from, 'en', 'the church preaches in English first');
  assert.notEqual(v.captions.to, 'en', 'so the screen shows the second language');
  assert.deepEqual(v.captions.lines, []);

  v = await call(owner, 'POST', '/admin/services/ev_1/presentation', { action: 'captions', captions: { on: true, from: 'en', to: 'te', show: 'both' } });
  assert.deepEqual(v.captions, { on: true, from: 'en', to: 'te', show: 'both', lines: [], count: 0 });
  const bad = await call(owner, 'POST', '/admin/services/ev_1/presentation', { action: 'captions', captions: { to: 'xx' } });
  assert.equal(bad.captions.to, 'te', 'an unknown language is ignored');

  await fails(call(owner, 'POST', '/admin/services/ev_1/captions', { text: ' ' }), 422);
  const ai = await call(owner, 'GET', '/admin/ai/status');
  const first = await call(owner, 'POST', '/admin/services/ev_1/captions', { text: 'For God so loved the world that He gave His only Son.' });
  assert.equal(first.line.text, 'For God so loved the world that He gave His only Son.');
  assert.ok(first.line.translated.includes('[Telugu]'), 'translated by the stand-in');
  assert.equal(first.count, 1);
  for (let i = 0; i < 4; i++) await call(owner, 'POST', '/admin/services/ev_1/captions', { text: `Line number ${i + 2} of the sermon.` });
  const after = await call(owner, 'GET', '/admin/ai/status');
  assert.equal(after.used, ai.used + 1, 'five caption lines count as one AI request');

  // The projector (public screen link) gets the last three lines; the presenter gets more.
  v = await call(owner, 'GET', '/admin/services/ev_1/presentation');
  assert.equal(v.captions.count, 5);
  assert.equal(v.captions.lines.length, 5);
  const screen = await engine.handle({ method: 'GET', path: '/screens/ev_1', body: null, auth: null, query: { key: v.screenKey } }) as any;
  assert.equal(screen.captions.on, true);
  assert.equal(screen.captions.lines.length, 3);
  assert.equal(screen.captions.lines[2].text, 'Line number 5 of the sermon.');
  assert.equal(screen.captions.count, 5);

  // Same language in and out: nothing to translate.
  await call(owner, 'POST', '/admin/services/ev_1/presentation', { action: 'captions', captions: { to: 'en' } });
  const same = await call(owner, 'POST', '/admin/services/ev_1/captions', { text: 'Let us pray.' });
  assert.equal(same.line.translated, null);

  const all = await call(owner, 'GET', '/admin/services/ev_1/captions');
  assert.equal(all.count, 6);
  await call(owner, 'DELETE', '/admin/services/ev_1/captions');
  v = await call(owner, 'GET', '/admin/services/ev_1/presentation');
  assert.equal(v.captions.count, 0);
  assert.equal(v.captions.on, true, 'clearing the lines does not switch captions off');
});
