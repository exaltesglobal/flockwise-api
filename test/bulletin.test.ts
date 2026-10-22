// The digital bulletin: built from the service plan, published to members, shared by link.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const env = createDemoEnv({ webUrl: 'https://app.example' });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(email: string, audience: 'admin' | 'member' = 'admin') {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown, query?: Record<string, string>) => engine.handle({ method, path, body, auth, query }) as Promise<any>;

test('a bulletin is drafted from the next service, published, and shared', async () => {
  db.del('bulletins', 'bl_1'); // start from no published bulletin
  const owner = await signIn('pastor@gracechurch.in');
  const b = await call(owner, 'POST', '/admin/bulletins', {});
  assert.equal(b.status, 'draft');
  assert.ok(b.service, 'picks the next service');
  assert.ok(b.order.length > 0, 'order of service from the plan');
  assert.ok(b.giving.url.endsWith('/app/give'));
  assert.match(b.shareUrl, /\/bulletin\/bl_.*\?k=/);

  const priya = await signIn('priya@example.com', 'member');
  assert.equal(await call(priya, 'GET', '/bulletins/latest'), null);
  const key = b.shareKey;
  await assert.rejects(engine.handle({ method: 'GET', path: `/public/bulletins/${b.id}`, auth: null, query: { k: key } }), /not valid/);

  const pub = await call(owner, 'PATCH', `/admin/bulletins/${b.id}`, { status: 'published', intro: 'Welcome, family!', verse: 'Psalm 118:24', sections: ['order', 'announcements', 'celebrations', 'giving'] });
  assert.ok(pub.publishedAt);
  assert.equal(pub.events.length, 0, 'events section turned off');

  const latest = await call(priya, 'GET', '/bulletins/latest');
  assert.equal(latest.intro, 'Welcome, family!');
  assert.ok(latest.celebrations.every((c: any) => db.all('people').find((p) => `${p.firstName} ${p.lastName}` === c.name)?.consent.directory));

  const shared = (await engine.handle({ method: 'GET', path: `/public/bulletins/${b.id}`, auth: null, query: { k: key } })) as any;
  assert.equal(shared.celebrations.length, 0, 'no birthdays on the public link');
  assert.equal(shared.serving.length, 0);
  await assert.rejects(engine.handle({ method: 'GET', path: `/public/bulletins/${b.id}`, auth: null, query: { k: 'wrong' } }), /not valid/);
});
