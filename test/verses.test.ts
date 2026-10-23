// Kids' memory verse game: three rounds in the parent's app scored on the server, the teacher's
// register tick, a class leaderboard that resets each Sunday, and the Monday push to parents.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { accuracyOf, puzzleOf, splitVerse } from '../src/core/modules/verses.js';
import { seedDemo } from '../src/core/seed.js';

let clock = Date.parse('2026-11-02T05:00:00.000Z'); // Monday, 10:30 am IST; the verse was taught Sunday 1 Nov
const env = createDemoEnv({ now: () => new Date(clock) });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(audience: 'admin' | 'member', email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown) => { const [p, qs] = path.split('?'); return engine.handle({ method, path: p, body, auth, query: qs ? Object.fromEntries(new URLSearchParams(qs)) : {} }) as Promise<any>; };
const fails = async (p: Promise<unknown>, status: number, code?: string) => { const e: any = await p.then(() => null, (err) => err); assert.ok(e, `expected ${status}`); assert.equal(e.status, status, e.message); if (code) assert.equal(e.code, code); };

test('verse text helpers', () => {
  assert.deepEqual(splitVerse('Be kind and compassionate to one another, forgiving each other. Ephesians 4:32'), { verse: 'Be kind and compassionate to one another, forgiving each other.', reference: 'Ephesians 4:32' });
  assert.deepEqual(splitVerse('The Lord who rescued me from the paw of the lion will rescue me. 1 Samuel 17:37').reference, '1 Samuel 17:37');
  assert.deepEqual(splitVerse('Jesus wept.'), { verse: 'Jesus wept.', reference: '' });
  const p = puzzleOf('Be kind and compassionate to one another, forgiving each other.', 'seed');
  const missing = p.words.filter((w) => w === null).length;
  assert.ok(missing >= 2 && missing <= 5, `${missing} blanks`);
  assert.ok(p.options.length >= missing, 'chips cover the blanks');
  assert.deepEqual(puzzleOf('Be kind and compassionate to one another, forgiving each other.', 'seed'), p, 'stable for the same game');
  assert.equal(accuracyOf('Be kind and compassionate to one another, forgiving each other.', 'be kind and compassionate to one another forgiving each other'), 100);
  assert.equal(accuracyOf('Be kind and compassionate to one another, forgiving each other.', 'Be kind to one another'), 50);
  assert.equal(accuracyOf('Be kind and compassionate to one another, forgiving each other.', ''), 0);
});

test("a parent plays the week's verse with their child, the class board, the teacher's view, the Monday push", async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const priya = await signIn('member', 'priya@example.com');
  db.del('verseGames', 'p_joel:ssl_1'); // start Joel fresh whatever the demo seed rolled
  const joelClass = db.all('ssClasses').find((c) => c.studentIds.includes('p_joel'))!;
  const reg0 = db.get('ssAttendance', `${joelClass.id}:2026-11-01`)!;
  db.put('ssAttendance', { ...reg0, verse: reg0.verse.filter((id) => id !== 'p_joel') });

  let mine = await call(priya, 'GET', '/me/verses');
  const joel = mine.children.find((c: any) => c.id === 'p_joel');
  const anna = mine.children.find((c: any) => c.id === 'p_anna');
  assert.ok(joel && anna, 'both Thomas children are in a class');
  assert.equal(joel.className, 'Primary'); assert.equal(anna.className, 'Beginners');
  assert.equal(joel.game.verse, 'Be kind and compassionate to one another, forgiving each other.');
  assert.equal(joel.game.reference, 'Ephesians 4:32');
  assert.equal(joel.game.title, 'Joseph forgives his brothers');
  assert.equal(joel.game.week, '2026-11-01');
  assert.equal(joel.game.nextLevel, 'read'); assert.equal(joel.game.points, 0); assert.equal(joel.rank, null);
  assert.ok(joel.game.puzzle.words.includes(null));
  const primary = mine.boards.find((b: any) => b.classId === joel.classId);
  assert.ok(primary && primary.of > 1 && primary.rows.some((r: any) => r.id === 'p_joel' && r.mine));
  assert.ok(primary.rows.every((r: any) => /^[A-Z][a-z]+ [A-Z]\.$/.test(r.name)), 'first name and initial only: ' + primary.rows[0].name);
  assert.ok(primary.players > 0, 'the demo class has started');

  // Rounds go in order, and a stranger's child is not yours.
  await fails(call(priya, 'POST', '/me/verses/p_joel/answer', { level: 'blanks', answers: [] }), 409, 'order');
  await fails(call(priya, 'POST', '/me/verses/p_nobody/answer', { level: 'read' }), 404);
  await fails(call(priya, 'POST', '/me/verses/p_joel/answer', { level: 'skip' }), 422);
  let r = await call(priya, 'POST', '/me/verses/p_joel/answer', { level: 'read' });
  assert.equal(r.ok, true); assert.equal(r.earned, 10); assert.equal(r.game.stars, 1); assert.equal(r.game.nextLevel, 'blanks');
  await fails(call(priya, 'POST', '/me/verses/p_joel/answer', { level: 'read' }), 409, 'done');

  // Blanks: wrong chips score nothing; the right ones in order score 20.
  const words = r.game.verse.split(/\s+/);
  const want = words.filter((_: string, i: number) => r.game.puzzle.words[i] === null);
  r = await call(priya, 'POST', '/me/verses/p_joel/answer', { level: 'blanks', answers: want.map(() => 'banana') });
  assert.equal(r.ok, false); assert.equal(r.earned, 0); assert.match(r.message, /0 of \d right/);
  r = await call(priya, 'POST', '/me/verses/p_joel/answer', { level: 'blanks', answers: want.map((w: string) => w.toUpperCase()) });
  assert.equal(r.ok, true); assert.equal(r.earned, 20); assert.equal(r.game.points, 30); assert.equal(r.game.stars, 2); assert.equal(r.game.nextLevel, 'recite');

  // Recite: half the words is not enough; a near-perfect try earns 30 and the third star.
  r = await call(priya, 'POST', '/me/verses/p_joel/answer', { level: 'recite', text: 'Be kind to one another' });
  assert.equal(r.ok, false); assert.equal(r.accuracy, 50); assert.match(r.message, /try again/i);
  r = await call(priya, 'POST', '/me/verses/p_joel/answer', { level: 'recite', text: 'be kind and compassionate to one another forgiving each other' });
  assert.equal(r.ok, true); assert.equal(r.accuracy, 100); assert.equal(r.earned, 30); assert.equal(r.game.points, 60); assert.equal(r.game.stars, 3); assert.equal(r.game.nextLevel, null);
  assert.equal(db.get('verseGames', 'p_joel:ssl_1')!.attempts, 5);

  // The teacher ticks "said the verse" on Sunday's register: 40 more, top of the class.
  const reg = await call(owner, 'GET', `/admin/sunday-school/classes/${joel.classId}/register?date=2026-11-01`);
  await call(owner, 'PUT', `/admin/sunday-school/classes/${joel.classId}/register`, { date: '2026-11-01', present: [...new Set([...reg.students.filter((s: any) => s.present).map((s: any) => s.id), 'p_joel'])], verse: ['p_joel'] });
  mine = await call(priya, 'GET', '/me/verses');
  const j2 = mine.children.find((c: any) => c.id === 'p_joel');
  assert.equal(j2.game.recitedInClass, true); assert.equal(j2.game.points, 100); assert.equal(j2.rank, 1); assert.equal(j2.totalStars, 3); assert.equal(j2.weeksPlayed, 1);
  const b2 = mine.boards.find((b: any) => b.classId === joel.classId);
  assert.equal(b2.rows[0].id, 'p_joel'); assert.deepEqual(b2.rows[0].levels, ['read', 'blanks', 'recite']);

  // Teachers see full names, every class, and the star table; members cannot.
  await fails(call(priya, 'GET', '/admin/sunday-school/verses'), 403);
  const admin = await call(owner, 'GET', '/admin/sunday-school/verses');
  assert.equal(admin.week, '2026-11-01');
  assert.ok(admin.boards.length >= 2);
  const pb = admin.boards.find((b: any) => b.classId === joel.classId);
  assert.equal(pb.rows[0].name, 'Joel Thomas'); assert.equal(pb.rows[0].points, 100);
  assert.ok(admin.stars.some((s: any) => s.name === 'Joel Thomas' && s.stars === 3 && s.className === 'Primary'));
  assert.equal(admin.stars[0].stars, Math.max(...admin.stars.map((s: any) => s.stars)));

  // Monday morning push to parents with the verse, once.
  await call(priya, 'POST', '/me/devices', { token: 'ExponentPushToken[priya]', platform: 'android', app: 'member' });
  let n = env.outbox.length;
  await engine.tick();
  const pushes = env.outbox.slice(n).filter((o) => o.channel === 'push' && /memory verse this week/.test(o.subject));
  assert.ok(pushes.length >= 1, 'Priya is told');
  assert.ok(pushes.some((o) => /Joel|Anna/.test(o.subject) && /Ephesians 4:32/.test(o.text)), JSON.stringify(pushes[0]));
  n = env.outbox.length;
  clock += 3_600_000;
  await engine.tick();
  assert.equal(env.outbox.slice(n).filter((o) => /memory verse this week/.test(o.subject)).length, 0, 'only once a week');

  // Next Sunday a new verse starts a new board; last week's stars stay in the total.
  clock = Date.parse('2026-11-09T05:00:00.000Z'); // Monday 9 Nov
  mine = await call(priya, 'GET', '/me/verses');
  const j3 = mine.children.find((c: any) => c.id === 'p_joel');
  assert.equal(j3.game.week, '2026-11-08'); assert.equal(j3.game.reference, 'Ruth 1:16'); assert.equal(j3.game.points, 0); assert.equal(j3.totalStars, 3);
});
