// Classes and courses: a baptism class, a membership class, pre-marital counselling, Alpha. Each
// has its sessions, a roster, attendance per session, and completes a person once they have come
// to enough sessions (adding a tag the church chooses). Members can sign up from the app.
import { ApiError } from '../errors.js';
import type { Ctx, Router } from '../engine.js';
import type { Course, CourseDetail, CourseEnrollment, CourseSession, CoursesHub, CourseTemplate, CourseView, MyCourse } from '../types.js';
import { find, fullName } from '../util.js';

const TEMPLATES: Record<Exclude<CourseTemplate, 'custom'>, { name: string; description: string; sessions: string[]; min: number; tag: string }> = {
  baptism: { name: 'Baptism class', description: 'What baptism means, the gospel, repentance and faith, and living as a disciple. For anyone preparing to be baptised.', sessions: ['The good news', 'Repentance and faith', 'What baptism means', 'Walking with Jesus'], min: 3, tag: 'Baptism class done' },
  membership: { name: 'Membership class', description: 'Who we are, what we believe, how the church is run, and how to belong and serve.', sessions: ['Our story and beliefs', 'Life in the church', 'Serving and giving'], min: 3, tag: 'Membership class done' },
  premarital: { name: 'Pre-marital counselling', description: 'Six sessions for engaged couples with the pastor: communication, money, family, faith at home.', sessions: ['God’s design for marriage', 'Communication', 'Money and work', 'Families and in-laws', 'Intimacy and children', 'Faith at home'], min: 5, tag: 'Pre-marital done' },
  alpha: { name: 'Alpha', description: 'Eleven evenings exploring the Christian faith over a meal and conversation.', sessions: ['Is there more to life?', 'Who is Jesus?', 'Why did Jesus die?', 'How can I have faith?', 'Why and how do I pray?', 'Why and how should I read the Bible?', 'How does God guide us?', 'Who is the Holy Spirit?', 'What does the Holy Spirit do?', 'How can I resist evil?', 'Why and how should I tell others?'], min: 8, tag: 'Alpha' },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
const live = (ctx: Ctx, courseId: string) => ctx.db.all('courseEnrollments').filter((e) => e.courseId === courseId && e.status !== 'dropped');

function view(ctx: Ctx, c: Course): CourseView {
  const rows = live(ctx, c.id);
  const today = ctx.now.toISOString().slice(0, 10);
  const nextSession = c.sessions.filter((s) => s.date && s.date.slice(0, 10) >= today).sort((a, b) => a.date!.localeCompare(b.date!))[0] ?? null;
  return { ...c, enrolled: rows.length, completed: rows.filter((e) => e.status === 'completed').length, nextSession };
}

function detail(ctx: Ctx, c: Course): CourseDetail {
  const roster = live(ctx, c.id)
    .map((e) => { const p = ctx.db.get('people', e.personId); return { ...e, name: p ? fullName(p) : 'Removed person', phone: p?.phone ?? null }; })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { ...view(ctx, c), roster };
}

function readSessions(ctx: Ctx, raw: unknown, prev: CourseSession[] = []): CourseSession[] {
  if (!Array.isArray(raw)) return prev;
  const out = raw.slice(0, 40).map((s, i) => {
    const r = (s ?? {}) as Partial<CourseSession>;
    const title = clean(r.title, 100) || `Session ${i + 1}`;
    const date = r.date && DATE_RE.test(String(r.date)) ? String(r.date).slice(0, 16) : null;
    return { id: r.id && prev.some((p) => p.id === r.id) ? r.id : ctx.id('cs'), title, date };
  });
  if (!out.length) throw new ApiError(422, 'invalid', 'A course needs at least one session.', { sessions: 'Add a session' });
  return out;
}

/** Completes (or un-completes) an enrolment from its attendance, adding the course's tag once. */
function settle(ctx: Ctx, c: Course, e: CourseEnrollment): CourseEnrollment {
  if (e.status === 'dropped') return e;
  const valid = e.attended.filter((id) => c.sessions.some((s) => s.id === id));
  const done = valid.length >= Math.min(c.minAttendance, c.sessions.length);
  let next: CourseEnrollment = { ...e, attended: valid };
  if (done && e.status !== 'completed') {
    next = { ...next, status: 'completed', completedAt: ctx.now.toISOString() };
    const p = ctx.db.get('people', e.personId);
    if (p && c.completeTag && !p.tags.includes(c.completeTag)) ctx.db.put('people', { ...p, tags: [...p.tags, c.completeTag] });
    if (p) ctx.audit('completed', 'courses', c.id, `${fullName(p)} completed ${c.name}`);
  } else if (!done && e.status === 'completed') {
    next = { ...next, status: 'enrolled', completedAt: null };
  }
  return ctx.db.put('courseEnrollments', next);
}

function enroll(ctx: Ctx, c: Course, personId: string, via: CourseEnrollment['via']): CourseEnrollment {
  const existing = ctx.db.all('courseEnrollments').find((e) => e.courseId === c.id && e.personId === personId);
  if (existing && existing.status !== 'dropped') return existing;
  if (c.capacity && live(ctx, c.id).length >= c.capacity) throw new ApiError(409, 'full', `${c.name} is full.`);
  if (existing) return ctx.db.put('courseEnrollments', { ...existing, status: 'enrolled', enrolledAt: ctx.now.toISOString(), via });
  return ctx.db.put('courseEnrollments', { id: ctx.id('ce'), courseId: c.id, personId, enrolledAt: ctx.now.toISOString(), attended: [], status: 'enrolled', completedAt: null, via });
}

function mine(ctx: Ctx): { courses: MyCourse[] } {
  const me = ctx.me();
  const courses = ctx.db
    .all('courses')
    .map((c) => {
      const e = ctx.db.all('courseEnrollments').find((x) => x.courseId === c.id && x.personId === me && x.status !== 'dropped');
      if (!e && !(c.openToEnroll && c.status === 'open')) return null;
      return { id: c.id, name: c.name, description: c.description, leaderName: c.leaderName, location: c.location, sessions: c.sessions, minAttendance: c.minAttendance, full: !!c.capacity && live(ctx, c.id).length >= c.capacity, mine: e ? { status: e.status, attended: e.attended.length } : null } satisfies MyCourse;
    })
    .filter((x): x is MyCourse => !!x)
    .sort((a, b) => Number(!!b.mine) - Number(!!a.mine) || a.name.localeCompare(b.name));
  return { courses };
}

export function registerCourses(r: Router) {
  r.get('/admin/courses', { perm: 'people.view' }, (ctx): CoursesHub => ({
    courses: ctx.db.all('courses').sort((a, b) => (a.status === b.status ? b.createdAt.localeCompare(a.createdAt) : a.status === 'open' ? -1 : 1)).map((c) => view(ctx, c)),
    templates: (Object.keys(TEMPLATES) as (keyof typeof TEMPLATES)[]).map((id) => ({ id, name: TEMPLATES[id].name, sessions: TEMPLATES[id].sessions.length, minAttendance: TEMPLATES[id].min })),
  }));

  r.post('/admin/courses', { perm: 'people.edit' }, (ctx) => {
    const b = ctx.body as Record<string, unknown>;
    const template = (['baptism', 'membership', 'premarital', 'alpha'].includes(String(b.template)) ? b.template : 'custom') as CourseTemplate;
    const t = template === 'custom' ? null : TEMPLATES[template];
    const sessions = Array.isArray(b.sessions) && b.sessions.length ? readSessions(ctx, b.sessions) : t ? t.sessions.map((title) => ({ id: ctx.id('cs'), title, date: null })) : readSessions(ctx, Array.isArray(b.sessions) ? b.sessions : []);
    const name = clean(b.name, 80) || t?.name || '';
    if (!name) throw new ApiError(422, 'invalid', 'Give the course a name.', { name: 'Required' });
    const c = ctx.db.put('courses', {
      id: ctx.id('co'),
      name,
      template,
      description: clean(b.description, 600) || t?.description || '',
      leaderName: clean(b.leaderName, 80) || ctx.staff?.name || '',
      location: clean(b.location, 120),
      sessions,
      minAttendance: Math.max(1, Math.min(sessions.length, Math.round(Number(b.minAttendance) || t?.min || sessions.length))),
      openToEnroll: b.openToEnroll !== undefined ? !!b.openToEnroll : true,
      capacity: Number(b.capacity) > 0 ? Math.round(Number(b.capacity)) : null,
      completeTag: b.completeTag !== undefined ? clean(b.completeTag, 40) || null : t?.tag ?? null,
      status: 'open',
      createdAt: ctx.now.toISOString(),
    });
    ctx.audit('created', 'courses', c.id, `Started ${c.name}`);
    return detail(ctx, c);
  });

  r.get('/admin/courses/:id', { perm: 'people.view' }, (ctx) => detail(ctx, find(ctx, 'courses', ctx.params[0], 'Course')));

  r.patch('/admin/courses/:id', { perm: 'people.edit' }, (ctx) => {
    const c = find(ctx, 'courses', ctx.params[0], 'Course');
    const b = ctx.body as Record<string, unknown>;
    const sessions = b.sessions !== undefined ? readSessions(ctx, b.sessions, c.sessions) : c.sessions;
    const next: Course = {
      ...c,
      name: b.name !== undefined ? clean(b.name, 80) || c.name : c.name,
      description: b.description !== undefined ? clean(b.description, 600) : c.description,
      leaderName: b.leaderName !== undefined ? clean(b.leaderName, 80) : c.leaderName,
      location: b.location !== undefined ? clean(b.location, 120) : c.location,
      sessions,
      minAttendance: Math.max(1, Math.min(sessions.length, b.minAttendance !== undefined ? Math.round(Number(b.minAttendance)) || 1 : c.minAttendance)),
      openToEnroll: b.openToEnroll !== undefined ? !!b.openToEnroll : c.openToEnroll,
      capacity: b.capacity !== undefined ? (Number(b.capacity) > 0 ? Math.round(Number(b.capacity)) : null) : c.capacity,
      completeTag: b.completeTag !== undefined ? clean(b.completeTag, 40) || null : c.completeTag,
      status: b.status === 'finished' || b.status === 'open' ? b.status : c.status,
    };
    ctx.db.put('courses', next);
    for (const e of live(ctx, c.id)) settle(ctx, next, e);
    return detail(ctx, next);
  });

  r.post('/admin/courses/:id/enroll', { perm: 'people.edit' }, (ctx) => {
    const c = find(ctx, 'courses', ctx.params[0], 'Course');
    const ids = Array.isArray(ctx.body.personIds) ? (ctx.body.personIds as unknown[]).map(String) : [];
    if (!ids.length) throw new ApiError(422, 'invalid', 'Choose who to add.', { personIds: 'Required' });
    for (const id of ids) { find(ctx, 'people', id, 'Person'); enroll(ctx, c, id, 'office'); }
    ctx.audit('updated', 'courses', c.id, `Added ${ids.length} to ${c.name}`);
    return detail(ctx, c);
  });

  // Attendance for one session: `present` is everyone who came; the rest are marked absent.
  r.post('/admin/courses/:id/attendance', { perm: 'people.edit' }, (ctx) => {
    const c = find(ctx, 'courses', ctx.params[0], 'Course');
    const sessionId = String(ctx.body.sessionId ?? '');
    if (!c.sessions.some((s) => s.id === sessionId)) throw new ApiError(422, 'invalid', 'Choose a session.', { sessionId: 'Required' });
    const present = new Set(Array.isArray(ctx.body.present) ? (ctx.body.present as unknown[]).map(String) : []);
    for (const e of live(ctx, c.id)) {
      const has = e.attended.includes(sessionId);
      const want = present.has(e.personId);
      if (has === want) continue;
      settle(ctx, c, { ...e, attended: want ? [...e.attended, sessionId] : e.attended.filter((x) => x !== sessionId) });
    }
    return detail(ctx, c);
  });

  r.post('/admin/courses/:id/enrollments/:eid/drop', { perm: 'people.edit' }, (ctx) => {
    const c = find(ctx, 'courses', ctx.params[0], 'Course');
    const e = find(ctx, 'courseEnrollments', ctx.params[1], 'Enrolment');
    ctx.db.put('courseEnrollments', { ...e, status: 'dropped' });
    return detail(ctx, c);
  });

  r.post('/admin/courses/:id/enrollments/:eid/complete', { perm: 'people.edit' }, (ctx) => {
    const c = find(ctx, 'courses', ctx.params[0], 'Course');
    const e = find(ctx, 'courseEnrollments', ctx.params[1], 'Enrolment');
    // Marked complete by hand (e.g. a make-up session): counts every session as attended.
    settle(ctx, c, { ...e, attended: c.sessions.map((s) => s.id) });
    return detail(ctx, c);
  });

  r.get('/me/courses', {}, (ctx) => mine(ctx));
  r.post('/me/courses/:id/enroll', {}, (ctx) => {
    const c = find(ctx, 'courses', ctx.params[0], 'Course');
    if (!c.openToEnroll || c.status !== 'open') throw new ApiError(409, 'closed', 'Sign-up for this course is closed. Please ask the church office.');
    enroll(ctx, c, ctx.me(), 'app');
    return mine(ctx);
  });
  r.del('/me/courses/:id', {}, (ctx) => {
    const e = ctx.db.all('courseEnrollments').find((x) => x.courseId === ctx.params[0] && x.personId === ctx.me() && x.status === 'enrolled');
    if (e) ctx.db.put('courseEnrollments', { ...e, status: 'dropped' });
    return mine(ctx);
  });
}
