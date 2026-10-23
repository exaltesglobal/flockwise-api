// Skills and helping hands: profiles, directory, board posts and moderation.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

let clock = Date.parse('2026-10-23T05:00:00.000Z');
const env = createDemoEnv({ now: () => new Date(clock) });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(audience: 'admin' | 'member', email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown) => engine.handle({ method, path, body, auth, query: {} }) as Promise<any>;
const fails = async (p: Promise<unknown>, status: number) => { const e: any = await p.then(() => null, (err) => err); assert.ok(e, `expected ${status}`); assert.equal(e.status, status, e.message); };
const pushes = (from: number, re: RegExp) => env.outbox.slice(from).filter((o) => o.channel === 'push' && re.test(`${o.subject} ${o.text}`));

test('members share skills, the office finds volunteers, and the board carries jobs and needs', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const priya = await signIn('member', 'priya@example.com');
  let my = await call(priya, 'GET', '/me/skills');
  assert.equal(my.mine, null);
  assert.ok(my.suggestions.includes('Electrician'));
  my = await call(priya, 'PUT', '/me/skills', { skills: ['electrician', ' Tabla ', 'Electrician', 'Telugu  typing'], note: 'Weekends only', serve: true, share: true });
  assert.deepEqual(my.mine.skills, ['Electrician', 'Tabla', 'Telugu typing']);

  let h = await call(owner, 'GET', '/admin/skills');
  assert.equal(h.counts.people, 1);
  assert.equal(h.counts.willingToServe, 1);
  assert.equal(h.skills.find((s: any) => s.skill === 'Tabla').count, 1);
  const rahul = db.all('people').find((p) => p.firstName === 'Rahul')!;
  h = await call(owner, 'PATCH', `/admin/skills/${rahul.id}`, { skills: 'Doctor, tabla', share: false });
  assert.equal(h.counts.people, 2);
  assert.equal(h.skills.find((s: any) => s.skill === 'Tabla').count, 2);

  // Rahul did not choose to share, so members do not see him; Priya sees nobody but herself is excluded.
  my = await call(priya, 'GET', '/me/skills');
  assert.equal(my.directory.length, 0);

  // Board: post, limit of three, close, and office moderation.
  await fails(call(priya, 'POST', '/me/board', { kind: 'job', title: '' }), 422);
  my = await call(priya, 'POST', '/me/board', { kind: 'job', title: 'Accounts assistant at my office', body: 'Tally, 2 years experience', place: 'Begumpet' });
  my = await call(priya, 'POST', '/me/board', { kind: 'need', title: 'Maths tutor for class 8' });
  my = await call(priya, 'POST', '/me/board', { kind: 'offer', title: 'Free baby clothes' });
  await fails(call(priya, 'POST', '/me/board', { kind: 'need', title: 'One too many' }), 409);
  const tutor = my.posts.find((p: any) => /tutor/.test(p.title));
  assert.equal(tutor.mine, true);
  assert.ok(tutor.phone);
  my = await call(priya, 'POST', `/me/board/${tutor.id}/close`);
  assert.equal(my.posts.find((p: any) => p.id === tutor.id).status, 'closed');
  h = await call(owner, 'GET', '/admin/skills');
  assert.equal(h.counts.openPosts, 2);
  const baby = h.posts.find((p: any) => /baby/.test(p.title));
  h = await call(owner, 'POST', `/admin/board/${baby.id}/hide`);
  assert.equal(h.counts.openPosts, 1);
  my = await call(priya, 'GET', '/me/skills');
  assert.equal(my.posts.some((p: any) => p.id === baby.id), false);

  // Posts expire after 30 days.
  clock += 31 * 86_400_000;
  h = await call(owner, 'GET', '/admin/skills');
  assert.equal(h.counts.openPosts, 0);
});
