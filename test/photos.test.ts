// Profile photos and avatars: upload a cropped picture, it shows on the person everywhere, and the link changes with each photo.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const env = createDemoEnv({ now: () => new Date('2026-10-24T05:00:00.000Z') });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(audience: 'admin' | 'member', email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown) => engine.handle({ method, path, body, auth, query: {} }) as Promise<any>;
// A 1x1 PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('a member sets a photo and an avatar; the office can too; the public link serves the picture', async () => {
  const m = await signIn('member', 'priya@example.com');
  let me = await call(m, 'GET', '/me');
  assert.equal(me.photoUrl, null);
  const r = await call(m, 'PUT', '/me/photo', { image: PNG });
  assert.match(r.photoUrl, /^data:image\/png;base64,/);
  me = await call(m, 'GET', '/me');
  assert.equal(me.photoUrl, r.photoUrl);
  await assert.rejects(call(m, 'PUT', '/me/photo', { image: 'data:text/html;base64,PGI+' }), (e: any) => e.status === 422);
  await assert.rejects(call(m, 'PUT', '/me/photo', { image: `data:image/jpeg;base64,${'A'.repeat(500_000)}` }), (e: any) => e.status === 413);
  const av = await call(m, 'PUT', '/me/avatar', { avatar: 42 });
  assert.equal(av.avatar, 42);
  await assert.rejects(call(m, 'PUT', '/me/avatar', { avatar: 100 }), (e: any) => e.status === 422);

  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const person = (await call(owner, 'GET', `/admin/people/${me.id}`));
  assert.equal(person.photoUrl, r.photoUrl);
  assert.equal(person.avatar, 42);
  const faces = await call(owner, 'GET', '/admin/faces');
  assert.equal(faces[me.id].a, 42);
  assert.equal(faces[me.id].p, r.photoUrl);
  const key = db.get('people', me.id)!.photoKey!;
  const raw = await engine.handle({ method: 'GET', path: `/public/photos/${me.id}/${key}`, auth: null, query: {} }) as any;
  assert.equal(raw.contentType, 'image/png');
  assert.equal(raw.bytes[1], 0x50); // "P" of PNG
  await assert.rejects(engine.handle({ method: 'GET', path: `/public/photos/${me.id}/wrongkey`, auth: null, query: {} }), (e: any) => e.status === 404);

  // A new photo from the office changes the link; removing it clears it.
  await call(owner, 'PUT', `/admin/people/${me.id}/photo`, { image: PNG });
  assert.notEqual(db.get('people', me.id)!.photoKey, key);
  const cleared = await call(owner, 'DELETE', `/admin/people/${me.id}/photo`);
  assert.equal(cleared.photoUrl, null);
  assert.equal(db.get('photos', me.id), undefined);
});
