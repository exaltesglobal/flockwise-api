// People, households, campuses, the member's own profile and the opt-in directory.
import { ApiError } from '../errors.js';
import type { Db } from '../db.js';
import type { Ctx, Router } from '../engine.js';
import { checkLimit } from '../plans.js';
import type { Collections, Consent, DirectoryEntry, ImportResult, PersonInput, PersonTimeline } from '../types.js';
import type { ImportPersonRow } from '../import-presets.js';
import { addMember } from './church.js';

/** A scoped login (zone, group or team leader) only opens people in its scope. */
export function inScope<T extends { id: string }>(ctx: Ctx, p: T): T {
  if (!ctx.inScope(p.id)) throw new ApiError(403, 'forbidden', 'This person is outside the zones, groups or teams you lead.');
  return p;
}
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
import { notify, pastorIds } from './notify.js';
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
  'campusId', 'baptismDate', 'anniversary', 'allergies', 'medicalNotes', 'consent', 'zoneId', 'prayerChain', 'externalId',
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

const LANG_CODES: Record<string, string> = { english: 'en', hindi: 'hi', tamil: 'ta', telugu: 'te', malayalam: 'ml', kannada: 'kn', en: 'en', hi: 'hi', ta: 'ta', te: 'te', ml: 'ml', kn: 'kn' };

/**
 * Adds or updates people from a spreadsheet. Matching order: the old system's id, then the
 * mobile number or email (dedupeBy). Rows sharing a household key become one household named
 * after the primary contact; group names are created when missing; campuses are matched by name.
 */
function importPeople(ctx: Ctx, rows: ImportPersonRow[], dedupeBy: 'phone' | 'email'): ImportResult {
  const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [], households: 0, groups: [], campuses: [] };
  const norm = (v: string | null | undefined) => (dedupeBy === 'phone' ? normPhone(v) : normEmail(v));
  const index = new Map<string, Collections['people']>();
  const byExternal = new Map<string, Collections['people']>();
  for (const p of ctx.db.all('people')) {
    const k = norm(dedupeBy === 'phone' ? p.phone : p.email);
    if (k) index.set(k, p);
    if (p.externalId) byExternal.set(p.externalId, p);
  }
  // Household names: the primary contact's surname, else the first row's with that key.
  const householdNames = new Map<string, string>();
  for (const r of rows) {
    if (!r.householdKey) continue;
    const key = r.householdKey.trim().toLowerCase();
    const name = r.householdName || `${(r.lastName || r.firstName).trim()} family`;
    if (!householdNames.has(key) || r.householdRole === 'primary') householdNames.set(key, name);
  }
  result.households = householdNames.size;
  const groupsByName = new Map(ctx.db.all('groups').map((g) => [g.name.trim().toLowerCase(), g]));
  const campusesByName = new Map(ctx.db.all('campuses').map((c) => [c.name.trim().toLowerCase(), c]));
  const groupFor = (name: string) => {
    const key = name.trim().toLowerCase();
    let g = groupsByName.get(key);
    if (!g) {
      g = ctx.db.put('groups', { id: ctx.id('gr'), name: name.trim(), description: '', meetingSchedule: '', location: '', leaderName: '', isOpen: false, type: 'other', zone: '', leaderId: null });
      groupsByName.set(key, g);
      result.groups!.push(g.name);
    }
    return g;
  };
  const campusFor = (name: string) => {
    const key = name.trim().toLowerCase();
    let c = campusesByName.get(key);
    if (!c) {
      try {
        checkLimit(ctx.db, ctx.now, 'campuses', ctx.db.count('campuses'));
      } catch {
        return null; // the plan has no room for another campus: leave the person on the main campus
      }
      c = ctx.db.put('campuses', { id: ctx.id('cp'), name: name.trim(), city: '', address: '', serviceTimes: '' });
      campusesByName.set(key, c);
      result.campuses!.push(c.name);
    }
    return c;
  };
  rows.slice(0, 20000).forEach((raw, i) => {
    const { householdKey, householdRole: _role, groups, campus, language, externalId, ...rest } = raw;
    const body: Record<string, unknown> = { ...rest };
    if (householdKey && !body.householdName) body.householdName = householdNames.get(householdKey.trim().toLowerCase());
    if (language) body.language = LANG_CODES[language.trim().toLowerCase()];
    if (externalId) body.externalId = externalId.trim();
    if (campus) body.campusId = campusFor(campus)?.id;
    let row: Partial<PersonInput>;
    try {
      row = cleanInput(body);
    } catch (e) {
      result.errors.push({ row: i + 1, message: (e as Error).message });
      return;
    }
    if (!row.firstName?.trim()) {
      result.errors.push({ row: i + 1, message: 'Missing first name' });
      return;
    }
    const key = norm(dedupeBy === 'phone' ? row.phone : row.email);
    const existing = (row.externalId && byExternal.get(row.externalId)) || (key ? index.get(key) : undefined);
    let person: Collections['people'];
    if (existing) {
      const patch = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)));
      if (row.tags) patch.tags = [...new Set([...existing.tags, ...row.tags])];
      const changed = Object.entries(patch).some(([k, v]) => JSON.stringify((existing as Record<string, unknown>)[k]) !== JSON.stringify(v));
      if (!changed) {
        result.skipped++;
        person = existing;
      } else {
        person = ctx.db.put('people', { ...existing, ...patch });
        result.updated++;
      }
    } else {
      person = ctx.db.put('people', newPerson(ctx, { lastName: '', ...row, firstName: row.firstName }));
      result.created++;
    }
    if (key) index.set(key, person);
    if (person.externalId) byExternal.set(person.externalId, person);
    for (const g of groups ?? []) addMember(ctx, groupFor(g).id, person.id);
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
  r.get('/me/preferences', {}, (ctx) => {
    const p = find(ctx, 'people', ctx.me(), 'Profile');
    return { consent: p.consent, checkinCode: p.checkinCode, campusId: p.campusId, prayerChain: !!p.prayerChain, titheDay: p.titheDay ?? null, titheAmount: p.titheAmount ?? null };
  });
  r.patch('/me/preferences', {}, (ctx) => {
    const p = find(ctx, 'people', ctx.me(), 'Profile');
    const consent: Consent = { ...p.consent };
    for (const k of ['email', 'sms', 'whatsapp', 'directory'] as const) if (typeof ctx.body.consent?.[k] === 'boolean') consent[k] = ctx.body.consent[k];
    const campusId = ctx.body.campusId !== undefined && (ctx.body.campusId === null || ctx.db.get('campuses', ctx.body.campusId)) ? ctx.body.campusId : p.campusId;
    const prayerChain = typeof ctx.body.prayerChain === 'boolean' ? ctx.body.prayerChain : !!p.prayerChain;
    let titheDay = p.titheDay ?? null;
    if (ctx.body.titheDay === null) titheDay = null;
    else if (ctx.body.titheDay !== undefined) {
      const d = Number(ctx.body.titheDay);
      if (!Number.isInteger(d) || d < 1 || d > 31) throw new ApiError(422, 'validation', 'titheDay must be 1–31');
      titheDay = d;
    }
    let titheAmount = p.titheAmount ?? null;
    if (ctx.body.titheAmount === null) titheAmount = null;
    else if (ctx.body.titheAmount !== undefined) {
      const a = Number(ctx.body.titheAmount);
      if (!Number.isInteger(a) || a < 0) throw new ApiError(422, 'validation', 'titheAmount must be a whole number of paise');
      titheAmount = a || null;
    }
    const next = ctx.db.put('people', { ...p, consent, campusId, prayerChain, titheDay, titheAmount });
    logConsent(ctx, p.id, p.consent, next.consent, 'member');
    if (prayerChain !== !!p.prayerChain) ctx.audit(prayerChain ? 'joined' : 'left', 'person', p.id, `${fullName(p)} ${prayerChain ? 'joined' : 'left'} the prayer chain`);
    if (titheDay !== (p.titheDay ?? null)) ctx.audit(titheDay ? 'set' : 'cleared', 'person', p.id, `${fullName(p)} ${titheDay ? `set salary day ${titheDay} for the tithe reminder` : 'turned the tithe reminder off'}`);
    return { consent: next.consent, checkinCode: next.checkinCode, campusId: next.campusId, prayerChain, titheDay, titheAmount };
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
      .filter((p) => ctx.inScope(p.id))
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
    if (p.status === 'visitor') {
      triggerWorkflows(ctx, 'new_visitor', p.id);
      void notify(ctx, 'visitor.new', { personIds: pastorIds(ctx), title: `New visitor: ${p.firstName} ${p.lastName}`.trim(), body: `${ctx.staff?.name ?? 'The office'} added ${p.firstName} as a visitor. Say hello and add them to a follow-up.`, link: `/admin/people/${p.id}`, except: ctx.staff?.personId ?? null });
    }
    return personView(ctx, p);
  });
  r.post('/admin/people/import', { perm: 'people.edit' }, (ctx) => {
    if (Array.isArray(ctx.body.rows)) checkLimit(ctx.db, ctx.now, 'people', activePeople(ctx.db), Math.max(0, ctx.body.rows.length - countExisting(ctx, ctx.body.rows)));
    const result = importPeople(ctx, Array.isArray(ctx.body.rows) ? ctx.body.rows : [], ctx.body.dedupeBy === 'email' ? 'email' : 'phone');
    ctx.audit('imported', 'person', null, `Imported people from ${ctx.body.source ?? 'a file'}: ${result.created} added, ${result.updated} updated${result.groups?.length ? `, ${result.groups.length} groups created` : ''}`);
    return result;
  });
  r.get('/admin/people/:id', { perm: 'people.view' }, (ctx) => personView(ctx, inScope(ctx, find(ctx, 'people', ctx.params[0], 'Person'))));
  r.get('/admin/people/:id/timeline', { perm: 'people.view' }, (ctx) => timeline(ctx, find(ctx, 'people', ctx.params[0], 'Person')));
  r.patch('/admin/people/:id', { perm: 'people.edit' }, (ctx) => {
    inScope(ctx, find(ctx, 'people', ctx.params[0], 'Person'));
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
