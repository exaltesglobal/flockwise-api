// Camps & retreats: the youth camp, the family retreat, the women's conference out of town. Members
// sign their family up from the app with medical and emergency details; the office sees who is
// going, records payments, and fills rooms and bus seats in one tap (by gender, families kept
// together where a family room has space), then adjusts by hand.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { Camp, CampBus, CampDetail, CampRoom, CampSignup, CampSignupView, CampView, MyCamp } from '../types.js';
import { age, find, fullName, localDate } from '../util.js';
import { household, parent } from './family.js';
import { notify } from './notify.js';
import { permsOf } from '../perms.js';
import { normEmail } from '../util.js';

const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
const isDate = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));
const ROOM_FOR: CampRoom['for'][] = ['any', 'male', 'female', 'family'];
const going = (ctx: Ctx, campId: string) => ctx.db.all('campSignups').filter((s) => s.campId === campId && s.status === 'going');

function readRooms(ctx: Ctx, v: unknown, prev: CampRoom[]): CampRoom[] {
  if (!Array.isArray(v)) return prev;
  return (v as Record<string, unknown>[]).slice(0, 200).map((r) => ({
    id: typeof r.id === 'string' && r.id ? r.id : ctx.id('cr'),
    name: clean(r.name, 60) || 'Room',
    beds: Math.max(1, Math.min(200, Math.round(Number(r.beds) || 1))),
    for: ROOM_FOR.includes(r.for as CampRoom['for']) ? (r.for as CampRoom['for']) : 'any',
  }));
}
function readBuses(ctx: Ctx, v: unknown, prev: CampBus[]): CampBus[] {
  if (!Array.isArray(v)) return prev;
  return (v as Record<string, unknown>[]).slice(0, 50).map((b) => ({ id: typeof b.id === 'string' && b.id ? b.id : ctx.id('cb'), name: clean(b.name, 60) || 'Bus', seats: Math.max(1, Math.min(120, Math.round(Number(b.seats) || 1))) }));
}

function readCamp(ctx: Ctx, b: Record<string, unknown>, prev?: Camp): Omit<Camp, 'id' | 'createdAt'> {
  const name = b.name !== undefined ? clean(b.name, 100) : (prev?.name ?? '');
  if (!name) throw new ApiError(422, 'invalid', 'Give the camp a name.', { name: 'Required' });
  const startsOn = b.startsOn !== undefined ? String(b.startsOn) : (prev?.startsOn ?? '');
  const endsOn = b.endsOn !== undefined ? String(b.endsOn) || startsOn : (prev?.endsOn ?? startsOn);
  if (!isDate(startsOn)) throw new ApiError(422, 'invalid', 'Pick the start date.', { startsOn: 'Required' });
  if (!isDate(endsOn) || endsOn < startsOn) throw new ApiError(422, 'invalid', 'The camp must end on or after it starts.', { endsOn: 'On or after the start' });
  const rooms = readRooms(ctx, b.rooms, prev?.rooms ?? []);
  const buses = readBuses(ctx, b.buses, prev?.buses ?? []);
  if (prev) {
    // A removed room or bus frees the people in it.
    const roomIds = new Set(rooms.map((r) => r.id));
    const busIds = new Set(buses.map((x) => x.id));
    for (const s of ctx.db.all('campSignups').filter((x) => x.campId === prev.id)) {
      if ((s.roomId && !roomIds.has(s.roomId)) || (s.busId && !busIds.has(s.busId))) ctx.db.put('campSignups', { ...s, roomId: s.roomId && roomIds.has(s.roomId) ? s.roomId : null, busId: s.busId && busIds.has(s.busId) ? s.busId : null });
    }
  }
  return {
    name, startsOn, endsOn, rooms, buses,
    place: b.place !== undefined ? clean(b.place, 160) : (prev?.place ?? ''),
    fee: b.fee !== undefined ? Math.max(0, Math.round(Number(b.fee) || 0)) : (prev?.fee ?? 0),
    capacity: b.capacity !== undefined ? Math.max(0, Math.round(Number(b.capacity) || 0)) : (prev?.capacity ?? 0),
    open: b.open !== undefined ? !!b.open : (prev?.open ?? true),
    note: b.note !== undefined ? clean(b.note, 1000) : (prev?.note ?? ''),
  };
}

function signupView(ctx: Ctx, s: CampSignup): CampSignupView {
  const p = ctx.db.get('people', s.personId);
  return { ...s, name: p ? fullName(p) : 'Removed person', phone: p?.phone ?? null, gender: p?.gender ?? null, age: p ? age(p.birthDate, ctx.now) : null, household: p?.householdName ?? (p ? fullName(p) : '') };
}

function campView(ctx: Ctx, c: Camp): CampView {
  const list = going(ctx, c.id);
  return {
    ...c,
    going: list.length,
    paidUp: c.fee ? list.filter((s) => s.paid >= c.fee).length : list.length,
    due: list.reduce((sum, s) => sum + Math.max(0, c.fee - s.paid), 0),
    collected: list.reduce((sum, s) => sum + s.paid, 0),
    roomless: c.rooms.length ? list.filter((s) => !s.roomId).length : 0,
    busless: c.buses.length ? list.filter((s) => s.needsBus && !s.busId).length : 0,
  };
}
const detail = (ctx: Ctx, c: Camp): CampDetail => ({
  ...campView(ctx, c),
  signups: going(ctx, c.id).map((s) => signupView(ctx, s)).sort((a, b) => a.household.localeCompare(b.household) || (b.age ?? 99) - (a.age ?? 99)),
});

function signUp(ctx: Ctx, c: Camp, personId: string, b: Record<string, unknown>, via: CampSignup['via'], by: string | null): CampSignup {
  const p = find(ctx, 'people', personId, 'Person');
  const existing = ctx.db.all('campSignups').find((s) => s.campId === c.id && s.personId === personId);
  if (existing?.status === 'going') return existing;
  if (c.capacity && going(ctx, c.id).length >= c.capacity) throw new ApiError(409, 'full', `${c.name} is full.`);
  const medical = typeof b.medical === 'object' && b.medical ? clean((b.medical as Record<string, unknown>)[personId], 300) : clean(b.medical, 300);
  return ctx.db.put('campSignups', {
    id: existing?.id ?? ctx.id('cs'), campId: c.id, personId, householdKey: p.householdName ?? p.id, status: 'going',
    medical: medical || p.medicalNotes || p.allergies || '', emergencyName: clean(b.emergencyName, 100), emergencyPhone: clean(b.emergencyPhone, 20),
    needsBus: b.needsBus !== undefined ? !!b.needsBus : true, roomId: null, busId: null, paid: existing?.paid ?? 0, via, signedUpBy: by, createdAt: ctx.now.toISOString(),
  });
}

/** Fill empty beds and seats: families into family rooms where they fit, everyone else by gender. */
function autoAssign(ctx: Ctx, c: Camp) {
  const list = going(ctx, c.id).map((s) => signupView(ctx, s));
  const used = new Map<string, number>();
  for (const s of list) if (s.roomId) used.set(s.roomId, (used.get(s.roomId) ?? 0) + 1);
  const free = (r: CampRoom) => r.beds - (used.get(r.id) ?? 0);
  const put = (s: CampSignupView, roomId: string) => { used.set(roomId, (used.get(roomId) ?? 0) + 1); s.roomId = roomId; ctx.db.put('campSignups', { ...ctx.db.get('campSignups', s.id)!, roomId }); };
  const homes = new Map<string, CampSignupView[]>();
  for (const s of list) if (!s.roomId) homes.set(s.householdKey, [...(homes.get(s.householdKey) ?? []), s]);
  for (const members of [...homes.values()].sort((a, b) => b.length - a.length)) {
    const family = members.length > 1 ? c.rooms.find((r) => r.for === 'family' && free(r) >= members.length) : undefined;
    if (family) { for (const s of members) put(s, family.id); continue; }
    for (const s of members) {
      // Prefer a room a relative of the same gender is already in, then any matching room with space.
      const ok = (r: CampRoom) => free(r) > 0 && r.for !== 'family' && (r.for === 'any' || r.for === s.gender);
      const kin = list.find((x) => x.householdKey === s.householdKey && x.roomId && x.gender === s.gender && ok(c.rooms.find((r) => r.id === x.roomId)!));
      const room = kin ? c.rooms.find((r) => r.id === kin.roomId) : (c.rooms.find((r) => ok(r) && r.for === s.gender) ?? c.rooms.find(ok));
      if (room) put(s, room.id);
    }
  }
  const seats = new Map<string, number>();
  for (const s of list) if (s.busId) seats.set(s.busId, (seats.get(s.busId) ?? 0) + 1);
  const riders = new Map<string, CampSignupView[]>();
  for (const s of list) if (s.needsBus && !s.busId) riders.set(s.householdKey, [...(riders.get(s.householdKey) ?? []), s]);
  for (const members of riders.values()) {
    for (const s of members) {
      const bus = c.buses.find((b) => b.seats - (seats.get(b.id) ?? 0) >= members.length) ?? c.buses.find((b) => b.seats - (seats.get(b.id) ?? 0) > 0);
      if (!bus) break;
      seats.set(bus.id, (seats.get(bus.id) ?? 0) + 1);
      ctx.db.put('campSignups', { ...ctx.db.get('campSignups', s.id)!, busId: bus.id });
    }
  }
}

function organiserIds(ctx: Ctx): string[] {
  const out = new Set<string>();
  for (const s of ctx.db.all('staff')) {
    if (s.status !== 'active' || !permsOf(ctx.db, s).includes('events')) continue;
    const p = (s.personId && ctx.db.get('people', s.personId)) || ctx.db.all('people').find((x) => normEmail(x.email) === normEmail(s.email));
    if (p) out.add(p.id);
  }
  return [...out];
}

function mine(ctx: Ctx): { camps: MyCamp[] } {
  const me = find(ctx, 'people', ctx.me(), 'Profile');
  const family = household(ctx, me);
  const today = localDate(ctx, ctx.now);
  return {
    camps: ctx.db.all('camps').filter((c) => c.endsOn >= today && (c.open || ctx.db.all('campSignups').some((s) => s.campId === c.id && s.status === 'going' && family.some((f) => f.id === s.personId))))
      .sort((a, b) => a.startsOn.localeCompare(b.startsOn))
      .map((c) => {
        const list = going(ctx, c.id);
        return {
          id: c.id, name: c.name, startsOn: c.startsOn, endsOn: c.endsOn, place: c.place, fee: c.fee, note: c.note,
          full: !!c.capacity && list.length >= c.capacity,
          family: family.map((p) => {
            const s = list.find((x) => x.personId === p.id);
            return { personId: p.id, name: fullName(p), signupId: s?.id ?? null, room: c.rooms.find((r) => r.id === s?.roomId)?.name ?? null, bus: c.buses.find((x) => x.id === s?.busId)?.name ?? null, paid: s?.paid ?? 0 };
          }),
        };
      }),
  };
}

export function registerCamps(r: Router) {
  r.get('/admin/camps', { perm: ['events', 'people.view'] }, (ctx) => ({ camps: ctx.db.all('camps').map((c) => campView(ctx, c)).sort((a, b) => b.startsOn.localeCompare(a.startsOn)) }));

  r.post('/admin/camps', { perm: 'events' }, (ctx) => {
    const c = ctx.db.put('camps', { id: ctx.id('cp'), ...readCamp(ctx, ctx.body as Record<string, unknown>), createdAt: ctx.now.toISOString() });
    ctx.audit('created', 'camp', c.id, c.name);
    return detail(ctx, c);
  });
  r.get('/admin/camps/:id', { perm: ['events', 'people.view'] }, (ctx) => detail(ctx, find(ctx, 'camps', ctx.params[0], 'Camp')));
  r.patch('/admin/camps/:id', { perm: 'events' }, (ctx) => {
    const c = find(ctx, 'camps', ctx.params[0], 'Camp');
    const next = ctx.db.put('camps', { ...c, ...readCamp(ctx, ctx.body as Record<string, unknown>, c) });
    return detail(ctx, next);
  });
  r.del('/admin/camps/:id', { perm: 'events' }, (ctx) => {
    const c = find(ctx, 'camps', ctx.params[0], 'Camp');
    if (going(ctx, c.id).some((s) => s.paid > 0)) throw new ApiError(409, 'has_payments', 'Some people have paid. Close sign-ups instead, or refund and remove them first.');
    for (const s of ctx.db.all('campSignups').filter((x) => x.campId === c.id)) ctx.db.del('campSignups', s.id);
    ctx.db.del('camps', c.id);
    ctx.audit('deleted', 'camp', c.id, c.name);
    return { ok: true };
  });

  r.post('/admin/camps/:id/signups', { perm: 'events' }, (ctx) => {
    const c = find(ctx, 'camps', ctx.params[0], 'Camp');
    const b = ctx.body as Record<string, unknown>;
    const ids = Array.isArray(b.personIds) ? (b.personIds as unknown[]).map(String).slice(0, 20) : [String(b.personId ?? '')];
    for (const id of ids) signUp(ctx, c, id, b, 'office', null);
    return detail(ctx, c);
  });
  r.patch('/admin/camps/:id/signups/:sid', { perm: 'events' }, (ctx) => {
    const c = find(ctx, 'camps', ctx.params[0], 'Camp');
    const s = find(ctx, 'campSignups', ctx.params[1], 'Sign-up');
    if (s.campId !== c.id) throw new ApiError(404, 'not_found', 'Sign-up not found.');
    const b = ctx.body as Record<string, unknown>;
    const roomId = b.roomId !== undefined ? (b.roomId ? String(b.roomId) : null) : s.roomId;
    const busId = b.busId !== undefined ? (b.busId ? String(b.busId) : null) : s.busId;
    if (roomId && roomId !== s.roomId) {
      const room = c.rooms.find((x) => x.id === roomId);
      if (!room) throw new ApiError(422, 'invalid', 'Unknown room.');
      if (going(ctx, c.id).filter((x) => x.roomId === roomId).length >= room.beds) throw new ApiError(409, 'full', `${room.name} is full.`);
    }
    if (busId && busId !== s.busId) {
      const bus = c.buses.find((x) => x.id === busId);
      if (!bus) throw new ApiError(422, 'invalid', 'Unknown bus.');
      if (going(ctx, c.id).filter((x) => x.busId === busId).length >= bus.seats) throw new ApiError(409, 'full', `${bus.name} is full.`);
    }
    ctx.db.put('campSignups', {
      ...s, roomId, busId,
      paid: b.paid !== undefined ? Math.max(0, Math.round(Number(b.paid) || 0)) : s.paid,
      status: b.status === 'cancelled' ? 'cancelled' : b.status === 'going' ? 'going' : s.status,
      medical: b.medical !== undefined ? clean(b.medical, 300) : s.medical,
      needsBus: b.needsBus !== undefined ? !!b.needsBus : s.needsBus,
    });
    return detail(ctx, c);
  });
  r.post('/admin/camps/:id/assign', { perm: 'events' }, (ctx) => {
    const c = find(ctx, 'camps', ctx.params[0], 'Camp');
    autoAssign(ctx, c);
    return detail(ctx, c);
  });

  // Member app: sign the family up.
  r.get('/me/camps', {}, (ctx) => mine(ctx));
  r.post('/me/camps/:id', {}, async (ctx) => {
    const c = find(ctx, 'camps', ctx.params[0], 'Camp');
    if (!c.open || c.endsOn < localDate(ctx, ctx.now)) throw new ApiError(409, 'closed', 'Sign-ups for this camp are closed.');
    const me = parent(ctx);
    const family = new Set(household(ctx, me).map((p) => p.id));
    const b = ctx.body as Record<string, unknown>;
    const ids = (Array.isArray(b.personIds) ? (b.personIds as unknown[]).map(String) : [me.id]).filter((id) => family.has(id));
    if (!ids.length) throw new ApiError(422, 'invalid', 'Choose who is going.', { personIds: 'Required' });
    if (!clean(b.emergencyPhone, 20)) throw new ApiError(422, 'invalid', 'Give an emergency contact number.', { emergencyPhone: 'Required' });
    if (c.capacity && going(ctx, c.id).filter((s) => !ids.includes(s.personId)).length + ids.length > c.capacity) throw new ApiError(409, 'full', `${c.name} has not got room for ${ids.length}.`);
    for (const id of ids) signUp(ctx, c, id, b, 'app', me.id);
    await notify(ctx, 'camp.signup', { personIds: organiserIds(ctx), except: me.id, title: `${c.name}: new sign-up`, body: `${fullName(me)} signed up ${ids.length === 1 ? '1 person' : `${ids.length} people`}.`, link: '/admin/camps' });
    return mine(ctx);
  });
  r.del('/me/camps/:id/:personId', {}, (ctx) => {
    const c = find(ctx, 'camps', ctx.params[0], 'Camp');
    const me = parent(ctx);
    if (!household(ctx, me).some((p) => p.id === ctx.params[1])) throw new ApiError(403, 'forbidden', 'You can only change your own family.');
    const s = going(ctx, c.id).find((x) => x.personId === ctx.params[1]);
    if (s) {
      if (s.paid > 0) throw new ApiError(409, 'paid', 'You have paid for this place. Please ask the church office to cancel it.');
      ctx.db.put('campSignups', { ...s, status: 'cancelled', roomId: null, busId: null });
    }
    return mine(ctx);
  });
}
