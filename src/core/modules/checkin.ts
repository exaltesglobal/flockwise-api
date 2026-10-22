// Check-in: staff desk, self-service kiosk, member QR codes and kids' rooms with
// matching security codes on the child's and the parent's labels.
import { ApiError } from '../errors.js';
import type { Ctx, Router } from '../engine.js';
import { CODE_ALPHABET, isSecurityCode, labelsFor, QR_PREFIX } from '../offline-checkin.js';
import type { Checkin, CheckinCandidate, CheckinFamily, CheckinMethod, CheckinResult, CheckinSummary, Collections, OfflinePack, OfflineSyncResult } from '../types.js';
import { age, checkinsFor, DAY, eventView, find, fullName, isChild, memberEvent, pick, requireFields, settings, touchAttendance } from '../util.js';
import { searchPeople } from './people.js';

export function roomFor(ctx: Ctx, p: Collections['people']) {
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

/** Who is scheduled to serve at an event (accepted or still pending). */
function servingAt(ctx: Ctx, eventId: string) {
  const teams = new Map(ctx.db.all('teams').map((t) => [t.id, t]));
  return ctx.db
    .all('assignments')
    .filter((a) => a.eventId === eventId && a.status !== 'declined')
    .map((a) => {
      const t = teams.get(a.teamId);
      return { personId: a.personId, teamName: t?.name ?? 'Team', positionName: t?.positions.find((p) => p.id === a.positionId)?.name ?? '' };
    });
}

export const headcountsFor = (ctx: Ctx, eventId: string) => ctx.db.all('headcounts').filter((h) => h.eventId === eventId).sort((x, y) => x.at.localeCompare(y.at));

function summary(ctx: Ctx, ev: Collections['events']): CheckinSummary {
  const list = checkinsFor(ctx, ev.id).sort((x, y) => y.at.localeCompare(x.at));
  const rooms = ctx.db.all('rooms').sort((x, y) => x.minAge - y.minAge);
  const serving = servingAt(ctx, ev.id);
  const inIds = new Set(list.map((c) => c.personId));
  const heads = headcountsFor(ctx, ev.id);
  return {
    headcounts: heads,
    headcountTotal: heads.reduce((s, h) => s + h.count, 0),
    volunteers: {
      scheduled: new Set(serving.map((s) => s.personId)).size,
      checkedIn: new Set(serving.filter((s) => inIds.has(s.personId)).map((s) => s.personId)).size,
      missing: serving.filter((s) => !inIds.has(s.personId)).map((s) => ({ ...s, name: ctx.db.get('people', s.personId) ? fullName(ctx.db.get('people', s.personId)!) : 'Unknown' })),
    },
    event: eventView(ctx, ev),
    total: list.length,
    children: list.filter((c) => c.isChild).length,
    stillIn: list.filter((c) => c.isChild && !c.checkedOutAt).length,
    rooms: rooms.map((room) => ({ room, count: list.filter((c) => c.roomId === room.id && !c.checkedOutAt).length })),
    checkins: list,
  };
}

/** What a desk without internet did, replayed: its time, its security code and an id so a retry is harmless. */
type Offline = { at: string; code: string | null; clientId: string };

/** Checks people in to an event. Children in one batch share a security code with their guardian label. */
export function checkIn(ctx: Ctx, ev: Collections['events'], personIds: string[], method: CheckinMethod, offline?: Offline): CheckinResult {
  if (!ev.checkinEnabled && !offline) throw new ApiError(422, 'checkin_closed', 'Check-in is turned off for this event.');
  const people = [...new Set(personIds)].map((id) => find(ctx, 'people', id, 'Person'));
  if (!people.length) throw new ApiError(422, 'invalid', 'Choose who is checking in.');
  const existing = new Set(checkinsFor(ctx, ev.id).map((c) => c.personId));
  const kids = people.filter((p) => isChild(ctx, p));
  // A room filled up while the desk was offline: the children are already in the room, so record them.
  for (const k of offline ? [] : kids) {
    const room = roomFor(ctx, k);
    if (room?.capacity && checkinsFor(ctx, ev.id).filter((c) => c.roomId === room.id && !c.checkedOutAt).length >= room.capacity)
      throw new ApiError(409, 'room_full', `${room.name} is full. Please speak to the kids' team.`);
  }
  const code = kids.length ? (offline && isSecurityCode(offline.code) ? offline.code : ctx.env.random(4, CODE_ALPHABET)) : null;
  const serving = servingAt(ctx, ev.id);
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
      at: offline?.at ?? ctx.now.toISOString(),
      method,
      isChild: child,
      roomId: room?.id ?? null,
      roomName: room?.name ?? null,
      securityCode: child ? code : null,
      allergies: child ? p.allergies : null,
      checkedOutAt: null,
      volunteer: (() => {
        const mine = serving.filter((x) => x.personId === p.id);
        return mine.length ? { teamName: [...new Set(mine.map((x) => x.teamName))].join(', '), positionName: mine.map((x) => x.positionName).filter(Boolean).join(', ') } : null;
      })(),
      ...(offline ? { clientId: offline.clientId } : {}),
    });
    touchAttendance(ctx, p.id);
    out.push(c);
  }
  const guardian = people.find((p) => !isChild(ctx, p));
  const labels = labelsFor(ev, out, guardian ? fullName(guardian) : null, code);
  return { checkins: out, securityCode: out.some((c) => c.isChild) ? code : null, labels };
}


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
  r.post('/admin/checkin/:eventId/headcounts', { perm: 'checkin' }, (ctx) => {
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    requireFields(ctx.body, ['area', 'count']);
    const count = Math.round(Number(ctx.body.count));
    if (!Number.isFinite(count) || count < 0) throw new ApiError(422, 'invalid', 'Enter how many people.', { count: 'Enter a number' });
    const area = String(ctx.body.area).trim().slice(0, 60);
    // One count per area: a recount replaces the earlier one.
    const prev = headcountsFor(ctx, ev.id).find((h) => h.area.toLowerCase() === area.toLowerCase());
    ctx.db.put('headcounts', { id: prev?.id ?? ctx.id('hc'), eventId: ev.id, area, count, recordedBy: ctx.staff?.name ?? '', at: ctx.now.toISOString() });
    const total = headcountsFor(ctx, ev.id).reduce((s, h) => s + h.count, 0);
    ctx.db.put('events', { ...ev, attendance: total });
    return summary(ctx, ctx.db.get('events', ev.id)!);
  });
  r.del('/admin/checkin/headcounts/:id', { perm: 'checkin' }, (ctx) => {
    const h = find(ctx, 'headcounts', ctx.params[0], 'Headcount');
    ctx.db.del('headcounts', h.id);
    const ev = ctx.db.get('events', h.eventId);
    if (ev) {
      const rest = headcountsFor(ctx, ev.id);
      ctx.db.put('events', { ...ev, attendance: rest.length ? rest.reduce((s, x) => s + x.count, 0) : ev.attendance });
    }
    return undefined;
  });
  // Everything a desk needs to keep checking people in when the internet drops.
  r.get('/admin/checkin/:eventId/offline', { perm: 'checkin' }, (ctx): OfflinePack => {
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    return {
      event: { id: ev.id, title: ev.title, startsAt: ev.startsAt },
      generatedAt: ctx.now.toISOString(),
      people: ctx.db
        .all('people')
        .filter((p) => p.status !== 'inactive')
        .map((p) => {
          const room = roomFor(ctx, p);
          const digits = (p.phone ?? '').replace(/\D/g, '');
          return { id: p.id, name: fullName(p), household: p.householdName, age: age(p.birthDate, ctx.now), isChild: isChild(ctx, p), roomId: room?.id ?? null, roomName: room?.name ?? null, allergies: p.allergies, code: p.checkinCode, phone4: digits.length >= 4 ? digits.slice(-4) : null };
        }),
      checkedIn: checkinsFor(ctx, ev.id).map((c) => c.personId),
      serving: servingAt(ctx, ev.id),
    };
  });
  // Replays check-ins made offline. Safe to send twice: items already synced come back as they are.
  r.post('/admin/checkin/:eventId/sync', { perm: 'checkin' }, (ctx) => {
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    const items = Array.isArray(ctx.body.items) ? (ctx.body.items as Record<string, unknown>[]).slice(0, 500) : [];
    const results: OfflineSyncResult[] = items.map((it) => {
      const clientId = String(it.clientId ?? '').slice(0, 60);
      if (!clientId) return { clientId, ok: false, checkins: [], skipped: [], error: 'Missing id' };
      const done = checkinsFor(ctx, ev.id).filter((c) => c.clientId === clientId);
      if (done.length) return { clientId, ok: true, checkins: done, skipped: [] };
      const ids = (Array.isArray(it.personIds) ? it.personIds : []).map(String).filter((id) => ctx.db.get('people', id));
      const already = checkinsFor(ctx, ev.id).filter((c) => ids.includes(c.personId));
      const t = Date.parse(String(it.at));
      // Trust the desk's clock within reason: not in the future, not before the day before the event.
      const at = Number.isFinite(t) && t <= ctx.now.getTime() && t >= new Date(ev.startsAt).getTime() - DAY ? new Date(t).toISOString() : ctx.now.toISOString();
      const method: CheckinMethod = it.method === 'kiosk' || it.method === 'qr' ? it.method : 'staff';
      try {
        const r = ids.length > already.length ? checkIn(ctx, ev, ids, method, { at, code: isSecurityCode(it.code) ? it.code : null, clientId }) : { checkins: [] };
        return { clientId, ok: true, checkins: r.checkins, skipped: already.map((c) => ({ personId: c.personId, name: c.personName, securityCode: c.securityCode })) };
      } catch (e) {
        return { clientId, ok: false, checkins: [], skipped: [], error: e instanceof Error ? e.message : 'Could not sync' };
      }
    });
    if (results.some((x) => x.checkins.length)) ctx.audit('synced', 'checkin', ev.id, `Synced ${results.reduce((n, x) => n + x.checkins.length, 0)} check-ins made offline`);
    return { results };
  });
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
    return { checkins: kids, securityCode: code, labels: labelsFor(ev, kids, kids[0].householdName ?? 'Guardian', code) };
  });
}
