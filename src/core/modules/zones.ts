// Zones, areas and family units (prayer cells, kudumba units, wards) with their leaders, and
// pastoral home visits: plan by area, log what happened, and see families not visited this year.
import { ApiError } from '../errors.js';
import type { Ctx, Router } from '../engine.js';
import type { Collections, Visit, VisitAction, VisitActionItem, VisitPurpose, VisitView, Zone, ZoneDetail, ZoneFamily, ZoneReportRow, ZoneView } from '../types.js';
import { age, find, fullName, localDate } from '../util.js';

export const VISIT_PURPOSES: Record<VisitPurpose, string> = {
  home: 'Home visit',
  new_family: 'New family welcome',
  hospital: 'Hospital visit',
  house_blessing: 'House blessing',
  bereavement: 'Bereavement visit',
  other: 'Other',
};

const clean = (v: unknown, max = 300) => String(v ?? '').trim().slice(0, max);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Action items from the form or the AI write-up: short text, done flag, optional due date. */
const cleanActions = (v: unknown): VisitAction[] => (Array.isArray(v) ? v : []).map((a: unknown) => { const x = (a ?? {}) as Record<string, unknown>; return { text: clean(typeof a === 'string' ? a : x.text, 200), done: !!x.done, due: DATE_RE.test(String(x.due)) ? String(x.due) : null }; }).filter((a) => a.text).slice(0, 12);

export const familyKey = (p: Collections['people']) => (p.householdName ? `h:${p.householdName}` : `solo:${p.id}`);

/** Visits are counted from 1 January unless the caller asks for another start (e.g. the financial year). */
const yearStart = (ctx: Ctx) => `${localDate(ctx, ctx.now).slice(0, 4)}-01-01`;

function families(people: Collections['people'][]) {
  const map = new Map<string, Collections['people'][]>();
  for (const p of people) {
    const k = familyKey(p);
    map.set(k, [...(map.get(k) ?? []), p]);
  }
  return map;
}

/** Visits that are confidential are seen by owners, admins, pastors and the visitors themselves. */
function canSee(ctx: Ctx, v: Visit) {
  return !v.confidential || ['owner', 'admin', 'pastor'].includes(ctx.role ?? '') || (!!ctx.staff && v.visitorIds.includes(ctx.staff.id));
}

function visitView(ctx: Ctx, v: Visit): VisitView {
  const staffNames = v.visitorIds.map((id) => ctx.db.get('staff', id)?.name).filter((x): x is string => !!x);
  const hidden = !canSee(ctx, v);
  return {
    ...v,
    notes: hidden ? null : v.notes,
    prayerPoints: hidden ? null : v.prayerPoints,
    zoneName: v.zoneId ? (ctx.db.get('zones', v.zoneId)?.name ?? null) : null,
    visitors: [...staffNames, ...v.visitorNames],
  };
}

/** Zone ids of this zone and every unit under it. */
function withUnits(ctx: Ctx, id: string) {
  const all = ctx.db.all('zones');
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const z of all) if (z.parentId && out.has(z.parentId) && !out.has(z.id)) { out.add(z.id); grew = true; }
  }
  return out;
}

function zoneView(ctx: Ctx, z: Zone): ZoneView {
  const ids = withUnits(ctx, z.id);
  const people = ctx.db.all('people').filter((p) => p.status !== 'inactive' && p.zoneId && ids.has(p.zoneId));
  const fams = families(people);
  const since = yearStart(ctx);
  const done = ctx.db.all('visits').filter((v) => v.status === 'done' && v.visitedOn);
  const visitedKeys = new Set(done.filter((v) => v.visitedOn! >= since).map((v) => v.familyKey));
  const mine = done.filter((v) => fams.has(v.familyKey)).map((v) => v.visitedOn!).sort();
  return {
    ...z,
    leaders: z.leaderIds.map((id) => ctx.db.get('people', id)).filter((p): p is Collections['people'] => !!p).map((p) => ({ id: p.id, name: fullName(p), phone: p.phone })),
    families: fams.size,
    people: people.length,
    visitedThisYear: [...fams.keys()].filter((k) => visitedKeys.has(k)).length,
    lastVisitAt: mine.at(-1) ?? null,
    children: ctx.db.all('zones').filter((x) => x.parentId === z.id).length,
  };
}

function familyRows(ctx: Ctx, people: Collections['people'][], since: string): ZoneFamily[] {
  const visits = ctx.db.all('visits');
  return [...families(people)]
    .map(([key, members]) => {
      const head = members.find((p) => p.phone) ?? members[0];
      const mine = visits.filter((v) => v.familyKey === key);
      const done = mine.filter((v) => v.status === 'done' && v.visitedOn).map((v) => v.visitedOn!).sort();
      const next = mine.filter((v) => v.status === 'planned' && v.plannedFor).map((v) => v.plannedFor!).sort()[0] ?? null;
      return {
        key,
        name: key.startsWith('h:') ? key.slice(2) : fullName(head),
        address: members.find((p) => p.address)?.address ?? null,
        phone: head.phone,
        people: members.map((p) => ({ id: p.id, name: fullName(p), status: p.status, age: age(p.birthDate, ctx.now) })),
        lastVisitAt: done.at(-1) ?? null,
        visitsThisYear: done.filter((d) => d >= since).length,
        nextVisitOn: next,
      };
    })
    .sort((a, b) => (a.lastVisitAt ?? '').localeCompare(b.lastVisitAt ?? '') || a.name.localeCompare(b.name));
}

function readZone(ctx: Ctx, base?: Zone): Omit<Zone, 'id' | 'createdAt'> {
  const name = ctx.body.name !== undefined ? clean(ctx.body.name, 80) : (base?.name ?? '');
  if (!name) throw new ApiError(422, 'invalid', 'Give the zone a name.', { name: 'Required' });
  let parentId = ctx.body.parentId !== undefined ? (ctx.body.parentId ? String(ctx.body.parentId) : null) : (base?.parentId ?? null);
  if (parentId) {
    find(ctx, 'zones', parentId, 'Parent zone');
    if (base && withUnits(ctx, base.id).has(parentId)) throw new ApiError(422, 'invalid', 'A zone cannot sit inside itself.', { parentId: 'Choose another area' });
  } else parentId = null;
  const leaderIds = Array.isArray(ctx.body.leaderIds) ? [...new Set((ctx.body.leaderIds as unknown[]).map(String))].filter((id) => ctx.db.get('people', id)).slice(0, 10) : (base?.leaderIds ?? []);
  return {
    name,
    parentId,
    leaderIds,
    meetingDay: ctx.body.meetingDay !== undefined ? clean(ctx.body.meetingDay, 60) || null : (base?.meetingDay ?? null),
    area: ctx.body.area !== undefined ? clean(ctx.body.area, 200) || null : (base?.area ?? null),
    notes: ctx.body.notes !== undefined ? clean(ctx.body.notes, 1000) || null : (base?.notes ?? null),
    active: ctx.body.active !== undefined ? !!ctx.body.active : (base?.active ?? true),
  };
}

function report(ctx: Ctx, since: string): ZoneReportRow[] {
  const people = ctx.db.all('people').filter((p) => p.status !== 'inactive');
  const visits = ctx.db.all('visits');
  const row = (zoneId: string | null, zoneName: string, members: Collections['people'][]): ZoneReportRow => {
    const keys = new Set(members.map(familyKey));
    const mine = visits.filter((v) => keys.has(v.familyKey));
    const visited = new Set(mine.filter((v) => v.status === 'done' && (v.visitedOn ?? '') >= since).map((v) => v.familyKey)).size;
    return { zoneId, zoneName, families: keys.size, visited, percent: keys.size ? Math.round((visited / keys.size) * 100) : 0, visitsDone: mine.filter((v) => v.status === 'done' && (v.visitedOn ?? '') >= since).length, planned: mine.filter((v) => v.status === 'planned').length };
  };
  const rows = ctx.db
    .all('zones')
    .filter((z) => z.active)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((z) => {
      const ids = withUnits(ctx, z.id);
      return row(z.id, z.name, people.filter((p) => p.zoneId && ids.has(p.zoneId)));
    });
  const none = people.filter((p) => !p.zoneId || !ctx.db.get('zones', p.zoneId));
  if (none.length) rows.push(row(null, 'No zone', none));
  return rows;
}

export function registerZones(r: Router) {
  r.get('/admin/zones', { perm: 'people.view' }, (ctx) => ctx.db.all('zones').filter((z) => !ctx.scope || ctx.scope.kind !== 'zone' || ctx.scope.ids.includes(z.id) || (z.parentId && ctx.scope.ids.includes(z.parentId))).sort((a, b) => a.name.localeCompare(b.name)).map((z) => zoneView(ctx, z)));

  r.get('/admin/zones/report', { perm: 'people.view' }, (ctx) => {
    const since = DATE_RE.test(String(ctx.query.since)) ? String(ctx.query.since) : yearStart(ctx);
    return { since, rows: report(ctx, since) };
  });

  r.get('/admin/zones/:id', { perm: 'people.view' }, (ctx): ZoneDetail => {
    const z = find(ctx, 'zones', ctx.params[0], 'Zone');
    const ids = withUnits(ctx, z.id);
    const people = ctx.db.all('people').filter((p) => p.status !== 'inactive' && p.zoneId && ids.has(p.zoneId));
    const keys = new Set(people.map(familyKey));
    const visits = ctx.db
      .all('visits')
      .filter((v) => keys.has(v.familyKey) || (v.zoneId && ids.has(v.zoneId)))
      .sort((a, b) => (b.visitedOn ?? b.plannedFor ?? '').localeCompare(a.visitedOn ?? a.plannedFor ?? ''))
      .slice(0, 100)
      .map((v) => visitView(ctx, v));
    return { zone: zoneView(ctx, z), families: familyRows(ctx, people, yearStart(ctx)), visits, units: ctx.db.all('zones').filter((x) => x.parentId === z.id).map((x) => zoneView(ctx, x)) };
  });

  r.post('/admin/zones', { perm: 'people.edit' }, (ctx) => {
    const z = ctx.db.put('zones', { id: ctx.id('zn'), ...readZone(ctx), createdAt: ctx.now.toISOString() });
    ctx.audit('created', 'zone', z.id, `Created zone ${z.name}`);
    return zoneView(ctx, z);
  });

  r.patch('/admin/zones/:id', { perm: 'people.edit' }, (ctx) => {
    const z = find(ctx, 'zones', ctx.params[0], 'Zone');
    const next = ctx.db.put('zones', { ...z, ...readZone(ctx, z) });
    ctx.audit('updated', 'zone', z.id, `Updated zone ${next.name}`);
    return zoneView(ctx, next);
  });

  r.del('/admin/zones/:id', { perm: 'people.edit' }, (ctx) => {
    const z = find(ctx, 'zones', ctx.params[0], 'Zone');
    // People and units move up to the parent area, so nobody is lost.
    for (const p of ctx.db.all('people')) if (p.zoneId === z.id) ctx.db.put('people', { ...p, zoneId: z.parentId });
    for (const u of ctx.db.all('zones')) if (u.parentId === z.id) ctx.db.put('zones', { ...u, parentId: z.parentId });
    ctx.db.del('zones', z.id);
    ctx.audit('deleted', 'zone', z.id, `Deleted zone ${z.name}`);
  });

  // Adding a person brings their whole household into the zone.
  r.post('/admin/zones/:id/members', { perm: 'people.edit' }, (ctx) => {
    const z = find(ctx, 'zones', ctx.params[0], 'Zone');
    const ids = Array.isArray(ctx.body.personIds) ? (ctx.body.personIds as unknown[]).map(String) : [];
    if (!ids.length) throw new ApiError(422, 'invalid', 'Choose people to add.');
    const keys = new Set(ids.map((id) => ctx.db.get('people', id)).filter((p): p is Collections['people'] => !!p).map(familyKey));
    let moved = 0;
    for (const p of ctx.db.all('people')) {
      if (keys.has(familyKey(p)) && p.zoneId !== z.id) {
        ctx.db.put('people', { ...p, zoneId: z.id });
        moved++;
      }
    }
    ctx.audit('updated', 'zone', z.id, `Added ${keys.size} famil${keys.size === 1 ? 'y' : 'ies'} (${moved} people) to ${z.name}`);
    return { families: keys.size, people: moved };
  });

  r.del('/admin/zones/:id/families/:key', { perm: 'people.edit' }, (ctx) => {
    const z = find(ctx, 'zones', ctx.params[0], 'Zone');
    const key = decodeURIComponent(ctx.params[1]);
    let moved = 0;
    for (const p of ctx.db.all('people')) if (p.zoneId === z.id && familyKey(p) === key) { ctx.db.put('people', { ...p, zoneId: null }); moved++; }
    ctx.audit('updated', 'zone', z.id, `Removed a family (${moved} people) from ${z.name}`);
    return { people: moved };
  });

  // ----- visits -----
  r.get('/admin/visits', { perm: 'people.view' }, (ctx) => {
    const status = ctx.query.status;
    const zone = ctx.query.zoneId ? withUnits(ctx, ctx.query.zoneId) : null;
    const mine = ctx.query.mine === '1' && ctx.staff ? ctx.staff.id : null;
    return ctx.db
      .all('visits')
      .filter((v) => !status || v.status === status)
      .filter((v) => !zone || (v.zoneId && zone.has(v.zoneId)))
      .filter((v) => !mine || v.visitorIds.includes(mine))
      .filter((v) => !ctx.query.familyKey || v.familyKey === ctx.query.familyKey)
      .sort((a, b) => (status === 'planned' ? (a.plannedFor ?? '').localeCompare(b.plannedFor ?? '') : (b.visitedOn ?? b.plannedFor ?? '').localeCompare(a.visitedOn ?? a.plannedFor ?? '')))
      .slice(0, 300)
      .map((v) => visitView(ctx, v));
  });

  /** Families with no visit since `since` (default 1 January), longest unvisited first. */
  r.get('/admin/visits/due', { perm: 'people.view' }, (ctx) => {
    const since = DATE_RE.test(String(ctx.query.since)) ? String(ctx.query.since) : yearStart(ctx);
    const zone = ctx.query.zoneId ? withUnits(ctx, ctx.query.zoneId) : null;
    const people = ctx.db.all('people').filter((p) => p.status === 'member' || p.status === 'regular').filter((p) => !zone || (p.zoneId && zone.has(p.zoneId)));
    return { since, families: familyRows(ctx, people, since).filter((f) => !f.lastVisitAt || f.lastVisitAt < since) };
  });

  /** Open action items from logged visits: the pastor's to-do list, soonest due first. */
  r.get('/admin/visits/actions', { perm: 'people.view' }, (ctx): VisitActionItem[] => {
    const mine = ctx.query.mine === '1' && ctx.staff ? ctx.staff.id : null;
    const all = ctx.query.all === '1';
    return ctx.db
      .all('visits')
      .filter((v) => v.status === 'done' && (v.actions?.length ?? 0) > 0 && canSee(ctx, v) && (!mine || v.visitorIds.includes(mine)))
      .flatMap((v) => (v.actions ?? []).map((a, index) => ({ ...a, visitId: v.id, index, familyKey: v.familyKey, familyName: v.familyName, visitedOn: v.visitedOn, visitors: visitView(ctx, v).visitors })))
      .filter((a) => all || !a.done)
      .sort((a, b) => Number(a.done) - Number(b.done) || (a.due ?? '9999').localeCompare(b.due ?? '9999') || (b.visitedOn ?? '').localeCompare(a.visitedOn ?? ''))
      .slice(0, 200);
  });

  /** Tick an action item off (or back on) from the to-do list. */
  r.post('/admin/visits/:id/actions/:index', { perm: 'care' }, (ctx) => {
    const v = find(ctx, 'visits', ctx.params[0], 'Visit');
    if (!canSee(ctx, v)) throw new ApiError(403, 'forbidden', 'This visit is confidential.');
    const i = Number(ctx.params[1]);
    const actions = [...(v.actions ?? [])];
    if (!actions[i]) throw new ApiError(404, 'not_found', 'No such action item.');
    actions[i] = { ...actions[i], done: ctx.body?.done === undefined ? !actions[i].done : !!ctx.body.done };
    ctx.db.put('visits', { ...v, actions });
    return visitView(ctx, { ...v, actions });
  });

  r.post('/admin/visits', { perm: 'care' }, (ctx) => {
    const person = ctx.body.personId ? find(ctx, 'people', String(ctx.body.personId), 'Person') : null;
    const key = person ? familyKey(person) : clean(ctx.body.familyKey, 120);
    const members = ctx.db.all('people').filter((p) => familyKey(p) === key);
    if (!members.length) throw new ApiError(422, 'invalid', 'Choose the family to visit.', { personId: 'Required' });
    const done = ctx.body.status === 'done';
    const date = clean(ctx.body.date, 10) || localDate(ctx, ctx.now);
    if (!DATE_RE.test(date)) throw new ApiError(422, 'invalid', 'Enter the date.', { date: 'Use YYYY-MM-DD' });
    const purpose = (Object.keys(VISIT_PURPOSES) as VisitPurpose[]).includes(ctx.body.purpose) ? (ctx.body.purpose as VisitPurpose) : 'home';
    const visitorIds = Array.isArray(ctx.body.visitorIds) ? (ctx.body.visitorIds as unknown[]).map(String).filter((id) => ctx.db.get('staff', id)) : ctx.staff ? [ctx.staff.id] : [];
    const v = ctx.db.put('visits', {
      id: ctx.id('vs'),
      familyKey: key,
      familyName: key.startsWith('h:') ? key.slice(2) : fullName(members[0]),
      personIds: members.map((p) => p.id),
      zoneId: members.find((p) => p.zoneId)?.zoneId ?? null,
      purpose,
      status: done ? 'done' : 'planned',
      plannedFor: done ? null : date,
      visitedOn: done ? date : null,
      visitorIds,
      visitorNames: Array.isArray(ctx.body.visitorNames) ? (ctx.body.visitorNames as unknown[]).map((x) => clean(x, 80)).filter(Boolean).slice(0, 6) : [],
      notes: clean(ctx.body.notes, 3000) || null,
      prayerPoints: clean(ctx.body.prayerPoints, 1000) || null,
      followUp: clean(ctx.body.followUp, 500) || null,
      confidential: !!ctx.body.confidential,
      voiceNote: clean(ctx.body.voiceNote, 8000) || null,
      actions: cleanActions(ctx.body.actions),
      createdAt: ctx.now.toISOString(),
      createdBy: ctx.staff?.name ?? 'Church office',
    });
    ctx.audit('created', 'visit', v.id, `${done ? 'Logged' : 'Planned'} a ${VISIT_PURPOSES[purpose].toLowerCase()} to ${v.familyName}`);
    return visitView(ctx, v);
  });

  r.patch('/admin/visits/:id', { perm: 'care' }, (ctx) => {
    const v = find(ctx, 'visits', ctx.params[0], 'Visit');
    if (!canSee(ctx, v)) throw new ApiError(403, 'forbidden', 'This visit is confidential.');
    const next: Visit = { ...v };
    if (ctx.body.status === 'done' && v.status !== 'done') {
      next.status = 'done';
      next.visitedOn = DATE_RE.test(String(ctx.body.date)) ? String(ctx.body.date) : localDate(ctx, ctx.now);
    } else if (ctx.body.status === 'cancelled') next.status = 'cancelled';
    else if (ctx.body.status === 'planned') next.status = 'planned';
    if (ctx.body.date !== undefined && DATE_RE.test(String(ctx.body.date))) {
      if (next.status === 'done') next.visitedOn = String(ctx.body.date);
      else next.plannedFor = String(ctx.body.date);
    }
    for (const k of ['notes', 'prayerPoints', 'followUp'] as const) if (ctx.body[k] !== undefined) next[k] = clean(ctx.body[k], k === 'notes' ? 3000 : 1000) || null;
    if (ctx.body.purpose && (Object.keys(VISIT_PURPOSES) as VisitPurpose[]).includes(ctx.body.purpose)) next.purpose = ctx.body.purpose;
    if (Array.isArray(ctx.body.visitorIds)) next.visitorIds = (ctx.body.visitorIds as unknown[]).map(String).filter((id) => ctx.db.get('staff', id));
    if (Array.isArray(ctx.body.visitorNames)) next.visitorNames = (ctx.body.visitorNames as unknown[]).map((x) => clean(x, 80)).filter(Boolean).slice(0, 6);
    if (ctx.body.confidential !== undefined) next.confidential = !!ctx.body.confidential;
    if (ctx.body.voiceNote !== undefined) next.voiceNote = clean(ctx.body.voiceNote, 8000) || null;
    if (ctx.body.actions !== undefined) next.actions = cleanActions(ctx.body.actions);
    ctx.db.put('visits', next);
    if (next.status !== v.status) ctx.audit('updated', 'visit', v.id, `${next.status === 'done' ? 'Logged' : next.status === 'cancelled' ? 'Cancelled' : 'Re-planned'} the visit to ${v.familyName}`);
    return visitView(ctx, next);
  });

  r.del('/admin/visits/:id', { perm: 'care' }, (ctx) => {
    const v = find(ctx, 'visits', ctx.params[0], 'Visit');
    if (v.status === 'done') throw new ApiError(409, 'done', 'A visit that happened stays on record. Edit its notes instead.');
    ctx.db.del('visits', v.id);
  });
}
