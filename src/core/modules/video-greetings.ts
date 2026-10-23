// The pastor's video greeting, recorded once and sent personalised on every birthday. The office
// keeps up to three recordings (adults' birthdays, children's birthdays, anniversaries). On the
// morning of the day, each person gets their own link: a page in the church's colours with their
// name on it, the video, a line from the pastor and a box to say thank you. A child's link goes to
// the parents. The page shows nothing but the greeting, so the link can travel on WhatsApp.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { CelebrationKind, Collections, GreetingLink, GreetingLinkView, PublicGreeting, VideoGreeting, VideoGreetingKind, VideoGreetingView, VideoGreetingsHub } from '../types.js';
import { DAY, find, fullName, isChild, localDate, settings } from '../util.js';
import { upcomingCelebrations } from './celebrations.js';
import { gcsStatus } from './connections.js';
import { notify } from './notify.js';

export const VIDEO_KINDS: VideoGreetingKind[] = ['birthday', 'child', 'anniversary'];
const LABEL: Record<VideoGreetingKind, string> = { birthday: 'Birthdays', child: "Children's birthdays", anniversary: 'Wedding anniversaries' };
const DEFAULT_MESSAGE: Record<VideoGreetingKind, string> = {
  birthday: 'Happy birthday, {{firstName}}! May the Lord bless you and keep you this year.',
  child: 'Happy birthday, {{firstName}}! Jesus loves you, and so do all of us at church.',
  anniversary: 'Happy anniversary, {{firstName}}! May God keep your home full of His love.',
};
const TOKEN_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const blank = (kind: VideoGreetingKind): VideoGreeting => ({ id: kind, enabled: false, videoUrl: '', mediaId: null, posterUrl: null, fromName: '', message: DEFAULT_MESSAGE[kind], recordedAt: null, updatedBy: '' });
export const greetingOf = (ctx: Ctx, kind: VideoGreetingKind): VideoGreeting => ctx.db.get('videoGreetings', kind) ?? blank(kind);

const fill = (t: string, vars: Record<string, string>) => t.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? '');

/** Which recording a celebration gets: children's when there is one, else the adults'. */
function videoKindFor(ctx: Ctx, kind: CelebrationKind, child: boolean): VideoGreetingKind | null {
  if (kind === 'baptism') return null;
  if (kind === 'anniversary') return ready(greetingOf(ctx, 'anniversary')) ? 'anniversary' : null;
  if (child && ready(greetingOf(ctx, 'child'))) return 'child';
  return ready(greetingOf(ctx, 'birthday')) ? 'birthday' : null;
}
const ready = (v: VideoGreeting) => v.enabled && !!v.videoUrl;

/** Adults in the same household, for a child's greeting. */
function parentsOf(ctx: Ctx, p: Collections['people']) {
  if (!p.householdName) return [];
  return ctx.db.all('people').filter((x) => x.id !== p.id && x.householdName === p.householdName && x.status !== 'inactive' && !isChild(ctx, x)).map((x) => x.id);
}

function linkView(ctx: Ctx, l: GreetingLink): GreetingLinkView {
  const p = ctx.db.get('people', l.personId);
  return { ...l, name: p ? fullName(p) : 'Someone', url: `${ctx.env.webUrl}/g/${l.id}` };
}

/** Makes the person's link, records the greeting, and tells them (or the parents). */
export async function sendVideoGreeting(ctx: Ctx, p: Collections['people'], kind: CelebrationKind, videoKind: VideoGreetingKind, year: number, test = false): Promise<GreetingLink> {
  const v = greetingOf(ctx, videoKind);
  const child = isChild(ctx, p);
  const to = child ? [...parentsOf(ctx, p), ...(p.phone || p.email ? [p.id] : [])] : [p.id];
  const link: GreetingLink = { id: ctx.env.random(12, TOKEN_ALPHABET), personId: p.id, kind, videoKind, year, sentTo: [...new Set(to)], createdAt: ctx.now.toISOString(), views: 0, watchedAt: null, reply: null, repliedAt: null, test };
  ctx.db.put('greetingLinks', link);
  if (!test) ctx.db.put('greetings', { id: ctx.id('gt'), personId: p.id, kind, year, fromId: null, fromName: v.fromName || settings(ctx).name, message: fill(v.message, { firstName: p.firstName }), channel: 'video', at: ctx.now.toISOString() });
  const what = kind === 'anniversary' ? 'anniversary' : 'birthday';
  const title = child && !test ? `A birthday greeting for ${p.firstName}` : `Happy ${what}, ${p.firstName}!`;
  const body = child && !test
    ? `${v.fromName || 'Our pastor'} recorded a ${what} blessing for ${p.firstName}. Watch it together.`
    : `${v.fromName || 'Our pastor'} recorded a ${what} blessing just for you. Tap to watch.`;
  await notify(ctx, 'greeting.video', { personIds: link.sentTo, title, body, link: `/g/${link.id}` });
  return link;
}

/** Daily: everyone celebrating today gets their link once. Runs inside the once-a-day block. */
export async function videoGreetingsDue(ctx: Ctx) {
  const links = ctx.db.all('greetingLinks');
  for (const c of upcomingCelebrations(ctx, 0, ['birthday', 'anniversary'])) {
    if (c.daysAway !== 0) continue;
    const videoKind = videoKindFor(ctx, c.kind, c.isChild);
    if (!videoKind) continue;
    const year = Number(c.date.slice(0, 4));
    if (links.some((l) => !l.test && l.personId === c.personId && l.kind === c.kind && l.year === year)) continue;
    const p = ctx.db.get('people', c.personId);
    if (!p) continue;
    await sendVideoGreeting(ctx, p, c.kind, videoKind, year);
  }
}

const isUrl = (u: string) => /^https?:\/\/\S+$/i.test(u) || u.startsWith('data:video/');

export function registerVideoGreetings(r: Router) {
  r.get('/admin/video-greetings', { perm: 'comms' }, (ctx): VideoGreetingsHub => {
    const year = Number(localDate(ctx, ctx.now).slice(0, 4));
    const links = ctx.db.all('greetingLinks');
    const soon = upcomingCelebrations(ctx, 7, ['birthday', 'anniversary']);
    const greetings = VIDEO_KINDS.map((k): VideoGreetingView => {
      const mine = links.filter((l) => l.videoKind === k && !l.test && l.year === year);
      return {
        ...greetingOf(ctx, k), sentThisYear: mine.length, watched: mine.filter((l) => l.watchedAt).length, replies: mine.filter((l) => l.reply).length,
        upcoming: soon.filter((c) => (k === 'anniversary' ? c.kind === 'anniversary' : c.kind === 'birthday' && (k === 'child') === c.isChild)).length,
      };
    });
    const recent = links.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30).map((l) => linkView(ctx, l));
    return { greetings, recent, storage: gcsStatus(ctx).connected, webUrl: ctx.env.webUrl };
  });

  r.put('/admin/video-greetings/:kind', { perm: 'comms' }, (ctx): VideoGreeting => {
    const kind = ctx.params[0] as VideoGreetingKind;
    if (!VIDEO_KINDS.includes(kind)) throw new ApiError(404, 'not_found', 'No such greeting.');
    const cur = greetingOf(ctx, kind);
    const b = ctx.body ?? {};
    let videoUrl = b.videoUrl !== undefined ? String(b.videoUrl).trim().slice(0, 2000) : cur.videoUrl;
    let mediaId = b.mediaId !== undefined ? (b.mediaId ? String(b.mediaId) : null) : cur.mediaId;
    if (b.mediaId) {
      const m = find(ctx, 'media', String(b.mediaId), 'Recording');
      if (m.status !== 'ready') throw new ApiError(409, 'not_ready', 'The upload has not finished.');
      videoUrl = m.url;
      mediaId = m.id;
    } else if (b.videoUrl !== undefined) mediaId = null;
    if (videoUrl && !isUrl(videoUrl)) throw new ApiError(422, 'invalid', 'Paste a full link to the video (https://…).', { videoUrl: 'Video link' });
    const enabled = b.enabled !== undefined ? b.enabled === true : cur.enabled;
    if (enabled && !videoUrl) throw new ApiError(422, 'invalid', 'Record or link a video before switching it on.', { videoUrl: 'Video link' });
    const next: VideoGreeting = {
      id: kind, enabled, videoUrl, mediaId,
      posterUrl: b.posterUrl !== undefined ? (b.posterUrl ? String(b.posterUrl).slice(0, 2000) : null) : cur.posterUrl,
      fromName: b.fromName !== undefined ? String(b.fromName).trim().slice(0, 80) : cur.fromName || ctx.staff?.name || '',
      message: b.message !== undefined ? String(b.message).trim().slice(0, 300) || DEFAULT_MESSAGE[kind] : cur.message,
      recordedAt: videoUrl !== cur.videoUrl ? ctx.now.toISOString() : cur.recordedAt,
      updatedBy: ctx.staff?.name ?? '',
    };
    ctx.db.put('videoGreetings', next);
    ctx.audit('updated', 'settings', kind, `${LABEL[kind]} video greeting ${next.enabled ? 'switched on' : 'saved'}`);
    return next;
  });

  r.del('/admin/video-greetings/:kind', { perm: 'comms' }, (ctx) => {
    const kind = ctx.params[0] as VideoGreetingKind;
    if (!VIDEO_KINDS.includes(kind)) throw new ApiError(404, 'not_found', 'No such greeting.');
    ctx.db.del('videoGreetings', kind);
    return { ok: true };
  });

  // Try it on yourself (or on one person) before the first birthday comes round.
  r.post('/admin/video-greetings/:kind/test', { perm: 'comms' }, async (ctx): Promise<GreetingLinkView> => {
    const kind = ctx.params[0] as VideoGreetingKind;
    if (!VIDEO_KINDS.includes(kind)) throw new ApiError(404, 'not_found', 'No such greeting.');
    if (!greetingOf(ctx, kind).videoUrl) throw new ApiError(422, 'invalid', 'Record or link a video first.');
    const me = ctx.body?.personId ? find(ctx, 'people', String(ctx.body.personId), 'Person')
      : ctx.db.get('people', ctx.staff?.personId ?? '') ?? ctx.db.all('people').find((p) => p.email && p.email.toLowerCase() === (ctx.staff?.email ?? '').toLowerCase());
    if (!me) throw new ApiError(404, 'not_found', 'Pick a person to send the test to; your account is not linked to a person record.');
    const year = Number(localDate(ctx, ctx.now).slice(0, 4));
    const link = await sendVideoGreeting(ctx, me, kind === 'anniversary' ? 'anniversary' : 'birthday', kind, year, true);
    return linkView(ctx, link);
  });

  r.get('/admin/video-greetings/links', { perm: 'comms' }, (ctx): GreetingLinkView[] => ctx.db.all('greetingLinks').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200).map((l) => linkView(ctx, l)));

  // ----- the greeting page (no sign-in: the link is the key) -----
  const open = (ctx: Ctx) => {
    const l = ctx.db.get('greetingLinks', ctx.params[0]);
    if (!l) throw new ApiError(404, 'not_found', 'This greeting link is not valid.');
    return l;
  };
  const view = (ctx: Ctx, l: GreetingLink): PublicGreeting => {
    const p = ctx.db.get('people', l.personId);
    const v = greetingOf(ctx, l.videoKind);
    const s = settings(ctx);
    const src = p ? (l.kind === 'anniversary' ? p.anniversary : p.birthDate) : null;
    return {
      firstName: p?.firstName ?? '', kind: l.kind, years: src ? l.year - Number(src.slice(0, 4)) || null : null, videoUrl: v.videoUrl, posterUrl: v.posterUrl,
      fromName: v.fromName || s.name, message: fill(v.message, { firstName: p?.firstName ?? '' }), reply: l.reply, church: { name: s.name, logoUrl: s.logoUrl ?? null, brand: s.brand ?? null },
    };
  };
  r.get('/public/greetings/:token', { public: true }, (ctx) => view(ctx, open(ctx)));
  r.post('/public/greetings/:token/watched', { public: true }, (ctx) => {
    const l = open(ctx);
    ctx.db.put('greetingLinks', { ...l, views: l.views + 1, watchedAt: l.watchedAt ?? ctx.now.toISOString() });
    return { ok: true };
  });
  r.post('/public/greetings/:token/reply', { public: true }, (ctx) => {
    const l = open(ctx);
    const reply = String(ctx.body?.message ?? '').trim().slice(0, 500);
    if (!reply) throw new ApiError(400, 'bad_request', 'Write a line first.');
    if (l.createdAt < new Date(ctx.now.getTime() - 60 * DAY).toISOString()) throw new ApiError(410, 'expired', 'This greeting is too old to reply to.');
    ctx.db.put('greetingLinks', { ...l, reply, repliedAt: ctx.now.toISOString() });
    const p = ctx.db.get('people', l.personId);
    ctx.audit('replied', 'person', l.personId, `${p ? fullName(p) : 'Someone'} replied to the video greeting: ${reply.slice(0, 80)}`);
    return { ok: true, message: 'Sent. Thank you!' };
  });
}
