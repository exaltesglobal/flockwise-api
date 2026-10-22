// Songbook pages read from photos, and dictated sermon notes tidied into clean notes.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const env = createDemoEnv({ now: () => new Date('2026-10-22T05:00:00.000Z') });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function owner() {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email: 'pastor@gracechurch.in', audience: 'admin' }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const fails = async (p: Promise<unknown>, status: number) => { const e: any = await p.then(() => null, (err) => err); assert.ok(e, `expected ${status}`); assert.equal(e.status, status, e.message); };
// A tiny JPEG stand-in: the demo model only counts the photos.
const photo = { mediaType: 'image/jpeg', data: 'data:image/jpeg;base64,' + 'A'.repeat(400) };

test('a photo of a songbook page comes back as songs to check, and costs one AI request', async () => {
  const auth = await owner();
  const call = (method: string, path: string, body?: unknown) => engine.handle({ method, path, body, auth }) as Promise<any>;
  const before = (await call('GET', '/admin/ai/status')).used;
  await fails(call('POST', '/admin/ai/song-scan', { images: [] }), 400);
  await fails(call('POST', '/admin/ai/song-scan', { images: [{ mediaType: 'image/bmp', data: photo.data }] }), 422);
  await fails(call('POST', '/admin/ai/song-scan', { images: [photo, photo, photo, photo, photo] }), 422);
  const out = await call('POST', '/admin/ai/song-scan', { images: [photo], hint: 'Telugu chorus book, page 12' });
  assert.equal(out.pages, 1);
  assert.ok(out.songs.length >= 1);
  const te = out.songs.find((s: any) => s.language === 'te');
  assert.ok(te && /యేసు/.test(te.lyrics), 'the Telugu stays in Telugu script');
  assert.match(te.chordChart, /\[G\]/);
  assert.equal(te.key, 'G');
  assert.ok(te.warnings.length >= 1);
  assert.equal((await call('GET', '/admin/ai/status')).used, before + 1);
  // The office checks and saves the song itself; nothing was added yet.
  const songs = await call('GET', '/admin/songs');
  assert.ok(!(songs.data ?? songs).some((s: any) => s.title === te.title));
});

test('dictated notes become clean sermon notes and are kept on the sermon for members', async () => {
  const auth = await owner();
  const call = (method: string, path: string, body?: unknown) => engine.handle({ method, path, body, auth }) as Promise<any>;
  await fails(call('POST', '/admin/ai/sermon', { kind: 'notes', title: 'Peace', notes: '' }), 400);
  const tidy = await call('POST', '/admin/ai/sermon', { kind: 'notes', title: 'Peace with God', passage: 'Romans 5', notes: 'um so paul says we have peace with god you know through our lord jesus. this is not a truce it is peace.' });
  assert.match(tidy.text, /^## /m);
  assert.ok(!/\bum\b/.test(tidy.text), 'fillers are gone');
  const s = await call('POST', '/admin/sermons', { title: 'Peace with God', scripture: 'Romans 5:1', notes: tidy.text });
  assert.equal(s.notes, tidy.text);
  const member = await engine.handle({ method: 'GET', path: '/sermons', auth }) as any[];
  assert.equal(member.find((x) => x.id === s.id).notes, tidy.text);
  const seeded = member.find((x) => x.id === 'sm_1');
  assert.match(seeded.notes, /Peace with God/);
});
