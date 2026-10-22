// People, households, campuses, the member's own profile and the opt-in directory.
import { ApiError } from '../errors.js';
import type { Db } from '../db.js';
import type { Ctx, Router } from '../engine.js';
import { checkLimit } from '../plans.js';
import type { Collections, Consent, DirectoryEntry, ImportResult, PersonInput, PersonTimeline } from '../types.js';
import {
  age,
  dateOnly,
  DAY,
  find,
  fiscalYearStart,
  fullName,
  giftDate,
  memberProfile,
  newPerson,
  normEmail,
  normPhone,
  page,
  personView,
  pick,
  requireFields,
} from '../util.js';
import { cleanCustom, triggerWorkflows } from './workflows.js';
import { logConsent } from './privacy.js';

/** People counted towards the plan: everyone except those marked inactive. */
export const activePeople = (db: Db) => db.all('people').filter((p) => p.status !== 'inactive').length;

/** How many import rows match someone already in the database (by email or phone). */
function countExisting(ctx: Ctx, rows: Record<string, unknown>[]) {
  const emails = new Set(ctx.db.all('people').map((p) => normEmail(p.email)).filter(Boolean));
  const phones = new Set(ctx.db.all('people').map((p) => String(p.phone ?? '').replace(/\D/g, '').slice(-10)).filter((x) => x.length >= 8));
  return rows.filter((r) => emails.has(normEmail(String(r.email ?? ''))) || phones.has(String(r.phone ?? '').replace(/\D/g, '').slice(-10))).length;
}

const EDITABLE: (keyof PersonInput)[] = [
  'firstName', 'lastName', 'phone', 'email', 'gender', 'birthDate', 'status', 'householdName', 'address', 'language', 'tags', 'notes',
  'campusId', 'baptismDate', 'anniversary', 'allergies', 'medicalNotes', 'consent', 'zoneId',
];

function cleanInput(body: Record<string, unknown>) {
  const input = pick<PersonInput>(body, EDITABLE);
  for (const k of ['phone', 'email', 'birthDate', 'householdName', 'address', 'notes', 'baptismDate', 'anniversary', 'allergies', 'medicalNotes', 'zoneId'] as const)
    if (input[k] === '') input[k] = null;
  if (input.email) input.email = normEmail(input.email);
  if (input.birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.birthDate)) throw new ApiError(422, 'invalid', 'Birth date should be a date.', { birthDate: 'Use YYYY-MM-DD' });
  return input;
}

/** Custom field values merge into what the person already has. */
function withCustom(ctx: Ctx, body: Record<string, unknown>, existing?: Collections['people']) {
  return body?.custom === undefined ? {} : { custom: { ...(existing?.custom ?? {}), ...cleanCustom(ctx, body.custom) } };
}

function matches(p: Collections['people'], q: string) {
  if (!q) return true;
  const digits = q.replace(/\D/g, '');
  return (
    fullName(p).toLowerCase().includes(q) ||
    (p.email ?? '').toLowerCase().includes(q) ||
    (digits.length >= 3 && (p.phone ?? '').replace(/\D/g, '').includes(digits)) ||
    (p.householdName ?? '').toLowerCase().includes(q) ||
    p.checkinCode.toLowerCase() === q
  );
}

export function searchPeople(ctx: Ctx, q: string) {
  const needle = q.trim().toLowerCase();
  return ctx.db.all('people').filter((p) => matches(p, needle));
}

function importPeople(ctx: Ctx, rows: PersonInput[], dedupeBy: 'phone' | 'email'): ImportResult {
  const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] };
  const norm = (v: string | null | undefined) => (dedupeBy === 'phone' ? normPhone(v) : normEmail(v));
  const index = new Map<string, Collections['people']>();
  for (const p of ctx.db.all('people')) {
    const k = norm(dedupeBy === 'phone' ? p.phone : p.email);
    if (k) index.set(k, p);
  }
  rows.slice(0, 20000).forEach((raw, i) => {
    let row: Partial<PersonInput>;
    try {
      row = cleanInput(raw as Record<string, unknown>);
    } catch (e) {
      result.errors.push({ row: i + 1, message: (e as Error).message });
      return;
    }
    if (!row.firstName?.trim()) {
      result.errors.push({ row: i + 1, message: 'Missing first name' });
      return;
    }
    const key = norm(dedupeBy === 'phone' ? row.phone : row.email);
    const existing = key ? index.get(key) : undefined;
    if (existing) {
      const patch = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined && v !== null && v !== ''));
      if (Object.keys(patch).length <= 2) result.skipped++;
      else {
        index.set(key, ctx.db.put('people', { ...existing, ...patch }));
        result.updated++;
      }
      return;
    }
    const p = ctx.db.put('people', newPerson(ctx, { lastName: '', ...row, firstName: row.firstName }));
    if (key) index.set(key, p);
    result.created++;
  });
  return result;
}

export function removePerson(ctx: Ctx, id: string) {
  ctx.db.del('people', id);
  for (const kind of ['groupMembers', 'rsvps', 'joinRequests', 'blockouts', 'assignments', 'pledges'] as const)
    for (const r of ctx.db.all(kind)) if (('personId' in r && r.personId === id) || ('person' in r && r.person.id === id)) ctx.db.del(kind, r.id);
  for (const t of ctx.db.all('teams'))
    if (t.members.some((m) => m.personId === id)) ctx.db.put('teams', { ...t, members: t.members.filter((m) => m.personId !== id) });
}

function timeline(ctx: Ctx, p: Collections['people']): PersonTimeline {
  const household = p.householdName
    ? ctx.db
        .all('people')
        .filter((x) => x.householdName === p.householdName && x.id !== p.id)
        .map((x) => ({ id: x.id, name: fullName(x), status: x.status, age: age(x.birthDate, ctx.now) }))
    : [];
  const events = new Map(ctx.db.all('events').map((e) => [e.id, e]));
  const attendance = ctx.db
    .all('checkins')
    .filter((c) => c.personId === p.id)
    .sort((x, y) => y.at.localeCompare(x.at))
    .slice(0, 12)
    .map((c) => ({ eventId: c.eventId, title: events.get(c.eventId)?.title ?? 'Event', at: c.at }));
  const teams = new Map(ctx.db.all('teams').map((t) => [t.id, t]));
  const serving = ctx.db
    .all('assignments')
    .filter((a) => a.personId === p.id && events.has(a.eventId))
    .map((a) => {
      const t = teams.get(a.teamId);
      const ev = events.get(a.eventId)!;
      return { teamName: t?.name ?? 'Team', positionName: t?.positions.find((x) => x.id === a.positionId)?.name ?? '', eventTitle: ev.title, startsAt: ev.startsAt, status: a.status };
    })
    .sort((x, y) => y.startsAt.localeCompare(x.startsAt))
    .slice(0, 10);
  let giving: PersonTimeline['giving'] = null;
  if (ctx.can('giving.view')) {
    const gifts = ctx.db.all('donations').filter((d) => d.donorId === p.id && d.status === 'succeeded');
    const from = fiscalYearStart(ctx).toISOString();
    giving = {
      thisYear: gifts.filter((d) => giftDate(d) >= from).reduce((s, d) => s + d.amount, 0),
      lastGiftAt: gifts.map(giftDate).sort().at(-1) ?? null,
      recurring: gifts.some((d) => d.frequency === 'monthly' && giftDate(d) > new Date(ctx.now.getTime() - 40 * DAY).toISOString()),
    };
  }
  const care = ctx.can('care')
    ? ctx.db
        .all('care')
        .filter((c) => c.personId === p.id && (!c.confidential || ctx.role === 'owner' || ctx.role === 'pastor' || c.assignedTo === ctx.staff?.id))
        .map((c) => ({ id: c.id, title: c.title, status: c.status, createdAt: c.createdAt }))
    : [];
  return { person: personView(ctx, p), household, attendance, serving, giving, care };
}

export function registerPeople(r: Router) {
  // ----- member: profile, preferences, directory -----
  r.get('/me', {}, (ctx) => memberProfile(find(ctx, 'people', ctx.me(), 'Profile')));
  r.patch('/me', {}, (ctx) => {
    const p = find(ctx, 'people', ctx.me(), 'Profile');
    const patch = pick<Collections['people']>(ctx.body, ['firstName', 'lastName', 'email', 'language', 'phone']);
    if (patch.email) patch.email = normEmail(patch.email);
    return memberProfile(ctx.db.put('people', { ...p, ...patch }));
  });
  r.post('/me/devices', {}, () => undefined);
  r.get('/me/preferences', {}, (ctx) => {
    const p = find(ctx, 'people', ctx.me(), 'Profile');
    return { consent: p.consent, checkinCode: p.checkinCode, campusId: p.campusId };
  });
  r.patch('/me/preferences', {}, (ctx) => {
    const p = find(ctx, 'people', ctx.me(), 'Profile');
    const consent: Consent = { ...p.consent };
    for (const k of ['email', 'sms', 'whatsapp', 'directory'] as const) if (typeof ctx.body.consent?.[k] === 'boolean') consent[k] = ctx.body.consent[k];
    const campusId = ctx.body.campusId !== undefined && (ctx.body.campusId === null || ctx.db.get('campuses', ctx.body.campusId)) ? ctx.body.campusId : p.campusId;
    const next = ctx.db.put('people', { ...p, consent, campusId });
    logConsent(ctx, p.id, p.consent, next.consent, 'member');
    return { consent: next.consent, checkinCode: next.checkinCode, campusId: next.campusId };
  });
  r.get('/campuses', {}, (ctx) => ctx.db.all('campuses'));
  r.get('/directory', {}, (ctx) => {
    const me = find(ctx, 'people', ctx.me(), 'Profile');
    if (!me.consent.directory) throw new ApiError(403, 'directory_opt_in', 'Turn on "Show me in the directory" in your profile to see the directory.');
    const q = String(ctx.query.q ?? '').trim().toLowerCase();
    const listed = ctx.db.all('people').filter((p) => p.consent.directory && p.status !== 'inactive' && (!q || fullName(p).toLowerCase().includes(q) || (p.householdName ?? '').toLowerCase().includes(q)));
    const byHouse = new Map<string, DirectoryEntry>();
    for (const p of listed) {
      const key = p.householdName ?? `solo:${p.id}`;
      const entry = byHouse.get(key) ?? { householdName: p.householdName ?? fullName(p), area: p.address?.split(',')[0] ?? null, people: [] };
      entry.people.push({ id: p.id, name: fullName(p), phone: p.phone, email: p.email });
      byHouse.set(key, entry);
    }
    return { data: [...byHouse.values()].sort((x, y) => x.householdName.localeCompare(y.householdName)), nextCursor: null };
  });

  // ----- admin: people -----
  r.get('/admin/people', { perm: 'people.view' }, (ctx) => {
    const status = ctx.query.status;
    const tag = ctx.query.tag;
    const campusId = ctx.query.campusId;
    const list = searchPeople(ctx, String(ctx.query.q ?? ''))
      .filter((p) => !status || p.status === status)
      .filter((p) => !tag || p.tags.includes(tag))
      .filter((p) => !campusId || p.campusId === campusId)
      .filter((p) => !ctx.query.zoneId || (ctx.query.zoneId === 'none' ? !p.zoneId : p.zoneId === ctx.query.zoneId))
      .sort((x, y) => x.lastName.localeCompare(y.lastName) || x.firstName.localeCompare(y.firstName));
    const res = page(list, ctx.query.cursor);
    return { ...res, data: res.data.map((p) => personView(ctx, p)) };
  });
  r.get('/admin/people/tags', { perm: 'people.view' }, (ctx) => {
    const counts = new Map<string, number>();
    for (const p of ctx.db.all('people')) for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].map(([tag, count]) => ({ tag, count })).sort((x, y) => y.count - x.count);
  });
  r.post('/admin/people', { perm: 'people.edit' }, (ctx) => {
    requireFields(ctx.body, ['firstName']);
    checkLimit(ctx.db, ctx.now, 'people', activePeople(ctx.db));
    const p = ctx.db.put('people', newPerson(ctx, { lastName: '', ...cleanInput(ctx.body), ...withCustom(ctx, ctx.body), firstName: String(ctx.body.firstName) }));
    ctx.audit('created', 'person', p.id, `Added ${fullName(p)}`);
    if (p.status === 'visitor') triggerWorkflows(ctx, 'new_visitor', p.id);
    return personView(ctx, p);
  });
  r.post('/admin/people/import', { perm: 'people.edit' }, (ctx) => {
    if (Array.isArray(ctx.body.rows)) checkLimit(ctx.db, ctx.now, 'people', activePeople(ctx.db), Math.max(0, ctx.body.rows.length - countExisting(ctx, ctx.body.rows)));
    const result = importPeople(ctx, Array.isArray(ctx.body.rows) ? ctx.body.rows : [], ctx.body.dedupeBy === 'email' ? 'email' : 'phone');
    ctx.audit('imported', 'person', null, `Imported people from ${ctx.body.source ?? 'a file'}: ${result.created} added, ${result.updated} updated`);
    return result;
  });
  r.get('/admin/people/:id', { perm: 'people.view' }, (ctx) => personView(ctx, find(ctx, 'people', ctx.params[0], 'Person')));
  r.get('/admin/people/:id/timeline', { perm: 'people.view' }, (ctx) => timeline(ctx, find(ctx, 'people', ctx.params[0], 'Person')));
  r.patch('/admin/people/:id', { perm: 'people.edit' }, (ctx) => {
    const p = find(ctx, 'people', ctx.params[0], 'Person');
    const next = ctx.db.put('people', { ...p, ...cleanInput(ctx.body), ...withCustom(ctx, ctx.body, p) });
    if (ctx.body.consent) logConsent(ctx, p.id, p.consent, next.consent, 'staff');
    ctx.audit('updated', 'person', p.id, `Updated ${fullName(next)}`);
    return personView(ctx, next);
  });
  r.post('/admin/people/merge', { perm: 'people.edit' }, (ctx) => {
    // Keep `keepId`, fold `mergeId` into it (fills blanks, moves history), then delete the duplicate.
    const keep = find(ctx, 'people', String(ctx.body.keepId), 'Person');
    const dup = find(ctx, 'people', String(ctx.body.mergeId), 'Person');
    if (keep.id === dup.id) throw new ApiError(422, 'invalid', 'Choose two different people.');
    const merged = { ...keep };
    for (const [k, v] of Object.entries(dup)) if ((merged as Record<string, unknown>)[k] == null && v != null) (merged as Record<string, unknown>)[k] = v;
    merged.tags = [...new Set([...keep.tags, ...dup.tags])];
    ctx.db.put('people', merged);
    for (const kind of ['groupMembers', 'rsvps', 'checkins', 'assignments', 'blockouts', 'pledges', 'care'] as const)
      for (const rec of ctx.db.all(kind)) if ('personId' in rec && rec.personId === dup.id) ctx.db.put(kind, { ...rec, personId: keep.id } as never);
    for (const d of ctx.db.all('donations')) if (d.donorId === dup.id) ctx.db.put('donations', { ...d, donorId: keep.id });
    for (const t of ctx.db.all('teams'))
      if (t.members.some((m) => m.personId === dup.id))
        ctx.db.put('teams', { ...t, members: [...t.members.filter((m) => m.personId !== dup.id && m.personId !== keep.id), { personId: keep.id, positionIds: [...new Set(t.members.filter((m) => m.personId === dup.id || m.personId === keep.id).flatMap((m) => m.positionIds))] }] });
    ctx.db.del('people', dup.id);
    ctx.audit('merged', 'person', keep.id, `Merged ${fullName(dup)} into ${fullName(keep)}`);
    return personView(ctx, ctx.db.get('people', keep.id)!);
  });
  r.get('/admin/people-duplicates', { perm: 'people.view' }, (ctx) => {
    const groups = new Map<string, Collections['people'][]>();
    for (const p of ctx.db.all('people')) {
      for (const key of [normPhone(p.phone) && `ph:${normPhone(p.phone)}`, normEmail(p.email) && `em:${normEmail(p.email)}`, `nm:${fullName(p).toLowerCase()}:${p.birthDate ?? ''}`]) {
        if (!key || key.endsWith(':')) continue;
        groups.set(key, [...(groups.get(key) ?? []), p]);
      }
    }
    const seen = new Set<string>();
    const out: { reason: string; people: { id: string; name: string; phone: string | null; email: string | null }[] }[] = [];
    for (const [key, ps] of groups) {
      if (ps.length < 2) continue;
      const sig = ps.map((p) => p.id).sort().join(',');
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push({ reason: key.startsWith('ph') ? 'Same phone' : key.startsWith('em') ? 'Same email' : 'Same name and birthday', people: ps.map((p) => ({ id: p.id, name: fullName(p), phone: p.phone, email: p.email })) });
    }
    return out.slice(0, 100);
  });
  r.del('/admin/people/:id', { perm: 'people.edit' }, (ctx) => {
    const p = find(ctx, 'people', ctx.params[0], 'Person');
    if (ctx.db.all('staff').some((s) => s.personId === p.id && s.role === 'owner')) throw new ApiError(422, 'owner', 'The church owner cannot be deleted.');
    removePerson(ctx, p.id);
    ctx.audit('deleted', 'person', p.id, `Deleted ${fullName(p)}`);
    return undefined;
  });

  // ----- admin: campuses -----
  r.get('/admin/campuses', { perm: 'people.view' }, (ctx) =>
    ctx.db.all('campuses').map((c) => ({ ...c, people: ctx.db.all('people').filter((p) => p.campusId === c.id).length })),
  );
  r.post('/admin/campuses', { perm: 'settings' }, (ctx) => {
    requireFields(ctx.body, ['name']);
    checkLimit(ctx.db, ctx.now, 'campuses', ctx.db.count('campuses'));
    const c = ctx.db.put('campuses', { id: ctx.id('cp'), name: ctx.body.name, city: ctx.body.city ?? '', address: ctx.body.address ?? '', serviceTimes: ctx.body.serviceTimes ?? '' });
    ctx.audit('created', 'campus', c.id, `Added campus ${c.name}`);
    return c;
  });
  r.patch('/admin/campuses/:id', { perm: 'settings' }, (ctx) => {
    const c = find(ctx, 'campuses', ctx.params[0], 'Campus');
    return ctx.db.put('campuses', { ...c, ...pick(ctx.body, ['name', 'city', 'address', 'serviceTimes']) });
  });
  r.del('/admin/campuses/:id', { perm: 'settings' }, (ctx) => {
    const c = find(ctx, 'campuses', ctx.params[0], 'Campus');
    for (const p of ctx.db.all('people')) if (p.campusId === c.id) ctx.db.put('people', { ...p, campusId: null });
    for (const e of ctx.db.all('events')) if (e.campusId === c.id) ctx.db.put('events', { ...e, campusId: null });
    ctx.db.del('campuses', c.id);
    ctx.audit('deleted', 'campus', c.id, `Removed campus ${c.name}`);
    return undefined;
  });
}

export const recentlyAttended = (p: Collections['people'], now: Date, days: number) => !!p.lastAttendedAt && now.getTime() - new Date(p.lastAttendedAt).getTime() < days * DAY;
export { dateOnly };
