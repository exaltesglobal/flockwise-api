// Discipleship: one-to-one mentoring. A mature believer walks with a new believer, someone preparing
// for baptism, a young leader or a young couple. Each pair agrees how often to meet; meetings are
// logged by the mentor in the app or by the office, overdue pairs stand out, and the mentor gets a
// gentle nudge. New people who have no one walking with them are listed so nobody slips through.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { DiscipleshipHub, MentorFocus, MentorMeeting, Mentorship, MentorshipDetail, MentorshipView, MyMentoring } from '../types.js';
import { find, fullName, localDate, settings } from '../util.js';
import { notify } from './notify.js';

const DAY = 86_400_000;
const FOCI: MentorFocus[] = ['new_believer', 'baptism', 'leadership', 'marriage', 'youth', 'other'];
const RHYTHMS = [7, 14, 30];
const GRACE_DAYS = 3;
const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const meetingsOf = (ctx: Ctx, id: string) => ctx.db.all('mentorMeetings').filter((m) => m.mentorshipId === id).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));

function view(ctx: Ctx, m: Mentorship): MentorshipView {
  const mentor = ctx.db.get('people', m.mentorId);
  const mentee = ctx.db.get('people', m.menteeId);
  const log = meetingsOf(ctx, m.id);
  const lastMet = log[0]?.date ?? null;
  const dueOn = addDays(lastMet ?? m.startedOn, m.everyDays);
  const today = localDate(ctx, ctx.now);
  return {
    ...m,
    mentorName: mentor ? fullName(mentor) : 'Removed person', menteeName: mentee ? fullName(mentee) : 'Removed person',
    mentorPhone: mentor?.phone ?? null, menteePhone: mentee?.phone ?? null,
    meetings: log.length, lastMet, dueOn,
    overdue: m.status === 'active' && addDays(dueOn, GRACE_DAYS) < today,
  };
}
const detail = (ctx: Ctx, m: Mentorship): MentorshipDetail => ({ ...view(ctx, m), log: meetingsOf(ctx, m.id) });

function hub(ctx: Ctx): DiscipleshipHub {
  const all = ctx.db.all('mentorships');
  const pairs = all.map((m) => view(ctx, m)).sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.status === b.status ? a.dueOn.localeCompare(b.dueOn) : a.status === 'active' ? -1 : 1));
  const active = pairs.filter((p) => p.status === 'active');
  const month = localDate(ctx, ctx.now).slice(0, 7);
  const ids = new Set(all.map((m) => m.id));
  const walked = new Set(all.filter((m) => m.status !== 'completed').map((m) => m.menteeId));
  const since = new Date(ctx.now.getTime() - 120 * DAY).toISOString();
  const needMentor = ctx.db
    .all('people')
    .filter((p) => p.status !== 'inactive' && p.joinedAt >= since && !walked.has(p.id) && (!p.birthDate || ctx.now.getFullYear() - Number(p.birthDate.slice(0, 4)) >= 13))
    .sort((a, b) => b.joinedAt.localeCompare(a.joinedAt))
    .slice(0, 50)
    .map((p) => ({ personId: p.id, name: fullName(p), joinedAt: p.joinedAt, status: p.status }));
  return {
    pairs,
    counts: {
      active: active.length,
      overdue: active.filter((p) => p.overdue).length,
      meetingsThisMonth: ctx.db.all('mentorMeetings').filter((x) => ids.has(x.mentorshipId) && x.date.startsWith(month)).length,
      mentors: new Set(active.map((p) => p.mentorId)).size,
    },
    needMentor,
  };
}

function logMeeting(ctx: Ctx, m: Mentorship, b: Record<string, unknown>, via: MentorMeeting['via'], by: string): MentorMeeting {
  const today = localDate(ctx, ctx.now);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date ?? '')) ? String(b.date) : today;
  if (date > today) throw new ApiError(422, 'invalid', 'The meeting date cannot be in the future.', { date: 'Not in the future' });
  const meeting = ctx.db.put('mentorMeetings', { id: ctx.id('mm'), mentorshipId: m.id, date, topic: clean(b.topic, 120), note: clean(b.note, 1000), loggedBy: by, via, createdAt: ctx.now.toISOString() });
  if (m.nudgedFor) ctx.db.put('mentorships', { ...m, nudgedFor: null });
  return meeting;
}

function mine(ctx: Ctx): MyMentoring {
  const me = ctx.me();
  const active = ctx.db.all('mentorships').filter((m) => m.status === 'active');
  return {
    mentees: active.filter((m) => m.mentorId === me).map((m) => {
      const v = view(ctx, m);
      return { id: m.id, name: v.menteeName, phone: v.menteePhone, focus: m.focus, goal: m.goal, lastMet: v.lastMet, dueOn: v.dueOn, overdue: v.overdue, recent: meetingsOf(ctx, m.id).slice(0, 3).map((x) => ({ date: x.date, topic: x.topic })) };
    }),
    mentors: active.filter((m) => m.menteeId === me).map((m) => { const v = view(ctx, m); return { id: m.id, name: v.mentorName, phone: v.mentorPhone, focus: m.focus, lastMet: v.lastMet }; }),
  };
}

/** Daily: a mentor whose pair is overdue gets one nudge for that due date. */
export async function mentorNudges(ctx: Ctx) {
  const church = settings(ctx).name;
  for (const m of ctx.db.all('mentorships').filter((x) => x.status === 'active')) {
    const v = view(ctx, m);
    if (!v.overdue || m.nudgedFor === v.dueOn) continue;
    ctx.db.put('mentorships', { ...m, nudgedFor: v.dueOn });
    await notify(ctx, 'mentor.nudge', {
      personIds: [m.mentorId],
      title: `${church}: time to meet ${v.menteeName.split(' ')[0]}`,
      body: `${v.lastMet ? `You last met ${v.menteeName} on ${v.lastMet}` : `You have not logged a meeting with ${v.menteeName} yet`}. A call or a cup of tea this week? Tap "We met" in the app afterwards.`,
      link: '/app/mentoring',
    });
  }
}

export function registerDiscipleship(r: Router) {
  r.get('/admin/discipleship', { perm: ['care', 'people.view'] }, (ctx) => hub(ctx));

  r.post('/admin/discipleship', { perm: 'care' }, (ctx) => {
    const b = ctx.body as Record<string, unknown>;
    const mentorId = String(b.mentorId ?? '');
    const menteeId = String(b.menteeId ?? '');
    find(ctx, 'people', mentorId, 'Mentor');
    find(ctx, 'people', menteeId, 'Person');
    if (mentorId === menteeId) throw new ApiError(422, 'invalid', 'Choose two different people.', { menteeId: 'Different from the mentor' });
    if (ctx.db.all('mentorships').some((m) => m.mentorId === mentorId && m.menteeId === menteeId && m.status !== 'completed')) throw new ApiError(409, 'exists', 'These two are already paired.');
    const m = ctx.db.put('mentorships', {
      id: ctx.id('ms'), mentorId, menteeId,
      focus: FOCI.includes(b.focus as MentorFocus) ? (b.focus as MentorFocus) : 'new_believer',
      goal: clean(b.goal, 300),
      everyDays: RHYTHMS.includes(Number(b.everyDays)) ? Number(b.everyDays) : 14,
      status: 'active', startedOn: localDate(ctx, ctx.now), endedOn: null, nudgedFor: null, createdAt: ctx.now.toISOString(),
    });
    const v = view(ctx, m);
    ctx.audit('created', 'discipleship', m.id, `${v.mentorName} is walking with ${v.menteeName}`);
    return detail(ctx, m);
  });

  r.get('/admin/discipleship/:id', { perm: ['care', 'people.view'] }, (ctx) => detail(ctx, find(ctx, 'mentorships', ctx.params[0], 'Pair')));

  r.patch('/admin/discipleship/:id', { perm: 'care' }, (ctx) => {
    const m = find(ctx, 'mentorships', ctx.params[0], 'Pair');
    const b = ctx.body as Record<string, unknown>;
    const status = b.status === 'active' || b.status === 'paused' || b.status === 'completed' ? b.status : m.status;
    const next: Mentorship = {
      ...m,
      focus: FOCI.includes(b.focus as MentorFocus) ? (b.focus as MentorFocus) : m.focus,
      goal: b.goal !== undefined ? clean(b.goal, 300) : m.goal,
      everyDays: RHYTHMS.includes(Number(b.everyDays)) ? Number(b.everyDays) : m.everyDays,
      status,
      endedOn: status === 'completed' ? (m.endedOn ?? localDate(ctx, ctx.now)) : null,
    };
    ctx.db.put('mentorships', next);
    if (status !== m.status) ctx.audit('updated', 'discipleship', m.id, `Pair ${status}`);
    return detail(ctx, next);
  });

  r.post('/admin/discipleship/:id/meetings', { perm: 'care' }, (ctx) => {
    const m = find(ctx, 'mentorships', ctx.params[0], 'Pair');
    logMeeting(ctx, m, ctx.body as Record<string, unknown>, 'office', ctx.staff?.name ?? '');
    return detail(ctx, find(ctx, 'mentorships', m.id, 'Pair'));
  });

  r.del('/admin/discipleship/:id/meetings/:mid', { perm: 'care' }, (ctx) => {
    const m = find(ctx, 'mentorships', ctx.params[0], 'Pair');
    const x = find(ctx, 'mentorMeetings', ctx.params[1], 'Meeting');
    if (x.mentorshipId === m.id) ctx.db.del('mentorMeetings', x.id);
    return detail(ctx, m);
  });

  // Member app: the mentor's side (who I walk with, "We met") and the mentee's (who walks with me).
  r.get('/me/mentoring', {}, (ctx) => mine(ctx));
  r.post('/me/mentoring/:id/meetings', {}, (ctx) => {
    const m = find(ctx, 'mentorships', ctx.params[0], 'Pair');
    if (m.mentorId !== ctx.me() || m.status !== 'active') throw new ApiError(403, 'forbidden', 'Only the mentor can log meetings for this pair.');
    const me = ctx.db.get('people', ctx.me());
    logMeeting(ctx, m, ctx.body as Record<string, unknown>, 'app', me ? fullName(me) : '');
    return mine(ctx);
  });
}
