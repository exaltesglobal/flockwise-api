// Pastoral care (follow-ups, visits, counselling), prayer requests, people at risk of
// drifting away, plus the dashboard and insights numbers.
import { ApiError } from '../errors.js';
import type { Ctx, Router } from '../engine.js';
import type { AtRiskPerson, CareCase, CareInput, Collections, Dashboard, Insights, PrayerView } from '../types.js';
import {
  adminDonation,
  bySoonest,
  checkinsFor,
  DAY,
  donationsSorted,
  eventView,
  find,
  fiscalYearStart,
  fullName,
  giftDate,
  isChild,
  page,
  requireFields,
  settings,
  upcoming,
} from '../util.js';

const CARE_TYPES: CareCase['type'][] = ['follow_up', 'visitor', 'hospital', 'counselling', 'bereavement', 'prayer', 'absent', 'other'];
const AT_RISK_WEEKS = 3;

/** Confidential cases are visible to owners, pastors, admins and whoever they are assigned to. */
function canSee(ctx: Ctx, c: CareCase) {
  return !c.confidential || ['owner', 'admin', 'pastor'].includes(ctx.role ?? '') || c.assignedTo === ctx.staff?.id;
}

function atRisk(ctx: Ctx): AtRiskPerson[] {
  const cutoff = ctx.now.getTime() - AT_RISK_WEEKS * 7 * DAY;
  const open = new Map(ctx.db.all('care').filter((c) => c.status !== 'closed' && c.personId).map((c) => [c.personId!, c.id]));
  return ctx.db
    .all('people')
    .filter((p) => (p.status === 'member' || p.status === 'regular') && !isChild(ctx, p) && (!p.lastAttendedAt || new Date(p.lastAttendedAt).getTime() < cutoff))
    .map((p) => ({
      id: p.id,
      name: fullName(p),
      phone: p.phone,
      status: p.status,
      lastAttendedAt: p.lastAttendedAt,
      weeksAway: p.lastAttendedAt ? Math.floor((ctx.now.getTime() - new Date(p.lastAttendedAt).getTime()) / (7 * DAY)) : 99,
      openCaseId: open.get(p.id) ?? null,
    }))
    .sort((x, y) => x.weeksAway - y.weeksAway);
}

function prayerView(_ctx: Ctx, p: Collections['prayer'], me: string): PrayerView {
  const { prayedBy, ...rest } = p;
  return { ...rest, name: p.visibility === 'church' || p.personId === me ? p.name : p.name.split(' ')[0], prayedCount: prayedBy.length, iPrayed: prayedBy.includes(me), mine: p.personId === me };
}

/** Attendance per Sunday: the stored history plus services since, using headcount or check-ins. */
export function attendanceTrend(ctx: Ctx, weeks = 12) {
  const byDate = new Map<string, number>();
  for (const h of ctx.db.all('attendanceHistory')) byDate.set(h.date, h.count);
  const services = ctx.db.all('events').filter((e) => e.kind === 'service' && !upcoming(ctx, e));
  const fromEvents = new Map<string, number>();
  for (const e of services) {
    const n = e.attendance ?? checkinsFor(ctx, e.id).length;
    if (!n) continue;
    const d = e.startsAt.slice(0, 10);
    fromEvents.set(d, (fromEvents.get(d) ?? 0) + n);
  }
  for (const [d, n] of fromEvents) byDate.set(d, n);
  return [...byDate].map(([date, count]) => ({ date, count })).sort((x, y) => x.date.localeCompare(y.date)).slice(-weeks);
}

function dashboard(ctx: Ctx): Dashboard {
  const now = ctx.now;
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const canGive = ctx.can('giving.view');
  const ok = canGive ? donationsSorted(ctx).filter((d) => d.status === 'succeeded') : [];
  const sumBetween = (from: Date, to: Date) => ok.filter((d) => new Date(giftDate(d)) >= from && new Date(giftDate(d)) < to).reduce((s, d) => s + d.amount, 0);
  const trend = Array.from({ length: 6 }, (_, i) => {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5 + i, 1));
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 4 + i, 1));
    return { month: from.toISOString().slice(0, 7), amount: sumBetween(from, to) };
  });
  const people = ctx.db.all('people');
  const week = Array.from({ length: 7 }, (_, i) => new Date(now.getTime() + i * DAY));
  const birthdays = people
    .filter((p) => p.birthDate && p.status !== 'inactive')
    .map((p) => {
      const [, mm, dd] = p.birthDate!.split('-').map(Number);
      const hit = week.find((d) => d.getUTCMonth() + 1 === mm && d.getUTCDate() === dd);
      return hit ? { id: p.id, name: fullName(p), date: hit.toISOString() } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((x, y) => x.date.localeCompare(y.date));
  const attendance = attendanceTrend(ctx);
  const nextEvents = ctx.db.all('events').filter((e) => upcoming(ctx, e)).sort(bySoonest);
  const nextService = nextEvents.find((e) => e.kind === 'service');
  let openSlots = 0;
  if (nextService) {
    for (const t of ctx.db.all('teams'))
      for (const pos of t.positions) {
        const filled = ctx.db.all('assignments').filter((a) => a.eventId === nextService.id && a.teamId === t.id && a.positionId === pos.id && a.status !== 'declined').length;
        openSlots += Math.max(0, pos.needed - filled);
      }
  }
  const care = ctx.db.all('care').filter((c) => c.status !== 'closed');
  return {
    currency: settings(ctx).currency,
    people: { total: people.length, members: people.filter((p) => p.status === 'member').length, newThisMonth: people.filter((p) => now.getTime() - new Date(p.joinedAt).getTime() < 30 * DAY).length },
    attendance: { lastSunday: attendance.at(-1)?.count ?? 0, trend: attendance },
    giving: { thisMonth: sumBetween(monthStart, now), lastMonth: sumBetween(lastMonthStart, monthStart), trend },
    pendingJoinRequests: ctx.db.count('joinRequests'),
    upcomingEvents: nextEvents.filter((e) => e.published).slice(0, 4).map((e) => eventView(ctx, e)),
    recentDonations: ok.slice(0, 6).map(adminDonation),
    birthdaysThisWeek: birthdays.slice(0, 6),
    care: { open: care.length, overdue: care.filter((c) => c.dueAt && c.dueAt < now.toISOString()).length, atRisk: atRisk(ctx).filter((p) => !p.openCaseId).length, prayer: ctx.db.all('prayer').filter((p) => p.status === 'open').length },
    serving: {
      openSlots,
      pending: nextService ? ctx.db.all('assignments').filter((a) => a.eventId === nextService.id && a.status === 'pending').length : 0,
      nextEventTitle: nextService?.title ?? null,
    },
  };
}

function insights(ctx: Ctx): Insights {
  const now = ctx.now;
  const people = ctx.db.all('people');
  const months = Array.from({ length: 6 }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5 + i, 1)).toISOString().slice(0, 7));
  const checkinsByDate = new Map<string, { adults: number; children: number }>();
  for (const c of ctx.db.all('checkins')) {
    const d = c.at.slice(0, 10);
    const row = checkinsByDate.get(d) ?? { adults: 0, children: 0 };
    c.isChild ? row.children++ : row.adults++;
    checkinsByDate.set(d, row);
  }
  const fyFrom = fiscalYearStart(ctx).toISOString();
  const gifts = ctx.can('giving.view') ? ctx.db.all('donations').filter((d) => d.status === 'succeeded' && !d.eventId) : [];
  const byFund = new Map<string, number>();
  for (const d of gifts) if (giftDate(d) >= fyFrom) byFund.set(d.fundName, (byFund.get(d.fundName) ?? 0) + d.amount);
  const donorMonths = new Map<string, Set<string>>();
  const lastGift = new Map<string, string>();
  for (const d of gifts) {
    if (!d.donorId) continue;
    const s = donorMonths.get(d.donorId) ?? new Set();
    s.add(giftDate(d).slice(0, 7));
    donorMonths.set(d.donorId, s);
    if ((lastGift.get(d.donorId) ?? '') < giftDate(d)) lastGift.set(d.donorId, giftDate(d));
  }
  const givers = { recurring: 0, regular: 0, occasional: 0, lapsed: 0 };
  const recentMonths = new Set(months);
  for (const [id, ms] of donorMonths) {
    const recurring = gifts.some((d) => d.donorId === id && d.frequency === 'monthly' && now.getTime() - new Date(giftDate(d)).getTime() < 40 * DAY);
    const recent = [...ms].filter((m) => recentMonths.has(m)).length;
    if (now.getTime() - new Date(lastGift.get(id)!).getTime() > 120 * DAY) givers.lapsed++;
    else if (recurring) givers.recurring++;
    else if (recent >= 3) givers.regular++;
    else givers.occasional++;
  }
  const adults = people.filter((p) => p.status !== 'inactive' && !isChild(ctx, p));
  const inGroup = new Set(ctx.db.all('groupMembers').map((m) => m.personId));
  const serving = new Set(ctx.db.all('teams').flatMap((t) => t.members.map((m) => m.personId)));
  const givingIds = new Set([...donorMonths.keys()].filter((id) => now.getTime() - new Date(lastGift.get(id)!).getTime() < 120 * DAY));
  const ninety = now.getTime() - 90 * DAY;
  const newVisitors = people.filter((p) => new Date(p.joinedAt).getTime() > ninety);
  const closed = ctx.db.all('care').filter((c) => c.status === 'closed' && c.closedAt);
  const recentClosed = closed.filter((c) => now.getTime() - new Date(c.closedAt!).getTime() < 30 * DAY);
  return {
    currency: settings(ctx).currency,
    funnel: (['visitor', 'regular', 'member', 'inactive'] as const).map((status) => ({ status, count: people.filter((p) => p.status === status).length })),
    newPeople: months.map((month) => ({ month, count: people.filter((p) => p.joinedAt.slice(0, 7) === month).length })),
    attendance: attendanceTrend(ctx, 26),
    checkins: [...checkinsByDate].map(([date, v]) => ({ date, ...v })).sort((x, y) => x.date.localeCompare(y.date)).slice(-12),
    givingByFund: [...byFund].map(([fund, amount]) => ({ fund, amount })).sort((x, y) => y.amount - x.amount),
    givers,
    engagement: { total: adults.length, inGroup: adults.filter((p) => inGroup.has(p.id)).length, serving: adults.filter((p) => serving.has(p.id)).length, giving: adults.filter((p) => givingIds.has(p.id)).length },
    retention: { visitorsLast90: newVisitors.length, becameRegular: newVisitors.filter((p) => p.status === 'regular' || p.status === 'member').length },
    care: {
      open: ctx.db.all('care').filter((c) => c.status !== 'closed').length,
      closedLast30: recentClosed.length,
      avgDaysToClose: closed.length ? Math.round((closed.reduce((t, c) => t + (new Date(c.closedAt!).getTime() - new Date(c.createdAt).getTime()), 0) / closed.length / DAY) * 10) / 10 : null,
    },
  };
}

export function registerCare(r: Router) {
  // ----- member: prayer wall -----
  r.get('/prayer', {}, (ctx) => {
    const me = ctx.me();
    const list = ctx.db
      .all('prayer')
      .filter((p) => p.personId === me || (p.visibility === 'church' && (p.status === 'open' || ctx.now.getTime() - new Date(p.createdAt).getTime() < 30 * DAY)))
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    return { data: list.slice(0, 100).map((p) => prayerView(ctx, p, me)), nextCursor: null };
  });
  r.post('/prayer', {}, (ctx) => {
    const me = find(ctx, 'people', ctx.me(), 'Profile');
    requireFields(ctx.body, ['text']);
    const text = String(ctx.body.text).trim().slice(0, 1000);
    const p = ctx.db.put('prayer', { id: ctx.id('pr'), personId: me.id, name: fullName(me), text, visibility: ctx.body.visibility === 'church' ? 'church' : 'pastors', status: 'open', prayedBy: [], createdAt: ctx.now.toISOString(), answeredNote: null });
    return prayerView(ctx, p, me.id);
  });
  r.post('/prayer/:id/pray', {}, (ctx) => {
    const me = ctx.me();
    const p = find(ctx, 'prayer', ctx.params[0], 'Prayer request');
    if (p.visibility !== 'church' && p.personId !== me) throw new ApiError(404, 'not_found', 'Prayer request not found.');
    const next = ctx.db.put('prayer', { ...p, prayedBy: p.prayedBy.includes(me) ? p.prayedBy : [...p.prayedBy, me] });
    return prayerView(ctx, next, me);
  });
  r.patch('/prayer/:id', {}, (ctx) => {
    const me = ctx.me();
    const p = find(ctx, 'prayer', ctx.params[0], 'Prayer request');
    if (p.personId !== me) throw new ApiError(403, 'forbidden', 'You can only update your own requests.');
    const next = ctx.db.put('prayer', { ...p, status: ctx.body.status === 'answered' ? 'answered' : 'open', answeredNote: ctx.body.answeredNote ? String(ctx.body.answeredNote).slice(0, 500) : p.answeredNote });
    return prayerView(ctx, next, me);
  });

  // ----- admin: care -----
  r.get('/admin/care', { perm: 'care' }, (ctx) => {
    const status = ctx.query.status;
    const mine = ctx.query.mine === 'true';
    const list = ctx.db
      .all('care')
      .filter((c) => canSee(ctx, c))
      .filter((c) => !status || c.status === status)
      .filter((c) => !mine || c.assignedTo === ctx.staff?.id)
      .sort((x, y) => (x.status === 'closed' ? 1 : 0) - (y.status === 'closed' ? 1 : 0) || (x.priority === 'urgent' ? -1 : 0) - (y.priority === 'urgent' ? -1 : 0) || (x.dueAt ?? '9').localeCompare(y.dueAt ?? '9'));
    return page(list, ctx.query.cursor, 200);
  });
  r.get('/admin/care/at-risk', { perm: 'care' }, (ctx) => atRisk(ctx));
  r.get('/admin/care/assignees', { perm: 'care' }, (ctx) =>
    ctx.db
      .all('staff')
      .filter((s) => s.status === 'active' && ['owner', 'admin', 'pastor', 'leader'].includes(s.role))
      .map((s) => ({ id: s.id, name: s.name, role: s.role })),
  );
  r.post('/admin/care', { perm: 'care' }, (ctx) => {
    const body = ctx.body as CareInput;
    requireFields(ctx.body, ['title']);
    const person = body.personId ? find(ctx, 'people', body.personId, 'Person') : null;
    const assignee = body.assignedTo ? find(ctx, 'staff', body.assignedTo, 'Team member') : null;
    const c = ctx.db.put('care', {
      id: ctx.id('cc'),
      personId: person?.id ?? null,
      personName: person ? fullName(person) : String(ctx.body.personName ?? 'Someone'),
      type: CARE_TYPES.includes(body.type) ? body.type : 'follow_up',
      title: String(body.title).slice(0, 200),
      status: 'open',
      priority: body.priority === 'urgent' ? 'urgent' : 'normal',
      assignedTo: assignee?.id ?? null,
      assignedName: assignee?.name ?? null,
      dueAt: body.dueAt ? new Date(body.dueAt).toISOString() : null,
      createdAt: ctx.now.toISOString(),
      closedAt: null,
      notes: body.note ? [{ id: ctx.id('cn'), at: ctx.now.toISOString(), by: ctx.staff?.name ?? '', text: String(body.note) }] : [],
      source: ctx.body.prayerId ? 'prayer' : 'manual',
      confidential: !!body.confidential,
    });
    ctx.audit('created', 'care', c.id, `Opened care case for ${c.personName}`);
    return c;
  });
  r.patch('/admin/care/:id', { perm: 'care' }, (ctx) => {
    const c = find(ctx, 'care', ctx.params[0], 'Case');
    if (!canSee(ctx, c)) throw new ApiError(404, 'not_found', 'Case not found.');
    const next: CareCase = { ...c };
    if (ctx.body.status && ['open', 'in_progress', 'closed'].includes(ctx.body.status)) {
      next.status = ctx.body.status;
      next.closedAt = ctx.body.status === 'closed' ? ctx.now.toISOString() : null;
    }
    if (ctx.body.assignedTo !== undefined) {
      const s = ctx.body.assignedTo ? find(ctx, 'staff', ctx.body.assignedTo, 'Team member') : null;
      next.assignedTo = s?.id ?? null;
      next.assignedName = s?.name ?? null;
    }
    if (ctx.body.priority) next.priority = ctx.body.priority === 'urgent' ? 'urgent' : 'normal';
    if (ctx.body.dueAt !== undefined) next.dueAt = ctx.body.dueAt ? new Date(ctx.body.dueAt).toISOString() : null;
    if (ctx.body.title) next.title = String(ctx.body.title).slice(0, 200);
    if (ctx.body.type && CARE_TYPES.includes(ctx.body.type)) next.type = ctx.body.type;
    if (typeof ctx.body.confidential === 'boolean') next.confidential = ctx.body.confidential;
    ctx.audit('updated', 'care', c.id, `Updated care case for ${c.personName}${next.status !== c.status ? ` (${next.status.replace('_', ' ')})` : ''}`);
    return ctx.db.put('care', next);
  });
  r.post('/admin/care/:id/notes', { perm: 'care' }, (ctx) => {
    const c = find(ctx, 'care', ctx.params[0], 'Case');
    if (!canSee(ctx, c)) throw new ApiError(404, 'not_found', 'Case not found.');
    requireFields(ctx.body, ['text']);
    const next = { ...c, notes: [...c.notes, { id: ctx.id('cn'), at: ctx.now.toISOString(), by: ctx.staff?.name ?? '', text: String(ctx.body.text).slice(0, 2000) }], status: c.status === 'open' ? ('in_progress' as const) : c.status };
    return ctx.db.put('care', next);
  });
  r.del('/admin/care/:id', { perm: 'care' }, (ctx) => {
    const c = find(ctx, 'care', ctx.params[0], 'Case');
    ctx.db.del('care', c.id);
    ctx.audit('deleted', 'care', c.id, `Deleted care case for ${c.personName}`);
    return undefined;
  });

  // ----- admin: prayer -----
  r.get('/admin/prayer', { perm: 'care' }, (ctx) => ({
    data: ctx.db
      .all('prayer')
      .sort((x, y) => (x.status === 'answered' ? 1 : 0) - (y.status === 'answered' ? 1 : 0) || y.createdAt.localeCompare(x.createdAt))
      .slice(0, 300)
      .map((p) => ({ ...prayerView(ctx, p, ''), name: p.name })),
    nextCursor: null,
  }));
  r.patch('/admin/prayer/:id', { perm: 'care' }, (ctx) => {
    const p = find(ctx, 'prayer', ctx.params[0], 'Prayer request');
    const next = ctx.db.put('prayer', {
      ...p,
      status: ctx.body.status === 'answered' ? 'answered' : ctx.body.status === 'open' ? 'open' : p.status,
      visibility: ctx.body.visibility === 'church' || ctx.body.visibility === 'pastors' ? ctx.body.visibility : p.visibility,
      answeredNote: ctx.body.answeredNote !== undefined ? String(ctx.body.answeredNote) : p.answeredNote,
    });
    return { ...prayerView(ctx, next, ''), name: next.name };
  });
  r.del('/admin/prayer/:id', { perm: 'care' }, (ctx) => {
    ctx.db.del('prayer', ctx.params[0]);
    return undefined;
  });

  // ----- dashboards -----
  r.get('/admin/dashboard', { staff: true }, (ctx) => dashboard(ctx));
  r.get('/admin/insights', { perm: 'insights' }, (ctx) => insights(ctx));
}
