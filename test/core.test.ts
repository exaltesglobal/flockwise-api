// Exercises the shared church engine end to end in demo mode.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const env = createDemoEnv();
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(audience: 'admin' | 'member', email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return { session: s, claims: JSON.parse(atob(s.accessToken.slice(5))) };
}
const call = (auth: any, method: string, path: string, body?: unknown, query?: Record<string, string>) => engine.handle({ method, path, body, auth, query }) as Promise<any>;

test('email-only sign in', async () => {
  await assert.rejects(call(null, 'POST', '/auth/otp/request', { identifier: '+919876543210' }), /email/i);
  const { session } = await signIn('admin', 'pastor@gracechurch.in');
  assert.equal(session.staff.role, 'owner');
  const m = await signIn('member', 'priya@example.com');
  assert.equal(m.session.member.firstName, 'Priya');
  assert.equal(m.session.staff, null);
  const refreshed = await call(null, 'POST', '/auth/refresh', { refreshToken: m.session.refreshToken });
  assert.ok(refreshed.accessToken);
  await assert.rejects(call(null, 'POST', '/auth/refresh', { refreshToken: m.session.refreshToken }), /sign in/);
});

test('members cannot use admin routes; roles are enforced', async () => {
  const m = await signIn('member', 'priya@example.com');
  await assert.rejects(call(m.claims, 'GET', '/admin/people'), /staff/);
  const fin = await signIn('admin', 'accounts@gracechurch.in');
  await call(fin.claims, 'GET', '/admin/giving/donations');
  await assert.rejects(call(fin.claims, 'GET', '/admin/care'), /role/);
  const pastor = await signIn('admin', 'mercy@gracechurch.in');
  await assert.rejects(call(pastor.claims, 'GET', '/admin/giving/donations'), /role/);
});

test('dashboard, insights and every list load', async () => {
  const a = (await signIn('admin', 'pastor@gracechurch.in')).claims;
  const d = await call(a, 'GET', '/admin/dashboard');
  assert.ok(d.people.total > 100);
  assert.ok(d.attendance.trend.length > 5);
  assert.ok(d.giving.trend.some((t: any) => t.amount > 0));
  const ins = await call(a, 'GET', '/admin/insights');
  assert.ok(ins.engagement.total > 0);
  for (const p of ['/admin/people', '/admin/events', '/admin/groups', '/admin/giving/funds', '/admin/giving/pledges', '/admin/announcements', '/admin/staff', '/admin/audit', '/admin/care', '/admin/care/at-risk', '/admin/prayer', '/admin/messages', '/admin/messages/templates', '/admin/messages/automations', '/admin/volunteers/teams', '/admin/volunteers/overview', '/admin/services', '/admin/songs', '/admin/checkin/events', '/admin/checkin/rooms', '/admin/campuses', '/admin/people-duplicates'])
    await call(a, 'GET', p);
});

test('kids check-in gives matching security codes and checkout needs the code', async () => {
  const a = (await signIn('admin', 'pastor@gracechurch.in')).claims;
  const fams = await call(a, 'GET', '/admin/checkin/ev_1/search', undefined, { q: 'Thomas' });
  const thomas = fams.find((f: any) => f.householdName === 'Thomas family');
  assert.ok(thomas);
  const kids = thomas.people.filter((p: any) => p.isChild);
  assert.equal(kids.length, 2);
  const res = await call(a, 'POST', '/admin/checkin/ev_1', { personIds: thomas.people.map((p: any) => p.id) });
  assert.equal(res.checkins.length, 4);
  assert.ok(res.securityCode);
  assert.equal(res.labels.filter((l: any) => l.kind === 'child').length, 2);
  assert.ok(res.labels.filter((l: any) => l.kind !== 'volunteer').every((l: any) => l.securityCode === res.securityCode));
  const joel = res.checkins.find((c: any) => c.personName === 'Joel Thomas');
  assert.equal(joel.allergies, 'Peanuts');
  await assert.rejects(call(a, 'POST', `/admin/checkin/checkins/${joel.id}/checkout`, { securityCode: 'ZZZZ' }), /security code/);
  const out = await call(a, 'POST', `/admin/checkin/checkins/${joel.id}/checkout`, { securityCode: res.securityCode });
  assert.ok(out.checkedOutAt);
  const scan = await call(a, 'POST', '/admin/checkin/ev_1/scan', { code: 'FW1:PRIYA7K2' });
  assert.equal(scan.alreadyCheckedIn, true);
});

test('volunteer scheduling: conflicts, autofill, respond', async () => {
  const a = (await signIn('admin', 'pastor@gracechurch.in')).claims;
  const before = await call(a, 'GET', '/admin/volunteers/schedule/ev_10');
  assert.ok(before.slots.every((s: any) => s.assignments.length === 0));
  const res = await call(a, 'POST', '/admin/volunteers/autofill/ev_10');
  assert.ok(res.added > 5);
  const m = await signIn('member', 'priya@example.com');
  const serving = await call(m.claims, 'GET', '/me/serving');
  const req = serving.assignments.find((x: any) => x.id === 'as_priya');
  assert.equal(req.status, 'pending');
  await call(m.claims, 'POST', '/me/serving/as_priya/respond', { status: 'accepted' });
  const after = await call(m.claims, 'GET', '/me/serving');
  assert.ok(after.assignments.find((x: any) => x.id === 'as_priya').plan.length > 3);
});

test('messaging respects consent and renders merge fields', async () => {
  const a = (await signIn('admin', 'pastor@gracechurch.in')).claims;
  const prev = await call(a, 'POST', '/admin/messages/audience', { channel: 'whatsapp', audience: { type: 'group', ids: ['gr_1'] } });
  assert.ok(prev.total >= prev.reachable);
  env.outbox.length = 0;
  const sent = await call(a, 'POST', '/admin/messages', { channel: 'email', subject: 'Hi {{firstName}}', body: 'Welcome to {{church}}', audience: { type: 'people', ids: ['p_priya'] }, send: true });
  assert.equal(sent.status, 'sent');
  assert.equal(env.outbox[0].subject, 'Hi Priya');
  assert.match(env.outbox[0].text, /Grace Community Church/);
});

test('giving: member gift, pledge progress, statement, 80G', async () => {
  const m = await signIn('member', 'priya@example.com');
  const intent = await call(m.claims, 'POST', '/giving/intents', { fundId: 'fd_building', amount: 250000, currency: 'INR', frequency: 'once', donorCitizenship: 'IN', pan: 'ABCPT1234K' });
  assert.ok(intent.donationId);
  const pledges = await call(m.claims, 'GET', '/giving/pledges');
  assert.equal(pledges[0].given, 1750000);
  const st = await call(m.claims, 'GET', '/giving/statement');
  assert.ok(st.total > 0 && st.eligible80g <= st.total);
  const a = (await signIn('admin', 'accounts@gracechurch.in')).claims;
  const cash = await call(a, 'POST', '/admin/giving/donations', { donorName: 'Walk-in', fundId: 'fd_tithe', amount: 300000, method: 'cash', donorCitizenship: 'IN', donorId: null });
  assert.ok(cash.receiptNumber);
});

test('paid event ticket then RSVP', async () => {
  const m = await signIn('member', 'priya@example.com');
  await assert.rejects(call(m.claims, 'PUT', '/events/ev_5/rsvp', { status: 'going' }), /ticket/);
  await call(m.claims, 'POST', '/events/ev_5/ticket');
  const ev = await call(m.claims, 'GET', '/events/ev_5');
  assert.equal(ev.myRsvp, 'going');
});

test('care: prayer wall and at-risk follow-up', async () => {
  const m = await signIn('member', 'priya@example.com');
  const p = await call(m.claims, 'POST', '/prayer', { text: 'Pray for exams', visibility: 'church' });
  const prayed = await call(m.claims, 'POST', `/prayer/${p.id}/pray`);
  assert.equal(prayed.prayedCount, 1);
  const a = (await signIn('admin', 'pastor@gracechurch.in')).claims;
  const risk = await call(a, 'GET', '/admin/care/at-risk');
  assert.ok(risk.length > 0);
  const c = await call(a, 'POST', '/admin/care', { personId: risk[0].id, type: 'absent', title: 'Call', priority: 'normal', assignedTo: 'st_4', dueAt: null, confidential: false });
  const noted = await call(a, 'POST', `/admin/care/${c.id}/notes`, { text: 'Called, all ok' });
  assert.equal(noted.status, 'in_progress');
});

test('automations run once per day', async () => {
  const tick = async () => engine.tick();
  await tick();
  const n = db.count('messages');
  await tick();
  assert.equal(db.count('messages'), n);
});
