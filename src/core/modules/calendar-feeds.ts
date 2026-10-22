// Calendar subscribe links: the church calendar, each team's rota and rehearsals, and a member's
// own Sundays, as iCalendar feeds that Google Calendar, Apple Calendar and Outlook refresh on
// their own. Each feed has an unguessable token; resetting it stops anyone who had the old link.
import type { Ctx, RawResult, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { CalendarFeed, CalendarFeedKind, CalendarFeedLink, Collections } from '../types.js';
import { DAY, find, fullName, settings } from '../util.js';

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const WINDOW_BACK = 30 * DAY;
const WINDOW_AHEAD = 400 * DAY;

type Ev = Collections['events'];
type Entry = { uid: string; start: string; end: string; title: string; description: string; location: string; url: string | null };

const feedsOf = (ctx: Ctx) => ctx.db.all('calendarFeeds');

/** The feed row for a scope, made on first use. */
function feedFor(ctx: Ctx, kind: CalendarFeedKind, refId: string): CalendarFeed {
  const cur = feedsOf(ctx).find((f) => f.kind === kind && f.refId === refId);
  if (cur) return cur;
  return ctx.db.put('calendarFeeds', { id: ctx.id('cf'), kind, refId, token: ctx.env.random(28, ALPHABET), createdAt: ctx.now.toISOString() });
}

/** Links for one feed: https for copying, webcal for Apple and Outlook, and Google's add page. */
export function feedLink(ctx: Ctx, f: CalendarFeed, name: string): CalendarFeedLink {
  const base = ctx.env.apiUrl ?? '';
  const slug = /\/c\/([^/?#]+)/.exec(ctx.env.webUrl)?.[1];
  const url = `${base}/public/calendar/${f.token}.ics${slug ? `?church=${encodeURIComponent(slug)}` : ''}`;
  const webcal = url.replace(/^https?:\/\//, 'webcal://');
  return { id: f.id, kind: f.kind, name, url, webcal, google: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}` };
}

// ----- building the .ics -----

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = (iso: string) => iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
/** iCalendar lines are at most 75 octets; longer ones continue on the next line after a space. */
function fold(line: string) {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ' '; bytes = 1; }
    cur += ch;
    bytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}

export function toIcs(name: string, entries: Entry[], now: Date, tz: string) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Flockwise//Church calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`, `X-WR-TIMEZONE:${tz}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
  ];
  for (const e of entries) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${stamp(now.toISOString())}`, `DTSTART:${stamp(e.start)}`, `DTEND:${stamp(e.end)}`, `SUMMARY:${esc(e.title)}`);
    if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
    if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
    if (e.url) lines.push(`URL:${e.url}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

function windowEvents(ctx: Ctx): Ev[] {
  const from = new Date(ctx.now.getTime() - WINDOW_BACK).toISOString();
  const to = new Date(ctx.now.getTime() + WINDOW_AHEAD).toISOString();
  return ctx.db.all('events').filter((e) => e.published && e.startsAt >= from && e.startsAt <= to).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}
const eventEntry = (ctx: Ctx, e: Ev, extra = ''): Entry => ({
  uid: `${e.id}@flockwise`, start: e.startsAt, end: e.endsAt > e.startsAt ? e.endsAt : new Date(Date.parse(e.startsAt) + 90 * 60_000).toISOString(),
  title: e.title, description: [extra, e.description].filter(Boolean).join('\n\n'), location: e.location, url: e.meetingUrl ?? (ctx.env.webUrl ? `${ctx.env.webUrl}/app/events/${e.id}` : null),
});
function rehearsalEntry(ctx: Ctx, e: Ev): Entry | null {
  const plan = ctx.db.get('plans', e.id) ?? ctx.db.all('plans').find((p) => p.eventId === e.id);
  if (!plan?.rehearsalAt) return null;
  return { uid: `${e.id}-rehearsal@flockwise`, start: plan.rehearsalAt, end: new Date(Date.parse(plan.rehearsalAt) + 90 * 60_000).toISOString(), title: `Rehearsal: ${e.title}`, description: plan.rehearsalNotes ?? '', location: e.location, url: null };
}

/** What each kind of feed contains. */
export function feedEntries(ctx: Ctx, f: CalendarFeed): { name: string; entries: Entry[] } {
  const church = settings(ctx).name;
  const events = windowEvents(ctx);
  if (f.kind === 'church') return { name: church, entries: events.map((e) => eventEntry(ctx, e)) };
  if (f.kind === 'team') {
    const team = ctx.db.get('teams', f.refId);
    if (!team) return { name: church, entries: [] };
    const byEvent = new Map<string, string[]>();
    for (const a of ctx.db.all('assignments').filter((a) => a.teamId === team.id && a.status !== 'declined')) {
      const who = ctx.db.get('people', a.personId);
      const pos = team.positions.find((p) => p.id === a.positionId)?.name ?? '';
      byEvent.set(a.eventId, [...(byEvent.get(a.eventId) ?? []), `${pos ? `${pos}: ` : ''}${who ? fullName(who) : 'Someone'}${a.status === 'pending' ? ' (not yet confirmed)' : ''}`]);
    }
    const entries: Entry[] = [];
    for (const e of events) {
      if (!byEvent.has(e.id)) continue;
      entries.push(eventEntry(ctx, e, `${team.name}\n${byEvent.get(e.id)!.join('\n')}`));
      const r = rehearsalEntry(ctx, e);
      if (r) entries.push(r);
    }
    return { name: `${church} · ${team.name}`, entries };
  }
  // A person: Sundays they said they are going to, and where they serve.
  const me = ctx.db.get('people', f.refId);
  if (!me) return { name: church, entries: [] };
  const going = new Set(ctx.db.all('rsvps').filter((r) => r.personId === me.id).map((r) => r.eventId));
  const mine = ctx.db.all('assignments').filter((a) => a.personId === me.id && a.status !== 'declined');
  const entries: Entry[] = [];
  for (const e of events) {
    const serving = mine.filter((a) => a.eventId === e.id).map((a) => { const t = ctx.db.get('teams', a.teamId); return `${t?.name ?? 'Team'}${t ? ` · ${t.positions.find((p) => p.id === a.positionId)?.name ?? ''}` : ''}${a.status === 'pending' ? ' (please confirm)' : ''}`; });
    if (!going.has(e.id) && !serving.length && e.kind !== 'service') continue;
    entries.push(eventEntry(ctx, e, serving.length ? `You serve: ${serving.join('; ')}` : ''));
    if (serving.length) { const r = rehearsalEntry(ctx, e); if (r) entries.push(r); }
  }
  return { name: `${church} · ${me.firstName}`, entries };
}

export function registerCalendarFeeds(r: Router) {
  r.get('/admin/calendar/feeds', { perm: ['settings', 'volunteers', 'events'] }, (ctx) => ({
    church: feedLink(ctx, feedFor(ctx, 'church', 'church'), settings(ctx).name),
    teams: ctx.db.all('teams').sort((a, b) => a.name.localeCompare(b.name)).map((t) => feedLink(ctx, feedFor(ctx, 'team', t.id), t.name)),
  }));
  // A new token: everyone with the old link stops getting updates.
  r.post('/admin/calendar/feeds/:id/reset', { perm: ['settings', 'volunteers'] }, (ctx) => {
    const f = find(ctx, 'calendarFeeds', ctx.params[0], 'Calendar link');
    const next = ctx.db.put('calendarFeeds', { ...f, token: ctx.env.random(28, ALPHABET), createdAt: ctx.now.toISOString() });
    ctx.audit('reset', 'calendar', f.id, `Made a new ${f.kind} calendar link`);
    const name = f.kind === 'team' ? ctx.db.get('teams', f.refId)?.name ?? 'Team' : settings(ctx).name;
    return feedLink(ctx, next, name);
  });
  r.get('/me/calendar', {}, (ctx) => feedLink(ctx, feedFor(ctx, 'person', ctx.me()), settings(ctx).name));
  r.post('/me/calendar/reset', {}, (ctx) => {
    const f = feedFor(ctx, 'person', ctx.me());
    return feedLink(ctx, ctx.db.put('calendarFeeds', { ...f, token: ctx.env.random(28, ALPHABET), createdAt: ctx.now.toISOString() }), settings(ctx).name);
  });

  // The feed itself: no sign-in, the token is the key. Calendar apps fetch it every hour or so.
  r.get('/public/calendar/:token', { public: true }, (ctx): RawResult => {
    const token = ctx.params[0].replace(/\.ics$/i, '');
    const f = feedsOf(ctx).find((x) => x.token === token);
    if (!f || token.length < 20) throw new ApiError(404, 'not_found', 'This calendar link is not valid any more.');
    const { name, entries } = feedEntries(ctx, f);
    return { __raw: true, contentType: 'text/calendar; charset=utf-8', filename: 'flockwise.ics', body: toIcs(name, entries, ctx.now, settings(ctx).timezone || 'Asia/Kolkata') };
  });
}
