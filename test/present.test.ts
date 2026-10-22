// Presentation and worship: lyric parsing, arrangements, slide decks, live control, theme and song stats.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { parseSections } from '../src/core/modules/present.js';
import { seedDemo } from '../src/core/seed.js';

const env = createDemoEnv();
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(audience: 'admin' | 'member', email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown, query?: Record<string, string>) => engine.handle({ method, path, body, auth, query }) as Promise<any>;

test('parseSections reads headings, ChordPro and unlabelled blocks', () => {
  const s = parseSections('[Verse 1]\n[G]Line one\nLine two\n\nChorus:\nSing it\n\n{soc}\nAgain\n{eoc}\n\nNo heading here');
  assert.deepEqual(s.map((x) => x.label), ['Verse 1', 'Chorus', 'Chorus', 'Verse 1']);
  assert.deepEqual(s[0].lines, ['Line one', 'Line two']);
  assert.equal(s[0].chords[0], '[G]Line one');
  const plain = parseSections('First verse line\n\nSecond verse line');
  assert.deepEqual(plain.map((x) => x.label), ['Verse 1', 'Verse 2']);
});

test('presentation: deck follows the arrangement, live control and theme', async () => {
  const a = await signIn('admin', 'pastor@gracechurch.in');
  const song = await call(a, 'POST', '/admin/songs', {
    title: 'Test Hymn', author: 'Public domain', defaultKey: 'G',
    lyrics: 'Verse 1\nA1\nA2\n\nChorus\nC1\nC2\n\nVerse 2\nB1\nB2',
    lyricsAlt: 'Verse 1\nअ1\nअ2\n\nChorus\nक1\nक2',
    arrangement: ['Verse 1', 'Chorus', 'Verse 2', 'Chorus'],
  });
  assert.deepEqual(song.arrangement, ['Verse 1', 'Chorus', 'Verse 2', 'Chorus']);

  const ev = await call(a, 'POST', '/admin/events', { title: 'Deck test service', kind: 'service', startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: new Date(Date.now() + 90_000_000).toISOString() });
  await call(a, 'PUT', `/admin/services/${ev.id}`, {
    theme: 'Test', notes: '', rehearsalAt: new Date(Date.now() + 40_000_000).toISOString(), rehearsalNotes: 'Bring capo',
    items: [
      { kind: 'song', title: 'Test Hymn', songId: song.id, key: 'G', minutes: 5, notes: '', person: 'Leena George' },
      { kind: 'reading', title: 'Psalm 23', minutes: 3, notes: '', person: '', text: 'The Lord is my shepherd.\n\nHe maketh me to lie down.' },
    ],
  });
  const { plan } = await call(a, 'GET', `/admin/services/${ev.id}`);
  assert.equal(plan.rehearsalNotes, 'Bring capo');

  let v = await call(a, 'GET', `/admin/services/${ev.id}/presentation`);
  const labels = v.slides.map((s: any) => `${s.kind}:${s.label}`);
  assert.deepEqual(labels, ['title:Title', 'lyrics:Verse 1', 'lyrics:Chorus', 'lyrics:Verse 2', 'lyrics:Chorus', 'title:Reading', 'text:Reading', 'text:Reading']);
  assert.deepEqual(v.slides[2].alt, ['क1', 'क2']);
  assert.deepEqual(v.slides[3].alt, []);
  assert.equal(v.state.index, 0);

  v = await call(a, 'POST', `/admin/services/${ev.id}/presentation`, { action: 'next' });
  assert.equal(v.state.index, 1);
  v = await call(a, 'POST', `/admin/services/${ev.id}/presentation`, { action: 'item', index: 1 });
  assert.equal(v.slides[v.state.index].itemIndex, 1);
  v = await call(a, 'POST', `/admin/services/${ev.id}/presentation`, { action: 'blank' });
  assert.equal(v.state.mode, 'blank');
  v = await call(a, 'POST', `/admin/services/${ev.id}/presentation`, { action: 'prev' });
  assert.equal(v.state.mode, 'live');
  v = await call(a, 'POST', `/admin/services/${ev.id}/presentation`, { action: 'goto', index: 999 });
  assert.equal(v.state.index, v.slides.length - 1);

  // A plan item's own arrangement wins over the song's.
  await call(a, 'PUT', `/admin/services/${ev.id}`, { items: [{ kind: 'song', title: 'Test Hymn', songId: song.id, key: 'A', minutes: 5, notes: '', person: '', arrangement: ['Chorus'] }] });
  const theme = await call(a, 'PUT', '/admin/presentation-theme', { titleSlides: false, linesPerSlide: 1, background: 'not-a-colour' });
  assert.equal(theme.linesPerSlide, 1);
  assert.equal(theme.background, '#0f1f1c');
  v = await call(a, 'GET', `/admin/services/${ev.id}/presentation`);
  assert.deepEqual(v.slides.map((s: any) => s.label), ['Chorus (1/2)', 'Chorus (2/2)']);
  await call(a, 'PUT', '/admin/presentation-theme', { titleSlides: true, linesPerSlide: 4 });

  // Members can't drive the screens.
  const m = await signIn('member', 'priya@example.com');
  await assert.rejects(call(m, 'POST', `/admin/services/${ev.id}/presentation`, { action: 'next' }));
});

test('seeded hymn shows on the projector, and song stats count past services', async () => {
  const a = await signIn('admin', 'pastor@gracechurch.in');
  const v = await call(a, 'GET', '/admin/services/ev_1/presentation');
  assert.ok(v.slides.some((s: any) => s.lines.includes('Amazing grace! How sweet the sound')));
  assert.ok(v.slides.some((s: any) => s.kind === 'text' && s.lines[0].startsWith('I am the good shepherd')));
  const stats = await call(a, 'GET', '/admin/songs/stats');
  assert.ok(stats.top.length > 0);
  assert.ok(stats.top.every((t: any) => t.uses >= 1));
  assert.ok(stats.resting.some((r: any) => r.songId === 'sg_h2'));
  assert.ok(stats.byLeader.length > 0);
});
