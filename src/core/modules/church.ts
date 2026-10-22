// Events, groups, announcements, home feed, settings, staff and the audit log.
import { ApiError } from '../errors.js';
import type { Ctx, Router } from '../engine.js';
import { PERMISSIONS, ROLE_LABELS } from '../perms.js';
import { checkLimit } from '../plans.js';
import type { Collections, EventAttendee, EventInput, GroupDetail, GroupInput, StaffRole } from '../types.js';
import {
  bySoonest,
  checkinsFor,
  churchId,
  eventView,
  find,
  fullName,
  groupView,
  memberEvent,
  memberGroup,
  normEmail,
  page,
  pick,
  requireFields,
  rsvpsFor,
  settings,
  touchAttendance,
  upcoming,
} from '../util.js';
import { notify } from './notify.js';

const EVENT_FIELDS: (keyof EventInput)[] = ['kind', 'title', 'description', 'startsAt', 'endsAt', 'location', 'imageUrl', 'capacity', 'published', 'campusId', 'checkinEnabled', 'price'];
const GROUP_FIELDS: (keyof GroupInput)[] = ['name', 'description', 'meetingSchedule', 'location', 'leaderName', 'isOpen', 'type', 'zone', 'leaderId'];
const ROLES = Object.keys(PERMISSIONS) as StaffRole[];

function cleanEvent(body: Record<string, unknown>) {
  const e = pick<EventInput>(body, EVENT_FIELDS);
  if (e.startsAt) e.startsAt = new Date(e.startsAt).toISOString();
  if (e.endsAt) e.endsAt = new Date(e.endsAt).toISOString();
  if (e.capacity !== undefined) e.capacity = e.capacity ? Number(e.capacity) : null;
  if (e.price !== undefined) e.price = e.price ? Math.round(Number(e.price)) : null;
  return e;
}

/** Visible upcoming events for the member side. */
const visibleUpcoming = (ctx: Ctx) => ctx.db.all('events').filter((e) => e.published && upcoming(ctx, e)).sort(bySoonest);

/** Paid ticket for an event, if any. */
export const paidTicket = (ctx: Ctx, eventId: string, personId: string) =>
  ctx.db.all('donations').some((d) => d.eventId === eventId && d.donorId === personId && d.status === 'succeeded');

/** Tells everyone in the church about a new announcement (push by default; the office may add email). */
function announce(ctx: Ctx, a: Collections['announcements']) {
  const people = ctx.db.all('people').filter((p) => p.status !== 'inactive').map((p) => p.id);
  void notify(ctx, 'announcement.published', { personIds: people, title: a.title, body: a.body.slice(0, 180), link: '/app' });
}

export function registerChurch(r: Router) {
  // ----- member -----
  r.get('/home', {}, (ctx) => {
    const me = ctx.me();
    const list = visibleUpcoming(ctx);
    const service = list.find((e) => e.kind === 'service');
    return {
      nextService: service ? memberEvent(ctx, service, me) : null,
      announcements: ctx.db
        .all('announcements')
        .filter((a) => a.status === 'published')
        .sort((x, y) => y.publishedAt.localeCompare(x.publishedAt))
        .slice(0, 10)
        .map(({ status: _s, ...a }) => a),
      upcomingEvents: list.filter((e) => e.kind === 'event').slice(0, 3).map((e) => memberEvent(ctx, e, me)),
    };
  });
  r.get('/events', {}, (ctx) => {
    const me = ctx.me();
    const res = page(visibleUpcoming(ctx), ctx.query.cursor);
    return { data: res.data.map((e) => memberEvent(ctx, e, me)), nextCursor: res.nextCursor };
  });
  r.get('/events/:id', {}, (ctx) => {
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    if (!ev.published) throw new ApiError(404, 'not_found', 'Event not found.');
    return memberEvent(ctx, ev, ctx.me());
  });
  r.put('/events/:id/rsvp', {}, (ctx) => {
    const me = ctx.me();
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    const mine = rsvpsFor(ctx, ev.id).find((x) => x.personId === me);
    if (ctx.body.status === 'going') {
      if (ev.price && !paidTicket(ctx, ev.id, me)) throw new ApiError(402, 'payment_required', 'This event needs a ticket. Use "Get ticket" to pay first.');
      if (ev.capacity && rsvpsFor(ctx, ev.id).length >= ev.capacity && !mine) throw new ApiError(409, 'full', 'Sorry, this event is full.');
      if (!mine) ctx.db.put('rsvps', { id: ctx.id('rv'), eventId: ev.id, personId: me, at: ctx.now.toISOString() });
    } else if (mine) {
      if (ev.price && paidTicket(ctx, ev.id, me)) throw new ApiError(409, 'ticket_paid', 'You have a paid ticket. Contact the church office for a refund.');
      ctx.db.del('rsvps', mine.id);
    }
    return memberEvent(ctx, ev, me);
  });
  r.post('/events/:id/ticket', {}, async (ctx) => {
    // Paid event registration: a pending payment to the hidden "Event registrations" fund.
    const me = find(ctx, 'people', ctx.me(), 'Profile');
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    if (!ev.price) throw new ApiError(422, 'free_event', 'This event is free. Just RSVP.');
    if (paidTicket(ctx, ev.id, me.id)) throw new ApiError(409, 'already_paid', 'You already have a ticket.');
    if (ev.capacity && rsvpsFor(ctx, ev.id).length >= ev.capacity) throw new ApiError(409, 'full', 'Sorry, this event is full.');
    const fund = ensureEventFund(ctx);
    const s = settings(ctx);
    const d: Collections['donations'] = {
      id: ctx.id('dn'),
      donorId: me.id,
      donorName: fullName(me),
      donorEmail: me.email,
      donorPhone: me.phone,
      fundId: fund.id,
      fundName: `Ticket: ${ev.title}`,
      amount: ev.price,
      currency: s.currency,
      frequency: 'once',
      status: 'pending',
      method: null,
      pan: null,
      donorCitizenship: 'IN',
      fcra: false,
      provider: 'demo',
      providerRef: null,
      providerPaymentId: null,
      createdAt: ctx.now.toISOString(),
      paidAt: null,
      eventId: ev.id,
      receiptNumber: null,
    };
    const co = await ctx.env.checkout(d, { description: `${ev.title} ticket · ${s.name}`, fundTaxDeductible: false });
    const saved = ctx.db.put('donations', { ...d, providerRef: co.providerRef, provider: co.provider, status: co.status ?? 'pending', paidAt: co.status === 'succeeded' ? ctx.now.toISOString() : null, method: co.status === 'succeeded' ? 'upi' : null });
    if (saved.status === 'succeeded') onTicketPaid(ctx, saved);
    return { donationId: d.id, checkoutUrl: co.checkoutUrl };
  });
  r.get('/groups', {}, (ctx) => {
    const me = ctx.me();
    const mine = new Set(ctx.db.all('groupMembers').filter((m) => m.personId === me).map((m) => m.groupId));
    return { data: ctx.db.all('groups').filter((g) => g.isOpen || mine.has(g.id)).map((g) => memberGroup(ctx, g, me)), nextCursor: null };
  });
  r.post('/groups/:id/join-requests', {}, (ctx) => {
    const me = find(ctx, 'people', ctx.me(), 'Profile');
    const g = find(ctx, 'groups', ctx.params[0], 'Group');
    const already = ctx.db.all('joinRequests').some((j) => j.groupId === g.id && j.person.id === me.id) || ctx.db.all('groupMembers').some((m) => m.groupId === g.id && m.personId === me.id);
    if (!already) ctx.db.put('joinRequests', { id: ctx.id('jr'), groupId: g.id, person: { id: me.id, name: fullName(me), phone: me.phone }, requestedAt: ctx.now.toISOString() });
    return memberGroup(ctx, g, me.id);
  });

  // ----- admin: events -----
  r.get('/admin/events', { perm: ['events', 'checkin', 'volunteers', 'services'] }, (ctx) => {
    const past = ctx.query.when === 'past';
    const list = ctx.db.all('events').filter((e) => (past ? !upcoming(ctx, e) : upcoming(ctx, e))).sort(bySoonest);
    return { data: (past ? list.reverse() : list).slice(0, 200).map((e) => eventView(ctx, e)), nextCursor: null };
  });
  r.post('/admin/events', { perm: 'events' }, (ctx) => {
    requireFields(ctx.body, ['title', 'startsAt', 'endsAt']);
    const e = cleanEvent(ctx.body);
    const ev = ctx.db.put('events', {
      kind: 'event',
      description: '',
      location: '',
      imageUrl: null,
      capacity: null,
      published: true,
      campusId: null,
      checkinEnabled: true,
      price: null,
      ...e,
      title: String(e.title),
      startsAt: e.startsAt!,
      endsAt: e.endsAt!,
      id: ctx.id('ev'),
      attendance: null,
    });
    if (ev.endsAt <= ev.startsAt) throw new ApiError(422, 'invalid', 'The event must end after it starts.', { endsAt: 'Must be after the start' });
    ctx.audit('created', 'event', ev.id, `Created event ${ev.title}`);
    // Repeat weekly: create copies for the next N weeks.
    const repeat = Math.min(52, Number(ctx.body.repeatWeeks) || 0);
    for (let i = 1; i <= repeat; i++) {
      const shift = i * 7 * 86_400_000;
      ctx.db.put('events', { ...ev, id: ctx.id('ev'), startsAt: new Date(new Date(ev.startsAt).getTime() + shift).toISOString(), endsAt: new Date(new Date(ev.endsAt).getTime() + shift).toISOString() });
    }
    return eventView(ctx, ev);
  });
  r.patch('/admin/events/:id', { perm: 'events' }, (ctx) => {
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    const next = ctx.db.put('events', { ...ev, ...cleanEvent(ctx.body) });
    ctx.audit('updated', 'event', ev.id, `Updated event ${next.title}`);
    const moved = next.startsAt !== ev.startsAt || next.endsAt !== ev.endsAt || next.location !== ev.location;
    if (moved && new Date(next.endsAt).getTime() > ctx.now.getTime()) {
      const people = [...rsvpsFor(ctx, ev.id).map((x) => x.personId), ...ctx.db.all('assignments').filter((a) => a.eventId === ev.id && a.status !== 'declined').map((a) => a.personId)];
      const when = new Date(next.startsAt).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: settings(ctx).timezone || 'Asia/Kolkata' });
      void notify(ctx, 'event.changed', { personIds: people, title: `${next.title} has changed`, body: `${next.title} is now on ${when}${next.location ? ` at ${next.location}` : ''}.`, link: `/app/events/${next.id}` });
    }
    return eventView(ctx, next);
  });
  r.del('/admin/events/:id', { perm: 'events' }, (ctx) => {
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    ctx.db.del('events', ev.id);
    for (const kind of ['rsvps', 'assignments', 'checkins'] as const) for (const x of ctx.db.all(kind)) if (x.eventId === ev.id) ctx.db.del(kind, x.id);
    ctx.db.del('plans', ev.id);
    ctx.audit('deleted', 'event', ev.id, `Deleted event ${ev.title}`);
    return undefined;
  });
  r.put('/admin/events/:id/attendance', { perm: ['events', 'checkin'] }, (ctx) => {
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    const next = ctx.db.put('events', { ...ev, attendance: Math.max(0, Number(ctx.body.count) || 0) });
    ctx.audit('updated', 'event', ev.id, `Recorded attendance ${next.attendance} for ${ev.title}`);
    return eventView(ctx, next);
  });
  r.get('/admin/events/:id/attendees', { perm: ['events', 'checkin'] }, (ctx) => {
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    const rsvp = new Set(rsvpsFor(ctx, ev.id).map((x) => x.personId));
    const checked = new Set(checkinsFor(ctx, ev.id).map((x) => x.personId));
    const ids = new Set([...rsvp, ...checked]);
    const out: EventAttendee[] = [...ids]
      .map((id) => ctx.db.get('people', id))
      .filter((p): p is Collections['people'] => !!p)
      .map((p) => ({ personId: p.id, name: fullName(p), phone: p.phone, rsvp: rsvp.has(p.id), checkedIn: checked.has(p.id), paid: ev.price ? paidTicket(ctx, ev.id, p.id) : null }))
      .sort((x, y) => x.name.localeCompare(y.name));
    return out;
  });

  // ----- admin: groups -----
  r.get('/admin/groups/join-requests', { perm: 'groups' }, (ctx) => ({
    data: ctx.db
      .all('joinRequests')
      .sort((x, y) => y.requestedAt.localeCompare(x.requestedAt))
      .map((j) => ({ ...j, groupName: ctx.db.get('groups', j.groupId)?.name ?? 'Group' })),
    nextCursor: null,
  }));
  r.post('/admin/groups/join-requests/:id/:decision', { perm: 'groups' }, (ctx) => {
    const jr = find(ctx, 'joinRequests', ctx.params[0], 'Request');
    if (ctx.params[1] === 'approve') addMember(ctx, jr.groupId, jr.person.id);
    ctx.db.del('joinRequests', jr.id);
    ctx.audit(ctx.params[1] === 'approve' ? 'approved' : 'declined', 'group', jr.groupId, `${ctx.params[1] === 'approve' ? 'Approved' : 'Declined'} ${jr.person.name} for ${ctx.db.get('groups', jr.groupId)?.name ?? 'a group'}`);
    return undefined;
  });
  r.get('/admin/groups', { perm: ['groups', 'people.view'] }, (ctx) => ({ data: ctx.db.all('groups').sort((x, y) => x.name.localeCompare(y.name)).map((g) => groupView(ctx, g)), nextCursor: null }));
  r.post('/admin/groups', { perm: 'groups' }, (ctx) => {
    requireFields(ctx.body, ['name']);
    const g = ctx.db.put('groups', { description: '', meetingSchedule: '', location: '', leaderName: '', isOpen: true, type: 'cell', zone: '', leaderId: null, ...pick<GroupInput>(ctx.body, GROUP_FIELDS), name: String(ctx.body.name), id: ctx.id('gr') });
    if (g.leaderId) addMember(ctx, g.id, g.leaderId);
    ctx.audit('created', 'group', g.id, `Created group ${g.name}`);
    return groupView(ctx, g);
  });
  r.get('/admin/groups/:id', { perm: ['groups', 'people.view'] }, (ctx): GroupDetail => {
    const g = find(ctx, 'groups', ctx.params[0], 'Group');
    const members = ctx.db
      .all('groupMembers')
      .filter((m) => m.groupId === g.id)
      .map((m) => ctx.db.get('people', m.personId))
      .filter((p): p is Collections['people'] => !!p)
      .map((p) => ({ id: p.id, name: fullName(p), phone: p.phone, status: p.status }))
      .sort((x, y) => x.name.localeCompare(y.name));
    const meetings = ctx.db.all('groupMeetings').filter((m) => m.groupId === g.id).sort((x, y) => y.date.localeCompare(x.date)).slice(0, 20);
    return { group: groupView(ctx, g), members, meetings };
  });
  r.patch('/admin/groups/:id', { perm: 'groups' }, (ctx) => {
    const g = find(ctx, 'groups', ctx.params[0], 'Group');
    const next = ctx.db.put('groups', { ...g, ...pick<GroupInput>(ctx.body, GROUP_FIELDS) });
    if (next.leaderId) addMember(ctx, g.id, next.leaderId);
    ctx.audit('updated', 'group', g.id, `Updated group ${next.name}`);
    return groupView(ctx, next);
  });
  r.del('/admin/groups/:id', { perm: 'groups' }, (ctx) => {
    const g = find(ctx, 'groups', ctx.params[0], 'Group');
    ctx.db.del('groups', g.id);
    for (const kind of ['groupMembers', 'joinRequests', 'groupMeetings'] as const) for (const x of ctx.db.all(kind)) if (x.groupId === g.id) ctx.db.del(kind, x.id);
    ctx.audit('deleted', 'group', g.id, `Deleted group ${g.name}`);
    return undefined;
  });
  r.post('/admin/groups/:id/members', { perm: 'groups' }, (ctx) => {
    const g = find(ctx, 'groups', ctx.params[0], 'Group');
    const ids: string[] = Array.isArray(ctx.body.personIds) ? ctx.body.personIds : [ctx.body.personId];
    for (const id of ids) if (ctx.db.get('people', id)) addMember(ctx, g.id, id);
    ctx.audit('updated', 'group', g.id, `Added ${ids.length} to ${g.name}`);
    return groupView(ctx, g);
  });
  r.del('/admin/groups/:id/members/:personId', { perm: 'groups' }, (ctx) => {
    for (const m of ctx.db.all('groupMembers')) if (m.groupId === ctx.params[0] && m.personId === ctx.params[1]) ctx.db.del('groupMembers', m.id);
    return undefined;
  });
  r.post('/admin/groups/:id/meetings', { perm: 'groups' }, (ctx) => {
    const g = find(ctx, 'groups', ctx.params[0], 'Group');
    requireFields(ctx.body, ['date']);
    const presentIds: string[] = (Array.isArray(ctx.body.presentIds) ? ctx.body.presentIds : []).filter((id: string) => ctx.db.get('people', id));
    const m = ctx.db.put('groupMeetings', { id: ctx.id('gm'), groupId: g.id, date: String(ctx.body.date).slice(0, 10), presentIds, guests: Math.max(0, Number(ctx.body.guests) || 0), notes: String(ctx.body.notes ?? ''), recordedBy: ctx.staff?.name ?? '' });
    const at = new Date(`${m.date}T12:00:00Z`);
    for (const id of presentIds) touchAttendance(ctx, id, at);
    ctx.audit('created', 'group', g.id, `Recorded ${presentIds.length} present at ${g.name}`);
    return m;
  });

  // ----- admin: announcements -----
  r.get('/admin/announcements', { perm: 'comms' }, (ctx) => ({ data: ctx.db.all('announcements').sort((x, y) => y.publishedAt.localeCompare(x.publishedAt)), nextCursor: null }));
  r.post('/admin/announcements', { perm: 'comms' }, (ctx) => {
    requireFields(ctx.body, ['title', 'body']);
    const a = ctx.db.put('announcements', { imageUrl: null, status: ctx.body.status === 'draft' ? 'draft' : 'published', title: String(ctx.body.title), body: String(ctx.body.body), id: ctx.id('an'), publishedAt: ctx.now.toISOString() });
    if (a.status === 'published') announce(ctx, a);
    ctx.audit('created', 'announcement', a.id, `Posted announcement ${a.title}`);
    return a;
  });
  r.patch('/admin/announcements/:id', { perm: 'comms' }, (ctx) => {
    const a = find(ctx, 'announcements', ctx.params[0], 'Announcement');
    const patch = pick<Collections['announcements']>(ctx.body, ['title', 'body', 'status', 'imageUrl']);
    const next = { ...a, ...patch };
    if (patch.status === 'published' && a.status === 'draft') {
      next.publishedAt = ctx.now.toISOString();
      announce(ctx, next);
    }
    ctx.audit('updated', 'announcement', a.id, `Updated announcement ${next.title}`);
    return ctx.db.put('announcements', next);
  });
  r.del('/admin/announcements/:id', { perm: 'comms' }, (ctx) => {
    const a = find(ctx, 'announcements', ctx.params[0], 'Announcement');
    ctx.db.del('announcements', a.id);
    ctx.audit('deleted', 'announcement', a.id, `Deleted announcement ${a.title}`);
    return undefined;
  });

  // ----- admin: settings, staff, audit -----
  r.get('/admin/settings', {}, (ctx) => ({ ...settings(ctx), id: churchId(ctx) }));
  r.patch('/admin/settings', { perm: 'settings' }, (ctx) => {
    const s = settings(ctx);
    const patch = pick<Collections['settings']>(ctx.body, ['name', 'city', 'address', 'phone', 'email', 'website', 'timezone', 'languages', 'logoUrl', 'childAgeLimit', 'zoneLabel']);
    const next = {
      ...s,
      ...patch,
      fcra: { ...s.fcra, ...pick(ctx.body.fcra ?? {}, ['registered', 'registrationNumber', 'accountLast4']) },
      receipts80g: { ...s.receipts80g, ...pick(ctx.body.receipts80g ?? {}, ['enabled', 'registrationNumber', 'pan']) },
    };
    ctx.audit('updated', 'settings', null, 'Updated church settings');
    return { ...ctx.db.put('settings', next), id: churchId(ctx) };
  });
  r.post('/admin/settings/payments/connect', { perm: 'settings' }, (ctx) => {
    const s = settings(ctx);
    if (ctx.env.demo) ctx.db.put('settings', { ...s, payments: { ...s.payments, connected: true, accountId: s.payments.accountId ?? 'acc_Demo12345' } });
    return { onboardingUrl: '' };
  });
  r.get('/admin/me', { staff: true }, (ctx) => ({ staff: ctx.staff, permissions: PERMISSIONS[ctx.role!], roles: ROLES.map((r) => ({ role: r, label: ROLE_LABELS[r], permissions: PERMISSIONS[r] })) }));
  r.get('/admin/staff', { perm: 'staff' }, (ctx) => ctx.db.all('staff').sort((x, y) => ROLES.indexOf(x.role) - ROLES.indexOf(y.role) || x.name.localeCompare(y.name)));
  r.post('/admin/staff', { perm: 'staff' }, (ctx) => {
    requireFields(ctx.body, ['name', 'email', 'role']);
    const email = normEmail(ctx.body.email);
    if (!ROLES.includes(ctx.body.role) || ctx.body.role === 'owner') throw new ApiError(422, 'invalid', 'Choose a role.', { role: 'Choose a role' });
    if (ctx.db.all('staff').some((s) => normEmail(s.email) === email)) throw new ApiError(409, 'exists', 'This email is already on the team.');
    checkLimit(ctx.db, ctx.now, 'staff', ctx.db.count('staff'));
    const person = ctx.db.all('people').find((p) => normEmail(p.email) === email);
    const s = ctx.db.put('staff', { id: ctx.id('st'), personId: person?.id ?? null, name: String(ctx.body.name), email, phone: ctx.body.phone ?? person?.phone ?? null, role: ctx.body.role, status: 'invited', lastActiveAt: null });
    ctx.audit('invited', 'staff', s.id, `Invited ${s.name} as ${ROLE_LABELS[s.role]}`);
    void ctx.env
      .deliver('email', [{ to: email, name: s.name, subject: `You're invited to ${settings(ctx).name} on Flockwise`, text: `Hi ${s.name},\n\nYou've been added to the ${settings(ctx).name} church office as ${ROLE_LABELS[s.role]}.\nSign in with this email at ${ctx.env.webUrl}/admin\n\nFlockwise` }])
      .catch(() => undefined);
    return s;
  });
  r.patch('/admin/staff/:id', { perm: 'staff' }, (ctx) => {
    const s = find(ctx, 'staff', ctx.params[0], 'Team member');
    const role = ctx.body.role as StaffRole;
    if (!ROLES.includes(role)) throw new ApiError(422, 'invalid', 'Choose a role.');
    if (s.role === 'owner' || role === 'owner') throw new ApiError(422, 'owner', 'Ownership cannot be changed here.');
    ctx.audit('updated', 'staff', s.id, `Changed ${s.name} to ${ROLE_LABELS[role]}`);
    return ctx.db.put('staff', { ...s, role });
  });
  r.del('/admin/staff/:id', { perm: 'staff' }, (ctx) => {
    const s = find(ctx, 'staff', ctx.params[0], 'Team member');
    if (s.role === 'owner') throw new ApiError(422, 'owner', 'The church owner cannot be removed.');
    ctx.db.del('staff', s.id);
    for (const t of ctx.db.all('refreshTokens')) if (t.staffId === s.id && !t.revoked) ctx.db.put('refreshTokens', { ...t, revoked: true });
    ctx.audit('removed', 'staff', s.id, `Removed ${s.name} from the team`);
    return undefined;
  });
  r.get('/admin/audit', { perm: 'settings' }, (ctx) => {
    const q = String(ctx.query.q ?? '').toLowerCase();
    const list = ctx.db
      .all('audit')
      .filter((a) => !q || a.summary.toLowerCase().includes(q) || a.actorName.toLowerCase().includes(q))
      .sort((x, y) => y.at.localeCompare(x.at));
    return page(list, ctx.query.cursor);
  });
}

export function addMember(ctx: Ctx, groupId: string, personId: string) {
  if (!ctx.db.all('groupMembers').some((m) => m.groupId === groupId && m.personId === personId))
    ctx.db.put('groupMembers', { id: ctx.id('gmb'), groupId, personId, since: ctx.now.toISOString() });
}

export function ensureEventFund(ctx: Ctx) {
  return ctx.db.get('funds', 'fd_events') ?? ctx.db.put('funds', { id: 'fd_events', name: 'Event registrations', description: 'Tickets for paid events.', taxDeductible: false, active: false, goal: null, system: true });
}

/** A paid ticket also counts as an RSVP. */
export function onTicketPaid(ctx: Ctx, d: Collections['donations']) {
  if (!d.eventId || !d.donorId) return;
  if (!rsvpsFor(ctx, d.eventId).some((x) => x.personId === d.donorId)) ctx.db.put('rsvps', { id: ctx.id('rv'), eventId: d.eventId, personId: d.donorId, at: ctx.now.toISOString() });
}
