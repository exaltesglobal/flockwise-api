// Family accounts: any adult in a household signs in once and looks after the whole family. They keep
// the children's details (allergies, medical notes, birthdays) up to date, add a new baby, and check the
// family in to a service from their phone. The children's pickup code shows on the phone; the welcome
// desk prints name labels from that code.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { Collections, FamilyCheckinEvent, FamilyCheckinResult, FamilyMember, FamilyView } from '../types.js';
import { age, checkinsFor, find, fullName, isChild, newPerson, settings } from '../util.js';
import { checkIn, roomFor } from './checkin.js';

type Person = Collections['people'];
const OPENS_MS = 3_600_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const text = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
const orNull = (v: unknown, max: number) => text(v, max) || null;

/** The signed-in adult. Children see their own things but don't manage the family. */
export function parent(ctx: Ctx): Person {
  const me = find(ctx, 'people', ctx.me(), 'Profile');
  if (isChild(ctx, me)) throw new ApiError(403, 'forbidden', 'Ask a parent to manage the family.');
  return me;
}

function household(ctx: Ctx, me: Person): Person[] {
  if (!me.householdName) return [me];
  return ctx.db.all('people').filter((p) => p.householdName === me.householdName && p.status !== 'inactive');
}

const canEdit = (ctx: Ctx, me: Person, p: Person) => p.id !== me.id && (isChild(ctx, p) || !p.email);

function member(ctx: Ctx, me: Person, p: Person): FamilyMember {
  return {
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    name: fullName(p),
    age: age(p.birthDate, ctx.now),
    birthDate: p.birthDate,
    gender: p.gender,
    isChild: isChild(ctx, p),
    isMe: p.id === me.id,
    hasLogin: !!p.email,
    phone: p.phone,
    allergies: p.allergies,
    medicalNotes: p.medicalNotes,
    roomName: roomFor(ctx, p)?.name ?? null,
    editable: canEdit(ctx, me, p),
  };
}

function family(ctx: Ctx, me: Person): FamilyView {
  const ms = household(ctx, me).map((p) => member(ctx, me, p));
  ms.sort((a, b) => Number(a.isChild) - Number(b.isChild) || Number(b.isMe) - Number(a.isMe) || (b.age ?? 0) - (a.age ?? 0));
  return { householdName: me.householdName, members: ms };
}

function detailsFrom(ctx: Ctx, b: Record<string, unknown>, adult: boolean): Partial<Person> {
  const out: Partial<Person> = {};
  if (b.firstName !== undefined) {
    out.firstName = text(b.firstName, 60);
    if (!out.firstName) throw new ApiError(422, 'invalid', 'Enter a first name.', { firstName: 'Required' });
  }
  if (b.lastName !== undefined) out.lastName = text(b.lastName, 60);
  if (b.birthDate !== undefined) {
    const d = b.birthDate ? String(b.birthDate) : null;
    if (d && (!DATE_RE.test(d) || d > ctx.now.toISOString().slice(0, 10))) throw new ApiError(422, 'invalid', 'Enter a date of birth that is not in the future.', { birthDate: 'Not a valid date' });
    out.birthDate = d;
  }
  if (b.gender !== undefined) out.gender = b.gender === 'male' || b.gender === 'female' ? b.gender : null;
  if (b.allergies !== undefined) out.allergies = orNull(b.allergies, 120);
  if (b.medicalNotes !== undefined) out.medicalNotes = orNull(b.medicalNotes, 500);
  if (adult && b.phone !== undefined) out.phone = orNull(b.phone, 20);
  return out;
}

export function checkinEvent(ctx: Ctx, me: Person, ev: Collections['events']): FamilyCheckinEvent {
  const t = ctx.now.getTime();
  const opens = new Date(ev.startsAt).getTime() - OPENS_MS;
  const done = checkinsFor(ctx, ev.id);
  return {
    id: ev.id,
    title: ev.title,
    startsAt: ev.startsAt,
    endsAt: ev.endsAt,
    location: ev.location,
    open: settings(ctx).phoneCheckin !== false && t >= opens && t <= new Date(ev.endsAt).getTime(),
    opensAt: new Date(opens).toISOString(),
    members: family(ctx, me).members.map((m) => {
      const c = done.find((x) => x.personId === m.id);
      return { id: m.id, name: m.name, isChild: m.isChild, roomName: m.roomName, allergies: m.allergies, checkedIn: !!c, securityCode: c?.securityCode ?? null };
    }),
  };
}

/** Services with check-in turned on that end in the future and start within a day, at the family's campus. */
const upcoming = (ctx: Ctx, me: Person) =>
  ctx.db
    .all('events')
    .filter((e) => e.checkinEnabled && new Date(e.endsAt).getTime() > ctx.now.getTime() && new Date(e.startsAt).getTime() - ctx.now.getTime() < 86_400_000)
    .filter((e) => !me.campusId || !e.campusId || e.campusId === me.campusId)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

export function registerFamily(r: Router) {
  r.get('/me/family', {}, (ctx) => family(ctx, parent(ctx)));
  r.post('/me/family/members', {}, (ctx) => {
    const me = parent(ctx);
    const d = detailsFrom(ctx, { lastName: me.lastName, ...ctx.body }, false);
    if (!d.firstName) throw new ApiError(422, 'invalid', 'Enter a first name.', { firstName: 'Required' });
    if (!d.birthDate) throw new ApiError(422, 'invalid', "Enter the child's date of birth. It decides their kids' church room.", { birthDate: 'Required' });
    // A family of one becomes "<surname> family" when the first child is added.
    const householdName = me.householdName ?? `${me.lastName || me.firstName} family`;
    if (!me.householdName) ctx.db.put('people', { ...me, householdName });
    const p = ctx.db.put('people', { ...newPerson(ctx, { ...d, firstName: d.firstName, lastName: d.lastName || me.lastName }), householdName, status: me.status === 'visitor' ? 'visitor' : 'regular', campusId: me.campusId, zoneId: me.zoneId ?? null, address: me.address, language: me.language, tags: ['added-by-family'] });
    ctx.audit('created', 'person', p.id, `${fullName(me)} added ${fullName(p)} to the ${householdName} from the app`);
    return member(ctx, { ...me, householdName }, p);
  });
  r.patch('/me/family/members/:id', {}, (ctx) => {
    const me = parent(ctx);
    const p = household(ctx, me).find((x) => x.id === ctx.params[0]);
    if (!p) throw new ApiError(404, 'not_found', 'This person is not in your family.');
    if (!canEdit(ctx, me, p)) throw new ApiError(403, 'forbidden', `${p.firstName} has their own sign-in and keeps their own details.`);
    const next = ctx.db.put('people', { ...p, ...detailsFrom(ctx, ctx.body, !isChild(ctx, p)) });
    ctx.audit('updated', 'person', p.id, `${fullName(me)} updated ${fullName(next)}'s details from the app`);
    return member(ctx, me, next);
  });

  r.get('/me/family/checkin', {}, (ctx) => {
    const me = parent(ctx);
    return upcoming(ctx, me).map((e) => checkinEvent(ctx, me, e));
  });
  r.post('/me/family/checkin/:eventId', {}, (ctx): FamilyCheckinResult => {
    const me = parent(ctx);
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    if (!ev.checkinEnabled) throw new ApiError(422, 'checkin_closed', 'Check-in is not open for this event.');
    const view = checkinEvent(ctx, me, ev);
    if (settings(ctx).phoneCheckin === false) throw new ApiError(422, 'not_allowed', "Your church checks families in at the welcome desk.");
    if (!view.open) throw new ApiError(422, 'not_open', 'Check-in opens an hour before the start.');
    const mine = new Set(view.members.map((m) => m.id));
    const ids = (Array.isArray(ctx.body.personIds) ? (ctx.body.personIds as unknown[]) : []).map(String).filter((id) => mine.has(id));
    if (!ids.length) throw new ApiError(422, 'invalid', 'Choose who is coming.');
    const res = checkIn(ctx, ev, ids, 'app');
    if (res.checkins.length) ctx.audit('checked_in', 'checkin', ev.id, `${fullName(me)} checked in ${res.checkins.map((c) => c.personName).join(', ')} from the app`);
    const after = checkinEvent(ctx, me, ev);
    // Children checked in earlier keep their code; show it again.
    const code = res.securityCode ?? after.members.find((m) => ids.includes(m.id) && m.securityCode)?.securityCode ?? null;
    return { securityCode: code, checkedIn: res.checkins.map((c) => c.personId), event: after };
  });

  // The office decides whether families may check in from their phones.
  r.get('/admin/checkin-settings', { perm: 'checkin' }, (ctx) => ({ phoneCheckin: settings(ctx).phoneCheckin !== false }));
  r.put('/admin/checkin-settings', { perm: 'checkin' }, (ctx) => {
    const phoneCheckin = !!ctx.body.phoneCheckin;
    ctx.db.put('settings', { ...settings(ctx), phoneCheckin });
    ctx.audit('updated', 'settings', null, `${phoneCheckin ? 'Allowed' : 'Stopped'} family check-in from phones`);
    return { phoneCheckin };
  });
}
