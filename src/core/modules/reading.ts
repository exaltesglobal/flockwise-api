// Bible reading plan: the office starts a plan (whole Bible in a year, New Testament in 90 days,
// the Gospels in 30, Psalms and Proverbs in a month, or its own list), members join from the app,
// tick each day's reading in their own language, keep a streak, and see the church-wide
// "we read together" bar. A morning push carries the day's reading.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import { localizeReading, READING_TEMPLATES, templateReadings, type ReadingTemplateId } from '../bible.js';
import type { MyReading, MyReadingPlan, ReadingHub, ReadingPlan, ReadingPlanView, ReadingProgress } from '../types.js';
import { find, localDate, settings } from '../util.js';
import { notify } from './notify.js';

const DAY = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const dayNumber = (plan: ReadingPlan, today: string) => Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${plan.startsOn}T00:00:00Z`)) / DAY) + 1;
/** 1-based day of the plan that falls on `today`, or null before it starts or after it ends. */
export function todayOf(plan: ReadingPlan, today: string): number | null {
  const d = dayNumber(plan, today);
  return d >= 1 && d <= plan.readings.length ? d : null;
}
const progressId = (planId: string, personId: string) => `${planId}:${personId}`;
const progressOf = (ctx: Ctx, planId: string) => ctx.db.all('readingProgress').filter((p) => p.planId === planId);

function view(ctx: Ctx, plan: ReadingPlan, today: string): ReadingPlanView {
  const rows = progressOf(ctx, plan.id);
  const day = todayOf(plan, today);
  const elapsed = Math.max(0, Math.min(plan.readings.length, dayNumber(plan, today)));
  const possible = rows.length * elapsed;
  const done = rows.reduce((s, r) => s + r.done.filter((d) => d <= elapsed).length, 0);
  return {
    ...plan, totalDays: plan.readings.length, endsOn: addDays(plan.startsOn, plan.readings.length - 1), today: day,
    participants: rows.length,
    readToday: day ? rows.filter((r) => r.done.includes(day)).length : 0,
    percent: possible ? Math.round((100 * done) / possible) : 0,
  };
}

export function hub(ctx: Ctx, status: string | undefined): ReadingHub {
  const today = localDate(ctx, ctx.now);
  const plans = ctx.db.all('readingPlans')
    .filter((p) => (status === 'all' ? true : status === 'archived' ? p.status === 'archived' : p.status === 'active'))
    .map((p) => view(ctx, p, today))
    .sort((a, b) => b.startsOn.localeCompare(a.startsOn));
  return { plans, templates: READING_TEMPLATES };
}

/** Days in a row ticked, counting back from today (or yesterday, so a streak survives until bedtime). */
export function streakOf(done: number[], today: number | null): number {
  if (!today) return 0;
  const set = new Set(done);
  let d = set.has(today) ? today : today - 1;
  let n = 0;
  while (d >= 1 && set.has(d)) { n++; d--; }
  return n;
}

function mine(ctx: Ctx): MyReading {
  const me = ctx.me();
  const person = ctx.db.get('people', me);
  const lang = person?.language ?? 'en';
  const today = localDate(ctx, ctx.now);
  const plans: MyReadingPlan[] = ctx.db.all('readingPlans').filter((p) => p.status === 'active').map((plan) => {
    const v = view(ctx, plan, today);
    const mineRow = ctx.db.get('readingProgress', progressId(plan.id, me)) ?? null;
    const day = v.today;
    return {
      id: plan.id, name: plan.name, description: plan.description, startsOn: plan.startsOn, endsOn: v.endsOn, totalDays: v.totalDays, today: day,
      readings: plan.readings.map((r, i) => ({ day: i + 1, on: addDays(plan.startsOn, i), ref: r, local: localizeReading(r, lang) })),
      joined: !!mineRow, done: mineRow?.done ?? [], doneCount: mineRow?.done.length ?? 0,
      streak: streakOf(mineRow?.done ?? [], day), todayDone: !!(day && mineRow?.done.includes(day)),
      church: { participants: v.participants, readToday: v.readToday, percent: v.percent },
    };
  }).sort((a, b) => Number(b.joined) - Number(a.joined) || a.startsOn.localeCompare(b.startsOn));
  return { plans };
}

/** Morning push with the day's reading, in each reader's language. Called from the daily tick. */
export async function readingReminders(ctx: Ctx, today: string) {
  const church = settings(ctx).name;
  for (const plan of ctx.db.all('readingPlans').filter((p) => p.status === 'active')) {
    const day = todayOf(plan, today);
    if (!day) continue;
    const key = `reading:${plan.id}:${day}`;
    if (ctx.db.get('meta', key)) continue;
    ctx.db.put('meta', { id: key, value: today });
    const ref = plan.readings[day - 1];
    const readers = progressOf(ctx, plan.id).map((r) => ctx.db.get('people', r.personId)).filter((p): p is NonNullable<typeof p> => !!p && p.status !== 'inactive');
    const byLang = new Map<string, string[]>();
    for (const p of readers) byLang.set(p.language ?? 'en', [...(byLang.get(p.language ?? 'en') ?? []), p.id]);
    for (const [lang, personIds] of byLang) {
      await notify(ctx, 'reading.today', {
        personIds,
        title: `${church}: day ${day} of ${plan.readings.length}`,
        body: `${localizeReading(ref, lang as never)} — ${plan.name}. Tick it in the app when you have read it.`,
        link: '/app/reading',
      });
    }
  }
}

export function registerReading(r: Router) {
  const EDIT = ['comms', 'settings'] as ('comms' | 'settings')[];
  r.get('/admin/reading', { staff: true }, (ctx) => hub(ctx, ctx.query.status));
  r.post('/admin/reading', { perm: EDIT }, (ctx) => {
    const template = (READING_TEMPLATES.some((t) => t.id === ctx.body.template) ? ctx.body.template : 'custom') as ReadingTemplateId;
    const startsOn = clean(ctx.body.startsOn, 10) || localDate(ctx, ctx.now);
    if (!DATE_RE.test(startsOn)) throw new ApiError(422, 'validation', 'Use YYYY-MM-DD for the start date.');
    const readings = template === 'custom'
      ? String(ctx.body.readings ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 400)
      : templateReadings(template);
    if (readings.length < 2) throw new ApiError(422, 'validation', 'A plan needs at least two days: one reading per line.', { readings: 'Required' });
    const name = clean(ctx.body.name, 80) || READING_TEMPLATES.find((t) => t.id === template)!.name;
    const plan: ReadingPlan = { id: ctx.id('rp'), name, description: clean(ctx.body.description, 400), template, startsOn, readings, status: 'active', createdAt: ctx.now.toISOString(), createdBy: ctx.staff?.name ?? 'office' };
    ctx.db.put('readingPlans', plan);
    ctx.audit('created', 'reading-plan', plan.id, `Started “${name}” (${readings.length} days from ${startsOn})`);
    return view(ctx, plan, localDate(ctx, ctx.now));
  });
  r.patch('/admin/reading/:id', { perm: EDIT }, (ctx) => {
    const plan = find(ctx, 'readingPlans', ctx.params[0], 'Reading plan');
    const next: ReadingPlan = {
      ...plan,
      name: ctx.body.name === undefined ? plan.name : clean(ctx.body.name, 80) || plan.name,
      description: ctx.body.description === undefined ? plan.description : clean(ctx.body.description, 400),
      status: ctx.body.status === 'archived' || ctx.body.status === 'active' ? ctx.body.status : plan.status,
    };
    ctx.db.put('readingPlans', next);
    ctx.audit('updated', 'reading-plan', plan.id, `${next.status === 'archived' && plan.status !== 'archived' ? 'Archived' : 'Updated'} “${next.name}”`);
    return view(ctx, next, localDate(ctx, ctx.now));
  });
  r.get('/admin/reading/:id/readers', { staff: true }, (ctx) => {
    const plan = find(ctx, 'readingPlans', ctx.params[0], 'Reading plan');
    const day = todayOf(plan, localDate(ctx, ctx.now));
    return progressOf(ctx, plan.id).map((p) => {
      const person = ctx.db.get('people', p.personId);
      return { personId: p.personId, name: person ? `${person.firstName} ${person.lastName}`.trim() : 'Former member', joinedAt: p.joinedAt, doneCount: p.done.length, streak: streakOf(p.done, day), todayDone: !!(day && p.done.includes(day)) };
    }).sort((a, b) => b.doneCount - a.doneCount || a.name.localeCompare(b.name));
  });

  r.get('/me/reading', {}, (ctx) => mine(ctx));
  r.post('/me/reading/:id/join', {}, (ctx) => {
    const plan = find(ctx, 'readingPlans', ctx.params[0], 'Reading plan');
    if (plan.status !== 'active') throw new ApiError(409, 'closed', 'This plan has finished.');
    const id = progressId(plan.id, ctx.me());
    if (!ctx.db.get('readingProgress', id)) ctx.db.put('readingProgress', { id, planId: plan.id, personId: ctx.me(), joinedAt: ctx.now.toISOString(), done: [], lastDoneAt: null } satisfies ReadingProgress);
    return mine(ctx);
  });
  r.del('/me/reading/:id', {}, (ctx) => {
    const row = ctx.db.get('readingProgress', progressId(ctx.params[0], ctx.me()));
    if (row) ctx.db.del('readingProgress', row.id);
    return mine(ctx);
  });
  r.post('/me/reading/:id/done', {}, (ctx) => {
    const plan = find(ctx, 'readingPlans', ctx.params[0], 'Reading plan');
    const row = ctx.db.get('readingProgress', progressId(plan.id, ctx.me()));
    if (!row) throw new ApiError(409, 'not_joined', 'Join the plan first.');
    const today = todayOf(plan, localDate(ctx, ctx.now)) ?? (dayNumber(plan, localDate(ctx, ctx.now)) > plan.readings.length ? plan.readings.length : 0);
    const day = Math.round(Number(ctx.body.day ?? today));
    if (!day || day < 1 || day > plan.readings.length) throw new ApiError(422, 'validation', 'That day is not in the plan.');
    if (day > today) throw new ApiError(422, 'validation', 'That day has not come yet.');
    const on = ctx.body.done === false ? row.done.filter((d) => d !== day) : [...new Set([...row.done, day])].sort((a, b) => a - b);
    ctx.db.put('readingProgress', { ...row, done: on, lastDoneAt: ctx.body.done === false ? row.lastDoneAt : ctx.now.toISOString() });
    return mine(ctx);
  });
}
