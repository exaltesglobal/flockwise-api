// The digital bulletin: each Sunday's order of service, announcements, the week's events, birthdays
// and anniversaries, who is serving and how to give, built from what is already in Flockwise. Published
// bulletins show in the member app and open from a share link on WhatsApp without signing in.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { Bulletin, BulletinSection, BulletinView, Collections } from '../types.js';
import { bySoonest, DAY, find, localDate, settings, upcoming } from '../util.js';
import { upcomingCelebrations } from './celebrations.js';
import { liveCampaigns, publicCampaign } from './offerings.js';

const SECTIONS: BulletinSection[] = ['order', 'announcements', 'events', 'celebrations', 'serving', 'giving'];
const KEY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const dayLabel = (date: string) => {
  try {
    return new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
  } catch {
    return date;
  }
};

/** The service the bulletin is for: the given event, or the next published service. */
function serviceFor(ctx: Ctx, eventId?: string | null) {
  if (eventId) return find(ctx, 'events', eventId, 'Service');
  return ctx.db.all('events').filter((e) => e.published && e.kind === 'service' && upcoming(ctx, e)).sort(bySoonest)[0] ?? null;
}

/** Builds the bulletin's content. `forPublic` leaves out birthdays, which are only for signed-in members. */
export function bulletinView(ctx: Ctx, b: Bulletin, forPublic = false): BulletinView {
  const s = settings(ctx);
  const ev = b.eventId ? ctx.db.get('events', b.eventId) ?? null : null;
  const plan = ev ? ctx.db.all('plans').find((p) => p.eventId === ev.id) : undefined;
  const has = (x: BulletinSection) => b.sections.includes(x);
  const from = Date.parse(`${b.date}T00:00:00Z`);
  const announcements = has('announcements')
    ? ctx.db.all('announcements').filter((a) => a.status === 'published' && Date.parse(a.publishedAt) > from - 14 * DAY && Date.parse(a.publishedAt) < from + DAY).sort((x, y) => y.publishedAt.localeCompare(x.publishedAt)).slice(0, 8).map((a) => ({ id: a.id, title: a.title, body: a.body }))
    : [];
  const events = has('events')
    ? ctx.db.all('events').filter((e) => e.published && e.id !== ev?.id && Date.parse(e.startsAt) >= from && Date.parse(e.startsAt) < from + 8 * DAY).sort(bySoonest).slice(0, 8).map((e) => ({ id: e.id, title: e.title, startsAt: e.startsAt, location: e.location }))
    : [];
  // Only people who agreed to be in the directory, and no children.
  const celebrations = has('celebrations') && !forPublic
    ? upcomingCelebrations({ ...ctx, now: new Date(from) } as Ctx, 6, ['birthday', 'anniversary'])
        .filter((c) => !c.isChild && ctx.db.get('people', c.personId)?.consent.directory)
        .slice(0, 20)
        .map((c) => ({ name: c.name, kind: c.kind, date: c.date, years: c.kind === 'anniversary' ? c.years : null }))
    : [];
  const serving: BulletinView['serving'] = [];
  if (has('serving') && ev) {
    const teams = new Map(ctx.db.all('teams').map((t) => [t.id, t.name]));
    const byTeam = new Map<string, Set<string>>();
    for (const a of ctx.db.all('assignments').filter((x) => x.eventId === ev.id && x.status !== 'declined')) {
      const p = ctx.db.get('people', a.personId);
      if (!p) continue;
      const team = teams.get(a.teamId) ?? 'Team';
      byTeam.set(team, (byTeam.get(team) ?? new Set()).add(`${p.firstName} ${p.lastName.slice(0, 1)}`.trim()));
    }
    for (const [team, names] of byTeam) serving.push({ team, names: [...names] });
  }
  return {
    ...b,
    church: { name: s.name, address: s.address, logoUrl: s.logoUrl ?? null, phone: s.phone, website: s.website },
    service: ev ? { title: ev.title, startsAt: ev.startsAt, location: ev.location, theme: plan?.theme ?? '' } : null,
    order: has('order') && plan ? plan.items.filter((i) => i.kind !== 'other' || i.title).map((i) => ({ kind: i.kind, title: i.title, person: i.person })) : [],
    announcements,
    events,
    celebrations,
    serving: forPublic ? [] : serving,
    giving: { url: `${ctx.env.webUrl}/app/give`, campaigns: has('giving') ? liveCampaigns(ctx).map((c) => publicCampaign(ctx, c)) : [] },
    shareUrl: `${ctx.env.webUrl}/bulletin/${b.id}?k=${b.shareKey}`,
  };
}

function input(ctx: Ctx, body: Record<string, unknown>, prev?: Bulletin): Partial<Bulletin> {
  const out: Partial<Bulletin> = {};
  if (body.title !== undefined) out.title = String(body.title).trim().slice(0, 120) || prev?.title || 'Bulletin';
  if (body.intro !== undefined) out.intro = String(body.intro).trim().slice(0, 2000);
  if (body.verse !== undefined) out.verse = String(body.verse).trim().slice(0, 500);
  if (body.date !== undefined) {
    const d = String(body.date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new ApiError(422, 'invalid', 'Choose the date.', { date: 'Invalid' });
    out.date = d;
  }
  if (Array.isArray(body.sections)) out.sections = SECTIONS.filter((x) => (body.sections as string[]).includes(x));
  if (body.eventId !== undefined) out.eventId = body.eventId ? find(ctx, 'events', String(body.eventId), 'Service').id : null;
  return out;
}

const latestPublished = (ctx: Ctx) => ctx.db.all('bulletins').filter((b) => b.status === 'published').sort((a, b) => b.date.localeCompare(a.date) || (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))[0];

export function registerBulletin(r: Router) {
  r.get('/admin/bulletins', { perm: 'comms' }, (ctx) => ctx.db.all('bulletins').sort((a, b) => b.date.localeCompare(a.date)));

  r.post('/admin/bulletins', { perm: 'comms' }, (ctx) => {
    const ev = serviceFor(ctx, ctx.body.eventId ? String(ctx.body.eventId) : null);
    const date = ev ? localDate(ctx, new Date(ev.startsAt)) : localDate(ctx, ctx.now);
    const last = latestPublished(ctx);
    const b: Bulletin = {
      id: ctx.id('bl'),
      eventId: ev?.id ?? null,
      date,
      title: `${ev?.title ?? 'Sunday'} · ${dayLabel(date)}`,
      intro: '',
      verse: '',
      sections: last?.sections ?? SECTIONS,
      status: 'draft',
      publishedAt: null,
      shareKey: ctx.env.random(10, KEY_ALPHABET),
      createdAt: ctx.now.toISOString(),
      updatedAt: ctx.now.toISOString(),
    };
    ctx.db.put('bulletins', { ...b, ...input(ctx, ctx.body) });
    return bulletinView(ctx, ctx.db.get('bulletins', b.id)!);
  });

  r.get('/admin/bulletins/:id', { perm: 'comms' }, (ctx) => bulletinView(ctx, find(ctx, 'bulletins', ctx.params[0], 'Bulletin')));

  r.patch('/admin/bulletins/:id', { perm: 'comms' }, (ctx) => {
    const b = find(ctx, 'bulletins', ctx.params[0], 'Bulletin');
    const status = ctx.body.status === 'published' || ctx.body.status === 'draft' ? (ctx.body.status as Bulletin['status']) : b.status;
    const next: Bulletin = { ...b, ...input(ctx, ctx.body, b), status, publishedAt: status === 'published' ? b.publishedAt ?? ctx.now.toISOString() : null, updatedAt: ctx.now.toISOString() };
    ctx.db.put('bulletins', next);
    if (status !== b.status) ctx.audit(status === 'published' ? 'published' : 'updated', 'bulletin', b.id, `${status === 'published' ? 'Published' : 'Unpublished'} the bulletin “${next.title}”`);
    return bulletinView(ctx, next);
  });

  r.del('/admin/bulletins/:id', { perm: 'comms' }, (ctx) => {
    const b = find(ctx, 'bulletins', ctx.params[0], 'Bulletin');
    ctx.db.del('bulletins', b.id);
    return { ok: true };
  });

  // ----- members -----
  r.get('/bulletins', {}, (ctx) => ctx.db.all('bulletins').filter((b) => b.status === 'published').sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12).map((b) => ({ id: b.id, title: b.title, date: b.date })));
  r.get('/bulletins/latest', {}, (ctx) => {
    const b = latestPublished(ctx);
    return b ? bulletinView(ctx, b) : null;
  });
  r.get('/bulletins/:id', {}, (ctx) => {
    const b = find(ctx, 'bulletins', ctx.params[0], 'Bulletin');
    if (b.status !== 'published') throw new ApiError(404, 'not_found', 'Bulletin not found.');
    return bulletinView(ctx, b);
  });

  // ----- the share link -----
  r.get('/public/bulletins/:id', { public: true }, (ctx) => {
    const b = ctx.db.get('bulletins', ctx.params[0]) as Collections['bulletins'] | undefined;
    if (!b || b.status !== 'published' || ctx.query.k !== b.shareKey) throw new ApiError(404, 'not_found', 'This bulletin link is not valid.');
    return bulletinView(ctx, b, true);
  });
}
