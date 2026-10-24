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

test('media team: screen links, lower-thirds, overlay and countdown', async () => {
  const a = await signIn('admin', 'pastor@gracechurch.in');
  let v = await call(a, 'GET', '/admin/services/ev_1/presentation');
  assert.ok(v.screenKey && v.screenKey.length >= 20);
  assert.ok(v.suggestedLowerThirds.some((l: any) => l.title === 'Pastor Samuel Raj'));

  const pub = await engine.handle({ method: 'GET', path: '/screens/ev_1', query: { key: v.screenKey }, auth: null }) as any;
  assert.equal(pub.screenKey, undefined);
  assert.equal(pub.slides.length, v.slides.length);
  await assert.rejects(engine.handle({ method: 'GET', path: '/screens/ev_1', query: { key: 'wrong' }, auth: null }));

  v = await call(a, 'POST', '/admin/services/ev_1/presentation', { action: 'lower', lowerThird: { title: 'Pastor Samuel Raj', subtitle: 'Lead pastor' } });
  assert.equal(v.state.lowerThird.title, 'Pastor Samuel Raj');
  v = await call(a, 'POST', '/admin/services/ev_1/presentation', { action: 'queue', lowerThirds: [{ title: 'Psalm 23' }, { title: '' }] });
  assert.equal(v.state.lowerThirds.length, 1);
  v = await call(a, 'POST', '/admin/services/ev_1/presentation', { action: 'lowerClear' });
  assert.equal(v.state.lowerThird, null);
  v = await call(a, 'POST', '/admin/services/ev_1/presentation', { action: 'overlay', on: true });
  assert.equal(v.state.overlayLyrics, true);
  v = await call(a, 'POST', '/admin/services/ev_1/presentation', { action: 'countdown' });
  assert.equal(v.state.mode, 'countdown');
  assert.equal(v.state.countdownTo, v.event.startsAt);

  const { screenKey } = await call(a, 'POST', '/admin/presentation-key/reset');
  assert.notEqual(screenKey, v.screenKey);
  await assert.rejects(engine.handle({ method: 'GET', path: '/screens/ev_1', query: { key: v.screenKey }, auth: null }));
});

test('song colours: only hex colours are kept and reach the musicians view', async () => {
  const a = await signIn('admin', 'pastor@gracechurch.in');
  const song = await call(a, 'POST', '/admin/songs', { title: 'Colour Hymn', chordChart: '[Verse 1]\n[G]Hello', colours: { chords: '#F2A93B', lyrics: 'red', background: '#101a18', bogus: '#ffffff' } });
  assert.deepEqual(song.colours, { chords: '#f2a93b', background: '#101a18' });
  const upd = await call(a, 'PATCH', `/admin/songs/${song.id}`, { colours: { headings: '#1f6b5c' } });
  assert.deepEqual(upd.colours, { headings: '#1f6b5c' });
  const ev = await call(a, 'POST', '/admin/events', { title: 'Colour service', kind: 'service', startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: new Date(Date.now() + 90_000_000).toISOString() });
  await call(a, 'PUT', `/admin/services/${ev.id}`, { theme: '', notes: '', items: [{ kind: 'song', title: 'Colour Hymn', songId: song.id, key: 'G', minutes: 4, notes: '', person: '' }] });
  const v = await call(a, 'GET', `/admin/services/${ev.id}/presentation`);
  assert.deepEqual(v.charts[0].colours, { headings: '#1f6b5c' });
});

test('presenter pro: Bible, songs and text added live, clear, stage timer and backgrounds', async () => {
  const a = await signIn('admin', 'pastor@gracechurch.in');
  const ev = await call(a, 'POST', '/admin/events', { title: 'Live add service', kind: 'service', startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: new Date(Date.now() + 90_000_000).toISOString() });
  await call(a, 'PUT', `/admin/services/${ev.id}`, { theme: '', notes: '', items: [{ kind: 'announcement', title: 'Welcome', minutes: 2, notes: '', person: '', text: 'Welcome to church' }] });
  const path = `/admin/services/${ev.id}/presentation`;

  // Bible lookup works offline for well-loved passages, with friendly aliases.
  const john = await call(a, 'GET', '/admin/bible', undefined, { ref: 'jn 3:16–17' });
  assert.equal(john.reference, 'John 3:16-17');
  assert.equal(john.verses.length, 2);
  const ps = await call(a, 'GET', '/admin/bible', undefined, { ref: 'Ps 23' });
  assert.equal(ps.verses.length, 6);
  await assert.rejects(call(a, 'GET', '/admin/bible', undefined, { ref: 'John' }), (e: any) => e.status === 422);

  // Put the passage up at once: one verse per slide, the screen jumps to the first verse.
  const text = ps.verses.map((v: any) => `${v.verse} ${v.text}`).join('\n\n');
  let v = await call(a, 'POST', path, { action: 'add', added: { kind: 'reading', title: 'Psalm 23 (KJV)', text }, live: true });
  const on = v.slides[v.state.index];
  assert.ok(on.added);
  assert.equal(on.kind, 'text');
  assert.match(on.lines[0], /^1 The LORD is my shepherd/);
  assert.equal(v.slides.filter((s: any) => s.added && s.kind === 'text').length, 6);

  // A song from the library goes to the end without changing the screen.
  const songs = await call(a, 'GET', '/admin/songs');
  const song = (songs.data ?? songs).find((s: any) => s.lyrics?.trim());
  const before = v.state.index;
  v = await call(a, 'POST', path, { action: 'add', added: { kind: 'song', songId: song.id } });
  assert.equal(v.state.index, before);
  assert.ok(v.slides.some((s: any) => s.added && s.itemTitle === song.title && s.kind === 'lyrics'));
  assert.ok(v.charts.some((c: any) => c.title === song.title));
  await assert.rejects(call(a, 'POST', path, { action: 'add', added: { kind: 'announcement', text: '  ' } }), (e: any) => e.status === 422);

  // Clear words, keep the background.
  v = await call(a, 'POST', path, { action: 'clear' });
  assert.equal(v.state.mode, 'clear');

  // Removing the item on screen clears the words.
  v = await call(a, 'POST', path, { action: 'goto', index: v.slides.findIndex((s: any) => s.itemTitle === 'Psalm 23 (KJV)' && s.kind === 'text') });
  v = await call(a, 'POST', path, { action: 'removeAdded', id: v.state.added[0].id });
  assert.equal(v.state.mode, 'clear');
  assert.ok(!v.slides.some((s: any) => s.itemTitle === 'Psalm 23 (KJV)'));

  // Stage-only note and a countdown for the preacher.
  v = await call(a, 'POST', path, { action: 'stageMessage', message: 'Wrap up in 5' });
  assert.equal(v.state.stageMessage, 'Wrap up in 5');
  v = await call(a, 'POST', path, { action: 'timer', minutes: 30, label: 'Sermon' });
  assert.equal(v.state.stageTimer.label, 'Sermon');
  assert.ok(new Date(v.state.stageTimer.endsAt).getTime() > Date.now() + 29 * 60_000);
  v = await call(a, 'POST', path, { action: 'timer', stopwatch: true });
  assert.ok(v.state.stageTimer.startedAt);
  await assert.rejects(call(a, 'POST', path, { action: 'timer', minutes: 0 }), (e: any) => e.status === 422);
  v = await call(a, 'POST', path, { action: 'timer', clear: true });
  assert.equal(v.state.stageTimer, null);

  // A moving background for one item; only https links.
  const itemId = v.charts[0].id;
  v = await call(a, 'POST', path, { action: 'background', itemId, url: 'https://cdn.example.org/loops/waves.mp4' });
  assert.equal(v.slides.find((s: any) => s.itemIndex === 0).bg, 'https://cdn.example.org/loops/waves.mp4');
  await assert.rejects(call(a, 'POST', path, { action: 'background', itemId, url: 'javascript:alert(1)' }), (e: any) => e.status === 422);
  v = await call(a, 'POST', path, { action: 'background', itemId, url: '' });
  assert.equal(v.slides.find((s: any) => s.itemIndex === 0).bg, undefined);

  // Transition is part of the slide style.
  const theme = await call(a, 'PUT', '/admin/presentation-theme', { transition: 'cut', imageUrl: 'http://insecure.example/x.jpg' });
  assert.equal(theme.transition, 'cut');
  assert.equal(theme.imageUrl, '');
});
