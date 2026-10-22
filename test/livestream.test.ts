// Livestream: YouTube links, viewer pings, online attendance written to the service headcount.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { channelIdOf, youtubeId } from '../src/core/modules/livestream.js';
import { seedDemo } from '../src/core/seed.js';

let clock = new Date();
const env = createDemoEnv({ now: () => clock });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(email: string, audience = 'admin') {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown) => engine.handle({ method, path, body, auth }) as Promise<any>;
const later = (min: number) => (clock = new Date(clock.getTime() + min * 60_000));

test('reads video and channel ids from YouTube links', () => {
  for (const url of ['https://www.youtube.com/watch?v=abcdefghijk&t=10', 'youtu.be/abcdefghijk', 'https://youtube.com/live/abcdefghijk?si=x', 'https://m.youtube.com/embed/abcdefghijk', 'abcdefghijk'])
    assert.equal(youtubeId(url), 'abcdefghijk', url);
  assert.equal(youtubeId('https://vimeo.com/123'), null);
  assert.equal(youtubeId('https://youtube.com/@grace'), null);
  assert.equal(channelIdOf('https://www.youtube.com/channel/UC1234567890123456789012'), 'UC1234567890123456789012');
});

test('the seeded past stream shows its online attendance', async () => {
  const a = await signIn('pastor@gracechurch.in');
  const o = await call(a, 'GET', '/admin/livestream');
  assert.equal(o.settings.channelId, 'UCgracechurchhyderabad01');
  const last = o.past.find((s: any) => s.id === 'st_last');
  assert.ok(last.viewers > 96 && last.attended > 0 && last.attended <= last.viewers);
  assert.ok(last.members > 0 && last.peak > 0);
  assert.equal(last.recorded, last.attended);
  const d = await call(a, 'GET', '/admin/livestream/streams/st_last');
  assert.ok(d.timeline.length > 100);
  assert.equal(d.people.length + d.guests, d.viewers);
});

test('viewers ping, the office ends the stream, and the service headcount gets the online count', async () => {
  const a = await signIn('pastor@gracechurch.in');
  await assert.rejects(call(a, 'POST', '/admin/livestream/streams', { url: 'not a link' }), /YouTube/);
  const s = await call(a, 'POST', '/admin/livestream/streams', { url: 'https://youtu.be/zyxwvutsrqp', eventId: 'ev_2', startsAt: new Date(clock.getTime() + 3_600_000).toISOString() });
  assert.equal(s.status, 'scheduled');
  assert.equal(s.title, 'Sunday Worship (Telugu)');
  // Not live yet: pings are ignored.
  assert.equal((await call(null, 'POST', `/public/live/${s.id}/ping`, { viewer: 'guest-0001' })).ok, false);

  await call(a, 'POST', `/admin/livestream/streams/${s.id}/start`);
  const now = await call(null, 'GET', '/public/live');
  assert.equal(now.stream.id, s.id);
  assert.equal(now.stream.status, 'live');

  const m = await signIn('priya@example.com', 'member');
  for (let i = 0; i < 6; i++) {
    await call(null, 'POST', `/public/live/${s.id}/ping`, { viewer: 'guest-0001' });
    await call(m, 'POST', `/public/live/${s.id}/ping`, { viewer: 'ignored-for-members' });
    if (i < 2) await call(null, 'POST', `/public/live/${s.id}/ping`, { viewer: 'guest-0002' });
    later(1);
  }
  // Two pings in the same minute count once.
  await call(null, 'POST', `/public/live/${s.id}/ping`, { viewer: 'guest-0001' });
  const r = await call(null, 'POST', `/public/live/${s.id}/ping`, { viewer: 'guest-0001' });
  assert.equal(r.ok, true);
  let d = await call(a, 'GET', `/admin/livestream/streams/${s.id}`);
  assert.equal(d.viewers, 3);
  assert.equal(d.watching, 2);
  assert.equal(d.people[0].name, 'Priya Thomas');

  d = await call(a, 'POST', `/admin/livestream/streams/${s.id}/end`);
  assert.equal(d.status, 'ended');
  assert.equal(d.recorded, 2);
  const summary = await call(a, 'GET', '/admin/checkin/ev_2');
  assert.equal(summary.headcounts.find((h: any) => h.area === 'Online').count, 2);
  assert.equal((await call(null, 'POST', `/public/live/${s.id}/ping`, { viewer: 'guest-0003' })).ok, false);
});

test('a stream nobody ended closes itself after four hours', async () => {
  const a = await signIn('pastor@gracechurch.in');
  const s = await call(a, 'POST', '/admin/livestream/streams', { url: 'abcdefghijk', title: 'Prayer night' });
  assert.equal(s.status, 'live');
  later(5 * 60);
  const o = await call(a, 'GET', '/admin/livestream');
  assert.equal(o.past.find((x: any) => x.id === s.id).status, 'ended');
});

test('guests cannot watch when the church keeps the stream for members', async () => {
  const a = await signIn('pastor@gracechurch.in');
  await call(a, 'PUT', '/admin/livestream/settings', { publicWatch: false });
  assert.equal((await call(null, 'GET', '/public/live')).stream, null);
  const m = await signIn('priya@example.com', 'member');
  assert.ok((await call(m, 'GET', '/public/live')).channelId);
  await assert.rejects(call(a, 'PUT', '/admin/livestream/settings', { channelId: '@gracechurch' }), /UC/);
  const pastor = await signIn('mercy@gracechurch.in');
  assert.ok(await call(pastor, 'GET', '/admin/livestream'));
});
