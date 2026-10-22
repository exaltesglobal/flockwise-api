// Presentation: turns a service plan into projector slides (song lyrics by section, readings,
// announcements), keeps every screen on the same slide, and adds song usage stats for worship teams.
import { ApiError } from '../errors.js';
import type { Ctx, Router } from '../engine.js';
import type { Collections, LowerThird, PlanItem, PresentationState, PresentationTheme, PresentationView, Slide, Song, SongStats } from '../types.js';
import { church, DAY, find, pick, settings } from '../util.js';
import { liveView } from './ministry.js';

export const DEFAULT_THEME: PresentationTheme = { background: '#0f1f1c', textColor: '#ffffff', imageUrl: '', fontScale: 1, linesPerSlide: 4, showAlt: true, titleSlides: true, uppercase: false };
const SECTION = /^(verse|chorus|refrain|bridge|pre-?chorus|intro|outro|tag|interlude|ending|instrumental|vamp|coda)\b/i;

export const themeOf = (ctx: Ctx): PresentationTheme => ({ ...DEFAULT_THEME, ...(settings(ctx).presentation ?? {}) });

type Section = { label: string; lines: string[]; chords: string[] };

/** Strips ChordPro chords ("[G]Amazing [C]grace") and returns the plain lyric line. */
const stripChords = (line: string) => line.replace(/\[[^\]]*\]/g, '').replace(/\s{2,}/g, ' ').trim();

/**
 * Splits lyrics into labelled sections. A section starts at a heading line such as
 * "Verse 1", "[Chorus]", "Bridge:" or "{start_of_chorus}", or after a blank line.
 */
export function parseSections(text: string): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  let verse = 0;
  const flush = () => { if (cur && cur.lines.length) out.push(cur); cur = null; };
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    const directive = /^\{(\w+)(?::\s*(.*))?\}$/.exec(line);
    if (directive) {
      const name = directive[1].toLowerCase();
      if (name === 'start_of_chorus' || name === 'soc') { flush(); cur = { label: 'Chorus', lines: [], chords: [] }; }
      else if (name === 'start_of_verse' || name === 'sov') { flush(); cur = { label: directive[2] || `Verse ${++verse}`, lines: [], chords: [] }; }
      else if (['end_of_chorus', 'eoc', 'end_of_verse', 'eov'].includes(name)) flush();
      else if (name === 'comment' || name === 'c') { flush(); if (directive[2] && SECTION.test(directive[2])) cur = { label: directive[2], lines: [], chords: [] }; }
      continue;
    }
    const heading = /^\[?([A-Za-z -]+\s*\d*)\]?:?$/.exec(line);
    if (heading && SECTION.test(heading[1].trim())) {
      flush();
      cur = { label: heading[1].trim().replace(/\b\w/g, (c) => c.toUpperCase()), lines: [], chords: [] };
      if (/^verse/i.test(cur.label)) verse = Number(/\d+/.exec(cur.label)?.[0] ?? verse + 1);
      continue;
    }
    if (!line) { if (cur && cur.lines.length) { const label = cur.label; flush(); cur = { label: SECTION.test(label) ? `${label} (cont.)` : '', lines: [], chords: [] }; } continue; }
    if (!cur) cur = { label: '', lines: [], chords: [] };
    const plain = stripChords(line);
    if (!plain) continue;
    cur.lines.push(plain);
    cur.chords.push(line);
  }
  flush();
  // Unlabelled blocks after a labelled one carry on its name; the rest become verses.
  let n = 0;
  return out.map((s) => {
    if (s.label && !s.label.endsWith('(cont.)')) return s;
    if (s.label.endsWith('(cont.)')) return { ...s, label: s.label.replace(' (cont.)', '') };
    return { ...s, label: `Verse ${++n}` };
  });
}

const norm = (label: string) => label.toLowerCase().replace(/\s+/g, ' ').trim();

/** Puts sections in the arrangement order. "Chorus" matches "Chorus 1" when there's no exact match. */
function arrange(sections: Section[], order: string[] | undefined) {
  if (!order?.length) return sections;
  const out: Section[] = [];
  for (const want of order) {
    const exact = sections.filter((s) => norm(s.label) === norm(want));
    const loose = exact.length ? exact : sections.filter((s) => norm(s.label).startsWith(norm(want)));
    out.push(...loose);
  }
  return out.length ? out : sections;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out.length ? out : [[]];
}

function songSlides(song: Song, item: PlanItem, itemIndex: number, theme: PresentationTheme): Slide[] {
  const source = song.lyrics?.trim() ? song.lyrics : song.chordChart ?? '';
  const sections = arrange(parseSections(source), item.arrangement?.length ? item.arrangement : song.arrangement);
  const altSections = song.lyricsAlt?.trim() ? parseSections(song.lyricsAlt) : [];
  // Chords come from the chart when the lyrics field has none.
  const chartSections = song.chordChart?.trim() ? parseSections(song.chordChart) : [];
  const seen = new Map<string, number>();
  const slides: Slide[] = [];
  sections.forEach((sec) => {
    const alt = altSections.find((a) => norm(a.label) === norm(sec.label));
    const chart = chartSections.find((c) => norm(c.label) === norm(sec.label));
    const chordLines = chart?.chords ?? sec.chords;
    const pieces = chunk(sec.lines, theme.linesPerSlide);
    pieces.forEach((lines, p) => {
      const key = `${norm(sec.label)}#${p}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      slides.push({
        id: `${item.id}:${key}:${n}`,
        itemIndex,
        itemTitle: item.title,
        kind: 'lyrics',
        label: sec.label + (pieces.length > 1 ? ` (${p + 1}/${pieces.length})` : ''),
        lines,
        alt: alt ? alt.lines.slice(p * theme.linesPerSlide, (p + 1) * theme.linesPerSlide) : [],
        chords: chordLines.slice(p * theme.linesPerSlide, (p + 1) * theme.linesPerSlide),
      });
    });
  });
  return slides;
}

/** Every slide for the service, in order. */
export function buildDeck(ctx: Ctx, items: PlanItem[], theme = themeOf(ctx)): Slide[] {
  const slides: Slide[] = [];
  items.forEach((item, i) => {
    const song = item.songId ? ctx.db.get('songs', item.songId) : undefined;
    const lyrics = song ? songSlides(song, item, i, theme) : [];
    const textLines = (item.text ?? '').replace(/\r/g, '').split('\n');
    const hasText = textLines.some((l) => l.trim());
    if (theme.titleSlides || (!lyrics.length && !hasText))
      slides.push({ id: `${item.id}:title`, itemIndex: i, itemTitle: item.title, kind: 'title', label: item.kind === 'song' ? 'Title' : item.kind[0].toUpperCase() + item.kind.slice(1), lines: [item.title, ...(song?.author ? [song.author] : item.person && item.kind !== 'song' ? [item.person] : [])], alt: [], chords: [] });
    slides.push(...lyrics);
    if (hasText) {
      // Blank lines split paragraphs; long paragraphs split by lines-per-slide (doubled, as text is shorter than lyrics).
      const paras = textLines.join('\n').split(/\n\s*\n/).map((p) => p.split('\n').map((l) => l.trim()).filter(Boolean)).filter((p) => p.length);
      let n = 0;
      for (const para of paras)
        for (const lines of chunk(para, theme.linesPerSlide * 2))
          slides.push({ id: `${item.id}:text:${n++}`, itemIndex: i, itemTitle: item.title, kind: 'text', label: item.kind === 'reading' ? 'Reading' : 'Text', lines, alt: [], chords: [] });
    }
  });
  return slides;
}

const stateFor = (ctx: Ctx, eventId: string): PresentationState =>
  ctx.db.get('presentations', eventId) ?? { id: eventId, eventId, index: 0, mode: 'live', message: '', updatedAt: ctx.now.toISOString() };

const KEY_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** The church's screen key, created the first time an office login asks for it. */
function screenKey(ctx: Ctx, rotate = false) {
  const s = settings(ctx);
  if (s.screenKey && !rotate) return s.screenKey;
  const key = ctx.env.random(24, KEY_ALPHABET);
  ctx.db.put('settings', { ...s, screenKey: key });
  return key;
}

/** Name straps the media team will probably want: the preacher, readers and Bible references. */
function suggestLowerThirds(items: PlanItem[]): LowerThird[] {
  const out: LowerThird[] = [];
  items.forEach((it, i) => {
    const person = it.person?.trim();
    if (it.kind === 'sermon' && person) out.push({ id: `s${i}`, title: person, subtitle: it.title });
    else if (it.kind === 'reading') out.push({ id: `r${i}`, title: it.title, subtitle: person ? `Read by ${person}` : 'Scripture reading' });
    else if (person && it.kind !== 'song' && person !== 'Worship team') out.push({ id: `p${i}`, title: person, subtitle: it.title });
  });
  const seen = new Set<string>();
  return out.filter((l) => { const k = `${l.title}|${l.subtitle}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

const cleanLower = (v: unknown, id: string): LowerThird | null => {
  const o = (v ?? {}) as Record<string, unknown>;
  const title = String(o.title ?? '').trim().slice(0, 80);
  return title ? { id: String(o.id ?? id).slice(0, 40), title, subtitle: String(o.subtitle ?? '').trim().slice(0, 120) } : null;
};

function view(ctx: Ctx, ev: Collections['events'], staff = true): PresentationView {
  const live = liveView(ctx, ev);
  const theme = themeOf(ctx);
  const slides = buildDeck(ctx, live.plan.items, theme);
  const state = stateFor(ctx, ev.id);
  const c = church(ctx);
  const runningItem = live.live.startedAt && !live.live.endedAt ? live.plan.items[live.live.itemIndex] : undefined;
  return {
    event: { id: ev.id, title: ev.title, startsAt: ev.startsAt, endsAt: ev.endsAt },
    churchName: c.name,
    logoUrl: c.logoUrl ?? null,
    slides,
    state: { ...state, index: Math.min(state.index, Math.max(0, slides.length - 1)) },
    theme,
    timer: { itemTitle: runningItem?.title ?? null, itemEndsAt: live.itemEndsAt, serviceEndsAt: live.serviceEndsAt },
    announcements: ctx.db.all('announcements').filter((a) => a.status === 'published').sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 6).map((a) => ({ title: a.title, body: a.body.slice(0, 240) })),
    suggestedLowerThirds: suggestLowerThirds(live.plan.items),
    ...(staff ? { screenKey: screenKey(ctx) } : {}),
  };
}

function songStats(ctx: Ctx): SongStats {
  const since = ctx.now.getTime() - 365 * DAY;
  const events = new Map(ctx.db.all('events').map((e) => [e.id, e]));
  const uses = new Map<string, { count: number; last: string | null }>();
  const leaders = new Map<string, { songs: number; ids: Map<string, number> }>();
  const keys = new Map<string, number>();
  for (const plan of ctx.db.all('plans')) {
    const ev = events.get(plan.eventId);
    if (!ev || new Date(ev.startsAt).getTime() < since || new Date(ev.startsAt).getTime() > ctx.now.getTime()) continue;
    for (const it of plan.items) {
      if (it.kind !== 'song' || !it.songId) continue;
      const u = uses.get(it.songId) ?? { count: 0, last: null };
      u.count++;
      if (!u.last || ev.startsAt > u.last) u.last = ev.startsAt;
      uses.set(it.songId, u);
      if (it.key) keys.set(it.key, (keys.get(it.key) ?? 0) + 1);
      if (it.person) {
        const l = leaders.get(it.person) ?? { songs: 0, ids: new Map() };
        l.songs++;
        l.ids.set(it.songId, (l.ids.get(it.songId) ?? 0) + 1);
        leaders.set(it.person, l);
      }
    }
  }
  const songs = ctx.db.all('songs');
  const title = (id: string) => songs.find((s) => s.id === id)?.title ?? 'Unknown song';
  return {
    top: [...uses.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 15).map(([songId, u]) => ({ songId, title: title(songId), uses: u.count, lastUsedAt: u.last })),
    // Songs not sung in 3 months (or ever): good candidates to bring back, or to retire.
    resting: songs
      .filter((s) => { const u = uses.get(s.id); return !u || !u.last || new Date(u.last).getTime() < ctx.now.getTime() - 90 * DAY; })
      .map((s) => ({ songId: s.id, title: s.title, lastUsedAt: uses.get(s.id)?.last ?? null }))
      .sort((a, b) => (a.lastUsedAt ?? '').localeCompare(b.lastUsedAt ?? '')),
    byLeader: [...leaders.entries()].map(([person, l]) => {
      const fav = [...l.ids.entries()].sort((a, b) => b[1] - a[1])[0];
      return { person, songs: l.songs, distinct: l.ids.size, favourite: fav ? title(fav[0]) : null };
    }).sort((a, b) => b.songs - a.songs),
    keys: [...keys.entries()].map(([key, n]) => ({ key, uses: n })).sort((a, b) => b.uses - a.uses),
  };
}

export function registerPresent(r: Router) {
  r.get('/admin/services/:eventId/presentation', { staff: true }, (ctx) => view(ctx, find(ctx, 'events', ctx.params[0], 'Event')));

  r.post('/admin/services/:eventId/presentation', { perm: ['services', 'checkin'] }, (ctx) => {
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    const v = view(ctx, ev);
    const s = { ...v.state };
    const last = Math.max(0, v.slides.length - 1);
    switch (ctx.body.action) {
      case 'next': s.index = Math.min(last, s.index + 1); s.mode = 'live'; break;
      case 'prev': s.index = Math.max(0, s.index - 1); s.mode = 'live'; break;
      case 'goto': s.index = Math.max(0, Math.min(last, Math.round(Number(ctx.body.index) || 0))); s.mode = 'live'; break;
      case 'item': {
        const i = v.slides.findIndex((sl) => sl.itemIndex === Number(ctx.body.index));
        if (i >= 0) { s.index = i; s.mode = 'live'; }
        break;
      }
      case 'blank': case 'logo': case 'live': s.mode = ctx.body.action; break;
      case 'countdown': {
        const until = ctx.body.until ? new Date(String(ctx.body.until)) : new Date(ev.startsAt);
        s.countdownTo = Number.isNaN(until.getTime()) ? ev.startsAt : until.toISOString();
        s.mode = 'countdown';
        break;
      }
      case 'lower': s.lowerThird = cleanLower(ctx.body.lowerThird, ctx.id('lt')); break;
      case 'lowerClear': s.lowerThird = null; break;
      case 'queue': s.lowerThirds = (Array.isArray(ctx.body.lowerThirds) ? ctx.body.lowerThirds : []).slice(0, 40).map((l: unknown, i: number) => cleanLower(l, `q${i}`)).filter((l: LowerThird | null): l is LowerThird => !!l); break;
      case 'overlay': s.overlayLyrics = !!ctx.body.on; break;
      case 'message': s.message = String(ctx.body.message ?? '').slice(0, 200); break;
      default: throw new ApiError(422, 'invalid', 'Unknown action.');
    }
    ctx.db.put('presentations', { ...s, updatedAt: ctx.now.toISOString() });
    return view(ctx, ev);
  });

  // Projector, stage display and OBS overlay without signing in: the link carries the church's screen key.
  r.get('/screens/:eventId', { public: true }, (ctx) => {
    const key = settings(ctx).screenKey;
    if (!key || String(ctx.query.key ?? '') !== key) throw new ApiError(404, 'not_found', 'This screen link is not valid. Copy a fresh link from the Present page.');
    return view(ctx, find(ctx, 'events', ctx.params[0], 'Event'), false);
  });
  r.post('/admin/presentation-key/reset', { perm: ['services', 'settings'] }, (ctx) => {
    ctx.audit('updated', 'settings', 'church', 'Reset the screen link key');
    return { screenKey: screenKey(ctx, true) };
  });

  r.get('/admin/presentation-theme', { staff: true }, (ctx) => themeOf(ctx));
  r.put('/admin/presentation-theme', { perm: ['services', 'settings'] }, (ctx) => {
    const patch = pick<PresentationTheme>(ctx.body, ['background', 'textColor', 'imageUrl', 'fontScale', 'linesPerSlide', 'showAlt', 'titleSlides', 'uppercase']);
    if (patch.linesPerSlide !== undefined) patch.linesPerSlide = Math.max(1, Math.min(8, Math.round(Number(patch.linesPerSlide)) || 4));
    if (patch.fontScale !== undefined) patch.fontScale = Math.max(0.5, Math.min(2, Number(patch.fontScale) || 1));
    for (const k of ['background', 'textColor'] as const) if (patch[k] !== undefined && !/^#[0-9a-f]{3,8}$/i.test(String(patch[k]))) delete patch[k];
    const next = { ...themeOf(ctx), ...patch };
    ctx.db.put('settings', { ...settings(ctx), presentation: next });
    return next;
  });

  r.get('/admin/songs/stats', { perm: 'services' }, (ctx) => songStats(ctx));
}
