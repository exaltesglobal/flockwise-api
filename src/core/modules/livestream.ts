// Livestream: the church's YouTube live service, embedded on the public church page and in the member
// app. Viewers' browsers ping once a minute while the video is on screen, so the office sees who is
// watching now and, after the service, how many attended online. When a stream ends, the people who
// watched long enough are written to the linked service's headcount as "Online".
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { LiveNow, LiveOverview, LiveSettings, LiveStatus, LiveStream, LiveStreamDetail, LiveStreamView, Permission, StreamView } from '../types.js';
import { find, fullName, settings, touchAttendance } from '../util.js';
import { headcountsFor } from './checkin.js';

const READ: Permission[] = ['services', 'events', 'comms'];
const WRITE: Permission[] = ['services', 'events'];
/** A stream with no "End" is treated as over this long after it started. */
const LIVE_HOURS = 4;
const WATCHING_MS = 150_000;
const ONLINE_AREA = 'Online';
const MAX_VIEWS = 20_000;
const text = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

/** The 11-character video id from any YouTube link: watch?v=, youtu.be/, /live/, /embed/, /shorts/. */
export function youtubeId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    let id = '';
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') id = u.searchParams.get('v') ?? u.pathname.match(/^\/(?:live|embed|shorts|v)\/([\w-]+)/)?.[1] ?? '';
    return /^[\w-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** A channel id (UC…) from the id itself or a youtube.com/channel/UC… link. Handles (@name) need the id. */
export const channelIdOf = (input: string) => input.match(/(UC[\w-]{22})/)?.[1] ?? null;

export function liveSettings(ctx: Ctx): LiveSettings {
  const l = settings(ctx).livestream ?? {};
  return { channelId: l.channelId ?? '', countAfterMinutes: l.countAfterMinutes ?? 5, publicWatch: l.publicWatch ?? true };
}

const startOf = (s: LiveStream) => Date.parse(s.startedAt ?? s.startsAt);

function statusOf(ctx: Ctx, s: LiveStream): LiveStatus {
  if (s.endedAt) return 'ended';
  const start = startOf(s);
  const now = ctx.now.getTime();
  if (s.startedAt || start <= now) return now - start < LIVE_HOURS * 3_600_000 ? 'live' : 'ended';
  return 'scheduled';
}

const viewsOf = (ctx: Ctx, id: string) => ctx.db.all('streamViews').filter((v) => v.streamId === id);

/** Ends a stream: counts who watched long enough and writes that to the service's headcount. */
function end(ctx: Ctx, s: LiveStream, at: Date): LiveStream {
  const min = liveSettings(ctx).countAfterMinutes;
  const attended = viewsOf(ctx, s.id).filter((v) => v.minutes.length >= min);
  for (const v of attended) if (v.personId) touchAttendance(ctx, v.personId, new Date(startOf(s)));
  const ev = s.eventId ? ctx.db.get('events', s.eventId) : undefined;
  if (ev) {
    const prev = headcountsFor(ctx, ev.id).find((h) => h.area.toLowerCase() === ONLINE_AREA.toLowerCase());
    ctx.db.put('headcounts', { id: prev?.id ?? ctx.id('hc'), eventId: ev.id, area: ONLINE_AREA, count: attended.length, recordedBy: 'Livestream', at: at.toISOString() });
    ctx.db.put('events', { ...ev, attendance: headcountsFor(ctx, ev.id).reduce((n, h) => n + h.count, 0) });
  }
  return ctx.db.put('streams', { ...s, endedAt: at.toISOString(), recorded: attended.length });
}

/** Closes streams nobody pressed "End" on, once they are past LIVE_HOURS. */
function settle(ctx: Ctx, s: LiveStream) {
  return !s.endedAt && statusOf(ctx, s) === 'ended' ? end(ctx, s, new Date(startOf(s) + LIVE_HOURS * 3_600_000)) : s;
}
const allStreams = (ctx: Ctx) => ctx.db.all('streams').map((s) => settle(ctx, s));

function view(ctx: Ctx, s: LiveStream, views = viewsOf(ctx, s.id)): LiveStreamView {
  const status = statusOf(ctx, s);
  const min = liveSettings(ctx).countAfterMinutes;
  const attended = views.filter((v) => v.minutes.length >= min);
  const perMinute = new Map<number, number>();
  for (const v of views) for (const m of v.minutes) perMinute.set(m, (perMinute.get(m) ?? 0) + 1);
  return {
    ...s,
    status,
    eventTitle: s.eventId ? ctx.db.get('events', s.eventId)?.title ?? null : null,
    watching: status === 'live' ? views.filter((v) => ctx.now.getTime() - Date.parse(v.lastAt) < WATCHING_MS).length : 0,
    viewers: views.length,
    attended: attended.length,
    members: new Set(attended.map((v) => v.personId).filter(Boolean)).size,
    avgMinutes: views.length ? Math.round(views.reduce((n, v) => n + v.minutes.length, 0) / views.length) : 0,
    peak: Math.max(0, ...perMinute.values()),
  };
}

function detail(ctx: Ctx, s: LiveStream): LiveStreamDetail {
  const views = viewsOf(ctx, s.id);
  const perMinute = new Map<number, number>();
  for (const v of views) for (const m of v.minutes) perMinute.set(m, (perMinute.get(m) ?? 0) + 1);
  const last = Math.max(-1, ...perMinute.keys());
  return {
    ...view(ctx, s, views),
    timeline: Array.from({ length: last + 1 }, (_, minute) => ({ minute, count: perMinute.get(minute) ?? 0 })),
    people: views
      .filter((v) => v.personId)
      .map((v) => {
        const p = ctx.db.get('people', v.personId!);
        return { personId: v.personId!, name: p ? fullName(p) : 'Former member', householdName: p?.householdName ?? null, minutes: v.minutes.length, firstAt: v.firstAt };
      })
      .sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name)),
    guests: views.filter((v) => !v.personId).length,
  };
}

function streamInput(ctx: Ctx, b: Record<string, unknown>, prev?: LiveStream) {
  const out: Partial<LiveStream> = {};
  if (b.url !== undefined || !prev) {
    const id = youtubeId(String(b.url ?? ''));
    if (!id) throw new ApiError(422, 'invalid', 'Paste the YouTube link of the live stream.', { url: 'Not a YouTube video or live link' });
    out.youtubeId = id;
  }
  if (b.eventId !== undefined) out.eventId = b.eventId ? find(ctx, 'events', String(b.eventId), 'Event').id : null;
  const ev = out.eventId ? ctx.db.get('events', out.eventId) : undefined;
  if (b.startsAt !== undefined && b.startsAt) {
    if (!Number.isFinite(Date.parse(String(b.startsAt)))) throw new ApiError(422, 'invalid', 'Choose when the stream starts.', { startsAt: 'Not a date and time' });
    out.startsAt = new Date(String(b.startsAt)).toISOString();
  } else if (!prev) out.startsAt = ev?.startsAt ?? ctx.now.toISOString();
  if (b.title !== undefined || !prev) out.title = text(b.title, 120) || ev?.title || prev?.title || 'Live service';
  return out;
}

/** What a viewer should see now: the live stream, or the next one this week. */
function liveNow(ctx: Ctx, viewer: boolean): LiveNow {
  const s = liveSettings(ctx);
  const church = settings(ctx).name;
  if (!viewer) return { stream: null, channelId: null, church };
  const streams = allStreams(ctx);
  const live = streams.filter((x) => statusOf(ctx, x) === 'live').sort((a, b) => startOf(b) - startOf(a))[0];
  const next = streams.filter((x) => statusOf(ctx, x) === 'scheduled' && startOf(x) - ctx.now.getTime() < 7 * 86_400_000).sort((a, b) => startOf(a) - startOf(b))[0];
  const pick = live ?? next;
  return {
    stream: pick ? (({ id, title, youtubeId, status, startsAt, watching }) => ({ id, title, youtubeId, status, startsAt, watching }))(view(ctx, pick)) : null,
    channelId: s.channelId || null,
    church,
  };
}

const signedIn = (ctx: Ctx) => (ctx.auth && ctx.db.get('people', ctx.auth.sub) ? ctx.auth.sub : null);

export function registerLivestream(r: Router) {
  r.get('/admin/livestream', { perm: READ }, (ctx): LiveOverview => {
    const all = allStreams(ctx).map((s) => view(ctx, s));
    return {
      settings: liveSettings(ctx),
      live: all.filter((s) => s.status === 'live').sort((a, b) => b.startsAt.localeCompare(a.startsAt))[0] ?? null,
      upcoming: all.filter((s) => s.status === 'scheduled').sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
      past: all.filter((s) => s.status === 'ended').sort((a, b) => b.startsAt.localeCompare(a.startsAt)).slice(0, 30),
    };
  });
  r.put('/admin/livestream/settings', { perm: WRITE }, (ctx) => {
    const b = ctx.body;
    const next = { ...liveSettings(ctx) };
    if (b.channelId !== undefined) {
      const raw = text(b.channelId, 200);
      const id = raw ? channelIdOf(raw) : '';
      if (id === null) throw new ApiError(422, 'invalid', 'Use the channel id that starts with UC. In YouTube Studio: Settings, Channel, Advanced settings.', { channelId: 'Starts with UC, 24 characters' });
      next.channelId = id;
    }
    if (b.countAfterMinutes !== undefined) next.countAfterMinutes = Math.min(60, Math.max(1, Math.round(Number(b.countAfterMinutes) || 5)));
    if (b.publicWatch !== undefined) next.publicWatch = !!b.publicWatch;
    ctx.db.put('settings', { ...settings(ctx), livestream: next });
    ctx.audit('updated', 'settings', null, 'Updated livestream settings');
    return next;
  });
  r.post('/admin/livestream/streams', { perm: WRITE }, (ctx) => {
    const input = streamInput(ctx, ctx.body);
    const s = ctx.db.put('streams', { id: ctx.id('st'), title: input.title!, youtubeId: input.youtubeId!, eventId: input.eventId ?? null, startsAt: input.startsAt!, startedAt: null, endedAt: null, recorded: null, createdAt: ctx.now.toISOString() });
    ctx.audit('created', 'stream', s.id, `Scheduled the livestream "${s.title}"`);
    return view(ctx, s);
  });
  r.get('/admin/livestream/streams/:id', { perm: READ }, (ctx) => detail(ctx, settle(ctx, find(ctx, 'streams', ctx.params[0], 'Stream'))));
  r.patch('/admin/livestream/streams/:id', { perm: WRITE }, (ctx) => {
    const s = find(ctx, 'streams', ctx.params[0], 'Stream');
    return detail(ctx, ctx.db.put('streams', { ...s, ...streamInput(ctx, ctx.body, s) }));
  });
  r.del('/admin/livestream/streams/:id', { perm: WRITE }, (ctx) => {
    const s = find(ctx, 'streams', ctx.params[0], 'Stream');
    for (const v of viewsOf(ctx, s.id)) ctx.db.del('streamViews', v.id);
    ctx.db.del('streams', s.id);
    ctx.audit('deleted', 'stream', s.id, `Deleted the livestream "${s.title}"`);
    return undefined;
  });
  r.post('/admin/livestream/streams/:id/start', { perm: WRITE }, (ctx) => {
    const s = settle(ctx, find(ctx, 'streams', ctx.params[0], 'Stream'));
    if (s.endedAt) throw new ApiError(409, 'ended', 'This stream has ended. Schedule a new one.');
    return detail(ctx, s.startedAt ? s : ctx.db.put('streams', { ...s, startedAt: ctx.now.toISOString() }));
  });
  r.post('/admin/livestream/streams/:id/end', { perm: WRITE }, (ctx) => {
    const s = settle(ctx, find(ctx, 'streams', ctx.params[0], 'Stream'));
    if (s.endedAt) return detail(ctx, s);
    if (statusOf(ctx, s) !== 'live') throw new ApiError(409, 'not_live', 'This stream has not started.');
    const done = end(ctx, s, ctx.now);
    ctx.audit('ended', 'stream', s.id, `Ended the livestream "${s.title}": ${done.recorded} watched online`);
    return detail(ctx, done);
  });

  // Viewers. Members call these signed in; the public church page calls them without signing in.
  r.get('/public/live', { public: true }, (ctx) => liveNow(ctx, !!signedIn(ctx) || liveSettings(ctx).publicWatch));
  r.post('/public/live/:id/ping', { public: true }, (ctx) => {
    const s = settle(ctx, find(ctx, 'streams', ctx.params[0], 'Stream'));
    const personId = signedIn(ctx);
    if (!personId && !liveSettings(ctx).publicWatch) throw new ApiError(403, 'forbidden', 'Sign in to watch.');
    const status = statusOf(ctx, s);
    if (status !== 'live') return { ok: false, status, watching: 0 };
    const viewer = personId ?? text(ctx.body.viewer, 64);
    if (!personId && !/^[\w-]{8,64}$/.test(viewer)) throw new ApiError(422, 'invalid', 'Missing viewer id.');
    const id = `${s.id}:${viewer}`;
    const prev = ctx.db.get('streamViews', id);
    if (!prev && viewsOf(ctx, s.id).length >= MAX_VIEWS) return { ok: false, status, watching: 0 };
    const minute = Math.max(0, Math.floor((ctx.now.getTime() - startOf(s)) / 60_000));
    const at = ctx.now.toISOString();
    const v: StreamView = prev
      ? { ...prev, minutes: prev.minutes.includes(minute) ? prev.minutes : [...prev.minutes, minute].slice(-LIVE_HOURS * 60), lastAt: at }
      : { id, streamId: s.id, viewer, personId, source: personId ? 'app' : 'public', minutes: [minute], firstAt: at, lastAt: at };
    ctx.db.put('streamViews', v);
    return { ok: true, status, watching: view(ctx, s).watching };
  });
}
