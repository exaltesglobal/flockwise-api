// Volunteer teams and rosters, and service planning (order of service + song library).
import { ApiError } from '../errors.js';
import type { Ctx, Router } from '../engine.js';
import type { Assignment, AvailablePerson, Collections, MyServing, Plan, PlanItem, Schedule, ScheduleOverview, ServiceDetail, ServiceSummary, SongAttachment, SongView, Team, TeamView } from '../types.js';
import { bySoonest, dateOnly, DAY, eventView, find, fullName, memberEvent, pick, requireFields, settings, upcoming } from '../util.js';
import { sendDirect } from './comms.js';
import { notify } from './notify.js';

const COLORS = ['#1F6B5C', '#F2A93B', '#3B82F6', '#A855F7', '#EF4444', '#14B8A6', '#F97316', '#64748B'];
const PLAN_KINDS: PlanItem['kind'][] = ['song', 'reading', 'sermon', 'prayer', 'announcement', 'offering', 'video', 'other'];

const name = (ctx: Ctx, id: string) => {
  const p = ctx.db.get('people', id);
  return p ? fullName(p) : 'Someone';
};

function served(ctx: Ctx, personId: string) {
  const since = new Date(ctx.now.getTime() - 90 * DAY).toISOString();
  const events = new Map(ctx.db.all('events').map((e) => [e.id, e]));
  const mine = ctx.db
    .all('assignments')
    .filter((a) => a.personId === personId && a.status !== 'declined')
    .map((a) => events.get(a.eventId)?.startsAt)
    .filter((d): d is string => !!d && d < ctx.now.toISOString());
  return { lastServedAt: mine.sort().at(-1) ?? null, timesServed90d: mine.filter((d) => d >= since).length };
}

function teamView(ctx: Ctx, t: Team): TeamView {
  return {
    ...t,
    leaderName: t.leaderId ? name(ctx, t.leaderId) : null,
    memberDetails: t.members
      .filter((m) => ctx.db.get('people', m.personId))
      .map((m) => ({ personId: m.personId, name: name(ctx, m.personId), positionIds: m.positionIds, ...served(ctx, m.personId) }))
      .sort((x, y) => x.name.localeCompare(y.name)),
  };
}

/** Why a person can't serve at an event, or null when they can. */
function conflict(ctx: Ctx, ev: Collections['events'], personId: string, ignoreAssignmentId?: string): string | null {
  const day = dateOnly(ev.startsAt);
  const blocked = ctx.db.all('blockouts').find((b) => b.personId === personId && b.from <= day && b.to >= day);
  if (blocked) return `Away${blocked.reason ? `: ${blocked.reason}` : ''}`;
  const other = ctx.db.all('assignments').find((a) => a.personId === personId && a.eventId === ev.id && a.id !== ignoreAssignmentId && a.status !== 'declined');
  if (other) return `Already serving as ${ctx.db.get('teams', other.teamId)?.positions.find((p) => p.id === other.positionId)?.name ?? 'another role'}`;
  // Overlapping events on the same day.
  const s = new Date(ev.startsAt).getTime();
  const e = new Date(ev.endsAt).getTime();
  for (const a of ctx.db.all('assignments')) {
    if (a.personId !== personId || a.eventId === ev.id || a.status === 'declined') continue;
    const o = ctx.db.get('events', a.eventId);
    if (o && new Date(o.startsAt).getTime() < e && new Date(o.endsAt).getTime() > s) return `Serving at ${o.title}`;
  }
  return null;
}

function schedule(ctx: Ctx, ev: Collections['events']): Schedule {
  const list = ctx.db.all('assignments').filter((a) => a.eventId === ev.id);
  const slots = ctx.db
    .all('teams')
    .sort((x, y) => x.name.localeCompare(y.name))
    .flatMap((t) =>
      t.positions.map((pos) => {
        const as = list.filter((a) => a.teamId === t.id && a.positionId === pos.id).map((a) => ({ ...a, name: name(ctx, a.personId) }));
        return { team: { id: t.id, name: t.name, color: t.color }, position: pos, assignments: as, open: Math.max(0, pos.needed - as.filter((a) => a.status !== 'declined').length) };
      }),
    );
  return { event: eventView(ctx, ev), slots };
}

function overview(ctx: Ctx, ev: Collections['events']): ScheduleOverview[number] {
  const s = schedule(ctx, ev);
  const all = s.slots.flatMap((x) => x.assignments);
  return {
    event: s.event,
    needed: s.slots.reduce((t, x) => t + x.position.needed, 0),
    filled: all.filter((a) => a.status !== 'declined').length,
    accepted: all.filter((a) => a.status === 'accepted').length,
    declined: all.filter((a) => a.status === 'declined').length,
    pending: all.filter((a) => a.status === 'pending').length,
  };
}

function assign(ctx: Ctx, ev: Collections['events'], teamId: string, positionId: string, personId: string, force = false): Assignment {
  const t = find(ctx, 'teams', teamId, 'Team');
  if (!t.positions.some((p) => p.id === positionId)) throw new ApiError(422, 'invalid', 'Choose a position.');
  find(ctx, 'people', personId, 'Person');
  const c = conflict(ctx, ev, personId);
  if (c && !force) throw new ApiError(409, 'conflict', `${name(ctx, personId)} can't serve: ${c}.`);
  const existing = ctx.db.all('assignments').find((a) => a.eventId === ev.id && a.teamId === teamId && a.positionId === positionId && a.personId === personId);
  const a = existing
    ? ctx.db.put('assignments', { ...existing, status: 'pending', respondedAt: null })
    : ctx.db.put('assignments', { id: ctx.id('as'), eventId: ev.id, teamId, positionId, personId, status: 'pending', createdAt: ctx.now.toISOString(), respondedAt: null, note: null });
  const pos = t.positions.find((p) => p.id === positionId)?.name ?? '';
  void notify(ctx, 'rota.assigned', { personIds: [personId], title: `You're on the rota: ${ev.title}`, body: `${t.name}${pos ? ` · ${pos}` : ''} at ${ev.title}, ${whenText(ctx, ev)}. Please accept or decline in the app.`, link: `/app/serving/${a.id}` });
  return a;
}

function whenText(ctx: Ctx, ev: Collections['events']) {
  return new Date(ev.startsAt).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: settings(ctx).timezone || 'Asia/Kolkata' });
}

/** Fills open positions with team members who are free, preferring those who served least recently. */
function autofill(ctx: Ctx, ev: Collections['events']) {
  let added = 0;
  for (const t of ctx.db.all('teams')) {
    for (const pos of t.positions) {
      const current = ctx.db.all('assignments').filter((a) => a.eventId === ev.id && a.teamId === t.id && a.positionId === pos.id && a.status !== 'declined');
      let open = pos.needed - current.length;
      if (open <= 0) continue;
      const declined = new Set(ctx.db.all('assignments').filter((a) => a.eventId === ev.id && a.status === 'declined').map((a) => a.personId));
      const candidates = t.members
        .filter((m) => m.positionIds.includes(pos.id) && !declined.has(m.personId) && ctx.db.get('people', m.personId) && !conflict(ctx, ev, m.personId))
        .map((m) => ({ id: m.personId, ...served(ctx, m.personId) }))
        .sort((x, y) => x.timesServed90d - y.timesServed90d || (x.lastServedAt ?? '').localeCompare(y.lastServedAt ?? ''));
      for (const c of candidates) {
        if (open <= 0) break;
        assign(ctx, ev, t.id, pos.id, c.id);
        open--;
        added++;
      }
    }
  }
  return added;
}

function planFor(ctx: Ctx, eventId: string): Plan {
  return ctx.db.get('plans', eventId) ?? { id: eventId, eventId, theme: '', notes: '', items: [], updatedAt: ctx.now.toISOString() };
}

function cleanItems(ctx: Ctx, items: unknown): PlanItem[] {
  if (!Array.isArray(items)) throw new ApiError(422, 'invalid', 'Send the list of items.');
  return items.slice(0, 80).map((raw: Record<string, unknown>) => {
    const song = raw.songId ? ctx.db.get('songs', String(raw.songId)) : undefined;
    return {
      id: String(raw.id || ctx.id('pi')),
      kind: PLAN_KINDS.includes(raw.kind as PlanItem['kind']) ? (raw.kind as PlanItem['kind']) : 'other',
      title: String(raw.title || song?.title || 'Untitled'),
      songId: song?.id ?? null,
      key: raw.key ? String(raw.key) : (song?.defaultKey ?? null),
      minutes: Math.max(0, Math.min(240, Number(raw.minutes) || 0)),
      notes: String(raw.notes ?? ''),
      person: String(raw.person ?? ''),
      arrangement: Array.isArray(raw.arrangement) ? raw.arrangement.map(String).map((x) => x.trim()).filter(Boolean).slice(0, 40) : [],
      text: String(raw.text ?? '').slice(0, 10_000),
    };
  });
}

export function registerServing(r: Router) {
  // ----- member -----
  r.get('/me/serving', {}, (ctx): MyServing => {
    const me = ctx.me();
    // The team app passes ?teamId= so a person sees one team's assignments at a time.
    const teamId = ctx.query.teamId || null;
    const assignments = ctx.db
      .all('assignments')
      .filter((a) => a.personId === me && (!teamId || a.teamId === teamId))
      .map((a) => ({ a, ev: ctx.db.get('events', a.eventId), t: ctx.db.get('teams', a.teamId) }))
      .filter((x) => x.ev && x.t && upcoming(ctx, x.ev))
      .sort((x, y) => bySoonest(x.ev!, y.ev!))
      .map(({ a, ev, t }) => ({
        ...a,
        event: memberEvent(ctx, ev!, me),
        teamName: t!.name,
        positionName: t!.positions.find((p) => p.id === a.positionId)?.name ?? '',
        plan: a.status === 'accepted' ? planFor(ctx, ev!.id).items : [],
      }));
    const teams = ctx.db
      .all('teams')
      .filter((t) => t.members.some((m) => m.personId === me) && (!teamId || t.id === teamId))
      .map((t) => ({ id: t.id, name: t.name, positions: t.positions.filter((p) => t.members.find((m) => m.personId === me)!.positionIds.includes(p.id)).map((p) => p.name) }));
    const blockouts = ctx.db.all('blockouts').filter((b) => b.personId === me && b.to >= dateOnly(ctx.now)).sort((x, y) => x.from.localeCompare(y.from));
    return { assignments, teams, blockouts };
  });
  r.post('/me/serving/:id/respond', {}, (ctx) => {
    const a = find(ctx, 'assignments', ctx.params[0], 'Request');
    if (a.personId !== ctx.me()) throw new ApiError(403, 'forbidden', 'This is not your request.');
    const status = ctx.body.status === 'declined' ? 'declined' : 'accepted';
    return ctx.db.put('assignments', { ...a, status, respondedAt: ctx.now.toISOString(), note: ctx.body.note ? String(ctx.body.note).slice(0, 300) : a.note });
  });
  r.post('/me/blockouts', {}, (ctx) => {
    requireFields(ctx.body, ['from', 'to']);
    const from = String(ctx.body.from).slice(0, 10);
    const to = String(ctx.body.to).slice(0, 10);
    if (to < from) throw new ApiError(422, 'invalid', 'The end date must be after the start.', { to: 'After the start date' });
    return ctx.db.put('blockouts', { id: ctx.id('bo'), personId: ctx.me(), from, to, reason: String(ctx.body.reason ?? '').slice(0, 120) });
  });
  r.del('/me/blockouts/:id', {}, (ctx) => {
    const b = find(ctx, 'blockouts', ctx.params[0], 'Blockout');
    if (b.personId !== ctx.me()) throw new ApiError(403, 'forbidden', 'Not yours.');
    ctx.db.del('blockouts', b.id);
    return undefined;
  });

  // ----- admin: teams -----
  r.get('/admin/volunteers/teams', { perm: ['volunteers', 'services'] }, (ctx) => ctx.db.all('teams').sort((x, y) => x.name.localeCompare(y.name)).map((t) => teamView(ctx, t)));
  r.post('/admin/volunteers/teams', { perm: 'volunteers' }, (ctx) => {
    requireFields(ctx.body, ['name']);
    const positions = (Array.isArray(ctx.body.positions) ? ctx.body.positions : [{ name: 'Member', needed: 1 }]).map((p: { id?: string; name: string; needed?: number }) => ({ id: p.id || ctx.id('pos'), name: String(p.name), needed: Math.max(0, Number(p.needed ?? 1)) }));
    const t = ctx.db.put('teams', { id: ctx.id('tm'), name: String(ctx.body.name), description: String(ctx.body.description ?? ''), color: ctx.body.color || COLORS[ctx.db.count('teams') % COLORS.length], leaderId: ctx.body.leaderId ?? null, positions, members: [] });
    ctx.audit('created', 'team', t.id, `Created team ${t.name}`);
    return teamView(ctx, t);
  });
  r.patch('/admin/volunteers/teams/:id', { perm: 'volunteers' }, (ctx) => {
    const t = find(ctx, 'teams', ctx.params[0], 'Team');
    const next: Team = { ...t, ...pick<Team>(ctx.body, ['name', 'description', 'color', 'leaderId']) };
    if (Array.isArray(ctx.body.positions)) {
      next.positions = ctx.body.positions.map((p: { id?: string; name: string; needed?: number }) => ({ id: p.id || ctx.id('pos'), name: String(p.name), needed: Math.max(0, Number(p.needed ?? 1)) }));
      const ids = new Set(next.positions.map((p) => p.id));
      next.members = next.members.map((m) => ({ ...m, positionIds: m.positionIds.filter((id) => ids.has(id)) }));
    }
    ctx.audit('updated', 'team', t.id, `Updated team ${next.name}`);
    return teamView(ctx, ctx.db.put('teams', next));
  });
  r.put('/admin/volunteers/teams/:id/members', { perm: 'volunteers' }, (ctx) => {
    const t = find(ctx, 'teams', ctx.params[0], 'Team');
    const ids = new Set(t.positions.map((p) => p.id));
    const members = (Array.isArray(ctx.body.members) ? ctx.body.members : [])
      .filter((m: { personId: string }) => ctx.db.get('people', m.personId))
      .map((m: { personId: string; positionIds?: string[] }) => ({ personId: m.personId, positionIds: (m.positionIds ?? []).filter((id) => ids.has(id)) }));
    ctx.audit('updated', 'team', t.id, `Updated members of ${t.name}`);
    return teamView(ctx, ctx.db.put('teams', { ...t, members }));
  });
  r.del('/admin/volunteers/teams/:id', { perm: 'volunteers' }, (ctx) => {
    const t = find(ctx, 'teams', ctx.params[0], 'Team');
    ctx.db.del('teams', t.id);
    for (const a of ctx.db.all('assignments')) if (a.teamId === t.id) ctx.db.del('assignments', a.id);
    ctx.audit('deleted', 'team', t.id, `Deleted team ${t.name}`);
    return undefined;
  });

  // ----- admin: schedule -----
  r.get('/admin/volunteers/overview', { perm: ['volunteers', 'services'] }, (ctx) =>
    ctx.db
      .all('events')
      .filter((e) => upcoming(ctx, e))
      .sort(bySoonest)
      .slice(0, 10)
      .map((e) => overview(ctx, e)),
  );
  r.get('/admin/volunteers/schedule/:eventId', { perm: ['volunteers', 'services'] }, (ctx) => schedule(ctx, find(ctx, 'events', ctx.params[0], 'Event')));
  r.get('/admin/volunteers/schedule/:eventId/available', { perm: 'volunteers' }, (ctx): AvailablePerson[] => {
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    const t = find(ctx, 'teams', String(ctx.query.teamId), 'Team');
    const positionId = String(ctx.query.positionId ?? '');
    return t.members
      .filter((m) => !positionId || m.positionIds.includes(positionId))
      .filter((m) => ctx.db.get('people', m.personId))
      .map((m) => {
        const reason = conflict(ctx, ev, m.personId);
        return { personId: m.personId, name: name(ctx, m.personId), available: !reason, reason, ...served(ctx, m.personId) };
      })
      .sort((x, y) => Number(y.available) - Number(x.available) || x.timesServed90d - y.timesServed90d);
  });
  r.post('/admin/volunteers/assignments', { perm: 'volunteers' }, (ctx) => {
    requireFields(ctx.body, ['eventId', 'teamId', 'positionId', 'personId']);
    const ev = find(ctx, 'events', ctx.body.eventId, 'Event');
    const a = assign(ctx, ev, ctx.body.teamId, ctx.body.positionId, ctx.body.personId, !!ctx.body.force);
    ctx.audit('scheduled', 'assignment', a.id, `Scheduled ${name(ctx, a.personId)} for ${ev.title}`);
    return a;
  });
  r.patch('/admin/volunteers/assignments/:id', { perm: 'volunteers' }, (ctx) => {
    const a = find(ctx, 'assignments', ctx.params[0], 'Assignment');
    const status = ['pending', 'accepted', 'declined'].includes(ctx.body.status) ? ctx.body.status : a.status;
    return ctx.db.put('assignments', { ...a, status, respondedAt: ctx.now.toISOString() });
  });
  r.del('/admin/volunteers/assignments/:id', { perm: 'volunteers' }, (ctx) => {
    ctx.db.del('assignments', ctx.params[0]);
    return undefined;
  });
  r.post('/admin/volunteers/autofill/:eventId', { perm: 'volunteers' }, (ctx) => {
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    const added = autofill(ctx, ev);
    ctx.audit('scheduled', 'event', ev.id, `Auto-filled ${added} positions for ${ev.title}`);
    return { added, schedule: schedule(ctx, ev) };
  });
  r.post('/admin/volunteers/notify/:eventId', { perm: 'volunteers' }, async (ctx) => {
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    const pending = ctx.db.all('assignments').filter((a) => a.eventId === ev.id && a.status === 'pending');
    const when = new Date(ev.startsAt).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: settings(ctx).timezone || 'Asia/Kolkata' });
    const res = await sendDirect(
      ctx,
      'email',
      pending.map((a) => a.personId),
      `Can you serve at ${ev.title}?`,
      `Hi {{firstName}},\n\nYou're on the rota for ${ev.title} (${when}). Please accept or decline in the app: ${ctx.env.webUrl}/app/serving\n\nThank you for serving!`,
      'system',
    );
    ctx.audit('sent', 'message', res.id, `Sent serving requests for ${ev.title}`);
    return { notified: res.stats.sent, message: res };
  });
  r.get('/admin/volunteers/blockouts', { perm: 'volunteers' }, (ctx) =>
    ctx.db
      .all('blockouts')
      .filter((b) => b.to >= dateOnly(ctx.now))
      .map((b) => ({ ...b, name: name(ctx, b.personId) }))
      .sort((x, y) => x.from.localeCompare(y.from)),
  );

  // ----- admin: service planning -----
  r.get('/admin/services', { perm: ['services', 'volunteers'] }, (ctx): ServiceSummary[] => {
    const past = ctx.query.when === 'past';
    const list = ctx.db.all('events').filter((e) => (past ? !upcoming(ctx, e) : upcoming(ctx, e)) && (e.kind === 'service' || ctx.db.get('plans', e.id))).sort(bySoonest);
    return (past ? list.reverse().slice(0, 20) : list.slice(0, 20)).map((e) => {
      const plan = planFor(ctx, e.id);
      const o = overview(ctx, e);
      return { event: eventView(ctx, e), items: plan.items.length, minutes: plan.items.reduce((t, i) => t + i.minutes, 0), songs: plan.items.filter((i) => i.kind === 'song').map((i) => i.title), theme: plan.theme, volunteers: { filled: o.filled, needed: o.needed } };
    });
  });
  r.get('/admin/services/:eventId', { perm: ['services', 'volunteers'] }, (ctx): ServiceDetail => {
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    const team = schedule(ctx, ev).slots.flatMap((s) => s.assignments.filter((a) => a.status !== 'declined').map((a) => ({ teamName: s.team.name, positionName: s.position.name, name: a.name, status: a.status })));
    return { event: eventView(ctx, ev), plan: planFor(ctx, ev.id), team };
  });
  r.put('/admin/services/:eventId', { perm: 'services' }, (ctx) => {
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    const plan = ctx.db.put('plans', {
      id: ev.id, eventId: ev.id, theme: String(ctx.body.theme ?? ''), notes: String(ctx.body.notes ?? ''), items: cleanItems(ctx, ctx.body.items), updatedAt: ctx.now.toISOString(),
      rehearsalAt: ctx.body.rehearsalAt ? new Date(String(ctx.body.rehearsalAt)).toISOString() : null,
      rehearsalNotes: String(ctx.body.rehearsalNotes ?? '').slice(0, 4000),
    });
    ctx.audit('updated', 'plan', ev.id, `Updated the order of service for ${ev.title}`);
    return plan;
  });
  r.post('/admin/services/:eventId/copy', { perm: 'services' }, (ctx) => {
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    const from = ctx.db.get('plans', String(ctx.body.fromEventId));
    if (!from) throw new ApiError(404, 'not_found', 'That service has no plan to copy.');
    return ctx.db.put('plans', { ...from, id: ev.id, eventId: ev.id, items: from.items.map((i) => ({ ...i, id: ctx.id('pi') })), updatedAt: ctx.now.toISOString() });
  });
  r.get('/admin/songs', { perm: ['services', 'volunteers'] }, (ctx): SongView[] => {
    const usage = new Map<string, { n: number; last: string | null }>();
    const events = new Map(ctx.db.all('events').map((e) => [e.id, e]));
    for (const p of ctx.db.all('plans')) {
      const at = events.get(p.eventId)?.startsAt ?? null;
      for (const i of p.items) {
        if (!i.songId) continue;
        const u = usage.get(i.songId) ?? { n: 0, last: null };
        u.n++;
        if (at && at <= ctx.now.toISOString() && (!u.last || at > u.last)) u.last = at;
        usage.set(i.songId, u);
      }
    }
    const q = String(ctx.query.q ?? '').toLowerCase();
    return ctx.db
      .all('songs')
      .filter((s) => !q || s.title.toLowerCase().includes(q) || s.author.toLowerCase().includes(q) || s.tags.some((t) => t.toLowerCase().includes(q)))
      .map((s) => ({ ...s, timesUsed: usage.get(s.id)?.n ?? 0, lastUsedAt: usage.get(s.id)?.last ?? null }))
      .sort((x, y) => x.title.localeCompare(y.title));
  });
  r.post('/admin/songs', { perm: 'services' }, (ctx) => {
    requireFields(ctx.body, ['title']);
    const s = ctx.db.put('songs', { id: ctx.id('sg'), title: String(ctx.body.title), author: String(ctx.body.author ?? ''), defaultKey: String(ctx.body.defaultKey ?? ''), bpm: ctx.body.bpm ? Number(ctx.body.bpm) : null, ccli: String(ctx.body.ccli ?? ''), tags: Array.isArray(ctx.body.tags) ? ctx.body.tags.map(String) : [], lyrics: String(ctx.body.lyrics ?? ''), chordChart: String(ctx.body.chordChart ?? ''), lyricsAlt: String(ctx.body.lyricsAlt ?? ''), arrangement: cleanArrangement(ctx.body.arrangement), attachments: cleanAttachments(ctx, ctx.body.attachments) });
    ctx.audit('created', 'song', s.id, `Added song ${s.title}`);
    return s;
  });
  r.patch('/admin/songs/:id', { perm: 'services' }, (ctx) => {
    const s = find(ctx, 'songs', ctx.params[0], 'Song');
    return ctx.db.put('songs', { ...s, ...pick(ctx.body, ['title', 'author', 'defaultKey', 'bpm', 'ccli', 'tags', 'lyrics', 'chordChart', 'lyricsAlt']), ...(ctx.body.arrangement !== undefined ? { arrangement: cleanArrangement(ctx.body.arrangement) } : {}), ...(ctx.body.attachments !== undefined ? { attachments: cleanAttachments(ctx, ctx.body.attachments) } : {}) });
  });
  r.del('/admin/songs/:id', { perm: 'services' }, (ctx) => {
    ctx.db.del('songs', ctx.params[0]);
    return undefined;
  });
}

/** Links to charts, lyrics sheets and recordings (Google Drive, Dropbox, YouTube...). */
const cleanArrangement = (raw: unknown) => (Array.isArray(raw) ? raw.map(String).map((x) => x.trim()).filter(Boolean).slice(0, 40) : []);

function cleanAttachments(ctx: Ctx, raw: unknown): SongAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 20)
    .map((a: Record<string, unknown>) => ({
      id: String(a.id || ctx.id('sa')),
      name: String(a.name ?? '').trim().slice(0, 120) || 'Attachment',
      url: String(a.url ?? '').trim(),
      kind: (['chart', 'lyrics', 'audio', 'video', 'other'].includes(String(a.kind)) ? a.kind : 'other') as SongAttachment['kind'],
    }))
    .filter((a) => /^https?:\/\//.test(a.url));
}
