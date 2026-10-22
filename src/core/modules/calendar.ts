// Church calendar: rooms, equipment and vehicles that can be booked, with approvals and
// clash warnings. Events and bookings show together on one calendar.
import { ApiError } from '../errors.js';
import type { Ctx, Router } from '../engine.js';
import type { Booking, BookingConflict, BookingView, CalendarItem, Collections, Resource } from '../types.js';
import { DAY, find, pick, requireFields } from '../util.js';

const KINDS = ['room', 'equipment', 'vehicle', 'other'];
const overlaps = (a: { startsAt: string; endsAt: string }, b: { startsAt: string; endsAt: string }) => a.startsAt < b.endsAt && b.startsAt < a.endsAt;

/** The time a booking blocks, including setup before it starts. */
const blocked = (b: Pick<Booking, 'startsAt' | 'endsAt' | 'setupMinutes'>) => ({ startsAt: new Date(new Date(b.startsAt).getTime() - (b.setupMinutes || 0) * 60_000).toISOString(), endsAt: b.endsAt });

export function conflictsFor(ctx: Ctx, b: Pick<Booking, 'id' | 'resourceIds' | 'startsAt' | 'endsAt' | 'setupMinutes'>): BookingConflict[] {
  const out: BookingConflict[] = [];
  for (const other of ctx.db.all('bookings')) {
    if (other.id === b.id || other.status === 'declined' || other.status === 'cancelled') continue;
    if (!overlaps(blocked(b), blocked(other))) continue;
    for (const rid of b.resourceIds) {
      if (!other.resourceIds.includes(rid)) continue;
      out.push({ bookingId: other.id, title: other.title, resourceName: ctx.db.get('resources', rid)?.name ?? 'Resource', startsAt: other.startsAt, endsAt: other.endsAt, status: other.status });
    }
  }
  return out;
}

function canDecide(ctx: Ctx, b: Booking) {
  if (ctx.role === 'owner' || ctx.role === 'admin') return true;
  return b.resourceIds.some((id) => ctx.db.get('resources', id)?.approverIds.includes(ctx.staff?.id ?? ''));
}

function view(ctx: Ctx, b: Booking): BookingView {
  return {
    ...b,
    resources: b.resourceIds.map((id) => ({ id, name: ctx.db.get('resources', id)?.name ?? 'Removed' })),
    conflicts: b.status === 'declined' || b.status === 'cancelled' ? [] : conflictsFor(ctx, b),
    canDecide: canDecide(ctx, b),
  };
}

function cleanResource(body: Record<string, unknown>): Partial<Resource> {
  const input = pick<Resource>(body, ['name', 'kind', 'capacity', 'description', 'needsApproval', 'approverIds']);
  if (input.kind && !KINDS.includes(input.kind)) input.kind = 'other';
  if (input.capacity !== undefined) input.capacity = input.capacity ? Math.max(1, Math.round(Number(input.capacity))) : null;
  if (input.approverIds) input.approverIds = (input.approverIds as unknown[]).map(String);
  return input;
}

function notifyApprovers(ctx: Ctx, b: Booking) {
  const ids = new Set(b.resourceIds.flatMap((id) => ctx.db.get('resources', id)?.approverIds ?? []));
  const staff = [...ids].map((id) => ctx.db.get('staff', id)).filter((s): s is Collections['staff'] => !!s && s.status === 'active' && !!s.email);
  if (!staff.length) return;
  const when = `${b.startsAt.slice(0, 16).replace('T', ' ')} UTC`;
  void ctx.env
    .deliver('email', staff.map((s) => ({ to: s.email, name: s.name, subject: `Booking request: ${b.title}`, text: `${b.requestedByName} asked to book ${view(ctx, b).resources.map((r) => r.name).join(', ')} for “${b.title}” at ${when}.\n\nApprove or decline it in the church office: ${ctx.env.webUrl}/admin/calendar` })))
    .catch(() => undefined);
}

export function registerCalendar(r: Router) {
  // ----- resources -----
  r.get('/admin/resources', { staff: true }, (ctx) => ctx.db.all('resources').sort((x, y) => x.kind.localeCompare(y.kind) || x.name.localeCompare(y.name)));
  r.post('/admin/resources', { perm: 'settings' }, (ctx) => {
    requireFields(ctx.body, ['name']);
    const res = ctx.db.put('resources', { name: '', kind: 'room', capacity: null, description: '', needsApproval: false, approverIds: [], ...cleanResource(ctx.body), id: ctx.id('rs') });
    ctx.audit('created', 'resource', res.id, `Added ${res.name} to bookable resources`);
    return res;
  });
  r.patch('/admin/resources/:id', { perm: 'settings' }, (ctx) => {
    const res = find(ctx, 'resources', ctx.params[0], 'Resource');
    return ctx.db.put('resources', { ...res, ...cleanResource(ctx.body) });
  });
  r.del('/admin/resources/:id', { perm: 'settings' }, (ctx) => {
    const res = find(ctx, 'resources', ctx.params[0], 'Resource');
    const future = ctx.db.all('bookings').some((b) => b.resourceIds.includes(res.id) && b.endsAt > ctx.now.toISOString() && (b.status === 'approved' || b.status === 'pending'));
    if (future) throw new ApiError(409, 'in_use', `${res.name} has upcoming bookings. Cancel them first.`);
    ctx.db.del('resources', res.id);
    return undefined;
  });

  // ----- calendar -----
  r.get('/admin/calendar', { staff: true }, (ctx): CalendarItem[] => {
    const from = ctx.query.from ? new Date(ctx.query.from).toISOString() : new Date(ctx.now.getTime() - 7 * DAY).toISOString();
    const to = ctx.query.to ? new Date(ctx.query.to).toISOString() : new Date(ctx.now.getTime() + 35 * DAY).toISOString();
    const range = { startsAt: from, endsAt: to };
    const bookingsByEvent = new Map<string, string[]>();
    const items: CalendarItem[] = [];
    for (const b of ctx.db.all('bookings')) {
      if (b.status === 'declined' || b.status === 'cancelled' || !overlaps(b, range)) continue;
      const names = b.resourceIds.map((id) => ctx.db.get('resources', id)?.name ?? '').filter(Boolean);
      if (b.eventId) bookingsByEvent.set(b.eventId, [...(bookingsByEvent.get(b.eventId) ?? []), ...names]);
      else items.push({ id: b.id, type: 'booking', title: b.title, startsAt: b.startsAt, endsAt: b.endsAt, status: b.status, resources: names, color: b.status === 'pending' ? '#B54708' : '#475467' });
    }
    for (const ev of ctx.db.all('events')) {
      if (!overlaps(ev, range)) continue;
      items.push({ id: ev.id, type: 'event', title: ev.title, startsAt: ev.startsAt, endsAt: ev.endsAt, status: ev.published ? 'published' : 'draft', resources: bookingsByEvent.get(ev.id) ?? (ev.location ? [ev.location] : []), color: ev.kind === 'service' ? '#1F5C4D' : '#6941C6' });
    }
    return items.sort((x, y) => x.startsAt.localeCompare(y.startsAt));
  });

  // ----- bookings -----
  r.get('/admin/bookings', { staff: true }, (ctx) => {
    const status = ctx.query.status;
    const upcoming = ctx.query.when !== 'past';
    return ctx.db
      .all('bookings')
      .filter((b) => (!status || b.status === status) && (upcoming ? b.endsAt >= ctx.now.toISOString() : b.endsAt < ctx.now.toISOString()))
      .sort((x, y) => (upcoming ? x.startsAt.localeCompare(y.startsAt) : y.startsAt.localeCompare(x.startsAt)))
      .map((b) => view(ctx, b));
  });
  r.post('/admin/bookings/check', { staff: true }, (ctx) => {
    const ids: string[] = Array.isArray(ctx.body.resourceIds) ? ctx.body.resourceIds.map(String) : [];
    if (!ctx.body.startsAt || !ctx.body.endsAt) return [];
    return conflictsFor(ctx, { id: String(ctx.body.id ?? ''), resourceIds: ids, startsAt: new Date(ctx.body.startsAt).toISOString(), endsAt: new Date(ctx.body.endsAt).toISOString(), setupMinutes: Number(ctx.body.setupMinutes) || 0 });
  });
  r.post('/admin/bookings', { staff: true }, (ctx) => {
    requireFields(ctx.body, ['title', 'startsAt', 'endsAt']);
    const resourceIds: string[] = (Array.isArray(ctx.body.resourceIds) ? ctx.body.resourceIds : []).map(String);
    if (!resourceIds.length) throw new ApiError(422, 'invalid', 'Choose at least one room or resource.', { resourceIds: 'Required' });
    const resources = resourceIds.map((id) => find(ctx, 'resources', id, 'Resource'));
    const startsAt = new Date(ctx.body.startsAt);
    const endsAt = new Date(ctx.body.endsAt);
    if (!(endsAt > startsAt)) throw new ApiError(422, 'invalid', 'The end must be after the start.', { endsAt: 'After the start' });
    if (ctx.body.eventId) find(ctx, 'events', String(ctx.body.eventId), 'Event');
    const weeks = Math.min(52, Math.max(1, Math.round(Number(ctx.body.repeatWeeks) || 1)));
    const needsApproval = resources.some((x) => x.needsApproval) && ctx.role !== 'owner' && ctx.role !== 'admin' && !resources.every((x) => x.approverIds.includes(ctx.staff!.id));
    const made: BookingView[] = [];
    for (let i = 0; i < weeks; i++) {
      const b: Booking = {
        id: ctx.id('bk'),
        title: String(ctx.body.title).trim().slice(0, 120),
        resourceIds,
        startsAt: new Date(startsAt.getTime() + i * 7 * DAY).toISOString(),
        endsAt: new Date(endsAt.getTime() + i * 7 * DAY).toISOString(),
        eventId: i === 0 && ctx.body.eventId ? String(ctx.body.eventId) : null,
        requestedBy: ctx.staff!.id,
        requestedByName: ctx.staff!.name,
        status: needsApproval ? 'pending' : 'approved',
        notes: String(ctx.body.notes ?? '').slice(0, 2000),
        setupMinutes: Math.max(0, Math.round(Number(ctx.body.setupMinutes) || 0)),
        createdAt: ctx.now.toISOString(),
        decidedBy: needsApproval ? null : ctx.staff!.name,
        decidedAt: needsApproval ? null : ctx.now.toISOString(),
        decisionNote: null,
      };
      const clashes = conflictsFor(ctx, b).filter((c) => c.status === 'approved');
      if (clashes.length && !ctx.body.force)
        throw new ApiError(409, 'conflict', `${clashes[0].resourceName} is already booked for “${clashes[0].title}” at that time${weeks > 1 ? ` (week ${i + 1})` : ''}.`, { conflicts: JSON.stringify(clashes) });
      ctx.db.put('bookings', b);
      if (needsApproval && i === 0) notifyApprovers(ctx, b);
      made.push(view(ctx, b));
    }
    ctx.audit('created', 'booking', made[0].id, `${needsApproval ? 'Requested' : 'Booked'} ${made[0].resources.map((x) => x.name).join(', ')} for “${made[0].title}”${weeks > 1 ? ` weekly × ${weeks}` : ''}`);
    return made[0];
  });
  r.patch('/admin/bookings/:id', { staff: true }, (ctx) => {
    const b = find(ctx, 'bookings', ctx.params[0], 'Booking');
    if (b.requestedBy !== ctx.staff!.id && !canDecide(ctx, b)) throw new ApiError(403, 'forbidden', 'Only the person who booked it or an approver can change this booking.');
    const patch = pick<Booking>(ctx.body, ['title', 'notes', 'startsAt', 'endsAt', 'resourceIds', 'setupMinutes']);
    for (const k of ['startsAt', 'endsAt'] as const) if (patch[k]) patch[k] = new Date(patch[k]!).toISOString();
    const next = { ...b, ...patch };
    const clashes = conflictsFor(ctx, next).filter((c) => c.status === 'approved');
    if (clashes.length && !ctx.body.force) throw new ApiError(409, 'conflict', `${clashes[0].resourceName} is already booked for “${clashes[0].title}” at that time.`);
    return view(ctx, ctx.db.put('bookings', next));
  });
  r.post('/admin/bookings/:id/:decision', { staff: true }, (ctx) => {
    const b = find(ctx, 'bookings', ctx.params[0], 'Booking');
    const decision = ctx.params[1];
    if (decision === 'cancel') {
      if (b.requestedBy !== ctx.staff!.id && !canDecide(ctx, b)) throw new ApiError(403, 'forbidden', 'Only the person who booked it or an approver can cancel it.');
      ctx.audit('cancelled', 'booking', b.id, `Cancelled the booking “${b.title}”`);
      return view(ctx, ctx.db.put('bookings', { ...b, status: 'cancelled' }));
    }
    if (decision !== 'approve' && decision !== 'decline') throw new ApiError(404, 'not_found', 'Unknown action.');
    if (!canDecide(ctx, b)) throw new ApiError(403, 'forbidden', 'You are not an approver for these resources.');
    if (decision === 'approve') {
      const clashes = conflictsFor(ctx, b).filter((c) => c.status === 'approved');
      if (clashes.length && !ctx.body.force) throw new ApiError(409, 'conflict', `${clashes[0].resourceName} is already booked for “${clashes[0].title}”. Decline one of them first.`);
    }
    const next = ctx.db.put('bookings', { ...b, status: decision === 'approve' ? 'approved' : 'declined', decidedBy: ctx.staff!.name, decidedAt: ctx.now.toISOString(), decisionNote: ctx.body.note ? String(ctx.body.note).slice(0, 500) : null });
    const requester = ctx.db.get('staff', b.requestedBy);
    if (requester?.email && requester.id !== ctx.staff!.id)
      void ctx.env.deliver('email', [{ to: requester.email, name: requester.name, subject: `Booking ${next.status}: ${b.title}`, text: `${ctx.staff!.name} ${next.status} your booking for “${b.title}”.${next.decisionNote ? `\n\n${next.decisionNote}` : ''}` }]).catch(() => undefined);
    ctx.audit(next.status, 'booking', b.id, `${next.status === 'approved' ? 'Approved' : 'Declined'} the booking “${b.title}”`);
    return view(ctx, next);
  });
}
