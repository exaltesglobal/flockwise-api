// Sunday school: classes by age, the register from check-ins, exams with ranks, prizes and promotion.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const env = createDemoEnv({ webUrl: 'https://app.example' });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(email: string, audience: 'admin' | 'member' = 'admin') {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown, query?: Record<string, string>) => engine.handle({ method, path, body, auth, query }) as Promise<any>;

test('classes, the register and exam results', async () => {
  const a = await signIn('pastor@gracechurch.in');
  const ov = await call(a, 'GET', '/admin/sunday-school');
  assert.equal(ov.classes.length, 5);
  assert.ok(ov.students > 0, `students ${ov.students}`);
  assert.ok(ov.classes.every((c: any) => c.attendance === null || (c.attendance >= 0 && c.attendance <= 100)));
  await assert.rejects(call(a, 'POST', '/admin/sunday-school/setup'), /already set up/);

  const cls = ov.classes.find((c: any) => c.students >= 2);
  const detail = await call(a, 'GET', `/admin/sunday-school/classes/${cls.id}`);
  assert.equal(detail.sessions.length, 10);
  assert.equal(detail.roster.length, cls.students);

  // The register for a past Sunday, saved with two children and one verse.
  const reg = await call(a, 'GET', `/admin/sunday-school/classes/${cls.id}/register`);
  assert.equal(reg.date, ov.sunday);
  const [k1, k2] = reg.students;
  const saved = await call(a, 'PUT', `/admin/sunday-school/classes/${cls.id}/register`, { date: reg.date, present: [k1.id, k2.id, 'p_stranger'], verse: [k1.id, 'nobody'], visitors: 2, offering: 5000 });
  assert.ok(saved.saved);
  assert.deepEqual(saved.students.filter((s: any) => s.present).map((s: any) => s.id).sort(), [k1.id, k2.id].sort());
  assert.deepEqual(saved.students.filter((s: any) => s.verse).map((s: any) => s.id), [k1.id]);
  await assert.rejects(call(a, 'PUT', `/admin/sunday-school/classes/${cls.id}/register`, { date: '2999-01-03', present: [] }), /has happened/);

  // A child moved to another class leaves the first one.
  const other = ov.classes.find((c: any) => c.id !== cls.id);
  const moved = await call(a, 'PATCH', `/admin/sunday-school/classes/${other.id}`, { studentIds: [...(await call(a, 'GET', `/admin/sunday-school/classes/${other.id}`)).roster.map((r: any) => r.id), k2.id] });
  assert.ok(moved.roster.some((r: any) => r.id === k2.id));
  assert.ok(!(await call(a, 'GET', `/admin/sunday-school/classes/${cls.id}`)).roster.some((r: any) => r.id === k2.id));
  await call(a, 'PATCH', `/admin/sunday-school/classes/${cls.id}`, { studentIds: [...detail.roster.map((r: any) => r.id)] });

  // Exam: marks, ties share a rank, the next one skips.
  const ex = await call(a, 'POST', '/admin/sunday-school/exams', { name: 'Quiz', maxMarks: 50, classIds: [cls.id] });
  const ids = detail.roster.map((r: any) => r.id);
  const marks: Record<string, number | null> = {};
  ids.forEach((id: string, i: number) => (marks[id] = i < 2 ? 45 : i === 2 ? 30 : null));
  const res = await call(a, 'PUT', `/admin/sunday-school/exams/${ex.id}/marks`, { classId: cls.id, marks });
  const rows = res.results[0].rows;
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[1].rank, 1);
  assert.equal(rows[0].grade, 'A+');
  if (ids.length > 2) assert.equal(rows[2].rank, 3);
  if (ids.length > 3) assert.equal(rows.at(-1).marks, null);
  await assert.rejects(call(a, 'PUT', `/admin/sunday-school/exams/${ex.id}/marks`, { classId: cls.id, marks: { [ids[0]]: 51 } }), /between 0 and 50/);
  await assert.rejects(call(a, 'PATCH', `/admin/sunday-school/exams/${ex.id}`, { maxMarks: 40 }), /below the highest/);
  await assert.rejects(call(a, 'POST', `/admin/sunday-school/exams/${ex.id}/send`), /Publish/);
  await call(a, 'PATCH', `/admin/sunday-school/exams/${ex.id}`, { status: 'published' });
  const before = env.outbox.length;
  const sent = await call(a, 'POST', `/admin/sunday-school/exams/${ex.id}/send`);
  assert.equal(env.outbox.length - before, sent.sent);
  assert.ok(sent.sent + sent.noParent.length > 0);
  // Only this class's marked children: everyone else is skipped, not told they were absent.
  const marked = ids.filter((id: string) => marks[id] !== undefined);
  const parentPhones = marked.flatMap((id: string) => { const k = db.get('people', id)!; return db.all('people').filter((p) => k.householdName && p.householdName === k.householdName && p.id !== id && p.phone && (new Date().getUTCFullYear() - Number((p.birthDate ?? '1980').slice(0, 4))) >= 18); });
  assert.equal(sent.sent, parentPhones.length);

  const prizes = await call(a, 'GET', '/admin/sunday-school/prizes', undefined, { from: '2000-01-01', to: '2999-12-31' });
  const pc = prizes.classes.find((c: any) => c.classId === cls.id);
  assert.ok(pc.toppers.some((t: any) => t.exam === 'Quiz' && t.rank === 1));
});

test('parents see their children, and a new year promotes by age', async () => {
  const a = await signIn('pastor@gracechurch.in');
  const kid = db.all('ssClasses').flatMap((c) => c.studentIds.map((id) => db.get('people', id)!)).find((p) => p.householdName && db.all('people').some((x) => x.householdName === p.householdName && x.email && x.id !== p.id && !db.all('ssClasses').some((c) => c.studentIds.includes(x.id))));
  assert.ok(kid);
  const parent = db.all('people').find((x) => x.householdName === kid!.householdName && x.email && x.id !== kid!.id)!;
  const m = await signIn(parent.email!, 'member');
  const mine = await call(m, 'GET', '/me/sunday-school');
  const child = mine.children.find((c: any) => c.id === kid!.id);
  assert.ok(child.className);
  assert.ok(child.attendance.of >= 10);
  assert.ok(child.lesson?.memoryVerse);

  // Make a Beginners child old enough for Primary, and a Senior child too old.
  const [beginners, primary, , , senior] = db.all('ssClasses').sort((x, y) => x.order - y.order);
  const grow = db.get('people', beginners.studentIds[0])!;
  db.put('people', { ...grow, birthDate: `${new Date().getUTCFullYear() - 7}-01-01` });
  const out = db.get('people', senior.studentIds[0] ?? beginners.studentIds[1])!;
  db.put('people', { ...out, birthDate: `${new Date().getUTCFullYear() - 19}-01-01` });
  const res = await call(a, 'POST', '/admin/sunday-school/promote');
  assert.ok(res.moved >= 1);
  assert.ok(res.graduated.some((g: any) => g.id === out.id));
  assert.ok(db.get('ssClasses', primary.id)!.studentIds.includes(grow.id));
});
