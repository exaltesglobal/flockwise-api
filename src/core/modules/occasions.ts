// Pastoral services: weddings, funerals, baby dedications, house blessings and baptisms. A member
// asks from the app (or the office writes it down from a phone call), the office confirms the date
// and pastor, and works through a checklist that fits the occasion: counselling sessions and banns
// for a wedding, the burial ground and register for a funeral. The pastor is reminded the day before.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { MyOccasion, Occasion, OccasionKind, OccasionsHub, OccasionStatus, OccasionView } from '../types.js';
import { permsOf } from '../perms.js';
import { find, fullName, localDate, normEmail, settings } from '../util.js';
import { notify } from './notify.js';

const DAY = 86_400_000;
const KINDS: OccasionKind[] = ['wedding', 'funeral', 'dedication', 'house_blessing', 'baptism', 'other'];
const LABEL: Record<OccasionKind, string> = { wedding: 'Wedding', funeral: 'Funeral', dedication: 'Baby dedication', house_blessing: 'House blessing', baptism: 'Baptism', other: 'Pastoral service' };
const TASKS: Record<OccasionKind, string[]> = {
  wedding: ['Pre-marriage counselling: session 1', 'Pre-marriage counselling: session 2', 'Pre-marriage counselling: session 3', 'Banns read on three Sundays', 'Age proof and baptism certificates collected', 'Witnesses confirmed', 'Marriage register signed', 'Marriage certificate issued'],
  funeral: ['Visit the family and pray', 'Order of service agreed', 'Burial ground or crematorium booked', 'Hearse and transport arranged', 'Recorded in the burial register', 'Follow-up visit after a week'],
  dedication: ['Meet the parents', 'Godparents confirmed', 'Dedication certificate prepared', 'Recorded in the register'],
  house_blessing: ['Address and time confirmed', 'Pastor and elders confirmed'],
  baptism: ['Baptism classes completed', 'Testimony heard', 'Baptismal clothes and towels ready', 'Recorded in the baptism register', 'Certificate issued'],
  other: [],
};
const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const isDate = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));
const isTime = (v: unknown) => /^\d{2}:\d{2}$/.test(String(v ?? ''));
const nameOf = (ctx: Ctx, id: string | null) => { const p = id ? ctx.db.get('people', id) : null; return p ? fullName(p) : null; };

/** People who can take a service: active staff with the care permission. */
function pastors(ctx: Ctx): { id: string; name: string }[] {
  const out = new Map<string, string>();
  for (const s of ctx.db.all('staff')) {
    if (s.status !== 'active' || !permsOf(ctx.db, s).includes('care')) continue;
    const p = (s.personId && ctx.db.get('people', s.personId)) || ctx.db.all('people').find((x) => normEmail(x.email) === normEmail(s.email));
    if (p) out.set(p.id, fullName(p));
  }
  return [...out].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

function view(ctx: Ctx, o: Occasion): OccasionView {
  return {
    ...o,
    people: o.personIds.map((id) => ({ id, name: nameOf(ctx, id) ?? 'Removed person' })),
    pastorName: nameOf(ctx, o.pastorId),
    requestedByName: nameOf(ctx, o.requestedBy),
    done: o.checklist.filter((t) => t.done).length,
    total: o.checklist.length,
  };
}

function hub(ctx: Ctx): OccasionsHub {
  const all = ctx.db.all('occasions').map((o) => view(ctx, o));
  const today = localDate(ctx, ctx.now);
  const byDate = (a: OccasionView, b: OccasionView) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || (a.time ?? '').localeCompare(b.time ?? '');
  const year = today.slice(0, 4);
  const thisYear = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<OccasionKind, number>;
  for (const o of all) if (o.status !== 'cancelled' && o.date?.startsWith(year)) thisYear[o.kind]++;
  return {
    requests: all.filter((o) => o.status === 'requested').sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    upcoming: all.filter((o) => o.status === 'scheduled').sort(byDate),
    past: all.filter((o) => o.status === 'done' || o.status === 'cancelled').sort((a, b) => byDate(b, a)).slice(0, 100),
    counts: {
      requests: all.filter((o) => o.status === 'requested').length,
      thisMonth: all.filter((o) => o.status === 'scheduled' && o.date?.startsWith(today.slice(0, 7))).length,
      thisYear,
    },
    pastors: pastors(ctx),
  };
}

function titleFor(ctx: Ctx, kind: OccasionKind, personIds: string[], given: string): string {
  if (given) return given;
  const names = personIds.map((id) => nameOf(ctx, id)).filter(Boolean) as string[];
  if (!names.length) return LABEL[kind];
  if (kind === 'wedding' && names.length >= 2) return `Wedding of ${names[0]} and ${names[1]}`;
  if (kind === 'funeral') return `Funeral of ${names[0]}`;
  return `${LABEL[kind]}: ${names.join(', ')}`;
}

function read(ctx: Ctx, b: Record<string, unknown>, prev?: Occasion): Omit<Occasion, 'id' | 'checklist' | 'requestedBy' | 'via' | 'remindedFor' | 'createdAt' | 'status' | 'requestNote'> {
  const kind = b.kind !== undefined ? (KINDS.includes(b.kind as OccasionKind) ? (b.kind as OccasionKind) : 'other') : (prev?.kind ?? 'other');
  const personIds = Array.isArray(b.personIds) ? [...new Set((b.personIds as unknown[]).map(String))].slice(0, 6) : (prev?.personIds ?? []);
  for (const id of personIds) find(ctx, 'people', id, 'Person');
  const pastorId = b.pastorId !== undefined ? (b.pastorId ? String(b.pastorId) : null) : (prev?.pastorId ?? null);
  if (pastorId) find(ctx, 'people', pastorId, 'Pastor');
  if (b.date !== undefined && b.date !== null && b.date !== '' && !isDate(b.date)) throw new ApiError(422, 'invalid', 'Pick a date.', { date: 'Invalid date' });
  if (b.time !== undefined && b.time !== null && b.time !== '' && !isTime(b.time)) throw new ApiError(422, 'invalid', 'Pick a time.', { time: 'Invalid time' });
  return {
    kind, personIds, pastorId,
    title: titleFor(ctx, kind, personIds, b.title !== undefined ? clean(b.title, 140) : (prev?.title ?? '')),
    contactName: b.contactName !== undefined ? clean(b.contactName, 100) : (prev?.contactName ?? ''),
    contactPhone: b.contactPhone !== undefined ? clean(b.contactPhone, 20) : (prev?.contactPhone ?? ''),
    date: b.date !== undefined ? (b.date ? String(b.date) : null) : (prev?.date ?? null),
    time: b.time !== undefined ? (b.time ? String(b.time) : null) : (prev?.time ?? null),
    place: b.place !== undefined ? clean(b.place, 200) : (prev?.place ?? ''),
    notes: b.notes !== undefined ? clean(b.notes, 2000) : (prev?.notes ?? ''),
  };
}

const tasksFor = (ctx: Ctx, kind: OccasionKind) => TASKS[kind].map((label) => ({ id: ctx.id('ot'), label, done: false }));

function mine(ctx: Ctx): { occasions: MyOccasion[] } {
  const me = ctx.me();
  return {
    occasions: ctx.db.all('occasions')
      .filter((o) => (o.requestedBy === me || o.personIds.includes(me)) && o.status !== 'cancelled')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20)
      .map((o) => ({ id: o.id, kind: o.kind, title: o.title, status: o.status, date: o.date, time: o.time, place: o.place, pastorName: nameOf(ctx, o.pastorId) })),
  };
}

async function tellScheduled(ctx: Ctx, o: Occasion) {
  const church = settings(ctx).name;
  const when = `${o.date ?? 'a date to be fixed'}${o.time ? ` at ${o.time}` : ''}`;
  const pastor = nameOf(ctx, o.pastorId);
  if (o.requestedBy) await notify(ctx, 'occasion.scheduled', { personIds: [o.requestedBy], title: `${church}: ${LABEL[o.kind]} confirmed`, body: `${o.title} is set for ${when}${o.place ? `, ${o.place}` : ''}.${pastor ? ` ${pastor} will lead it.` : ''}`, link: '/app/occasions' });
  if (o.pastorId) await notify(ctx, 'occasion.scheduled', { personIds: [o.pastorId], title: `You are taking: ${o.title}`, body: `${when}${o.place ? `, ${o.place}` : ''}. The checklist is in Flockwise.`, link: '/admin/occasions' });
}

/** Daily: the pastor gets a reminder the day before, with any checklist items still open. */
export async function occasionReminders(ctx: Ctx, today: string) {
  const tomorrow = addDays(today, 1);
  for (const o of ctx.db.all('occasions')) {
    if (o.status !== 'scheduled' || o.date !== tomorrow || !o.pastorId || o.remindedFor === o.date) continue;
    ctx.db.put('occasions', { ...o, remindedFor: o.date });
    const open = o.checklist.filter((t) => !t.done).map((t) => t.label);
    await notify(ctx, 'occasion.reminder', {
      personIds: [o.pastorId],
      title: `Tomorrow: ${o.title}`,
      body: `${o.time ? `${o.time}, ` : ''}${o.place || 'place not set'}.${o.contactName ? ` Family contact: ${o.contactName}${o.contactPhone ? ` ${o.contactPhone}` : ''}.` : ''}${open.length ? ` Still open: ${open.slice(0, 4).join('; ')}${open.length > 4 ? ` and ${open.length - 4} more` : ''}.` : ''}`,
      link: '/admin/occasions',
    });
  }
}

export function registerOccasions(r: Router) {
  r.get('/admin/occasions', { perm: ['care', 'people.view'] }, (ctx) => hub(ctx));

  r.post('/admin/occasions', { perm: 'care' }, async (ctx) => {
    const b = ctx.body as Record<string, unknown>;
    const base = read(ctx, b);
    const status: OccasionStatus = base.date ? 'scheduled' : 'requested';
    const o = ctx.db.put('occasions', { id: ctx.id('oc'), ...base, status, checklist: tasksFor(ctx, base.kind), requestNote: '', requestedBy: null, via: 'office', remindedFor: null, createdAt: ctx.now.toISOString() });
    ctx.audit('created', 'occasion', o.id, o.title);
    if (status === 'scheduled') await tellScheduled(ctx, o);
    return view(ctx, o);
  });

  r.patch('/admin/occasions/:id', { perm: 'care' }, async (ctx) => {
    const o = find(ctx, 'occasions', ctx.params[0], 'Service');
    const b = ctx.body as Record<string, unknown>;
    const base = read(ctx, b, o);
    let status: OccasionStatus = (['requested', 'scheduled', 'done', 'cancelled'] as OccasionStatus[]).includes(b.status as OccasionStatus) ? (b.status as OccasionStatus) : o.status;
    if (status === 'scheduled' && !base.date) throw new ApiError(422, 'invalid', 'Set a date to confirm it.', { date: 'Required to confirm' });
    if (o.status === 'requested' && b.status === undefined && base.date && base.pastorId) status = 'scheduled';
    const kindChanged = base.kind !== o.kind && !o.checklist.some((t) => t.done);
    const next: Occasion = { ...o, ...base, status, checklist: kindChanged ? tasksFor(ctx, base.kind) : o.checklist, remindedFor: base.date !== o.date ? null : o.remindedFor };
    ctx.db.put('occasions', next);
    if (status !== o.status) ctx.audit('updated', 'occasion', o.id, `${o.title}: ${status}`);
    const moved = status === 'scheduled' && (o.status !== 'scheduled' || base.date !== o.date || base.time !== o.time || base.pastorId !== o.pastorId);
    if (moved) await tellScheduled(ctx, next);
    return view(ctx, next);
  });

  r.post('/admin/occasions/:id/checklist', { perm: 'care' }, (ctx) => {
    const o = find(ctx, 'occasions', ctx.params[0], 'Service');
    const b = ctx.body as Record<string, unknown>;
    let checklist = o.checklist;
    if (b.toggle) checklist = checklist.map((t) => (t.id === b.toggle ? { ...t, done: !t.done } : t));
    else if (b.remove) checklist = checklist.filter((t) => t.id !== b.remove);
    else {
      const label = clean(b.label, 120);
      if (!label) throw new ApiError(422, 'invalid', 'Write the task.', { label: 'Required' });
      if (checklist.length >= 30) throw new ApiError(409, 'limit', 'A checklist can have up to 30 items.');
      checklist = [...checklist, { id: ctx.id('ot'), label, done: false }];
    }
    const next = ctx.db.put('occasions', { ...o, checklist });
    return view(ctx, next);
  });

  r.del('/admin/occasions/:id', { perm: 'care' }, (ctx) => {
    const o = find(ctx, 'occasions', ctx.params[0], 'Service');
    ctx.db.del('occasions', o.id);
    ctx.audit('deleted', 'occasion', o.id, o.title);
    return { ok: true };
  });

  // Member app: ask for a service, and see the ones I asked for or am part of.
  r.get('/me/occasions', {}, (ctx) => mine(ctx));
  r.post('/me/occasions', {}, async (ctx) => {
    const b = ctx.body as Record<string, unknown>;
    const me = ctx.me();
    const kind = KINDS.includes(b.kind as OccasionKind) ? (b.kind as OccasionKind) : 'other';
    if (ctx.db.all('occasions').filter((o) => o.requestedBy === me && o.status === 'requested').length >= 3) throw new ApiError(409, 'limit', 'You already have requests waiting. The office will call you soon.');
    if (b.date && (!isDate(b.date) || String(b.date) < localDate(ctx, ctx.now))) throw new ApiError(422, 'invalid', 'Pick a date from today on.', { date: 'From today' });
    const p = ctx.db.get('people', me);
    const note = clean(b.note, 1000);
    const o = ctx.db.put('occasions', {
      id: ctx.id('oc'), kind, personIds: kind === 'funeral' ? [] : [me], pastorId: null,
      title: kind === 'funeral' ? clean(b.title, 140) || 'Funeral' : titleFor(ctx, kind, [me], clean(b.title, 140)),
      contactName: p ? fullName(p) : '', contactPhone: clean(b.phone, 20) || p?.phone || '',
      date: b.date ? String(b.date) : null, time: isTime(b.time) ? String(b.time) : null, place: clean(b.place, 200),
      notes: '', requestNote: note, status: 'requested', checklist: tasksFor(ctx, kind), requestedBy: me, via: 'app', remindedFor: null, createdAt: ctx.now.toISOString(),
    });
    await notify(ctx, 'occasion.request', { personIds: pastors(ctx).map((x) => x.id), except: me, title: `${LABEL[kind]} request`, body: `${p ? fullName(p) : 'A member'} asked for a ${LABEL[kind].toLowerCase()}${o.date ? ` on ${o.date}` : ''}.${note ? ` "${note.slice(0, 140)}"` : ''}`, link: '/admin/occasions' });
    return mine(ctx);
  });
  r.del('/me/occasions/:id', {}, (ctx) => {
    const o = find(ctx, 'occasions', ctx.params[0], 'Service');
    if (o.requestedBy !== ctx.me() || o.status !== 'requested') throw new ApiError(403, 'forbidden', 'Only a waiting request you made can be withdrawn.');
    ctx.db.put('occasions', { ...o, status: 'cancelled' });
    return mine(ctx);
  });
}
