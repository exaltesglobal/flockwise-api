// Forms, calendar booking, smart lists, workflows, batches, headcounts, live services, groups and the public page.
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
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown, query?: Record<string, string>) => engine.handle({ method, path, body, auth, query }) as Promise<any>;

test('registration form: questions, tickets, discount, capacity and waitlist', async () => {
  const a = await signIn('admin', 'pastor@gracechurch.in');
  const form = await call(a, 'POST', '/admin/forms', {
    title: 'Youth camp',
    status: 'open',
    capacity: 3,
    waitlist: true,
    addTag: 'Youth camp 2026',
    fields: [{ id: 'tshirt', label: 'T-shirt size', type: 'select', options: ['S', 'M', 'L'], required: true }],
    ticketTypes: [{ name: 'Camper', price: 150000 }],
    discountCodes: [{ code: 'early', percentOff: 20, maxUses: 1 }],
  });
  assert.equal(form.status, 'open');
  const tt = form.ticketTypes[0].id;
  await assert.rejects(call(null, 'POST', `/public/forms/${form.id}/responses`, { name: 'Asha K', email: 'asha@example.com', answers: {}, tickets: [{ ticketTypeId: tt, qty: 1 }] }), /highlighted/);
  const r1 = await call(null, 'POST', `/public/forms/${form.id}/responses`, { name: 'Asha K', email: 'asha@example.com', answers: { tshirt: 'M' }, tickets: [{ ticketTypeId: tt, qty: 2 }], discountCode: 'EARLY' });
  assert.equal(r1.response.amount, 240000);
  assert.equal(r1.response.status, 'confirmed'); // demo checkout pays instantly
  assert.equal(r1.response.personId, undefined);
  await assert.rejects(call(null, 'POST', `/public/forms/${form.id}/responses`, { name: 'Ben', email: 'ben@example.com', answers: { tshirt: 'S' }, tickets: [{ ticketTypeId: tt, qty: 1 }], discountCode: 'EARLY' }), /used up/);
  const m = await signIn('member', 'priya@example.com');
  const r2 = await call(m, 'POST', `/forms/${form.id}/responses`, { answers: { tshirt: 'S' }, tickets: [{ ticketTypeId: tt, qty: 2 }] });
  assert.equal(r2.response.status, 'waitlisted');
  const view = await call(a, 'GET', `/admin/forms/${form.id}`);
  assert.equal(view.places, 2);
  assert.equal(view.waitlisted, 1);
  const asha = db.all('people').find((p) => p.email === 'asha@example.com')!;
  assert.ok(asha.tags.includes('Youth camp 2026'));
  assert.equal(db.all('donations').find((d) => d.formResponseId)?.receiptNumber, null);
  const promoted = await call(a, 'POST', `/admin/forms/${form.id}/responses/${r2.response.id}/promote`);
  assert.equal(promoted.response.status, 'confirmed');
});

test('free event form auto-promotes the waitlist when someone cancels', async () => {
  const a = await signIn('admin', 'pastor@gracechurch.in');
  const form = await call(a, 'POST', '/admin/forms', { title: 'Marriage seminar', status: 'open', capacity: 1, waitlist: true, eventId: 'ev_2' });
  const one = await call(null, 'POST', `/public/forms/${form.id}/responses`, { name: 'One Person', email: 'one@example.com', answers: {} });
  const two = await call(null, 'POST', `/public/forms/${form.id}/responses`, { name: 'Two Person', email: 'two@example.com', answers: {} });
  assert.equal(two.response.status, 'waitlisted');
  await call(a, 'PATCH', `/admin/forms/${form.id}/responses/${one.response.id}`, { status: 'cancelled' });
  const list = await call(a, 'GET', `/admin/forms/${form.id}/responses`);
  assert.equal(list.find((x: any) => x.id === two.response.id).status, 'confirmed');
  const m = await signIn('member', 'priya@example.com');
  const ev = await call(m, 'GET', '/events/ev_2');
  assert.equal(ev.registrationFormId, form.id);
});

test('room booking: clashes, approvals and the calendar', async () => {
  const a = await signIn('admin', 'pastor@gracechurch.in');
  const hall = await call(a, 'POST', '/admin/resources', { name: 'Fellowship Hall', kind: 'room', needsApproval: true, approverIds: [] });
  const start = new Date(Date.now() + 3 * 86400000);
  const end = new Date(start.getTime() + 2 * 3600000);
  const b1 = await call(a, 'POST', '/admin/bookings', { title: 'Youth night', resourceIds: [hall.id], startsAt: start, endsAt: end });
  assert.equal(b1.status, 'approved'); // owners don't need approval
  await assert.rejects(call(a, 'POST', '/admin/bookings', { title: 'Choir', resourceIds: [hall.id], startsAt: new Date(start.getTime() + 3600000), endsAt: end }), /already booked/);
  const clashes = await call(a, 'POST', '/admin/bookings/check', { resourceIds: [hall.id], startsAt: start, endsAt: end });
  assert.equal(clashes.length, 1);
  const cal = await call(a, 'GET', '/admin/calendar');
  assert.ok(cal.some((i: any) => i.id === b1.id) && cal.some((i: any) => i.type === 'event'));
  const coord = await signIn('admin', 'accounts@gracechurch.in');
  const later = new Date(end.getTime() + 86400000);
  const b2 = await call(coord, 'POST', '/admin/bookings', { title: 'Finance meeting', resourceIds: [hall.id], startsAt: later, endsAt: new Date(later.getTime() + 3600000) });
  assert.equal(b2.status, 'pending');
  await assert.rejects(call(coord, 'POST', `/admin/bookings/${b2.id}/approve`), /approver/);
  assert.equal((await call(a, 'POST', `/admin/bookings/${b2.id}/approve`)).status, 'approved');
});

test('custom fields, smart lists as audiences, and workflows', async () => {
  const a = await signIn('admin', 'pastor@gracechurch.in');
  const field = await call(a, 'POST', '/admin/people-fields', { label: 'Baptised', type: 'checkbox' });
  const someone = db.all('people').find((p) => p.status === 'member')!;
  const updated = await call(a, 'PATCH', `/admin/people/${someone.id}`, { custom: { [field.id]: true, bogus: 'x' } });
  assert.equal(updated.custom[field.id], true);
  assert.ok(!('bogus' in updated.custom));
  const list = await call(a, 'POST', '/admin/lists', { name: 'Baptised members', rules: [{ field: 'custom', customFieldId: field.id, op: 'is', value: 'true' }, { field: 'status', op: 'is', value: 'member' }] });
  assert.equal(list.count, 1);
  const visitors = await call(a, 'POST', '/admin/lists/preview', { rules: [{ field: 'status', op: 'is', value: 'visitor' }, { field: 'joinedDays', op: 'within', value: '3650' }] });
  assert.ok(visitors.count > 0);
  const preview = await call(a, 'POST', '/admin/messages/audience', { channel: 'email', audience: { type: 'list', ids: [list.id] } });
  assert.equal(preview.total, 1);

  const wf = await call(a, 'POST', '/admin/workflows', { name: 'New visitor follow-up', trigger: 'new_visitor', steps: [{ title: 'Call within 2 days', dueDays: 2 }, { title: 'Invite to lunch', dueDays: 7 }] });
  const p = await call(a, 'POST', '/admin/people', { firstName: 'Neha', lastName: 'Rao', status: 'visitor' });
  const cards = (await call(a, 'GET', '/admin/workflow-cards', undefined, { personId: p.id })).filter((c: any) => c.workflowId === wf.id);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].stepTitle, 'Call within 2 days');
  const c2 = await call(a, 'PATCH', `/admin/workflow-cards/${cards[0].id}`, { action: 'advance', note: 'Called, she will come Sunday' });
  assert.equal(c2.stepIndex, 1);
  const c3 = await call(a, 'PATCH', `/admin/workflow-cards/${cards[0].id}`, { action: 'advance' });
  assert.equal(c3.status, 'done');
  const detail = await call(a, 'GET', `/admin/workflows/${wf.id}`, undefined, { status: 'all' });
  assert.equal(detail.cards.length, 1);
});

test('deposit batches lock once committed', async () => {
  const fin = await signIn('admin', 'accounts@gracechurch.in');
  const fund = (await call(fin, 'GET', '/admin/giving/funds'))[0];
  const batch = await call(fin, 'POST', '/admin/giving/batches', { name: 'Sunday cash', expectedTotal: 300000 });
  const g = await call(fin, 'POST', '/admin/giving/donations', { donorName: 'Anonymous', fundId: fund.id, amount: 100000, method: 'cash', batchId: batch.id });
  await call(fin, 'POST', '/admin/giving/donations', { donorName: 'Anonymous', fundId: fund.id, amount: 150000, method: 'cheque', batchId: batch.id });
  await assert.rejects(call(fin, 'POST', `/admin/giving/batches/${batch.id}/commit`), /match/);
  const done = await call(fin, 'POST', `/admin/giving/batches/${batch.id}/commit`, { force: true });
  assert.equal(done.status, 'committed');
  assert.equal(done.difference, -50000);
  await assert.rejects(call(fin, 'POST', '/admin/giving/donations', { donorName: 'Late', fundId: fund.id, amount: 100, method: 'cash', batchId: batch.id }), /committed/);
  await assert.rejects(call(fin, 'POST', `/admin/giving/donations/${g.id}/refund`), /committed/);
});

test('headcounts, volunteer check-in, live service and CCLI report', async () => {
  const a = await signIn('admin', 'pastor@gracechurch.in');
  await call(a, 'POST', '/admin/checkin/ev_1/headcounts', { area: 'Main hall', count: 420 });
  await call(a, 'POST', '/admin/checkin/ev_1/headcounts', { area: 'Balcony', count: 80 });
  const s = await call(a, 'POST', '/admin/checkin/ev_1/headcounts', { area: 'main hall', count: 430 });
  assert.equal(s.headcountTotal, 510);
  assert.equal(s.event.attendance, 510);
  assert.ok(s.volunteers.scheduled >= 0);
  const live0 = await call(a, 'GET', '/admin/services/ev_1/live');
  if (live0.plan.items.length) {
    const live = await call(a, 'POST', '/admin/services/ev_1/live', { action: 'start' });
    assert.ok(live.itemEndsAt);
    const next = await call(a, 'POST', '/admin/services/ev_1/live', { action: 'next' });
    assert.equal(next.live.itemIndex, Math.min(1, live.plan.items.length - 1));
  }
  const report = await call(a, 'GET', '/admin/songs/ccli-report');
  assert.ok(Array.isArray(report.rows));
});

test('group space, sermons and the public church page', async () => {
  const a = await signIn('admin', 'pastor@gracechurch.in');
  await call(a, 'PUT', '/admin/public-page', { enabled: false });
  await assert.rejects(call(null, 'GET', '/public/church'), /not published/);
  await call(a, 'PUT', '/admin/public-page', { enabled: true, tagline: 'A church for the city' });
  await call(a, 'POST', '/admin/sermons', { title: 'Grace upon grace', speaker: 'Ps. John', date: '2026-10-18', videoUrl: 'https://youtube.com/watch?v=x' });
  const page = await call(null, 'GET', '/public/church');
  assert.equal(page.page.tagline, 'A church for the city');
  assert.equal(page.sermons[0].title, 'Grace upon grace');
  assert.ok(page.groups.length > 0 && page.groups.every((g: any) => !('leaderId' in g)));
  const res = await call(null, 'POST', `/public/groups/${page.groups[0].id}/interest`, { name: 'Ravi Teja', email: 'ravi@example.com' });
  assert.ok(res.ok);

  const m = await signIn('member', 'priya@example.com');
  const groups = await call(m, 'GET', '/groups');
  const mine = groups.data.find((g: any) => g.membership === 'member');
  if (mine) {
    await call(m, 'POST', `/groups/${mine.id}/posts`, { text: 'See you Wednesday!' });
    const d = await call(m, 'GET', `/groups/${mine.id}`);
    assert.ok(d.posts.some((x: any) => x.text === 'See you Wednesday!'));
  }
  const other = groups.data.find((g: any) => g.membership !== 'member');
  if (other) await assert.rejects(call(m, 'POST', `/groups/${other.id}/posts`, { text: 'hi' }), /members/);
});
