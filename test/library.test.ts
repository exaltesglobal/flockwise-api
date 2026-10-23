// Church library: catalogue, requests from the app, lending with due dates, renewals, returns and reminders.
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

test('a member asks for a book, borrows it, is reminded, renews and returns it', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  let h = await call(owner, 'POST', '/admin/library/books', { books: [{ title: 'Mere Christianity', author: 'C. S. Lewis', category: 'Apologetics', copies: 1 }, { title: 'The Pilgrim’s Progress', author: 'John Bunyan', language: 'Telugu', copies: 2 }] });
  assert.equal(h.counts.titles, 2);
  assert.equal(h.counts.copies, 3);
  await fails(call(owner, 'POST', '/admin/library/books', { title: '' }), 422);
  h = await call(owner, 'PATCH', '/admin/library/settings', { loanDays: 14 });
  assert.equal(h.settings.loanDays, 14);
  const lewis = h.books.find((b: any) => b.author === 'C. S. Lewis');

  const priya = await signIn('member', 'priya@example.com');
  await call(priya, 'POST', '/me/devices', { token: 'ExponentPushToken[priya-phone]', platform: 'android', app: 'member' });
  let my = await call(priya, 'GET', '/me/library');
  assert.equal(my.books.length, 2);
  my = await call(priya, 'POST', `/me/library/${lewis.id}/request`);
  assert.equal(my.books.find((b: any) => b.id === lewis.id).mine, 'requested');
  h = await call(owner, 'GET', '/admin/library');
  assert.equal(h.counts.requests, 1);

  // Handed over: out for 14 days; the only copy is now unavailable to someone else.
  h = await call(owner, 'POST', `/admin/library/loans/${h.requests[0].id}/issue`);
  assert.equal(h.loans.length, 1);
  assert.equal(h.loans[0].dueOn, '2026-11-06');
  assert.equal(h.books.find((b: any) => b.id === lewis.id).available, 0);
  const other = db.all('people').find((p) => p.email !== 'priya@example.com')!;
  await fails(call(owner, 'POST', '/admin/library/loans', { bookId: lewis.id, personId: other.id }), 409);
  await fails(call(owner, 'DELETE', `/admin/library/books/${lewis.id}`), 409);

  // Day before: one reminder; after the due date: one overdue reminder.
  clock = Date.parse('2026-11-05T05:00:00.000Z');
  let at = env.outbox.length;
  await engine.tick(); await engine.tick();
  assert.equal(pushes(at, /due back tomorrow/).length, 1);
  clock = Date.parse('2026-11-08T05:00:00.000Z');
  at = env.outbox.length;
  await engine.tick(); await engine.tick();
  assert.equal(pushes(at, /was due back on 2026-11-06/).length, 1);
  h = await call(owner, 'GET', '/admin/library');
  assert.equal(h.counts.overdue, 1);
  assert.equal((await call(priya, 'GET', '/me/library')).loans[0].overdue, true);

  // Renew from today, then return.
  h = await call(owner, 'POST', `/admin/library/loans/${h.loans[0].id}/renew`);
  assert.equal(h.loans[0].dueOn, '2026-11-22');
  assert.equal(h.counts.overdue, 0);
  h = await call(owner, 'POST', `/admin/library/loans/${h.loans[0].id}/return`);
  assert.equal(h.loans.length, 0);
  assert.equal(h.books.find((b: any) => b.id === lewis.id).timesBorrowed, 1);
  assert.equal((await call(priya, 'GET', '/me/library')).loans.length, 0);

  // A request can be withdrawn by the member.
  my = await call(priya, 'POST', `/me/library/${lewis.id}/request`);
  my = await call(priya, 'DELETE', `/me/library/${lewis.id}/request`);
  assert.equal(my.books.find((b: any) => b.id === lewis.id).mine, null);
});
