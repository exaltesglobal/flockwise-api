// Christmas carol rounds: which homes the carol team visits on which night, in what order, by
// which team; households ask for a visit and pick nights; the night before, they are told when
// to expect the singers; offerings taken at the door go straight into the giving ledger.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { CarolNight, CarolNightView, CarolRequest, CarolSeason, CarolSeasonView, CarolStop, CarolStopStatus, Collections, MyCarols } from '../types.js';
import { DAY, find, fullName, localDate, nextReceiptNumber, requireFields, settings } from '../util.js';
import { notify } from './notify.js';
import { familyKey } from './zones.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const STOP_STATUSES: CarolStopStatus[] = ['planned', 'visited', 'not_home', 'skipped'];
const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

type Family = { key: string; name: string; address: string | null; phone: string | null; personIds: string[]; zoneId: string | null };

/** Households of the church (people grouped by household), with the address and a phone to call from the gate. */
function familiesOf(ctx: Ctx, people = ctx.db.all('people').filter((p) => p.status !== 'inactive')): Family[] {
  const map = new Map<string, Collections['people'][]>();
  for (const p of people) map.set(familyKey(p), [...(map.get(familyKey(p)) ?? []), p]);
  return [...map.entries()].map(([key, members]) => ({
    key,
    name: key.startsWith('h:') ? key.slice(2) : fullName(members[0]),
    address: members.find((p) => p.address)?.address ?? null,
    phone: members.find((p) => p.phone)?.phone ?? null,
    personIds: members.map((p) => p.id),
    zoneId: members.find((p) => p.zoneId)?.zoneId ?? null,
  }));
}

const addMinutes = (hhmm: string, minutes: number) => {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + minutes;
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

/** Recomputes the arrival time of every stop from the night's start and the season's pace. */
function withEtas(season: CarolSeason, night: CarolNight): CarolNight {
  const stops = night.stops.map((s, i) => ({ ...s, eta: addMinutes(night.startTime, i * (season.minutesPerHouse + season.travelMinutes)) }));
  return { ...night, stops };
}

function mapsUrl(night: CarolNight) {
  const addrs = night.stops.map((s) => s.address).filter((a): a is string => !!a);
  return addrs.length ? `https://www.google.com/maps/dir/${addrs.map((a) => encodeURIComponent(a)).join('/')}` : '';
}

function nightView(night: CarolNight): CarolNightView {
  return {
    ...night,
    total: night.stops.length,
    visited: night.stops.filter((s) => s.status === 'visited').length,
    offering: night.stops.reduce((n, s) => n + (s.offering ?? 0), 0),
    mapsUrl: mapsUrl(night),
  };
}

const currentSeason = (ctx: Ctx): CarolSeason | null => ctx.db.all('carolSeasons').sort((a, b) => b.from.localeCompare(a.from))[0] ?? null;
const nightsOf = (ctx: Ctx, seasonId: string) => ctx.db.all('carolNights').filter((n) => n.seasonId === seasonId).sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
const requestsOf = (ctx: Ctx, seasonId: string) => ctx.db.all('carolRequests').filter((r) => r.seasonId === seasonId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

/** Dates in the season the team goes out on (not on the off days). */
export function nightDates(season: CarolSeason): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${season.from}T12:00:00Z`); t <= Date.parse(`${season.to}T12:00:00Z`); t += DAY) {
    const d = new Date(t);
    if (!season.offDays.includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function seasonView(ctx: Ctx, season: CarolSeason): CarolSeasonView {
  const nights = nightsOf(ctx, season.id).map(nightView);
  const placed = new Set(nights.flatMap((n) => n.stops.map((s) => s.familyKey)));
  const requests = requestsOf(ctx, season.id).map((r) => ({ ...r, placed: placed.has(r.familyKey) }));
  const zones = new Map(ctx.db.all('zones').map((z) => [z.id, z.name]));
  const families = new Map(familiesOf(ctx).map((f) => [f.key, f]));
  return {
    ...season,
    fundName: season.fundId ? ctx.db.get('funds', season.fundId)?.name ?? null : null,
    dates: nightDates(season),
    nights,
    requests,
    waiting: requests.filter((r) => !r.placed).map((r) => { const f = families.get(r.familyKey); return { familyKey: r.familyKey, familyName: r.familyName, address: f?.address ?? null, zoneName: f?.zoneId ? zones.get(f.zoneId) ?? null : null, preferredDates: r.preferredDates }; }),
    totals: {
      nights: nights.length,
      homes: nights.reduce((n, x) => n + x.total, 0),
      visited: nights.reduce((n, x) => n + x.visited, 0),
      offering: nights.reduce((n, x) => n + x.offering, 0),
      requests: requests.length,
    },
  };
}

function cleanSeason(ctx: Ctx, body: Record<string, unknown>, cur?: CarolSeason): CarolSeason {
  const year = Number(String(body.from ?? cur?.from ?? '').slice(0, 4)) || ctx.now.getUTCFullYear();
  const s: CarolSeason = {
    id: cur?.id ?? ctx.id('cs'),
    name: clean(body.name ?? cur?.name, 80) || `Christmas carols ${year}`,
    from: clean(body.from ?? cur?.from, 10),
    to: clean(body.to ?? cur?.to, 10),
    startTime: clean(body.startTime ?? cur?.startTime ?? '18:30', 5),
    minutesPerHouse: Math.min(60, Math.max(5, Number(body.minutesPerHouse ?? cur?.minutesPerHouse ?? 15) || 15)),
    travelMinutes: Math.min(60, Math.max(0, Number(body.travelMinutes ?? cur?.travelMinutes ?? 10) || 0)),
    housesPerNight: Math.min(40, Math.max(1, Number(body.housesPerNight ?? cur?.housesPerNight ?? 8) || 8)),
    offDays: Array.isArray(body.offDays) ? (body.offDays as unknown[]).map(Number).filter((d) => d >= 0 && d <= 6) : cur?.offDays ?? [0],
    fundId: body.fundId !== undefined ? (body.fundId ? find(ctx, 'funds', String(body.fundId), 'Fund').id : null) : cur?.fundId ?? null,
    message: clean(body.message ?? cur?.message ?? 'Our carol singers would love to visit your home this Christmas. Tell us which evenings suit you.', 600),
    createdAt: cur?.createdAt ?? ctx.now.toISOString(),
  };
  if (!DATE_RE.test(s.from) || !DATE_RE.test(s.to) || s.to < s.from) throw new ApiError(422, 'invalid', 'Give the first and last night of the rounds.', { from: 'YYYY-MM-DD', to: 'After the first night' });
  if (!TIME_RE.test(s.startTime)) throw new ApiError(422, 'invalid', 'Start time should look like 18:30.', { startTime: 'HH:MM' });
  return s;
}

function toStop(f: Family): CarolStop {
  return { familyKey: f.key, familyName: f.name, address: f.address, phone: f.phone, personIds: f.personIds, eta: '', status: 'planned', offering: null, note: '', visitedAt: null };
}

/** Rough nearness: homes sorted by the tail of the address (area, pincode) then the street, so a night stays in one area. */
const addressKey = (a: string | null) => (a ?? '').toLowerCase().split(',').map((x) => x.trim()).reverse().join(' ');

/**
 * Builds the nights: homes from the chosen zones (and every household that asked), grouped by zone,
 * in address order, `housesPerNight` a night, one team a night in turn. Nights already visited stay.
 */
function plan(ctx: Ctx, season: CarolSeason, body: Record<string, unknown>): CarolSeasonView {
  const zoneIds = Array.isArray(body.zoneIds) ? (body.zoneIds as unknown[]).map(String).filter((id) => ctx.db.get('zones', id)) : [];
  const teams = (Array.isArray(body.teamIds) ? (body.teamIds as unknown[]).map(String) : []).map((id) => ctx.db.get('teams', id)).filter((t): t is Collections['teams'] => !!t);
  const onlyRequests = !!body.onlyRequests;
  const zones = new Map(ctx.db.all('zones').map((z) => [z.id, z.name]));
  const all = familiesOf(ctx);
  const requests = requestsOf(ctx, season.id);
  const asked = new Set(requests.map((r) => r.familyKey));
  const kept = nightsOf(ctx, season.id).filter((n) => n.stops.some((s) => s.status !== 'planned'));
  for (const n of nightsOf(ctx, season.id)) if (!kept.includes(n)) ctx.db.del('carolNights', n.id);
  const already = new Set(kept.flatMap((n) => n.stops.map((s) => s.familyKey)));
  const usedDates = new Map<string, number>();
  for (const n of kept) usedDates.set(n.date, (usedDates.get(n.date) ?? 0) + 1);

  const homes = all.filter((f) => !already.has(f.key) && (asked.has(f.key) || (!onlyRequests && f.zoneId && zoneIds.includes(f.zoneId))));
  // Group by zone, requested homes first inside each zone, then by address.
  const groups = new Map<string, Family[]>();
  for (const f of homes) groups.set(f.zoneId ?? '', [...(groups.get(f.zoneId ?? '') ?? []), f]);
  const dates = nightDates(season).filter((d) => d >= localDate(ctx, ctx.now) || true);
  let di = 0;
  let ti = 0;
  const made: CarolNight[] = [];
  const nextDate = () => {
    // Several teams can go out the same night, one night per team; otherwise move to the next date.
    for (let k = 0; k < dates.length * Math.max(1, teams.length); k++) {
      const d = dates[di % dates.length];
      const used = usedDates.get(d) ?? 0;
      if (used < Math.max(1, teams.length)) { usedDates.set(d, used + 1); if (used + 1 >= Math.max(1, teams.length)) di++; return d; }
      di++;
    }
    return dates[dates.length - 1] ?? season.to;
  };
  for (const [zoneId, fams] of [...groups.entries()].sort((a, b) => (zones.get(a[0]) ?? '').localeCompare(zones.get(b[0]) ?? ''))) {
    fams.sort((a, b) => Number(asked.has(b.key)) - Number(asked.has(a.key)) || addressKey(a.address).localeCompare(addressKey(b.address)));
    for (let i = 0; i < fams.length; i += season.housesPerNight) {
      const chunk = fams.slice(i, i + season.housesPerNight);
      // If everyone in this chunk asked for the same night, use it.
      const wanted = chunk.map((f) => requests.find((r) => r.familyKey === f.key)?.preferredDates[0]).filter((d): d is string => !!d && dates.includes(d));
      const team = teams.length ? teams[ti++ % teams.length] : null;
      const date = wanted.length && wanted.every((d) => d === wanted[0]) && (usedDates.get(wanted[0]) ?? 0) < Math.max(1, teams.length) ? (usedDates.set(wanted[0], (usedDates.get(wanted[0]) ?? 0) + 1), wanted[0]) : nextDate();
      const leader = team?.leaderId ? ctx.db.get('people', team.leaderId) : null;
      const night: CarolNight = {
        id: ctx.id('cn'), seasonId: season.id, date, startTime: season.startTime, teamId: team?.id ?? null, teamName: team?.name ?? '', leaderName: leader ? fullName(leader) : '',
        zoneId: zoneId || null, area: zones.get(zoneId) ?? 'Requested homes', stops: chunk.map(toStop), notes: '', createdAt: ctx.now.toISOString(),
      };
      made.push(withEtas(season, night));
    }
  }
  for (const n of made) ctx.db.put('carolNights', n);
  ctx.audit('planned', 'carols', season.id, `Planned ${made.length} carol nights for ${made.reduce((x, n) => x + n.stops.length, 0)} homes`);
  return seasonView(ctx, season);
}

/** Marks a stop; an offering at the door goes into the season's fund as a cash gift from the family. */
function updateStop(ctx: Ctx, night: CarolNight, key: string, body: Record<string, unknown>, by: string): CarolNightView {
  const season = find(ctx, 'carolSeasons', night.seasonId, 'Season');
  const i = night.stops.findIndex((s) => s.familyKey === key);
  if (i < 0) throw new ApiError(404, 'not_found', 'That home is not on this route.');
  const stop = { ...night.stops[i] };
  if (body.status !== undefined) {
    if (!STOP_STATUSES.includes(body.status as CarolStopStatus)) throw new ApiError(422, 'invalid', 'Unknown status.');
    stop.status = body.status as CarolStopStatus;
    stop.visitedAt = stop.status === 'visited' ? stop.visitedAt ?? ctx.now.toISOString() : null;
  }
  if (body.note !== undefined) stop.note = clean(body.note, 500);
  if (body.offering !== undefined) {
    const amount = body.offering === null || body.offering === '' ? null : Math.round(Number(body.offering));
    if (amount !== null && !(amount >= 0)) throw new ApiError(422, 'invalid', 'Enter the offering amount.', { offering: 'A number' });
    const before = stop.offering ?? 0;
    stop.offering = amount;
    const fund = season.fundId ? ctx.db.get('funds', season.fundId) : null;
    // Record the difference as a cash gift so the ledger and the stop agree even after a correction.
    const diff = (amount ?? 0) - before;
    if (fund && diff !== 0) {
      const donor = ctx.db.get('people', stop.personIds[0]);
      const at = ctx.now.toISOString();
      ctx.db.put('donations', {
        id: ctx.id('dn'), donorId: donor?.id ?? null, donorName: stop.familyName, donorEmail: donor?.email ?? null, donorPhone: donor?.phone ?? null,
        fundId: fund.id, fundName: fund.name, amount: diff, currency: settings(ctx).currency, frequency: 'once', status: 'succeeded', method: 'cash', pan: null,
        donorCitizenship: 'IN', fcra: false, provider: 'offline', providerRef: null, providerPaymentId: null, createdAt: at, paidAt: at, eventId: null,
        receiptNumber: diff > 0 ? nextReceiptNumber(ctx) : null, batchId: null,
      });
      ctx.audit('recorded', 'donation', null, `Carol offering from ${stop.familyName} on ${night.date} (${night.area}), taken by ${by}`);
    }
  }
  const stops = [...night.stops];
  stops[i] = stop;
  const saved = ctx.db.put('carolNights', { ...night, stops });
  return nightView(saved);
}

/** The night before, each home on a route is told roughly when the singers come. Called from the daily tick. */
export async function carolReminders(ctx: Ctx, today: string) {
  const season = currentSeason(ctx);
  if (!season) return;
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + DAY).toISOString().slice(0, 10);
  const church = settings(ctx).name;
  for (const n of nightsOf(ctx, season.id).filter((n) => n.date === tomorrow)) {
    for (const s of n.stops.filter((s) => s.status === 'planned')) {
      await notify(ctx, 'carol.visit', { personIds: s.personIds, title: `${church}: carol singers tomorrow`, body: `Our carol team${n.teamName ? ` (${n.teamName})` : ''} plans to reach your home around ${s.eta} tomorrow. Reply here if the time does not suit.`, link: '/app/carols' });
    }
  }
}

export function registerCarols(r: Router) {
  // ----- office -----
  r.get('/admin/carols', { perm: ['people.view', 'care', 'services'] }, (ctx) => {
    const season = currentSeason(ctx);
    return {
      season: season ? seasonView(ctx, season) : null,
      seasons: ctx.db.all('carolSeasons').sort((a, b) => b.from.localeCompare(a.from)).map((s) => ({ id: s.id, name: s.name, from: s.from, to: s.to })),
      zones: ctx.db.all('zones').filter((z) => z.active).sort((a, b) => a.name.localeCompare(b.name)).map((z) => ({ id: z.id, name: z.name, homes: familiesOf(ctx).filter((f) => f.zoneId === z.id).length })),
      teams: ctx.db.all('teams').map((t) => ({ id: t.id, name: t.name })),
      funds: ctx.db.all('funds').map((f) => ({ id: f.id, name: f.name })),
      currency: settings(ctx).currency,
    };
  });
  r.get('/admin/carols/seasons/:id', { perm: ['people.view', 'care', 'services'] }, (ctx) => seasonView(ctx, find(ctx, 'carolSeasons', ctx.params[0], 'Season')));
  r.post('/admin/carols/seasons', { perm: 'care' }, (ctx) => {
    requireFields(ctx.body, ['from', 'to']);
    const s = ctx.db.put('carolSeasons', cleanSeason(ctx, ctx.body));
    ctx.audit('created', 'carols', s.id, `Started ${s.name}`);
    return seasonView(ctx, s);
  });
  r.patch('/admin/carols/seasons/:id', { perm: 'care' }, (ctx) => {
    const cur = find(ctx, 'carolSeasons', ctx.params[0], 'Season');
    const s = ctx.db.put('carolSeasons', cleanSeason(ctx, ctx.body, cur));
    // A new pace or start time moves every arrival time.
    for (const n of nightsOf(ctx, s.id)) ctx.db.put('carolNights', withEtas(s, n));
    return seasonView(ctx, s);
  });
  r.del('/admin/carols/seasons/:id', { perm: 'care' }, (ctx) => {
    const s = find(ctx, 'carolSeasons', ctx.params[0], 'Season');
    for (const n of nightsOf(ctx, s.id)) ctx.db.del('carolNights', n.id);
    for (const q of requestsOf(ctx, s.id)) ctx.db.del('carolRequests', q.id);
    ctx.db.del('carolSeasons', s.id);
    ctx.audit('deleted', 'carols', s.id, `Removed ${s.name}`);
    return undefined;
  });
  r.post('/admin/carols/seasons/:id/plan', { perm: 'care' }, (ctx) => plan(ctx, find(ctx, 'carolSeasons', ctx.params[0], 'Season'), ctx.body));

  r.post('/admin/carols/seasons/:id/nights', { perm: 'care' }, (ctx) => {
    const season = find(ctx, 'carolSeasons', ctx.params[0], 'Season');
    const date = clean(ctx.body.date, 10);
    if (!DATE_RE.test(date)) throw new ApiError(422, 'invalid', 'Pick the night.', { date: 'YYYY-MM-DD' });
    const team = ctx.body.teamId ? find(ctx, 'teams', String(ctx.body.teamId), 'Team') : null;
    const leader = team?.leaderId ? ctx.db.get('people', team.leaderId) : null;
    const n = ctx.db.put('carolNights', { id: ctx.id('cn'), seasonId: season.id, date, startTime: TIME_RE.test(String(ctx.body.startTime)) ? String(ctx.body.startTime) : season.startTime, teamId: team?.id ?? null, teamName: team?.name ?? '', leaderName: leader ? fullName(leader) : '', zoneId: null, area: clean(ctx.body.area, 80) || 'Extra night', stops: [], notes: '', createdAt: ctx.now.toISOString() });
    return nightView(n);
  });
  r.patch('/admin/carols/nights/:id', { perm: 'care' }, (ctx) => {
    const n = find(ctx, 'carolNights', ctx.params[0], 'Night');
    const season = find(ctx, 'carolSeasons', n.seasonId, 'Season');
    const next = { ...n };
    if (ctx.body.date !== undefined) { if (!DATE_RE.test(String(ctx.body.date))) throw new ApiError(422, 'invalid', 'Pick the night.', { date: 'YYYY-MM-DD' }); next.date = String(ctx.body.date); }
    if (ctx.body.startTime !== undefined) { if (!TIME_RE.test(String(ctx.body.startTime))) throw new ApiError(422, 'invalid', 'Start time should look like 18:30.'); next.startTime = String(ctx.body.startTime); }
    if (ctx.body.teamId !== undefined) {
      const team = ctx.body.teamId ? find(ctx, 'teams', String(ctx.body.teamId), 'Team') : null;
      const leader = team?.leaderId ? ctx.db.get('people', team.leaderId) : null;
      next.teamId = team?.id ?? null; next.teamName = team?.name ?? ''; next.leaderName = leader ? fullName(leader) : '';
    }
    if (ctx.body.area !== undefined) next.area = clean(ctx.body.area, 80) || n.area;
    if (ctx.body.notes !== undefined) next.notes = clean(ctx.body.notes, 2000);
    if (Array.isArray(ctx.body.order)) {
      const order = (ctx.body.order as unknown[]).map(String);
      next.stops = [...n.stops].sort((a, b) => (order.indexOf(a.familyKey) + 1 || 999) - (order.indexOf(b.familyKey) + 1 || 999));
    }
    return nightView(ctx.db.put('carolNights', withEtas(season, next)));
  });
  r.del('/admin/carols/nights/:id', { perm: 'care' }, (ctx) => { find(ctx, 'carolNights', ctx.params[0], 'Night'); ctx.db.del('carolNights', ctx.params[0]); return undefined; });
  r.post('/admin/carols/nights/:id/stops', { perm: 'care' }, (ctx) => {
    const n = find(ctx, 'carolNights', ctx.params[0], 'Night');
    const season = find(ctx, 'carolSeasons', n.seasonId, 'Season');
    const person = ctx.body.personId ? find(ctx, 'people', String(ctx.body.personId), 'Person') : null;
    const key = person ? familyKey(person) : clean(ctx.body.familyKey, 120);
    const f = familiesOf(ctx).find((x) => x.key === key);
    if (!f) throw new ApiError(422, 'invalid', 'Choose the home to add.', { personId: 'Required' });
    if (n.stops.some((s) => s.familyKey === key)) throw new ApiError(409, 'duplicate', `${f.name} is already on this route.`);
    return nightView(ctx.db.put('carolNights', withEtas(season, { ...n, stops: [...n.stops, toStop(f)] })));
  });
  r.del('/admin/carols/nights/:id/stops/:key', { perm: 'care' }, (ctx) => {
    const n = find(ctx, 'carolNights', ctx.params[0], 'Night');
    const season = find(ctx, 'carolSeasons', n.seasonId, 'Season');
    return nightView(ctx.db.put('carolNights', withEtas(season, { ...n, stops: n.stops.filter((s) => s.familyKey !== ctx.params[1]) })));
  });
  r.patch('/admin/carols/nights/:id/stops/:key', { perm: 'care' }, (ctx) => updateStop(ctx, find(ctx, 'carolNights', ctx.params[0], 'Night'), ctx.params[1], ctx.body, ctx.staff?.name ?? 'Church office'));

  // ----- member app: ask for a visit, see when the singers come -----
  r.get('/me/carols', {}, (ctx): MyCarols => {
    const season = currentSeason(ctx);
    if (!season || season.to < localDate(ctx, ctx.now)) return { season: null, visit: null, request: null, dates: [] };
    const me = find(ctx, 'people', ctx.me(), 'Person');
    const key = familyKey(me);
    const night = nightsOf(ctx, season.id).find((n) => n.stops.some((s) => s.familyKey === key));
    const stop = night?.stops.find((s) => s.familyKey === key);
    return {
      season: { id: season.id, name: season.name, from: season.from, to: season.to, message: season.message },
      visit: night && stop ? { date: night.date, eta: stop.eta, teamName: night.teamName, status: stop.status } : null,
      request: requestsOf(ctx, season.id).find((q) => q.familyKey === key) ?? null,
      dates: nightDates(season),
    };
  });
  r.post('/me/carols/request', {}, (ctx) => {
    const season = currentSeason(ctx);
    if (!season) throw new ApiError(404, 'not_found', 'Carol rounds are not open yet.');
    const me = find(ctx, 'people', ctx.me(), 'Person');
    const key = familyKey(me);
    const allowed = nightDates(season);
    const preferredDates = (Array.isArray(ctx.body.preferredDates) ? (ctx.body.preferredDates as unknown[]).map(String) : []).filter((d) => allowed.includes(d)).slice(0, 5);
    const cur = requestsOf(ctx, season.id).find((q) => q.familyKey === key);
    const q: CarolRequest = { id: cur?.id ?? ctx.id('cq'), seasonId: season.id, familyKey: key, familyName: key.startsWith('h:') ? key.slice(2) : fullName(me), personId: me.id, preferredDates, note: clean(ctx.body.note, 300), createdAt: cur?.createdAt ?? ctx.now.toISOString() };
    ctx.db.put('carolRequests', q);
    return q;
  });
  r.del('/me/carols/request', {}, (ctx) => {
    const season = currentSeason(ctx);
    const me = find(ctx, 'people', ctx.me(), 'Person');
    if (season) for (const q of requestsOf(ctx, season.id)) if (q.familyKey === familyKey(me)) ctx.db.del('carolRequests', q.id);
    return undefined;
  });

  // ----- team app: tonight's route for the carol team -----
  const onTeam = (ctx: Ctx, teamId: string) => {
    const t = find(ctx, 'teams', teamId, 'Team');
    const me = ctx.staff ? null : ctx.me();
    if (!ctx.staff && !(t.leaderId === me || t.members.some((m) => m.personId === me))) throw new ApiError(403, 'forbidden', 'You are not on this team.');
    return t;
  };
  r.get('/team/:teamId/carols', {}, (ctx) => {
    const t = onTeam(ctx, ctx.params[0]);
    const season = currentSeason(ctx);
    if (!season) return { season: null, nights: [] };
    return { season: { id: season.id, name: season.name, fundName: season.fundId ? ctx.db.get('funds', season.fundId)?.name ?? null : null }, nights: nightsOf(ctx, season.id).filter((n) => n.teamId === t.id).map(nightView) };
  });
  r.patch('/team/:teamId/carols/:nightId/stops/:key', {}, (ctx) => {
    const t = onTeam(ctx, ctx.params[0]);
    const n = find(ctx, 'carolNights', ctx.params[1], 'Night');
    if (n.teamId !== t.id) throw new ApiError(403, 'forbidden', 'This route belongs to another team.');
    const by = ctx.staff?.name ?? fullName(find(ctx, 'people', ctx.me(), 'Person'));
    return updateStop(ctx, n, ctx.params[2], ctx.body, by);
  });
}
