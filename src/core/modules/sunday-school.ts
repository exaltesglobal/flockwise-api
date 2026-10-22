// Sunday school: classes by age with their teachers, the weekly register (filled from kids' check-in),
// lessons and memory verses, exams with marks, grades and ranks, the annual day prize list, promotion
// to the next class each year, and results sent to parents on WhatsApp.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { Collections, MemberSundaySchool, SsAttendance, SsClass, SsClassDetail, SsClassView, SsExam, SsExamResults, SsExamView, SsGrade, SsLesson, SsOverview, SsPerson, SsPrizes, SsRegister, SsResultRow } from '../types.js';
import { age, DAY, find, fullName, localDate, requireFields, settings } from '../util.js';
import { channelStatus, deliverAll } from './integrations.js';
import { parentsOf } from './pager.js';

const PERM = 'checkin' as const;
const DEFAULT_CLASSES: [string, number, number][] = [
  ['Beginners', 3, 5],
  ['Primary', 6, 8],
  ['Junior', 9, 11],
  ['Intermediate', 12, 14],
  ['Senior', 15, 17],
];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
/** The most recent Sunday, or today when it is Sunday. */
export function lastSunday(ctx: Ctx) {
  const today = localDate(ctx, ctx.now);
  return addDays(today, -new Date(`${today}T00:00:00Z`).getUTCDay());
}
const dateOr = (v: unknown, fallback: string) => (typeof v === 'string' && DATE_RE.test(v) ? v : fallback);

function person(ctx: Ctx, id: string): SsPerson | null {
  const p = ctx.db.get('people', id);
  return p ? { id: p.id, name: fullName(p), age: age(p.birthDate, ctx.now) } : null;
}
const people = (ctx: Ctx, ids: string[]) => ids.map((id) => person(ctx, id)).filter((p): p is SsPerson => !!p).sort((a, b) => a.name.localeCompare(b.name));
const classes = (ctx: Ctx) => ctx.db.all('ssClasses').sort((a, b) => a.order - b.order || a.minAge - b.minAge);
const sessionsOf = (ctx: Ctx, classId: string) => ctx.db.all('ssAttendance').filter((a) => a.classId === classId).sort((a, b) => b.date.localeCompare(a.date));

export function grade(percent: number): SsGrade {
  return percent >= 90 ? 'A+' : percent >= 75 ? 'A' : percent >= 60 ? 'B' : percent >= 45 ? 'C' : 'D';
}

function classView(ctx: Ctx, c: SsClass): SsClassView {
  const recent = sessionsOf(ctx, c.id).slice(0, 8);
  const rates = (c.studentIds.length ? recent : []).map((s) => s.present.filter((id) => c.studentIds.includes(id)).length / c.studentIds.length);
  return {
    ...c,
    teachers: people(ctx, c.teacherIds),
    students: c.studentIds.length,
    roomName: c.roomId ? ctx.db.get('rooms', c.roomId)?.name ?? null : null,
    attendance: rates.length ? Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 100) : null,
    lastMarked: recent[0]?.date ?? null,
  };
}

function studentStats(sessions: SsAttendance[], id: string) {
  const present = sessions.filter((s) => s.present.includes(id)).length;
  let streak = 0;
  for (const s of sessions) {
    if (!s.present.includes(id)) break;
    streak++;
  }
  return { present, of: sessions.length, percent: sessions.length ? Math.round((present * 100) / sessions.length) : null, verses: sessions.filter((s) => s.verse.includes(id)).length, streak };
}

function classDetail(ctx: Ctx, c: SsClass): SsClassDetail {
  const all = sessionsOf(ctx, c.id);
  const term = all.slice(0, 13);
  const today = localDate(ctx, ctx.now);
  return {
    ...classView(ctx, c),
    roster: people(ctx, c.studentIds).map((p) => ({ ...p, ...studentStats(term, p.id) })),
    sessions: term.map((s) => ({ date: s.date, present: s.present.length, of: c.studentIds.length, visitors: s.visitors, offering: s.offering })),
    lessons: ctx.db.all('ssLessons').filter((l) => (l.classId === null || l.classId === c.id) && l.date >= addDays(today, -7)).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6),
  };
}

function lessonFor(ctx: Ctx, classId: string | null, date: string) {
  const all = ctx.db.all('ssLessons').filter((l) => l.date === date);
  return all.find((l) => l.classId === classId) ?? all.find((l) => l.classId === null) ?? null;
}

/** Children of Sunday school age who are not in any class. */
function unassigned(ctx: Ctx): SsPerson[] {
  const cls = classes(ctx);
  if (!cls.length) return [];
  const min = Math.min(...cls.map((c) => c.minAge));
  const max = Math.max(...cls.map((c) => c.maxAge));
  const taken = new Set(cls.flatMap((c) => c.studentIds));
  return ctx.db
    .all('people')
    .filter((p) => p.status !== 'inactive' && !taken.has(p.id))
    .map((p) => ({ id: p.id, name: fullName(p), age: age(p.birthDate, ctx.now) }))
    .filter((p) => p.age !== null && p.age >= min && p.age <= max)
    .sort((a, b) => (a.age ?? 0) - (b.age ?? 0) || a.name.localeCompare(b.name));
}

const classForAge = (cls: SsClass[], a: number | null) => (a === null ? null : cls.find((c) => a >= c.minAge && a <= c.maxAge) ?? null);

/** Puts every child who is not in a class into the class for their age. */
function enrollByAge(ctx: Ctx) {
  const cls = classes(ctx);
  let placed = 0;
  for (const p of unassigned(ctx)) {
    const c = classForAge(cls, p.age);
    if (!c) continue;
    c.studentIds = [...c.studentIds, p.id];
    placed++;
  }
  for (const c of cls) ctx.db.put('ssClasses', c);
  return placed;
}

function classInput(ctx: Ctx, b: Record<string, unknown>, prev?: SsClass): Partial<SsClass> {
  const out: Partial<SsClass> = {};
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name) throw new ApiError(422, 'validation_failed', 'Give the class a name.', { name: 'Required' });
    out.name = name.slice(0, 60);
  }
  for (const k of ['minAge', 'maxAge'] as const) if (b[k] !== undefined) out[k] = Math.max(0, Math.min(25, Math.round(Number(b[k]) || 0)));
  const min = out.minAge ?? prev?.minAge ?? 0;
  const max = out.maxAge ?? prev?.maxAge ?? 0;
  if (min > max) throw new ApiError(422, 'validation_failed', 'The youngest age must not be above the oldest.', { minAge: 'Too high' });
  if (b.roomId !== undefined) out.roomId = b.roomId ? find(ctx, 'rooms', String(b.roomId), 'Room').id : null;
  for (const k of ['teacherIds', 'studentIds'] as const)
    if (Array.isArray(b[k])) out[k] = [...new Set((b[k] as unknown[]).map(String))].filter((id) => ctx.db.get('people', id));
  if (b.order !== undefined) out.order = Math.round(Number(b.order) || 0);
  return out;
}

/** A child is in one class at a time, so adding them here takes them out of any other. */
function claimStudents(ctx: Ctx, keep: SsClass) {
  for (const c of classes(ctx)) {
    if (c.id === keep.id) continue;
    const left = c.studentIds.filter((id) => !keep.studentIds.includes(id));
    if (left.length !== c.studentIds.length) ctx.db.put('ssClasses', { ...c, studentIds: left });
  }
}

function checkedInOn(ctx: Ctx, date: string) {
  const events = new Set(ctx.db.all('events').filter((e) => localDate(ctx, new Date(e.startsAt)) === date).map((e) => e.id));
  return new Set(ctx.db.all('checkins').filter((c) => events.has(c.eventId)).map((c) => c.personId));
}

function register(ctx: Ctx, c: SsClass, date: string): SsRegister {
  const saved = ctx.db.get('ssAttendance', `${c.id}:${date}`);
  const inToday = checkedInOn(ctx, date);
  return {
    classId: c.id,
    className: c.name,
    date,
    saved: !!saved,
    lesson: lessonFor(ctx, c.id, date),
    students: people(ctx, c.studentIds).map((p) => ({ ...p, checkedIn: inToday.has(p.id), present: saved ? saved.present.includes(p.id) : inToday.has(p.id), verse: !!saved?.verse.includes(p.id) })),
    visitors: saved?.visitors ?? 0,
    offering: saved?.offering ?? 0,
  };
}

function examView(ctx: Ctx, e: SsExam): SsExamView {
  const marks = ctx.db.all('ssMarks').filter((m) => m.examId === e.id);
  return {
    ...e,
    classes: e.classIds.map((id) => ctx.db.get('ssClasses', id)).filter((c): c is SsClass => !!c).map((c) => ({ id: c.id, name: c.name, entered: marks.filter((m) => m.classId === c.id).length, of: c.studentIds.length })),
  };
}

function examResults(ctx: Ctx, e: SsExam): SsExamResults {
  const marks = ctx.db.all('ssMarks').filter((m) => m.examId === e.id);
  const view = examView(ctx, e);
  return {
    ...view,
    results: view.classes.map((vc) => {
      const c = ctx.db.get('ssClasses', vc.id)!;
      const ids = [...new Set([...c.studentIds, ...marks.filter((m) => m.classId === c.id).map((m) => m.personId)])];
      const rows: SsResultRow[] = people(ctx, ids).map((p) => {
        const m = marks.find((x) => x.personId === p.id) ?? null;
        const percent = m?.marks != null ? Math.round((m.marks * 100) / e.maxMarks) : null;
        return { ...p, marks: m?.marks ?? null, absent: !!m && m.marks === null, percent, grade: percent === null ? null : grade(percent), rank: null };
      });
      // Standard competition ranking: two children on 92 are both first, the next is third.
      const scored = rows.filter((r) => r.marks !== null).sort((a, b) => b.marks! - a.marks!);
      scored.forEach((r, i) => (r.rank = i > 0 && scored[i - 1].marks === r.marks ? scored[i - 1].rank : i + 1));
      rows.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.name.localeCompare(b.name));
      return { classId: c.id, name: c.name, average: scored.length ? Math.round(scored.reduce((s, r) => s + r.percent!, 0) / scored.length) : null, rows };
    }),
  };
}

/** The annual day list: exam toppers, best attendance and most memory verses in each class. */
function prizes(ctx: Ctx, from: string, to: string): SsPrizes {
  const exams = ctx.db.all('ssExams').filter((e) => e.status === 'published' && e.date >= from && e.date <= to).sort((a, b) => a.date.localeCompare(b.date));
  const results = exams.map((e) => examResults(ctx, e));
  return {
    from,
    to,
    classes: classes(ctx).map((c) => {
      const sessions = sessionsOf(ctx, c.id).filter((s) => s.date >= from && s.date <= to);
      const stats = people(ctx, c.studentIds).map((p) => ({ name: p.name, ...studentStats(sessions, p.id) }));
      const best = Math.max(0, ...stats.map((s) => s.present));
      const topVerses = Math.max(0, ...stats.map((s) => s.verses));
      return {
        classId: c.id,
        name: c.name,
        toppers: results.flatMap((r, i) =>
          (r.results.find((x) => x.classId === c.id)?.rows ?? []).filter((row) => row.rank !== null && row.rank <= 3).map((row) => ({ exam: exams[i].name, rank: row.rank!, name: row.name, marks: row.marks!, maxMarks: exams[i].maxMarks })),
        ),
        // Full attendance, or the best in the class when nobody came every week (at least 75%).
        attendance: sessions.length ? stats.filter((s) => s.present === best && best >= Math.ceil(sessions.length * 0.75)).map((s) => ({ name: s.name, present: s.present, of: sessions.length })) : [],
        verses: topVerses ? stats.filter((s) => s.verses === topVerses).map((s) => ({ name: s.name, verses: s.verses })) : [],
      };
    }),
  };
}

/** Sunday school runs on the calendar year in most Indian churches, ending with exams and annual day in December. */
function yearRange(ctx: Ctx, q: Record<string, string | undefined>) {
  const y = localDate(ctx, ctx.now).slice(0, 4);
  return { from: dateOr(q.from, `${y}-01-01`), to: dateOr(q.to, `${y}-12-31`) };
}

function lessonInput(ctx: Ctx, b: Record<string, unknown>): Partial<SsLesson> {
  const out: Partial<SsLesson> = {};
  if (b.classId !== undefined) out.classId = b.classId ? find(ctx, 'ssClasses', String(b.classId), 'Class').id : null;
  if (b.date !== undefined) {
    if (!DATE_RE.test(String(b.date))) throw new ApiError(422, 'validation_failed', 'Pick the Sunday for this lesson.', { date: 'Required' });
    out.date = String(b.date);
  }
  for (const k of ['title', 'scripture', 'memoryVerse', 'notes'] as const) if (b[k] !== undefined) out[k] = String(b[k] ?? '').trim().slice(0, k === 'notes' ? 4000 : 400);
  if (out.title === '') throw new ApiError(422, 'validation_failed', 'Give the lesson a title.', { title: 'Required' });
  return out;
}

export function registerSundaySchool(r: Router) {
  r.get('/admin/sunday-school', { perm: PERM }, (ctx): SsOverview => {
    const sunday = lastSunday(ctx);
    const cls = classes(ctx);
    const today = localDate(ctx, ctx.now);
    return {
      sunday,
      classes: cls.map((c) => classView(ctx, c)),
      students: cls.reduce((n, c) => n + c.studentIds.length, 0),
      teachers: new Set(cls.flatMap((c) => c.teacherIds)).size,
      markedThisSunday: cls.filter((c) => ctx.db.get('ssAttendance', `${c.id}:${sunday}`)).length,
      unassigned: unassigned(ctx),
      nextLesson: ctx.db.all('ssLessons').filter((l) => l.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0] ?? null,
    };
  });

  r.post('/admin/sunday-school/setup', { perm: PERM }, (ctx) => {
    if (ctx.db.all('ssClasses').length) throw new ApiError(409, 'invalid_state', 'Your classes are already set up.');
    const rooms = ctx.db.all('rooms');
    DEFAULT_CLASSES.forEach(([name, minAge, maxAge], i) => {
      const room = rooms.find((rm) => minAge >= rm.minAge && maxAge <= rm.maxAge) ?? null;
      ctx.db.put('ssClasses', { id: ctx.id('ssc'), name, minAge, maxAge, roomId: room?.id ?? null, teacherIds: [], studentIds: [], order: i, createdAt: ctx.now.toISOString() });
    });
    return { placed: enrollByAge(ctx), classes: classes(ctx).map((c) => classView(ctx, c)) };
  });

  r.post('/admin/sunday-school/enroll', { perm: PERM }, (ctx) => ({ placed: enrollByAge(ctx) }));

  // A new year: every child moves to the class for their age now, and those too old for the senior class finish.
  r.post('/admin/sunday-school/promote', { perm: PERM }, (ctx) => {
    const cls = classes(ctx);
    const top = Math.max(0, ...cls.map((c) => c.maxAge));
    const next = new Map(cls.map((c) => [c.id, [] as string[]]));
    let moved = 0;
    const graduated: string[] = [];
    for (const c of cls)
      for (const id of c.studentIds) {
        const a = age(ctx.db.get('people', id)?.birthDate, ctx.now);
        const to = classForAge(cls, a);
        if (to) {
          next.get(to.id)!.push(id);
          if (to.id !== c.id) moved++;
        } else if (a !== null && a > top) graduated.push(id);
        else next.get(c.id)!.push(id);
      }
    for (const c of cls) ctx.db.put('ssClasses', { ...c, studentIds: next.get(c.id)! });
    return { moved, graduated: people(ctx, graduated) };
  });

  r.post('/admin/sunday-school/classes', { perm: PERM }, (ctx) => {
    requireFields(ctx.body, ['name']);
    const c: SsClass = { id: ctx.id('ssc'), name: '', minAge: 0, maxAge: 0, roomId: null, teacherIds: [], studentIds: [], order: classes(ctx).length, createdAt: ctx.now.toISOString(), ...classInput(ctx, ctx.body) };
    ctx.db.put('ssClasses', c);
    claimStudents(ctx, c);
    return classDetail(ctx, c);
  });
  r.get('/admin/sunday-school/classes/:id', { perm: PERM }, (ctx) => classDetail(ctx, find(ctx, 'ssClasses', ctx.params[0], 'Class')));
  r.patch('/admin/sunday-school/classes/:id', { perm: PERM }, (ctx) => {
    const prev = find(ctx, 'ssClasses', ctx.params[0], 'Class');
    const c = { ...prev, ...classInput(ctx, ctx.body, prev) };
    ctx.db.put('ssClasses', c);
    claimStudents(ctx, c);
    return classDetail(ctx, c);
  });
  r.del('/admin/sunday-school/classes/:id', { perm: PERM }, (ctx) => {
    const c = find(ctx, 'ssClasses', ctx.params[0], 'Class');
    for (const a of sessionsOf(ctx, c.id)) ctx.db.del('ssAttendance', a.id);
    ctx.db.del('ssClasses', c.id);
    return { ok: true };
  });

  r.get('/admin/sunday-school/classes/:id/register', { perm: PERM }, (ctx) => register(ctx, find(ctx, 'ssClasses', ctx.params[0], 'Class'), dateOr(ctx.query.date, lastSunday(ctx))));
  r.put('/admin/sunday-school/classes/:id/register', { perm: PERM }, (ctx) => {
    const c = find(ctx, 'ssClasses', ctx.params[0], 'Class');
    const date = dateOr(ctx.body.date, lastSunday(ctx));
    if (date > localDate(ctx, ctx.now)) throw new ApiError(422, 'validation_failed', 'You can only mark a Sunday that has happened.', { date: 'In the future' });
    const ids = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(String))].filter((id) => c.studentIds.includes(id)) : []);
    const present = ids(ctx.body.present);
    ctx.db.put('ssAttendance', {
      id: `${c.id}:${date}`,
      classId: c.id,
      date,
      present,
      verse: ids(ctx.body.verse).filter((id) => present.includes(id)),
      visitors: Math.max(0, Math.round(Number(ctx.body.visitors) || 0)),
      offering: Math.max(0, Math.round(Number(ctx.body.offering) || 0)),
      markedBy: ctx.staff?.name ?? '',
      markedAt: ctx.now.toISOString(),
    });
    return register(ctx, c, date);
  });

  r.get('/admin/sunday-school/lessons', { perm: PERM }, (ctx) => {
    const today = localDate(ctx, ctx.now);
    const all = ctx.db.all('ssLessons');
    return [...all.filter((l) => l.date >= today).sort((a, b) => a.date.localeCompare(b.date)), ...all.filter((l) => l.date < today).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20)];
  });
  r.post('/admin/sunday-school/lessons', { perm: PERM }, (ctx) => {
    requireFields(ctx.body, ['title', 'date']);
    const l: SsLesson = { id: ctx.id('ssl'), classId: null, date: '', title: '', scripture: '', memoryVerse: '', notes: '', ...lessonInput(ctx, ctx.body) };
    return ctx.db.put('ssLessons', l);
  });
  r.patch('/admin/sunday-school/lessons/:id', { perm: PERM }, (ctx) => {
    const l = find(ctx, 'ssLessons', ctx.params[0], 'Lesson');
    return ctx.db.put('ssLessons', { ...l, ...lessonInput(ctx, ctx.body) });
  });
  r.del('/admin/sunday-school/lessons/:id', { perm: PERM }, (ctx) => {
    ctx.db.del('ssLessons', find(ctx, 'ssLessons', ctx.params[0], 'Lesson').id);
    return { ok: true };
  });

  r.get('/admin/sunday-school/exams', { perm: PERM }, (ctx) => ctx.db.all('ssExams').sort((a, b) => b.date.localeCompare(a.date)).map((e) => examView(ctx, e)));
  r.post('/admin/sunday-school/exams', { perm: PERM }, (ctx) => {
    requireFields(ctx.body, ['name']);
    const maxMarks = Math.round(Number(ctx.body.maxMarks) || 100);
    if (maxMarks < 1 || maxMarks > 1000) throw new ApiError(422, 'validation_failed', 'Maximum marks must be between 1 and 1000.', { maxMarks: 'Out of range' });
    const ids = Array.isArray(ctx.body.classIds) && ctx.body.classIds.length ? (ctx.body.classIds as unknown[]).map(String).filter((id) => ctx.db.get('ssClasses', id)) : classes(ctx).map((c) => c.id);
    const e: SsExam = { id: ctx.id('sse'), name: String(ctx.body.name).trim().slice(0, 80), date: dateOr(ctx.body.date, localDate(ctx, ctx.now)), maxMarks, classIds: ids, status: 'open', createdAt: ctx.now.toISOString() };
    ctx.db.put('ssExams', e);
    return examResults(ctx, e);
  });
  r.get('/admin/sunday-school/exams/:id', { perm: PERM }, (ctx) => examResults(ctx, find(ctx, 'ssExams', ctx.params[0], 'Exam')));
  r.patch('/admin/sunday-school/exams/:id', { perm: PERM }, (ctx) => {
    const e = find(ctx, 'ssExams', ctx.params[0], 'Exam');
    const next = { ...e };
    if (ctx.body.name !== undefined) next.name = String(ctx.body.name).trim().slice(0, 80) || e.name;
    if (ctx.body.date !== undefined) next.date = dateOr(ctx.body.date, e.date);
    if (ctx.body.maxMarks !== undefined) {
      const max = Math.round(Number(ctx.body.maxMarks) || 0);
      const top = Math.max(0, ...ctx.db.all('ssMarks').filter((m) => m.examId === e.id).map((m) => m.marks ?? 0));
      if (max < 1 || max < top) throw new ApiError(422, 'validation_failed', `Maximum marks can't be below the highest mark entered (${top}).`, { maxMarks: 'Too low' });
      next.maxMarks = max;
    }
    if (ctx.body.status === 'open' || ctx.body.status === 'published') next.status = ctx.body.status;
    ctx.db.put('ssExams', next);
    return examResults(ctx, next);
  });
  r.del('/admin/sunday-school/exams/:id', { perm: PERM }, (ctx) => {
    const e = find(ctx, 'ssExams', ctx.params[0], 'Exam');
    for (const m of ctx.db.all('ssMarks').filter((x) => x.examId === e.id)) ctx.db.del('ssMarks', m.id);
    ctx.db.del('ssExams', e.id);
    return { ok: true };
  });
  // Marks for one class: { classId, marks: { personId: number | null } }. A blank leaves the child out; null marks them absent.
  r.put('/admin/sunday-school/exams/:id/marks', { perm: PERM }, (ctx) => {
    const e = find(ctx, 'ssExams', ctx.params[0], 'Exam');
    const c = find(ctx, 'ssClasses', String(ctx.body.classId ?? ''), 'Class');
    if (!e.classIds.includes(c.id)) throw new ApiError(422, 'validation_failed', `${c.name} is not sitting this exam.`);
    const marks = (ctx.body.marks ?? {}) as Record<string, unknown>;
    const errors: Record<string, string> = {};
    for (const [pid, v] of Object.entries(marks)) {
      if (!c.studentIds.includes(pid)) continue;
      const id = `${e.id}:${pid}`;
      if (v === '' || v === undefined) {
        ctx.db.del('ssMarks', id);
        continue;
      }
      const n = v === null || v === 'AB' ? null : Number(v);
      if (n !== null && (!Number.isFinite(n) || n < 0 || n > e.maxMarks)) {
        errors[pid] = `Between 0 and ${e.maxMarks}`;
        continue;
      }
      ctx.db.put('ssMarks', { id, examId: e.id, personId: pid, classId: c.id, marks: n === null ? null : Math.round(n * 2) / 2 });
    }
    if (Object.keys(errors).length) throw new ApiError(422, 'validation_failed', `Some marks are not between 0 and ${e.maxMarks}.`, errors);
    return examResults(ctx, e);
  });
  // Each child's result to their parents, on WhatsApp (or SMS when only SMS is set up).
  r.post('/admin/sunday-school/exams/:id/send', { perm: PERM }, async (ctx) => {
    const e = find(ctx, 'ssExams', ctx.params[0], 'Exam');
    if (e.status !== 'published') throw new ApiError(409, 'invalid_state', 'Publish the results before sending them to parents.');
    const st = channelStatus(ctx);
    const channel = st.whatsapp.configured || !st.sms.configured ? 'whatsapp' : 'sms';
    const church = settings(ctx).name;
    const batch: { to: string; name: string; subject: string; text: string }[] = [];
    const noParent: string[] = [];
    for (const cls of examResults(ctx, e).results)
      for (const row of cls.rows) {
        if (row.marks === null && !row.absent) continue; // not marked yet
        const parents = parentsOf(ctx, row.id);
        if (!parents.length) {
          noParent.push(row.name);
          continue;
        }
        const first = row.name.split(' ')[0];
        const result = row.marks === null ? `${first} was absent for the exam.` : `${first} scored ${row.marks} out of ${e.maxMarks} (${row.grade})${row.rank && row.rank <= 3 ? `, rank ${row.rank} in ${cls.name}` : ` in ${cls.name}`}. Well done!`;
        for (const p of parents) batch.push({ to: p.phone!, name: fullName(p), subject: e.name, text: `${church} Sunday school, ${e.name}: ${result}` });
      }
    const results = batch.length ? await deliverAll(ctx, channel, batch) : [];
    return { channel, sent: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length, noParent };
  });

  r.get('/admin/sunday-school/prizes', { perm: PERM }, (ctx) => {
    const { from, to } = yearRange(ctx, ctx.query);
    return prizes(ctx, from, to);
  });

  // Parents see their children; an older child signed in sees their own.
  r.get('/me/sunday-school', {}, (ctx): MemberSundaySchool => {
    const me = find(ctx, 'people', ctx.me(), 'Profile');
    const household = me.householdName ? ctx.db.all('people').filter((p) => p.householdName === me.householdName) : [me];
    const cls = classes(ctx);
    const exams = ctx.db.all('ssExams').filter((e) => e.status === 'published').sort((a, b) => b.date.localeCompare(a.date));
    const marks = ctx.db.all('ssMarks');
    const sunday = lastSunday(ctx);
    const children = household
      .map((p) => ({ p, c: cls.find((c) => c.studentIds.includes(p.id)) }))
      .filter((x): x is { p: Collections['people']; c: SsClass } => !!x.c)
      .map(({ p, c }) => {
        const stats = studentStats(sessionsOf(ctx, c.id).slice(0, 13), p.id);
        return {
          id: p.id,
          name: fullName(p),
          className: c.name,
          teachers: people(ctx, c.teacherIds).map((t) => t.name),
          attendance: { present: stats.present, of: stats.of, percent: stats.percent },
          verses: stats.verses,
          lesson: lessonFor(ctx, c.id, addDays(sunday, 7)) ?? lessonFor(ctx, c.id, sunday),
          results: exams
            .filter((e) => marks.some((m) => m.examId === e.id && m.personId === p.id))
            .slice(0, 4)
            .map((e) => {
              const row = examResults(ctx, e).results.flatMap((x) => x.rows).find((x) => x.id === p.id)!;
              return { exam: e.name, date: e.date, marks: row.marks, maxMarks: e.maxMarks, grade: row.grade, rank: row.rank };
            }),
        };
      });
    return { children };
  });
}
