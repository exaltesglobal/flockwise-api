// Prayer vigils and fasting chains: a 24-hour prayer chain before a convention, 21 days of fasting
// in January, an all-night watch. The time is cut into slots; members take a slot from the app (or
// the office puts them in one) until every slot is covered, and each gets a reminder before theirs.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { MyVigil, Vigil, VigilDetail, VigilSignup, VigilSlot, VigilView } from '../types.js';
import { find, fullName, settings } from '../util.js';
import { notify } from './notify.js';

const MIN = 60_000;
const MAX_SLOTS = 500;
const SLOT_SIZES = [15, 30, 60, 120, 180, 360, 720, 1440];
const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

function slotStarts(v: Pick<Vigil, 'startsAt' | 'endsAt' | 'slotMinutes'>): string[] {
  const out: string[] = [];
  const end = Date.parse(v.endsAt);
  for (let t = Date.parse(v.startsAt); t < end && out.length < MAX_SLOTS; t += v.slotMinutes * MIN) out.push(new Date(t).toISOString());
  return out;
}
const signupsOf = (ctx: Ctx, vigilId: string) => ctx.db.all('vigilSignups').filter((s) => s.vigilId === vigilId);

function view(ctx: Ctx, v: Vigil): VigilView {
  const starts = slotStarts(v);
  const rows = signupsOf(ctx, v.id);
  const taken = new Set(rows.map((s) => s.slotStart));
  const now = ctx.now.toISOString();
  const nextGap = starts.find((s, i) => !taken.has(s) && (starts[i + 1] ?? v.endsAt) > now) ?? null;
  return { ...v, slots: starts.length, covered: starts.filter((s) => taken.has(s)).length, people: new Set(rows.map((s) => s.personId)).size, nextGap };
}

function detail(ctx: Ctx, v: Vigil): VigilDetail {
  const rows = signupsOf(ctx, v.id);
  const slotList: VigilSlot[] = slotStarts(v).map((start) => ({
    start,
    end: new Date(Math.min(Date.parse(start) + v.slotMinutes * MIN, Date.parse(v.endsAt))).toISOString(),
    people: rows.filter((s) => s.slotStart === start).map((s) => { const p = ctx.db.get('people', s.personId); return { signupId: s.id, personId: s.personId, name: p ? fullName(p) : 'Removed person' }; }),
  }));
  return { ...view(ctx, v), slotList };
}

function readVigil(b: Record<string, unknown>, prev?: Vigil): Omit<Vigil, 'id' | 'createdAt' | 'createdBy' | 'status'> {
  const kind = b.kind !== undefined ? (b.kind === 'fasting' ? 'fasting' : 'prayer') : (prev?.kind ?? 'prayer');
  const name = b.name !== undefined ? clean(b.name, 80) : (prev?.name ?? '');
  if (!name) throw new ApiError(422, 'invalid', 'Give the vigil a name.', { name: 'Required' });
  const startsAt = b.startsAt !== undefined ? String(b.startsAt) : prev?.startsAt;
  const endsAt = b.endsAt !== undefined ? String(b.endsAt) : prev?.endsAt;
  if (!startsAt || Number.isNaN(Date.parse(startsAt))) throw new ApiError(422, 'invalid', 'Choose when it starts.', { startsAt: 'Required' });
  if (!endsAt || Number.isNaN(Date.parse(endsAt)) || Date.parse(endsAt) <= Date.parse(startsAt)) throw new ApiError(422, 'invalid', 'It has to end after it starts.', { endsAt: 'After the start' });
  const slotMinutes = b.slotMinutes !== undefined ? Math.round(Number(b.slotMinutes)) : (prev?.slotMinutes ?? (kind === 'fasting' ? 1440 : 60));
  if (!SLOT_SIZES.includes(slotMinutes)) throw new ApiError(422, 'invalid', 'Choose a slot length.', { slotMinutes: 'Choose one' });
  const out = {
    name,
    kind,
    purpose: b.purpose !== undefined ? clean(b.purpose, 600) : (prev?.purpose ?? ''),
    startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(endsAt).toISOString(),
    slotMinutes,
    perSlot: b.perSlot !== undefined ? (Number(b.perSlot) > 0 ? Math.round(Number(b.perSlot)) : null) : (prev?.perSlot ?? null),
    location: b.location !== undefined ? clean(b.location, 120) : (prev?.location ?? ''),
  } satisfies Omit<Vigil, 'id' | 'createdAt' | 'createdBy' | 'status'>;
  if ((Date.parse(out.endsAt) - Date.parse(out.startsAt)) / (slotMinutes * MIN) > MAX_SLOTS) throw new ApiError(422, 'invalid', `That makes more than ${MAX_SLOTS} slots. Choose longer slots or a shorter time.`, { slotMinutes: 'Too many slots' });
  return out;
}

function take(ctx: Ctx, v: Vigil, personId: string, slotStart: string, via: VigilSignup['via']): VigilSignup {
  const start = new Date(slotStart).toISOString();
  if (!slotStarts(v).includes(start)) throw new ApiError(422, 'invalid', 'That slot is not part of this vigil.', { slotStart: 'Choose a slot' });
  const rows = signupsOf(ctx, v.id).filter((s) => s.slotStart === start);
  const mine = rows.find((s) => s.personId === personId);
  if (mine) return mine;
  if (v.perSlot && rows.length >= v.perSlot) throw new ApiError(409, 'full', 'That slot is taken. Please choose another.');
  return ctx.db.put('vigilSignups', { id: ctx.id('vs'), vigilId: v.id, personId, slotStart: start, via, reminded: false, createdAt: ctx.now.toISOString() });
}

function mine(ctx: Ctx): { vigils: MyVigil[] } {
  const me = ctx.me();
  const now = ctx.now.toISOString();
  const vigils = ctx.db
    .all('vigils')
    .filter((v) => v.endsAt > now && (v.status === 'open' || signupsOf(ctx, v.id).some((s) => s.personId === me)))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .map((v) => {
      const rows = signupsOf(ctx, v.id);
      const starts = slotStarts(v);
      return {
        id: v.id, name: v.name, kind: v.kind, purpose: v.purpose, startsAt: v.startsAt, endsAt: v.endsAt, slotMinutes: v.slotMinutes, location: v.location,
        covered: starts.filter((s) => rows.some((r) => r.slotStart === s)).length,
        slots: starts.map((start) => {
          const here = rows.filter((r) => r.slotStart === start);
          return { start, end: new Date(Math.min(Date.parse(start) + v.slotMinutes * MIN, Date.parse(v.endsAt))).toISOString(), count: here.length, full: !!v.perSlot && here.length >= v.perSlot, mine: here.some((r) => r.personId === me) };
        }),
      } satisfies MyVigil;
    });
  return { vigils };
}

function localTime(ctx: Ctx, iso: string, withDay: boolean) {
  try {
    return new Intl.DateTimeFormat('en-IN', { timeZone: settings(ctx).timezone || 'Asia/Kolkata', ...(withDay ? { weekday: 'short', day: 'numeric', month: 'short' } : {}), hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** Runs on every tick: 30 minutes before a prayer slot (12 hours before a day-long fasting slot), a reminder. */
export async function vigilReminders(ctx: Ctx) {
  const now = ctx.now.getTime();
  const church = settings(ctx).name;
  for (const s of ctx.db.all('vigilSignups')) {
    if (s.reminded) continue;
    const at = Date.parse(s.slotStart);
    if (at <= now - 5 * MIN) { ctx.db.put('vigilSignups', { ...s, reminded: true }); continue; }
    const v = ctx.db.get('vigils', s.vigilId);
    if (!v || v.status === 'closed') continue;
    const lead = v.slotMinutes >= 720 ? 12 * 60 * MIN : 30 * MIN;
    if (at - now > lead) continue;
    ctx.db.put('vigilSignups', { ...s, reminded: true });
    const fasting = v.kind === 'fasting';
    await notify(ctx, 'vigil.reminder', {
      personIds: [s.personId],
      title: `${church}: ${v.name}`,
      body: fasting
        ? `Your fasting ${v.slotMinutes >= 1440 ? 'day' : 'slot'} starts ${localTime(ctx, s.slotStart, true)}. ${v.purpose ? `We are praying for: ${v.purpose.slice(0, 200)}` : 'Thank you for standing with the church.'}`
        : `Your prayer slot is at ${localTime(ctx, s.slotStart, false)}${v.location ? ` (${v.location})` : ''}. ${v.purpose ? `Pray for: ${v.purpose.slice(0, 200)}` : 'Thank you for keeping watch.'}`,
      link: '/app/vigils',
    });
  }
}

export function registerVigils(r: Router) {
  r.get('/admin/vigils', { perm: 'care' }, (ctx) => ({
    vigils: ctx.db.all('vigils').sort((a, b) => (a.status === b.status ? b.startsAt.localeCompare(a.startsAt) : a.status === 'open' ? -1 : 1)).map((v) => view(ctx, v)),
  }));

  r.post('/admin/vigils', { perm: 'care' }, (ctx) => {
    const v = ctx.db.put('vigils', { id: ctx.id('vg'), ...readVigil(ctx.body as Record<string, unknown>), status: 'open', createdAt: ctx.now.toISOString(), createdBy: ctx.staff?.name ?? '' });
    ctx.audit('created', 'vigils', v.id, `Started ${v.name}`);
    return detail(ctx, v);
  });

  r.get('/admin/vigils/:id', { perm: 'care' }, (ctx) => detail(ctx, find(ctx, 'vigils', ctx.params[0], 'Vigil')));

  r.patch('/admin/vigils/:id', { perm: 'care' }, (ctx) => {
    const v = find(ctx, 'vigils', ctx.params[0], 'Vigil');
    const b = ctx.body as Record<string, unknown>;
    const next: Vigil = { ...v, ...readVigil(b, v), status: b.status === 'closed' || b.status === 'open' ? b.status : v.status };
    ctx.db.put('vigils', next);
    // Slots that no longer exist (new times or slot length) lose their sign-ups.
    const starts = new Set(slotStarts(next));
    for (const s of signupsOf(ctx, v.id)) if (!starts.has(s.slotStart)) ctx.db.del('vigilSignups', s.id);
    return detail(ctx, next);
  });

  r.del('/admin/vigils/:id', { perm: 'care' }, (ctx) => {
    const v = find(ctx, 'vigils', ctx.params[0], 'Vigil');
    for (const s of signupsOf(ctx, v.id)) ctx.db.del('vigilSignups', s.id);
    ctx.db.del('vigils', v.id);
    ctx.audit('deleted', 'vigils', v.id, `Removed ${v.name}`);
  });

  r.post('/admin/vigils/:id/signups', { perm: 'care' }, (ctx) => {
    const v = find(ctx, 'vigils', ctx.params[0], 'Vigil');
    const personId = String(ctx.body.personId ?? '');
    find(ctx, 'people', personId, 'Person');
    take(ctx, v, personId, String(ctx.body.slotStart ?? ''), 'office');
    return detail(ctx, v);
  });

  r.del('/admin/vigils/:id/signups/:sid', { perm: 'care' }, (ctx) => {
    const v = find(ctx, 'vigils', ctx.params[0], 'Vigil');
    const s = find(ctx, 'vigilSignups', ctx.params[1], 'Sign-up');
    if (s.vigilId === v.id) ctx.db.del('vigilSignups', s.id);
    return detail(ctx, v);
  });

  r.get('/me/vigils', {}, (ctx) => mine(ctx));
  r.post('/me/vigils/:id/slots', {}, (ctx) => {
    const v = find(ctx, 'vigils', ctx.params[0], 'Vigil');
    if (v.status !== 'open' || v.endsAt <= ctx.now.toISOString()) throw new ApiError(409, 'closed', 'This vigil is not taking sign-ups.');
    const start = new Date(String(ctx.body.slotStart ?? '')).toISOString();
    if (Date.parse(start) + v.slotMinutes * MIN <= ctx.now.getTime()) throw new ApiError(409, 'past', 'That slot has already passed.');
    take(ctx, v, ctx.me(), start, 'app');
    return mine(ctx);
  });
  r.del('/me/vigils/:id/slots', {}, (ctx) => {
    const start = new Date(String(ctx.query.slotStart ?? '')).toISOString();
    const s = signupsOf(ctx, ctx.params[0]).find((x) => x.personId === ctx.me() && x.slotStart === start);
    if (s) ctx.db.del('vigilSignups', s.id);
    return mine(ctx);
  });
}
