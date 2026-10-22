// The shared song database: search the public-domain hymns, add one to the church library, the
// team adds an Indian-language hymn, and a licensed lyrics feed answers for a church with a CCLI licence.
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.WEB_URL = 'https://app.example';
process.env.API_PUBLIC_URL = 'https://api.example';
process.env.CHURCH_ID = 'ch_main';
process.env.CHURCH_NAME = 'First Church';
process.env.CHURCH_SLUG = 'first';
process.env.OWNER_EMAIL = 'owner@first.test';
process.env.PLATFORM_ADMINS = 'team@flockwise.test';
process.env.LYRICS_FEEDS = JSON.stringify([{ id: 'pub', name: 'Test Publisher', url: 'https://lyrics.example/v1/words', key: 'feed-key', covers: 'all' }, { id: 'bad', name: 'Not https', url: 'http://x', key: 'k' }]);

const { createApp } = await import('../src/app.js');
const { buildServer, bootstrap } = await import('../src/server.js');
const { OPEN_HYMNAL } = await import('../src/core/catalog/open-hymnal.js');
type HttpRequest = import('../src/core/index.js').HttpRequest;

const server = buildServer();
bootstrap(server);
const codes = new Map<string, string>();
server.hooks.sendOtpEmail = async (to, code) => void codes.set(to, code);
const calls: HttpRequest[] = [];
server.hooks.http = async (req) => {
  calls.push(req);
  const body = JSON.parse(String(req.body ?? '{}'));
  if (req.url === 'https://lyrics.example/v1/words' && req.headers?.Authorization === 'Bearer feed-key' && body.licence?.ccli === '1234567')
    return { status: 200, headers: {}, text: JSON.stringify({ lyrics: 'Verse 1\nLicensed line one\nLicensed line two', copyright: '© 2020 Test Publisher', defaultKey: 'A' }) };
  return { status: 404, headers: {}, text: '' };
};
const app = createApp(server);

const req = (method: string, path: string, body?: unknown, token?: string) =>
  app.request(path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const ok = async (res: Response, status = 200) => {
  const text = await res.text();
  assert.equal(res.status, status, text);
  return text ? JSON.parse(text) : undefined;
};
async function signIn(email: string) {
  const r = await ok(await req('POST', '/v1/auth/otp/request', { email, audience: 'admin' }));
  return (await ok(await req('POST', '/v1/auth/otp/verify', { requestId: r.requestId, code: codes.get(email.toLowerCase()) }))).accessToken as string;
}

let owner = '';
let team = '';

test('the built-in hymns are all public domain, with words and unique ids', () => {
  assert.ok(OPEN_HYMNAL.length > 200);
  assert.equal(new Set(OPEN_HYMNAL.map((s) => s.id)).size, OPEN_HYMNAL.length);
  for (const s of OPEN_HYMNAL) {
    assert.equal(s.rights, 'public-domain', s.id);
    assert.ok(s.lyrics?.startsWith('Verse 1\n'), s.id);
    assert.ok(s.arrangement?.length, s.id);
    assert.doesNotMatch(s.lyrics!, /[~_|\\]/, s.id);
  }
});

test('search the song database and add a hymn to the library', async () => {
  owner = await signIn('owner@first.test');
  const all = await ok(await req('GET', '/v1/admin/song-catalog?limit=5', undefined, owner));
  assert.equal(all.songs.length, 5);
  assert.ok(all.total > 200);
  assert.equal(all.languages.find((l: { id: string }) => l.id === 'en').songs, all.total);
  assert.equal(all.songs[0].lyrics, undefined, 'the list leaves the words out');

  const found = await ok(await req('GET', '/v1/admin/song-catalog?q=abide%20with', undefined, owner));
  const hymn = found.songs.find((s: { title: string }) => s.title === 'Abide With Me');
  assert.ok(hymn);
  assert.equal(found.songs[0].title, 'Abide With Me', 'title matches come first');
  assert.equal(hymn.tune, 'EVENTIDE');
  assert.equal(hymn.inLibrary, null);
  const byTune = await ok(await req('GET', '/v1/admin/song-catalog?q=eventide', undefined, owner));
  assert.ok(byTune.songs.some((s: { id: string }) => s.id === hymn.id));

  const detail = await ok(await req('GET', `/v1/admin/song-catalog/${hymn.id}`, undefined, owner));
  assert.ok(detail.lyrics.length > 100);
  const added = await ok(await req('POST', `/v1/admin/song-catalog/${hymn.id}/add`, {}, owner));
  assert.equal(added.created, true);
  assert.equal(added.song.catalogId, hymn.id);
  assert.equal(added.song.copyright, 'Public domain');
  assert.equal(added.song.lyrics, detail.lyrics);
  assert.deepEqual(added.song.arrangement, detail.arrangement);
  const again = await ok(await req('POST', `/v1/admin/song-catalog/${hymn.id}/add`, {}, owner));
  assert.equal(again.created, false);
  assert.equal(again.song.id, added.song.id);
  const lib = await ok(await req('GET', '/v1/admin/songs?q=abide', undefined, owner));
  assert.equal(lib.filter((s: { catalogId?: string }) => s.catalogId === hymn.id).length, 1);
  const after = await ok(await req('GET', '/v1/admin/song-catalog?q=abide%20with', undefined, owner));
  assert.equal(after.songs.find((s: { id: string }) => s.id === hymn.id).inLibrary, added.song.id);
  assert.equal((await req('POST', '/v1/admin/song-catalog/nope/add', {}, owner)).status, 404);
});

test('the Flockwise team adds a Telugu hymn; only public-domain words are accepted', async () => {
  const r = await ok(await req('POST', '/v1/platform/auth/request', { email: 'team@flockwise.test' }));
  team = (await ok(await req('POST', '/v1/platform/auth/verify', { requestId: r.requestId, code: codes.get('team@flockwise.test') }))).token;
  const entry = { title: 'Test Telugu hymn', aka: ['Test transliteration'], language: 'te', writers: 'Test writer (1850)', year: 1850, rights: 'public-domain', defaultKey: 'D', themes: ['Hymn'], lyrics: 'Verse 1\nLine one\nLine two', arrangement: ['Verse 1'] };
  assert.equal((await req('POST', '/v1/platform/songs', entry)).status, 401);
  assert.equal((await req('POST', '/v1/platform/songs', { ...entry, rights: 'copyrighted', source: 'x' }, team)).status, 422);
  assert.equal((await req('POST', '/v1/platform/songs', entry, team)).status, 422, 'words need a source');
  const made = await ok(await req('POST', '/v1/platform/songs', { ...entry, source: 'Test hymnbook, 1900 edition' }, team));
  assert.equal(made.id, 'fw-test-telugu-hymn');

  const te = await ok(await req('GET', '/v1/admin/song-catalog?lang=te', undefined, owner));
  assert.equal(te.total, 1);
  assert.equal(te.songs[0].hasLyrics, true);
  assert.equal(te.languages.find((l: { id: string }) => l.id === 'te').songs, 1);
  const byAka = await ok(await req('GET', '/v1/admin/song-catalog?q=transliteration', undefined, owner));
  assert.equal(byAka.songs[0].id, made.id);

  const list = await ok(await req('GET', '/v1/platform/songs?lang=te', undefined, team));
  assert.equal(list.songs[0].edited, true);
  await ok(await req('DELETE', `/v1/platform/songs/${made.id}`, undefined, team), 204);
  assert.equal((await ok(await req('GET', '/v1/admin/song-catalog?lang=te', undefined, owner))).total, 0);
});

test('song licences and a licensed lyrics feed fill in words for a song without them', async () => {
  const st = await ok(await req('GET', '/v1/admin/song-catalog/licence', undefined, owner));
  assert.equal(st.licence, null);
  assert.deepEqual(st.feeds.map((f: { id: string }) => f.id), ['pub'], 'feeds that are not https are ignored');
  assert.equal((await req('PUT', '/v1/admin/song-catalog/licence', { ccliLicence: 'abc' }, owner)).status, 422);

  // A song with no words yet (the team added only its credits).
  const bare = await ok(await req('POST', '/v1/platform/songs', { title: 'Credits only', language: 'en', writers: 'Someone', rights: 'public-domain' }, team));
  const before = await ok(await req('GET', `/v1/admin/song-catalog/${bare.id}`, undefined, owner));
  assert.equal(before.licensedAvailable, false, 'no CCLI licence yet');

  const saved = await ok(await req('PUT', '/v1/admin/song-catalog/licence', { ccliLicence: '1234567', streamingLicence: '7654321' }, owner));
  assert.equal(saved.licence.ccliLicence, '1234567');
  assert.equal((await ok(await req('GET', `/v1/admin/song-catalog/${bare.id}`, undefined, owner))).licensedAvailable, true);
  const added = await ok(await req('POST', `/v1/admin/song-catalog/${bare.id}/add`, {}, owner));
  assert.equal(added.licensed, true);
  assert.equal(added.song.licensedFrom, 'Test Publisher');
  assert.equal(added.song.copyright, '© 2020 Test Publisher');
  assert.equal(added.song.defaultKey, 'A');
  assert.match(added.song.lyrics, /Licensed line one/);
  const feedCall = calls.find((c) => c.url === 'https://lyrics.example/v1/words')!;
  assert.equal(JSON.parse(String(feedCall.body)).catalogId, bare.id);

  // Hymns that already have words never ask the feed.
  const n = calls.length;
  const hymn = (await ok(await req('GET', '/v1/admin/song-catalog?q=amazing%20grace', undefined, owner))).songs[0];
  await ok(await req('POST', `/v1/admin/song-catalog/${hymn.id}/add`, {}, owner));
  assert.equal(calls.length, n);
});
