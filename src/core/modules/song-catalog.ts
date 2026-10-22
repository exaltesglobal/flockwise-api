// The shared song database: hymns every church can search and add to its own song library in
// one click. Ships with the public-domain hymns of the Open Hymnal Project; the Flockwise team
// adds more (Indian-language hymns from checked hymnbooks) in /platform/songs. Licensed lyrics
// services (lyrics feeds) plug in for songs whose words Flockwise may not ship itself.
import type { Ctx, LyricsFeed, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { CatalogList, CatalogSong, CatalogSongDetail, CatalogSongRow, LicensedLyrics, Song, SongLicenceConfig, SongLicenceStatus } from '../types.js';
import { SONG_LANGUAGES } from '../types.js';
import { churchId } from '../util.js';

/** Lower case, no accents or punctuation, for matching "Abide with me" to "abide, with me". */
export const searchable = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Every song in the database: the built-in hymns, then the team's additions and corrections. */
export async function catalogSongs(env: Ctx['env']): Promise<CatalogSong[]> {
  const { OPEN_HYMNAL } = await import('../catalog/open-hymnal.js');
  const byId = new Map(OPEN_HYMNAL.map((s) => [s.id, s]));
  for (const s of env.songCatalog?.stored() ?? []) byId.set(s.id, s);
  // Words are only ever shipped for public-domain songs.
  return [...byId.values()].map((s) => (s.rights === 'public-domain' ? s : { ...s, lyrics: undefined, chordChart: undefined }));
}

const licence = (ctx: Ctx) => (ctx.db.get('integrations', 'songLicence') as SongLicenceConfig | undefined) ?? null;
const feeds = (ctx: Ctx) => ctx.env.lyricsFeeds ?? [];
const feedsFor = (ctx: Ctx, s: CatalogSong) => (s.lyrics ? [] : feeds(ctx).filter((f) => f.covers === 'all' || !!s.ccli));
/** Licensed words are only fetched for churches that hold a CCLI licence. */
const licensedAvailable = (ctx: Ctx, s: CatalogSong) => !!licence(ctx)?.ccliLicence && feedsFor(ctx, s).length > 0;

function libraryIndex(ctx: Ctx) {
  const map = new Map<string, string>();
  for (const s of ctx.db.all('songs')) if (s.catalogId) map.set(s.catalogId, s.id);
  return map;
}

/** Asks each licensed lyrics feed for a song's words, in order, until one has them. */
async function fetchLicensed(ctx: Ctx, s: CatalogSong): Promise<LicensedLyrics | null> {
  const lic = licence(ctx);
  if (!lic?.ccliLicence || !ctx.env.http) return null;
  for (const f of feedsFor(ctx, s)) {
    const got = await askFeed(ctx, f, s, lic).catch(() => null);
    if (got) return got;
  }
  return null;
}

async function askFeed(ctx: Ctx, f: LyricsFeed, s: CatalogSong, lic: SongLicenceConfig): Promise<LicensedLyrics | null> {
  const r = await ctx.env.http!({
    method: 'POST',
    url: f.url,
    headers: { Authorization: `Bearer ${f.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ catalogId: s.id, title: s.title, writers: s.writers, ccli: s.ccli ?? null, language: s.language, church: churchId(ctx), licence: { ccli: lic.ccliLicence, streaming: lic.streamingLicence || null } }),
    timeoutMs: 10_000,
  });
  if (r.status !== 200) return null;
  const data = JSON.parse(r.text || 'null') as { lyrics?: unknown; chordChart?: unknown; copyright?: unknown; defaultKey?: unknown } | null;
  if (!data || typeof data.lyrics !== 'string' || !data.lyrics.trim()) return null;
  return {
    lyrics: data.lyrics.slice(0, 20_000),
    chordChart: typeof data.chordChart === 'string' ? data.chordChart.slice(0, 30_000) : undefined,
    copyright: typeof data.copyright === 'string' ? data.copyright.slice(0, 300) : undefined,
    defaultKey: typeof data.defaultKey === 'string' ? data.defaultKey.slice(0, 4) : undefined,
    feedId: f.id,
    feedName: f.name,
  };
}

const row = (ctx: Ctx, s: CatalogSong, lib: Map<string, string>): CatalogSongRow => {
  const { lyrics, chordChart, ...rest } = s;
  return { ...rest, hasLyrics: !!lyrics?.trim(), hasChords: !!chordChart?.trim(), inLibrary: lib.get(s.id) ?? null, licensedAvailable: licensedAvailable(ctx, s) };
};

export function registerSongCatalog(r: Router) {
  r.get('/admin/song-catalog', { perm: ['services', 'volunteers'] }, async (ctx): Promise<CatalogList> => {
    const all = await catalogSongs(ctx.env);
    const lang = String(ctx.query.lang ?? '');
    const theme = String(ctx.query.theme ?? '');
    const q = searchable(String(ctx.query.q ?? ''));
    const limit = Math.min(Math.max(Number(ctx.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(ctx.query.offset) || 0, 0);
    // Title and credit matches first, then songs that only match a line of the words.
    const scored = all
      .filter((s) => (!lang || s.language === lang) && (!theme || s.themes.includes(theme)))
      .map((s) => {
        if (!q) return { s, score: 1 };
        const head = searchable([s.title, ...(s.aka ?? []), s.tune ?? ''].join(' '));
        if (head.startsWith(q)) return { s, score: 4 };
        if (head.includes(q)) return { s, score: 3 };
        if (searchable(`${s.writers} ${s.music ?? ''} ${s.themes.join(' ')}`).includes(q)) return { s, score: 2 };
        return { s, score: s.lyrics && searchable(s.lyrics).includes(q) ? 1 : 0 };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.s.title.localeCompare(b.s.title));
    const lib = libraryIndex(ctx);
    const counts = new Map<string, number>();
    for (const s of all) counts.set(s.language, (counts.get(s.language) ?? 0) + 1);
    return {
      songs: scored.slice(offset, offset + limit).map((x) => row(ctx, x.s, lib)),
      total: scored.length,
      languages: SONG_LANGUAGES.map((l) => ({ ...l, songs: counts.get(l.id) ?? 0 })),
    };
  });

  r.get('/admin/song-catalog/licence', { perm: ['services', 'settings'] }, (ctx): SongLicenceStatus => ({
    licence: licence(ctx),
    feeds: feeds(ctx).map((f) => ({ id: f.id, name: f.name, covers: f.covers })),
  }));
  r.put('/admin/song-catalog/licence', { perm: 'settings' }, (ctx): SongLicenceStatus => {
    const clean = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);
    const next: SongLicenceConfig = { id: 'songLicence', ccliLicence: clean(ctx.body.ccliLicence, 20), streamingLicence: clean(ctx.body.streamingLicence, 20), otherLicences: clean(ctx.body.otherLicences, 300), updatedAt: ctx.now.toISOString() };
    if (next.ccliLicence && !/^[0-9]{3,12}$/.test(next.ccliLicence)) throw new ApiError(422, 'invalid', 'A CCLI licence number is digits only.', { ccliLicence: 'Digits only' });
    if (next.streamingLicence && !/^[0-9]{3,12}$/.test(next.streamingLicence)) throw new ApiError(422, 'invalid', 'A CCLI streaming licence number is digits only.', { streamingLicence: 'Digits only' });
    if (!next.ccliLicence && !next.streamingLicence && !next.otherLicences) ctx.db.del('integrations', 'songLicence');
    else ctx.db.put('integrations', next);
    ctx.audit('updated', 'settings', 'songLicence', 'Updated the church’s song licences');
    return { licence: licence(ctx), feeds: feeds(ctx).map((f) => ({ id: f.id, name: f.name, covers: f.covers })) };
  });

  r.get('/admin/song-catalog/:id', { perm: ['services', 'volunteers'] }, async (ctx): Promise<CatalogSongDetail> => {
    const s = (await catalogSongs(ctx.env)).find((x) => x.id === ctx.params[0]);
    if (!s) throw new ApiError(404, 'not_found', 'That song is not in the song database.');
    return { ...s, inLibrary: libraryIndex(ctx).get(s.id) ?? null, licensedAvailable: licensedAvailable(ctx, s) };
  });

  /** Copies a song into the church's library. Adding it twice returns the copy already there. */
  r.post('/admin/song-catalog/:id/add', { perm: 'services' }, async (ctx): Promise<{ song: Song; created: boolean; licensed: boolean }> => {
    const s = (await catalogSongs(ctx.env)).find((x) => x.id === ctx.params[0]);
    if (!s) throw new ApiError(404, 'not_found', 'That song is not in the song database.');
    const have = ctx.db.all('songs').find((x) => x.catalogId === s.id);
    if (have) return { song: have, created: false, licensed: !!have.licensedFrom };
    const words = s.lyrics ? null : await fetchLicensed(ctx, s);
    const song = ctx.db.put('songs', {
      id: ctx.id('sg'),
      title: s.title,
      author: s.music ? `${s.writers}; music ${s.music}` : s.writers,
      defaultKey: words?.defaultKey || s.defaultKey,
      bpm: s.bpm,
      ccli: s.ccli ?? '',
      tags: s.themes,
      lyrics: s.lyrics ?? words?.lyrics ?? '',
      chordChart: s.chordChart ?? words?.chordChart ?? '',
      lyricsAlt: '',
      arrangement: s.arrangement ?? [],
      attachments: [],
      catalogId: s.id,
      copyright: words?.copyright || s.copyright,
      ...(words ? { licensedFrom: words.feedName } : {}),
    });
    ctx.audit('created', 'song', song.id, `Added ${s.title} from the song database`);
    return { song, created: true, licensed: !!words };
  });
}
