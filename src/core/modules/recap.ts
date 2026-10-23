// "Sunday in 60 seconds": after the service the office presses one button and the week's facts
// (check-ins, the plan, the sermon, first-timers, prayers, the week ahead) become a headline, a
// WhatsApp status caption and five short slides. The web draws the card and the reel from them in
// the church's colours. Members get it in the app once it is published; anyone with the link can
// watch the share page. Money only appears when the office ticks "include giving".
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { Collections, LanguageCode, MemberRecap, Recap, RecapFacts, RecapSlide, RecapStats, RecapSunday } from '../types.js';
import { checkinsFor, DAY, find, localDate, settings } from '../util.js';
import { writeRecap } from './ai.js';
import { upcomingCelebrations } from './celebrations.js';
import { notify } from './notify.js';

const LANG_CODES: LanguageCode[] = ['en', 'hi', 'ta', 'te', 'ml', 'kn'];

/** Past Sunday services, latest first. */
export const pastServices = (ctx: Ctx) => ctx.db.all('events').filter((e) => e.kind === 'service' && Date.parse(e.endsAt) <= ctx.now.getTime()).sort((a, b) => b.startsAt.localeCompare(a.startsAt));

/** Everything the recap is written from, read from the records around one service. */
export function recapFacts(ctx: Ctx, ev: Collections['events'], includeGiving = false): RecapFacts {
  const start = Date.parse(ev.startsAt), end = Date.parse(ev.endsAt);
  const date = localDate(ctx, new Date(ev.startsAt));
  const checkins = checkinsFor(ctx, ev.id);
  const heads = ctx.db.all('headcounts').filter((h) => h.eventId === ev.id).reduce((s, h) => s + h.count, 0);
  const attendance = Math.max(ev.attendance ?? 0, checkins.length, heads) || null;
  const children = checkins.length ? checkins.filter((c) => c.isChild).length : null;

  // First Sunday: checked in here and never before, and on the books less than a fortnight; or added to people that day.
  const earlier = new Set(ctx.db.all('checkins').filter((c) => c.eventId !== ev.id && Date.parse(c.at) < start).map((c) => c.personId));
  const here = new Set(checkins.map((c) => c.personId));
  const firstTimers = ctx.db.all('people')
    .filter((p) => p.status !== 'inactive' && ((here.has(p.id) && !earlier.has(p.id) && Date.parse(p.joinedAt) > start - 14 * DAY) || localDate(ctx, new Date(p.joinedAt)) === date))
    .map((p) => p.firstName).filter(Boolean).slice(0, 8);

  const plan = ctx.db.all('plans').find((p) => p.eventId === ev.id);
  const sermonRec = ctx.db.all('sermons').find((s) => s.eventId === ev.id) ?? ctx.db.all('sermons').find((s) => s.date === date);
  const sermonItem = plan?.items.find((i) => i.kind === 'sermon');
  const reading = plan?.items.find((i) => i.kind === 'reading');
  const sermon = sermonRec
    ? { title: sermonRec.title, speaker: sermonRec.speaker, scripture: sermonRec.scripture, oneLiner: sermonRec.description }
    : sermonItem ? { title: sermonItem.title, speaker: sermonItem.person, scripture: reading?.title ?? '', oneLiner: '' } : null;
  const songs = (plan?.items ?? []).filter((i) => i.kind === 'song').map((i) => i.title).filter(Boolean);

  const celebrations = upcomingCelebrations(ctx, 6).slice(0, 8).map((c) => ({ kind: c.kind, name: c.name }));
  const weekPrayers = ctx.db.all('prayer').filter((p) => { const t = Date.parse(p.createdAt); return t >= start - 7 * DAY && t <= Math.max(end, ctx.now.getTime()); });
  const prayers = { requests: weekPrayers.length, prayed: weekPrayers.reduce((s, p) => s + p.prayedBy.length, 0) };

  const giving = includeGiving
    ? ctx.db.all('donations').filter((d) => d.status === 'succeeded' && (() => { const t = Date.parse(d.paidAt ?? d.createdAt); return t >= start - 6 * DAY && t < start + DAY; })()).reduce((s, d) => s + d.amount, 0)
    : null;
  const nextEvents = ctx.db.all('events').filter((e) => e.published && e.kind !== 'service' && e.id !== ev.id && Date.parse(e.startsAt) > end && Date.parse(e.startsAt) < end + 8 * DAY)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt)).slice(0, 3).map((e) => ({ title: e.title, startsAt: e.startsAt, location: e.location }));

  return { eventId: ev.id, eventTitle: ev.title, date, attendance, children, firstTimers, sermon, songs, celebrations, prayers, giving, nextEvents };
}

const statsOf = (f: RecapFacts): RecapStats => ({ attendance: f.attendance, children: f.children, firstTimers: f.firstTimers.length, prayed: f.prayers.prayed, songs: f.songs.length });

function cleanSlides(raw: unknown): RecapSlide[] {
  if (!Array.isArray(raw)) throw new ApiError(400, 'bad_request', 'Slides must be a list.');
  const out = raw.map((x) => ({ title: String(x?.title ?? '').trim().slice(0, 60), text: String(x?.text ?? '').trim().slice(0, 300), stat: x?.stat ? String(x.stat).trim().slice(0, 40) : null })).filter((x) => x.title || x.text);
  if (!out.length || out.length > 8) throw new ApiError(400, 'bad_request', 'A recap has between one and eight slides.');
  return out;
}

export function memberRecap(ctx: Ctx, r: Recap): MemberRecap {
  const s = settings(ctx);
  return { id: r.id, eventTitle: r.eventTitle, date: r.date, language: r.language, headline: r.headline, caption: r.caption, slides: r.slides, stats: r.stats, publishedAt: r.publishedAt, church: { name: s.name, logoUrl: s.logoUrl ?? null, brand: s.brand ?? null } };
}

const published = (ctx: Ctx, id: string) => {
  const r = ctx.db.get('recaps', id);
  if (!r || r.status !== 'published') throw new ApiError(404, 'not_found', 'This recap is not available.');
  return r;
};

export function registerRecaps(r: Router) {
  r.get('/admin/recaps', { perm: 'comms' }, (ctx): Recap[] => ctx.db.all('recaps').sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)));

  r.get('/admin/recaps/sundays', { perm: 'comms' }, (ctx): RecapSunday[] => {
    const recaps = ctx.db.all('recaps').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return pastServices(ctx).slice(0, 8).map((e) => ({ eventId: e.id, title: e.title, date: localDate(ctx, new Date(e.startsAt)), startsAt: e.startsAt, attendance: Math.max(e.attendance ?? 0, checkinsFor(ctx, e.id).length) || null, recapId: recaps.find((x) => x.eventId === e.id)?.id ?? null }));
  });

  // A look at the facts before spending the AI request.
  r.get('/admin/recaps/facts', { perm: 'comms' }, (ctx): RecapFacts => {
    const ev = ctx.query.eventId ? find(ctx, 'events', String(ctx.query.eventId), 'Service') : pastServices(ctx)[0];
    if (!ev) throw new ApiError(404, 'not_found', 'No past Sunday service to recap yet.');
    return recapFacts(ctx, ev, ctx.query.includeGiving === '1');
  });

  r.post('/admin/recaps', { perm: 'comms' }, async (ctx): Promise<Recap> => {
    const ev = ctx.body.eventId ? find(ctx, 'events', String(ctx.body.eventId), 'Service') : pastServices(ctx)[0];
    if (!ev) throw new ApiError(404, 'not_found', 'No past Sunday service to recap yet.');
    if (Date.parse(ev.endsAt) > ctx.now.getTime()) throw new ApiError(409, 'not_yet', 'The service has not finished yet.');
    const language: LanguageCode = LANG_CODES.includes(ctx.body.language) ? ctx.body.language : settings(ctx).languages?.[0] ?? 'en';
    const facts = recapFacts(ctx, ev, ctx.body.includeGiving === true);
    const ai = await writeRecap(ctx, facts, language);
    const rec: Recap = {
      id: ctx.id('rc'), eventId: ev.id, eventTitle: ev.title, date: facts.date, language, headline: ai.headline, caption: ai.caption, slides: ai.slides,
      stats: statsOf(facts), facts, status: 'draft', createdAt: ctx.now.toISOString(), createdBy: ctx.staff?.name ?? '', publishedAt: null, notified: 0,
    };
    ctx.db.put('recaps', rec);
    ctx.audit('recap.create', 'recap', rec.id, `Wrote the Sunday recap for ${facts.date}`);
    return rec;
  });

  r.get('/admin/recaps/:id', { perm: 'comms' }, (ctx) => find(ctx, 'recaps', ctx.params[0], 'Recap'));

  r.patch('/admin/recaps/:id', { perm: 'comms' }, (ctx): Recap => {
    const rec = find(ctx, 'recaps', ctx.params[0], 'Recap');
    const next: Recap = {
      ...rec,
      headline: ctx.body.headline !== undefined ? String(ctx.body.headline).trim().slice(0, 120) : rec.headline,
      caption: ctx.body.caption !== undefined ? String(ctx.body.caption).trim().slice(0, 600) : rec.caption,
      slides: ctx.body.slides !== undefined ? cleanSlides(ctx.body.slides) : rec.slides,
    };
    if (!next.headline) throw new ApiError(400, 'bad_request', 'Give the recap a headline.');
    ctx.db.put('recaps', next);
    return next;
  });

  r.post('/admin/recaps/:id/publish', { perm: 'comms' }, async (ctx): Promise<Recap> => {
    const rec = find(ctx, 'recaps', ctx.params[0], 'Recap');
    if (rec.status === 'published') return rec;
    const people = ctx.db.all('people').filter((p) => p.status === 'member' || p.status === 'regular');
    const next: Recap = { ...rec, status: 'published', publishedAt: ctx.now.toISOString(), notified: people.length };
    ctx.db.put('recaps', next);
    ctx.audit('recap.publish', 'recap', rec.id, `Published the Sunday recap for ${rec.date}`);
    await notify(ctx, 'recap.ready', { personIds: people.map((p) => p.id), title: rec.headline, body: `Sunday in 60 seconds: ${rec.slides[0]?.text ?? rec.caption.split('\n')[0]}`, link: `/app/recap/${rec.id}` });
    return next;
  });

  r.del('/admin/recaps/:id', { perm: 'comms' }, (ctx) => {
    find(ctx, 'recaps', ctx.params[0], 'Recap');
    ctx.db.del('recaps', ctx.params[0]);
    return { ok: true };
  });

  r.get('/me/recaps', {}, (ctx): MemberRecap[] => ctx.db.all('recaps').filter((x) => x.status === 'published').sort((a, b) => b.date.localeCompare(a.date) || (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '')).slice(0, 6).map((x) => memberRecap(ctx, x)));
  r.get('/me/recaps/:id', {}, (ctx): MemberRecap => memberRecap(ctx, published(ctx, ctx.params[0])));
  r.get('/public/recaps/:id', { public: true }, (ctx): MemberRecap => memberRecap(ctx, published(ctx, ctx.params[0])));
}
