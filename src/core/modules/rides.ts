// Sunday transport matcher: households that need a lift to the service, members who can drive,
// matched by zone with the seats they have. The office matches in one click or by hand, both sides
// are told, and a reminder goes out the day before.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { Collections, MyRides, RideOffer, RideOfferView, RideRequest, RideRequestView, RidesHub } from '../types.js';
import { find, fullName, localDate, settings } from '../util.js';
import { notify } from './notify.js';
import { familyKey } from './zones.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;
const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
const count = (v: unknown, fallback: number, max: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : fallback; };
const isSunday = (d: string) => DATE_RE.test(d) && new Date(`${d}T12:00:00Z`).getUTCDay() === 0;

/** The next `n` Sundays in church time, today included when it is a Sunday. */
export function sundaysAhead(ctx: Ctx, n = 4): string[] {
  let t = Date.parse(`${localDate(ctx, ctx.now)}T12:00:00Z`);
  while (new Date(t).getUTCDay() !== 0) t += DAY;
  return Array.from({ length: n }, (_, i) => new Date(t + i * 7 * DAY).toISOString().slice(0, 10));
}

function pickSunday(ctx: Ctx, wanted: unknown): string {
  const s = clean(wanted, 10);
  if (!s) return sundaysAhead(ctx, 1)[0];
  if (!isSunday(s)) throw new ApiError(422, 'validation', 'Pick a Sunday (YYYY-MM-DD).');
  return s;
}

/** Rows that apply to a Sunday: dated for it, or weekly and started on or before it. */
const applies = (r: { date: string; weekly: boolean; status: string }, sunday: string) => r.status !== 'cancelled' && (r.date === sunday || (r.weekly && r.date <= sunday));
const requestsFor = (ctx: Ctx, sunday: string) => ctx.db.all('rideRequests').filter((q) => applies(q, sunday));
const offersFor = (ctx: Ctx, sunday: string) => ctx.db.all('rideOffers').filter((o) => applies(o, sunday));
const zoneName = (ctx: Ctx, id: string | null) => (id ? ctx.db.get('zones', id)?.name ?? null : null);

/** The first service that Sunday, as HH:MM in church time, from the events calendar. */
export function serviceTime(ctx: Ctx, sunday: string): string | null {
  const ev = ctx.db.all('events').filter((e) => e.kind === 'service' && localDate(ctx, new Date(e.startsAt)) === sunday).sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
  if (!ev) return null;
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: settings(ctx).timezone || 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ev.startsAt)); } catch { return ev.startsAt.slice(11, 16); }
}

/** Where a person's household lives and who to call: the address and phone of anyone in it. */
function household(ctx: Ctx, p: Collections['people']) {
  const key = familyKey(p);
  const members = ctx.db.all('people').filter((x) => x.status !== 'inactive' && familyKey(x) === key);
  return {
    familyKey: key,
    familyName: key.startsWith('h:') ? key.slice(2) : fullName(p),
    phone: p.phone ?? members.find((x) => x.phone)?.phone ?? null,
    address: p.address ?? members.find((x) => x.address)?.address ?? null,
    zoneId: p.zoneId ?? members.find((x) => x.zoneId)?.zoneId ?? null,
    personIds: members.map((x) => x.id),
  };
}
const householdIds = (ctx: Ctx, key: string) => ctx.db.all('people').filter((x) => x.status !== 'inactive' && familyKey(x) === key).map((x) => x.id);

/** The driver a request rides with that Sunday: a one-off offer matched to a weekly request only counts on its own Sunday. */
function driverFor(ctx: Ctx, q: RideRequest, sunday: string): RideOffer | null {
  const o = q.offerId ? ctx.db.get('rideOffers', q.offerId) : null;
  return o && applies(o, sunday) ? o : null;
}
/** The Sunday a row is about: its own date, or the next one it applies to when weekly. */
const sundayFor = (ctx: Ctx, r: { date: string; weekly: boolean }) => (r.weekly ? [r.date, sundaysAhead(ctx, 1)[0]].sort()[1] : r.date);

function requestView(ctx: Ctx, q: RideRequest, sunday: string): RideRequestView {
  const o = driverFor(ctx, q, sunday);
  return { ...q, status: q.status === 'cancelled' ? 'cancelled' : o ? 'matched' : 'waiting', zoneName: zoneName(ctx, q.zoneId), driver: o ? { id: o.id, name: o.driverName, phone: o.phone, address: o.address } : null };
}
function offerView(ctx: Ctx, o: RideOffer, sunday: string): RideOfferView {
  const riders = requestsFor(ctx, sunday).filter((q) => q.offerId === o.id);
  const taken = riders.reduce((s, q) => s + q.people, 0);
  return { ...o, zoneName: zoneName(ctx, o.zoneId), seatsLeft: Math.max(0, o.seats - taken), riders: riders.map((q) => ({ id: q.id, familyName: q.familyName, people: q.people, phone: q.phone, address: q.address, zoneName: zoneName(ctx, q.zoneId), note: q.note })) };
}

export function hub(ctx: Ctx, sunday: string): RidesHub {
  const requests = requestsFor(ctx, sunday).map((q) => requestView(ctx, q, sunday)).sort((a, b) => Number(!!a.driver) - Number(!!b.driver) || (a.zoneName ?? '').localeCompare(b.zoneName ?? '') || a.familyName.localeCompare(b.familyName));
  const offers = offersFor(ctx, sunday).map((o) => offerView(ctx, o, sunday)).sort((a, b) => (a.zoneName ?? '').localeCompare(b.zoneName ?? '') || a.driverName.localeCompare(b.driverName));
  return {
    sunday, sundays: sundaysAhead(ctx), serviceTime: serviceTime(ctx, sunday), requests, offers,
    zones: ctx.db.all('zones').filter((z) => z.active).map((z) => ({ id: z.id, name: z.name })).sort((a, b) => a.name.localeCompare(b.name)),
    waiting: requests.filter((q) => !q.driver).length, matched: requests.filter((q) => q.driver).length, seatsLeft: offers.reduce((s, o) => s + o.seatsLeft, 0),
  };
}

async function tellMatched(ctx: Ctx, q: RideRequest, o: RideOffer, sunday: string) {
  const church = settings(ctx).name;
  const at = serviceTime(ctx, sunday);
  const when = `${new Date(`${sunday}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' })}${at ? ` (service at ${at})` : ''}`;
  await notify(ctx, 'ride.update', { personIds: householdIds(ctx, q.familyKey), title: `${church}: your lift on Sunday`, body: `${o.driverName} will pick you up for ${when}.${o.phone ? ` Call or WhatsApp ${o.phone} to agree a time.` : ''}`, link: '/app/rides' });
  await notify(ctx, 'ride.update', { personIds: [o.personId], title: `${church}: you are giving a lift`, body: `${q.familyName} (${q.people}) ride with you on ${when}.${q.address ? ` Pick up: ${q.address}.` : ''}${q.phone ? ` Phone ${q.phone}.` : ''}`, link: '/app/rides' });
}

/** Matches waiting households to drivers in the same zone with seats to spare; `anyZone` then fills from any zone. */
export async function matchSunday(ctx: Ctx, sunday: string, anyZone = false): Promise<number> {
  let made = 0;
  const offers = offersFor(ctx, sunday);
  const left = new Map(offers.map((o) => [o.id, offerView(ctx, o, sunday).seatsLeft]));
  const waiting = requestsFor(ctx, sunday).filter((q) => !driverFor(ctx, q, sunday)).sort((a, b) => b.people - a.people || a.createdAt.localeCompare(b.createdAt));
  for (const q of waiting) {
    const fits = (o: RideOffer) => (left.get(o.id) ?? 0) >= q.people;
    // The tightest fit first, so a car with one seat spare takes the single rider and the van keeps room for a family.
    const pick = [...offers.filter((o) => o.zoneId && o.zoneId === q.zoneId && fits(o)), ...(anyZone ? offers.filter((o) => fits(o)) : [])].sort((a, b) => (left.get(a.id) ?? 0) - (left.get(b.id) ?? 0))[0];
    if (!pick) continue;
    left.set(pick.id, (left.get(pick.id) ?? 0) - q.people);
    ctx.db.put('rideRequests', { ...q, offerId: pick.id, status: 'matched' });
    ctx.audit('matched', 'ride', q.id, `${q.familyName} (${q.people}) ride with ${pick.driverName} on ${sunday}`);
    await tellMatched(ctx, q, pick, sunday);
    made += 1;
  }
  return made;
}

/** The day before a Sunday with lifts, riders and drivers are reminded. Called from the daily tick. */
export async function rideReminders(ctx: Ctx, today: string) {
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + DAY).toISOString().slice(0, 10);
  if (!isSunday(tomorrow)) return;
  const church = settings(ctx).name;
  const at = serviceTime(ctx, tomorrow);
  for (const o of offersFor(ctx, tomorrow)) {
    const riders = requestsFor(ctx, tomorrow).filter((q) => q.offerId === o.id);
    if (!riders.length) continue;
    for (const q of riders) await notify(ctx, 'ride.update', { personIds: householdIds(ctx, q.familyKey), title: `${church}: lift tomorrow`, body: `${o.driverName} picks you up tomorrow${at ? ` for the ${at} service` : ''}.${o.phone ? ` Phone ${o.phone}.` : ''}`, link: '/app/rides' });
    await notify(ctx, 'ride.update', { personIds: [o.personId], title: `${church}: lifts tomorrow`, body: `Tomorrow you drive ${riders.map((q) => `${q.familyName} (${q.people})`).join(', ')}${at ? ` for the ${at} service` : ''}.`, link: '/app/rides' });
  }
}

function newRequest(ctx: Ctx, p: Collections['people'], body: Record<string, unknown>, by: string): RideRequest {
  const sunday = pickSunday(ctx, body.sunday);
  const h = household(ctx, p);
  const dup = requestsFor(ctx, sunday).find((q) => q.familyKey === h.familyKey);
  if (dup) throw new ApiError(409, 'duplicate', `${h.familyName} already asked for a lift that Sunday.`);
  const q: RideRequest = { id: ctx.id('rq'), date: sunday, weekly: body.weekly === true, personId: p.id, familyKey: h.familyKey, familyName: h.familyName, phone: h.phone, address: h.address, zoneId: h.zoneId, people: count(body.people, 1, 12), note: clean(body.note, 300), offerId: null, status: 'waiting', createdAt: ctx.now.toISOString(), createdBy: by };
  ctx.db.put('rideRequests', q);
  ctx.audit('asked', 'ride', q.id, `${q.familyName} (${q.people}) need a lift on ${sunday}${q.weekly ? ' and every Sunday' : ''}`);
  return q;
}
function newOffer(ctx: Ctx, p: Collections['people'], body: Record<string, unknown>, by: string): RideOffer {
  const sunday = pickSunday(ctx, body.sunday);
  if (offersFor(ctx, sunday).some((o) => o.personId === p.id)) throw new ApiError(409, 'duplicate', `${fullName(p)} is already down to drive that Sunday.`);
  const h = household(ctx, p);
  const o: RideOffer = { id: ctx.id('ro'), date: sunday, weekly: body.weekly === true, personId: p.id, driverName: fullName(p), phone: p.phone ?? h.phone, address: p.address ?? h.address, zoneId: h.zoneId, seats: count(body.seats, 3, 20), note: clean(body.note, 300), status: 'open', createdAt: ctx.now.toISOString(), createdBy: by };
  ctx.db.put('rideOffers', o);
  ctx.audit('offered', 'ride', o.id, `${o.driverName} can drive ${o.seats} on ${sunday}${o.weekly ? ' and every Sunday' : ''}`);
  return o;
}
/** Takes an offer off the board; its riders go back to waiting and are told. */
async function dropOffer(ctx: Ctx, o: RideOffer) {
  const riders = ctx.db.all('rideRequests').filter((q) => q.offerId === o.id && q.status === 'matched');
  for (const q of riders) {
    ctx.db.put('rideRequests', { ...q, offerId: null, status: 'waiting' });
    await notify(ctx, 'ride.update', { personIds: householdIds(ctx, q.familyKey), title: `${settings(ctx).name}: lift changed`, body: `${o.driverName} can no longer give you a lift. The office is finding another driver.`, link: '/app/rides' });
  }
  ctx.db.put('rideOffers', { ...o, status: 'cancelled' });
  ctx.audit('withdrew', 'ride', o.id, `${o.driverName} no longer drives on ${o.date}${riders.length ? ` (${riders.length} back to waiting)` : ''}`);
}

export function registerRides(r: Router) {
  // ----- office -----
  r.get('/admin/rides', { perm: ['care', 'people.view'] }, (ctx) => hub(ctx, pickSunday(ctx, ctx.query.sunday)));
  r.post('/admin/rides/match', { perm: 'care' }, async (ctx) => {
    const sunday = pickSunday(ctx, ctx.body.sunday);
    const made = await matchSunday(ctx, sunday, ctx.body.anyZone === true);
    return { ...hub(ctx, sunday), made };
  });
  r.post('/admin/rides/requests', { perm: 'care' }, (ctx) => { const q = newRequest(ctx, find(ctx, 'people', String(ctx.body.personId ?? ''), 'Person'), ctx.body, ctx.staff?.name ?? 'office'); return requestView(ctx, q, q.date); });
  r.patch('/admin/rides/requests/:id', { perm: 'care' }, async (ctx) => {
    const q = find(ctx, 'rideRequests', ctx.params[0], 'Lift request');
    let next: RideRequest = { ...q };
    if (ctx.body.people !== undefined) next.people = count(ctx.body.people, q.people, 12);
    if (ctx.body.note !== undefined) next.note = clean(ctx.body.note, 300);
    if (ctx.body.status === 'cancelled') next = { ...next, status: 'cancelled', offerId: null };
    if (ctx.body.offerId !== undefined) {
      if (ctx.body.offerId === null) next = { ...next, offerId: null, status: next.status === 'cancelled' ? 'cancelled' : 'waiting' };
      else {
        const o = find(ctx, 'rideOffers', String(ctx.body.offerId), 'Driver');
        if (o.status === 'cancelled') throw new ApiError(409, 'cancelled', 'That driver is no longer on the board.');
        next = { ...next, offerId: o.id, status: 'matched' };
        ctx.db.put('rideRequests', next);
        ctx.audit('matched', 'ride', q.id, `${q.familyName} ride with ${o.driverName} on ${q.date}`);
        await tellMatched(ctx, next, o, sundayFor(ctx, q));
        return requestView(ctx, next, sundayFor(ctx, q));
      }
    }
    ctx.db.put('rideRequests', next);
    return requestView(ctx, next, sundayFor(ctx, q));
  });
  r.del('/admin/rides/requests/:id', { perm: 'care' }, (ctx) => { const q = find(ctx, 'rideRequests', ctx.params[0], 'Lift request'); ctx.db.put('rideRequests', { ...q, status: 'cancelled', offerId: null }); return { ok: true }; });
  r.post('/admin/rides/offers', { perm: 'care' }, (ctx) => { const o = newOffer(ctx, find(ctx, 'people', String(ctx.body.personId ?? ''), 'Person'), ctx.body, ctx.staff?.name ?? 'office'); return offerView(ctx, o, o.date); });
  r.patch('/admin/rides/offers/:id', { perm: 'care' }, (ctx) => {
    const o = find(ctx, 'rideOffers', ctx.params[0], 'Driver');
    const next: RideOffer = { ...o, seats: ctx.body.seats !== undefined ? count(ctx.body.seats, o.seats, 20) : o.seats, note: ctx.body.note !== undefined ? clean(ctx.body.note, 300) : o.note, weekly: typeof ctx.body.weekly === 'boolean' ? ctx.body.weekly : o.weekly };
    ctx.db.put('rideOffers', next);
    return offerView(ctx, next, next.date);
  });
  r.del('/admin/rides/offers/:id', { perm: 'care' }, async (ctx) => { await dropOffer(ctx, find(ctx, 'rideOffers', ctx.params[0], 'Driver')); return { ok: true }; });

  // ----- member app -----
  const mine = (ctx: Ctx, sunday: string): MyRides => {
    const me = find(ctx, 'people', ctx.me(), 'Person');
    const key = familyKey(me);
    const q = requestsFor(ctx, sunday).find((x) => x.familyKey === key) ?? null;
    const o = offersFor(ctx, sunday).find((x) => x.personId === me.id) ?? null;
    return { sunday, sundays: sundaysAhead(ctx), serviceTime: serviceTime(ctx, sunday), request: q ? requestView(ctx, q, sunday) : null, offer: o ? offerView(ctx, o, sunday) : null };
  };
  r.get('/me/rides', {}, (ctx) => mine(ctx, pickSunday(ctx, ctx.query.sunday)));
  r.post('/me/rides/request', {}, (ctx) => { const me = find(ctx, 'people', ctx.me(), 'Person'); const q = newRequest(ctx, me, ctx.body, fullName(me)); return mine(ctx, q.date); });
  r.del('/me/rides/request', {}, (ctx) => {
    const me = find(ctx, 'people', ctx.me(), 'Person');
    const sunday = pickSunday(ctx, ctx.query.sunday);
    const q = requestsFor(ctx, sunday).find((x) => x.familyKey === familyKey(me));
    if (q) { ctx.db.put('rideRequests', { ...q, status: 'cancelled', offerId: null }); ctx.audit('withdrew', 'ride', q.id, `${q.familyName} no longer need a lift on ${sunday}`); }
    return mine(ctx, sunday);
  });
  r.post('/me/rides/offer', {}, (ctx) => { const me = find(ctx, 'people', ctx.me(), 'Person'); const o = newOffer(ctx, me, ctx.body, fullName(me)); return mine(ctx, o.date); });
  r.del('/me/rides/offer', {}, async (ctx) => {
    const me = find(ctx, 'people', ctx.me(), 'Person');
    const sunday = pickSunday(ctx, ctx.query.sunday);
    const o = offersFor(ctx, sunday).find((x) => x.personId === me.id);
    if (o) await dropOffer(ctx, o);
    return mine(ctx, sunday);
  });
}
