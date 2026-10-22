// The Flockwise team's side of the shared song database (/platform/songs): add hymns the built-in
// set lacks, such as Indian-language hymns from a checked hymnbook, and correct built-in ones.
// Entries live in the platform database and reach every church through env.songCatalog.
// Only public-domain words may be published here.
import type { Db } from '../db.js';
import type { Env } from '../engine.js';
import { ApiError } from '../errors.js';
import { catalogSongs, searchable } from '../modules/song-catalog.js';
import type { CatalogSong, SongLanguage } from '../types.js';
import { SONG_LANGUAGES } from '../types.js';

const PREFIX = 'song:';
const LANGS = new Set(SONG_LANGUAGES.map((l) => l.id));

export const storedSongs = (db: Db): CatalogSong[] =>
  db
    .all('meta')
    .filter((m) => m.id.startsWith(PREFIX))
    .map((m) => JSON.parse(m.value) as CatalogSong);

const text = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);
const list = (v: unknown, n: number) => (Array.isArray(v) ? v.map((x) => text(x, 60)).filter(Boolean).slice(0, n) : []);

/** Checks a song from the team panel; throws a 422 naming the first problem. */
export function cleanEntry(id: string, b: Record<string, unknown>): CatalogSong {
  const fields: Record<string, string> = {};
  const title = text(b.title, 160);
  const language = text(b.language, 4) as SongLanguage;
  const lyrics = String(b.lyrics ?? '').replace(/\r\n/g, '\n').trim().slice(0, 20_000);
  const source = text(b.source, 300);
  if (!title) fields.title = 'Enter the title';
  if (!LANGS.has(language)) fields.language = 'Choose a language';
  if (!text(b.writers, 300)) fields.writers = 'Enter who wrote the words, or Traditional';
  if (b.rights !== 'public-domain') fields.rights = 'Only public-domain songs can go in the song database';
  if (lyrics && !source) fields.source = 'Say where the words come from (hymnbook and edition, or a website)';
  if (Object.keys(fields).length) throw new ApiError(422, 'invalid', Object.values(fields)[0], fields);
  const year = Number(b.year);
  return {
    id,
    title,
    aka: list(b.aka, 10),
    language,
    writers: text(b.writers, 300),
    ...(text(b.music, 300) ? { music: text(b.music, 300) } : {}),
    ...(year >= 100 && year <= 2100 ? { year: Math.round(year) } : {}),
    rights: 'public-domain',
    copyright: 'Public domain',
    defaultKey: text(b.defaultKey, 4),
    bpm: Number(b.bpm) > 0 ? Math.round(Number(b.bpm)) : null,
    ...(text(b.tune, 80) ? { tune: text(b.tune, 80).toUpperCase() } : {}),
    themes: list(b.themes, 12),
    ...(lyrics ? { lyrics } : {}),
    ...(String(b.chordChart ?? '').trim() ? { chordChart: String(b.chordChart).replace(/\r\n/g, '\n').trim().slice(0, 30_000) } : {}),
    arrangement: list(b.arrangement, 40),
    ...(source ? { source } : {}),
  };
}

const slug = (s: string) =>
  searchable(s)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

export async function songTeamRoute(db: Db, env: Env, method: string, parts: string[], body: Record<string, unknown>, query: Record<string, string | undefined>, log: (action: string, summary: string) => void): Promise<unknown> {
  const all = () => catalogSongs({ ...env, songCatalog: { stored: () => storedSongs(db) } });
  const stored = new Set(storedSongs(db).map((s) => s.id));
  const id = parts[1];

  if (method === 'GET' && !id) {
    const q = searchable(String(query.q ?? ''));
    const lang = String(query.lang ?? '');
    const songs = (await all()).filter((s) => (!lang || s.language === lang) && (!q || searchable(`${s.title} ${(s.aka ?? []).join(' ')} ${s.writers}`).includes(q)));
    return {
      total: songs.length,
      songs: songs
        .sort((a, b) => a.title.localeCompare(b.title))
        .slice(0, 200)
        .map(({ lyrics, chordChart, ...s }) => ({ ...s, hasLyrics: !!lyrics, hasChords: !!chordChart, edited: stored.has(s.id) })),
    };
  }
  if (method === 'GET' && id) {
    const s = (await all()).find((x) => x.id === id);
    if (!s) throw new ApiError(404, 'not_found', 'That song is not in the song database.');
    return { ...s, edited: stored.has(s.id) };
  }
  if (method === 'POST' && !id) {
    const base = `fw-${slug(String(body.title ?? '')) || 'song'}`;
    const taken = new Set((await all()).map((s) => s.id));
    let newId = base;
    for (let n = 2; taken.has(newId); n++) newId = `${base}-${n}`;
    const s = cleanEntry(newId, body);
    db.put('meta', { id: PREFIX + s.id, value: JSON.stringify(s) });
    log('song_added', `Added ${s.title} (${s.language}) to the song database`);
    return s;
  }
  if (method === 'PUT' && id) {
    if (!(await all()).some((x) => x.id === id)) throw new ApiError(404, 'not_found', 'That song is not in the song database.');
    const s = cleanEntry(id, body);
    db.put('meta', { id: PREFIX + id, value: JSON.stringify(s) });
    log('song_updated', `Updated ${s.title} in the song database`);
    return s;
  }
  if (method === 'DELETE' && id) {
    if (!stored.has(id)) throw new ApiError(404, 'not_found', 'Only songs the team added or changed can be removed.');
    db.del('meta', PREFIX + id);
    log('song_removed', `Removed the team's version of ${id} from the song database`);
    return undefined;
  }
  throw new ApiError(404, 'not_found', 'Not found.');
}
