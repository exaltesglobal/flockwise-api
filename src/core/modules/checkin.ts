// Check-in: staff desk, self-service kiosk, member QR codes and kids' rooms with
// matching security codes on the child's and the parent's labels.
import { ApiError } from '../errors.js';
import type { Ctx, Router } from '../engine.js';
import type { Checkin, CheckinCandidate, CheckinFamily, CheckinLabel, CheckinMethod, CheckinResult, CheckinSummary, Collections } from '../types.js';
import { age, checkinsFor, DAY, eventView, find, fullName, isChild, memberEvent, pick, requireFields, settings, touchAttendance } from '../util.js';
import { searchPeople } from './people.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function roomFor(ctx: Ctx, p: Collections['people']) {
  const a = age(p.birthDate, ctx.now);
  if (a === null || !isChild(ctx, p)) return null;
  return ctx.db
    .all('rooms')
    .filter((r) => a >= r.minAge && a <= r.maxAge)
    .sort((x, y) => x.maxAge - x.minAge - (y.maxAge - y.minAge))[0] ?? null;
}

function candidate(ctx: Ctx, eventId: string, p: Collections['people']): CheckinCandidate {
  const room = roomFor(ctx, p);
  return {
    id: p.id,
    name: fullName(p),
    age: age(p.birthDate, ctx.now),
    isChild: isChild(ctx, p),
    allergies: p.allergies,
    roomId: room?.id ?? null,
    roomName: room?.name ?? null,
    checkedIn: checkinsFor(ctx, eventId).some((c) => c.personId === p.id),
  };
}

function families(ctx: Ctx, eventId: string, people: Collections['people'][]): CheckinFamily[] {
  const byHouse = new Map<string, Collections['people'][]>();
  const all = ctx.db.all('people');
  for (const p of people) {
    const key = p.householdName ?? `solo:${p.id}`;
    if (byHouse.has(key)) continue;
    byHouse.set(key, p.householdName ? all.filter((x) => x.householdName === p.householdName && x.status !== 'inactive') : [p]);
  }
  return [...byHouse.values()].slice(0, 12).map((ps) => ({
    householdName: ps[0].householdName,
    people: ps.map((p) => candidate(ctx, eventId, p)).sort((x, y) => Number(x.isChild) - Number(y.isChild) || (y.age ?? 0) - (x.age ?? 0)),
  }));
}

function summary(ctx: Ctx, ev: Collections['events']): CheckinSummary {
  const list = checkinsFor(ctx, ev.id).sort((x, y) => y.at.localeCompare(x.at));
  const rooms = ctx.db.all('rooms').sort((x, y) => x.minAge - y.minAge);
  return {
    event: eventView(ctx, ev),
    total: list.length,
    children: list.filter((c) => c.isChild).length,
    stillIn: list.filter((c) => c.isChild && !c.checkedOutAt).length,
    rooms: rooms.map((room) => ({ room, count: list.filter((c) => c.roomId === room.id && !c.checkedOutAt).length })),
    checkins: list,
  };
}

/** Checks people in to an event. Children in one batch share a security code with their guardian label. */
export function checkIn(ctx: Ctx, ev: Collections['events'], personIds: string[], method: CheckinMethod): CheckinResult {
  if (!ev.checkinEnabled) throw new ApiError(422, 'checkin_closed', 'Check-in is turned off for this event.');
  const people = [...new Set(personIds)].map((id) => find(ctx, 'people', id, 'Person'));
  if (!people.length) throw new ApiError(422, 'invalid', 'Choose who is checking in.');
  const existing = new Set(checkinsFor(ctx, ev.id).map((c) => c.personId));
  const kids = people.filter((p) => isChild(ctx, p));
  for (const k of kids) {
    const room = roomFor(ctx, k);
    if (room?.capacity && checkinsFor(ctx, ev.id).filter((c) => c.roomId === room.id && !c.checkedOutAt).length >= room.capacity)
      throw new ApiError(409, 'room_full', `${room.name} is full. Please speak to the kids' team.`);
  }
  const code = kids.length ? ctx.env.random(4, CODE_ALPHABET) : null;
  const out: Checkin[] = [];
  for (const p of people) {
    if (existing.has(p.id)) continue;
    const child = isChild(ctx, p);
    const room = child ? roomFor(ctx, p) : null;
    const c = ctx.db.put('checkins', {
      id: ctx.id('ci'),
      eventId: ev.id,
      personId: p.id,
      personName: fullName(p),
      householdName: p.householdName,
      at: ctx.now.toISOString(),
      method,
      isChild: child,
      roomId: room?.id ?? null,
      roomName: room?.name ?? null,
      securityCode: child ? code : null,
      allergies: child ? p.allergies : null,
      checkedOutAt: null,
    });
    touchAttendance(ctx, p.id);
    out.push(c);
  }
  const date = ev.startsAt.slice(0, 10);
  const labels: CheckinLabel[] = out
    .filter((c) => c.isChild)
    .map((c) => ({ kind: 'child' as const, name: c.personName, room: c.roomName, securityCode: code!, allergies: c.allergies, event: ev.title, date }));
  if (labels.length) {
    const guardian = people.find((p) => !isChild(ctx, p));
    labels.push({ kind: 'guardian', name: guardian ? fullName(guardian) : `${labels.length} ${labels.length === 1 ? 'child' : 'children'}`, room: null, securityCode: code!, allergies: null, event: ev.title, date });
  }
  return { checkins: out, securityCode: out.some((c) => c.isChild) ? code : null, labels };
}

const QR_PREFIX = 'FW1:';

export function registerCheckin(r: Router) {
  // ----- member -----
  r.get('/me/checkin-code', {}, (ctx) => {
    const p = find(ctx, 'people', ctx.me(), 'Profile');
    return { code: p.checkinCode, qr: `${QR_PREFIX}${p.checkinCode}`, name: fullName(p) };
  });
  r.post('/events/:id/check-in', {}, (ctx) => {
    // Self check-in from the app, allowed from an hour before the start until the end.
    const me = ctx.me();
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    const t = ctx.now.getTime();
    if (t < new Date(ev.startsAt).getTime() - 3600_000 || t > new Date(ev.endsAt).getTime()) throw new ApiError(422, 'not_open', 'Check-in opens an hour before the start.');
    const p = find(ctx, 'people', me, 'Profile');
    if (isChild(ctx, p)) throw new ApiError(422, 'child', "Children are checked in at the kids' desk.");
    checkIn(ctx, ev, [me], 'self');
    return memberEvent(ctx, ev, me);
  });

  // ----- admin -----
  r.get('/admin/checkin/events', { perm: 'checkin' }, (ctx) => {
    const from = ctx.now.getTime() - DAY;
    const to = ctx.now.getTime() + 7 * DAY;
    return ctx.db
      .all('events')
      .filter((e) => e.checkinEnabled && new Date(e.endsAt).getTime() > from && new Date(e.startsAt).getTime() < to)
      .sort((x, y) => x.startsAt.localeCompare(y.startsAt))
      .map((e) => eventView(ctx, e));
  });
  r.get('/admin/checkin/rooms', { perm: 'checkin' }, (ctx) => ctx.db.all('rooms').sort((x, y) => x.minAge - y.minAge));
  r.post('/admin/checkin/rooms', { perm: 'checkin' }, (ctx) => {
    requireFields(ctx.body, ['name']);
    const room = ctx.db.put('rooms', { id: ctx.id('rm'), name: String(ctx.body.name), minAge: Number(ctx.body.minAge) || 0, maxAge: Number(ctx.body.maxAge) || settings(ctx).childAgeLimit - 1, capacity: ctx.body.capacity ? Number(ctx.body.capacity) : null });
    ctx.audit('created', 'room', room.id, `Added kids room ${room.name}`);
    return room;
  });
  r.patch('/admin/checkin/rooms/:id', { perm: 'checkin' }, (ctx) => {
    const room = find(ctx, 'rooms', ctx.params[0], 'Room');
    const patch = pick<Collections['rooms']>(ctx.body, ['name', 'minAge', 'maxAge', 'capacity']);
    return ctx.db.put('rooms', { ...room, ...patch });
  });
  r.del('/admin/checkin/rooms/:id', { perm: 'checkin' }, (ctx) => {
    ctx.db.del('rooms', ctx.params[0]);
    return undefined;
  });
  r.get('/admin/checkin/:eventId', { perm: 'checkin' }, (ctx) => summary(ctx, find(ctx, 'events', ctx.params[0], 'Event')));
  r.get('/admin/checkin/:eventId/search', { perm: 'checkin' }, (ctx) => {
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    const q = String(ctx.query.q ?? '').trim();
    if (q.replace(/\s/g, '').length < 2) return [];
    const code = q.toUpperCase().startsWith(QR_PREFIX) ? q.slice(QR_PREFIX.length) : q;
    const byCode = ctx.db.all('people').filter((p) => p.checkinCode === code.toUpperCase());
    return families(ctx, ev.id, byCode.length ? byCode : searchPeople(ctx, q).filter((p) => p.status !== 'inactive'));
  });
  r.post('/admin/checkin/:eventId', { perm: 'checkin' }, (ctx) => {
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    const method: CheckinMethod = ctx.body.method === 'kiosk' ? 'kiosk' : 'staff';
    return checkIn(ctx, ev, Array.isArray(ctx.body.personIds) ? ctx.body.personIds : [], method);
  });
  r.post('/admin/checkin/:eventId/scan', { perm: 'checkin' }, (ctx) => {
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    const raw = String(ctx.body.code ?? '').trim().toUpperCase();
    const code = raw.startsWith(QR_PREFIX) ? raw.slice(QR_PREFIX.length) : raw;
    const p = ctx.db.all('people').find((x) => x.checkinCode === code);
    if (!p) throw new ApiError(404, 'unknown_code', 'This QR code is not recognised.');
    const already = checkinsFor(ctx, ev.id).find((c) => c.personId === p.id);
    if (already) return { checkins: [already], securityCode: already.securityCode, labels: [], alreadyCheckedIn: true };
    return checkIn(ctx, ev, [p.id], 'qr');
  });
  r.post('/admin/checkin/checkins/:id/checkout', { perm: 'checkin' }, (ctx) => {
    const c = find(ctx, 'checkins', ctx.params[0], 'Check-in');
    if (c.isChild && c.securityCode && String(ctx.body.securityCode ?? '').trim().toUpperCase() !== c.securityCode && !ctx.body.override)
      throw new ApiError(422, 'wrong_code', 'The security code does not match. Ask the parent for their label.');
    if (ctx.body.override) ctx.audit('override', 'checkin', c.id, `Checked out ${c.personName} without the security code`);
    return ctx.db.put('checkins', { ...c, checkedOutAt: ctx.now.toISOString() });
  });
  r.del('/admin/checkin/checkins/:id', { perm: 'checkin' }, (ctx) => {
    ctx.db.del('checkins', ctx.params[0]);
    return undefined;
  });
  r.post('/admin/checkin/:eventId/reprint', { perm: 'checkin' }, (ctx) => {
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    const code = String(ctx.body.securityCode ?? '').toUpperCase();
    const kids = checkinsFor(ctx, ev.id).filter((c) => c.securityCode === code);
    if (!kids.length) throw new ApiError(404, 'not_found', 'No children checked in with that code.');
    const date = ev.startsAt.slice(0, 10);
    const labels: CheckinLabel[] = kids.map((c) => ({ kind: 'child', name: c.personName, room: c.roomName, securityCode: code, allergies: c.allergies, event: ev.title, date }));
    labels.push({ kind: 'guardian', name: kids[0].householdName ?? 'Guardian', room: null, securityCode: code, allergies: null, event: ev.title, date });
    return { checkins: kids, securityCode: code, labels };
  });
}
