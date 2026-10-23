// Hall rental to outsiders: the office puts the hall up for hire, a stranger asks for a date from the
// public page, the office approves, the renter pays online, and the slot becomes an approved booking.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const clock = Date.parse('2026-11-02T05:00:00.000Z');
const DAY = 86_400_000;
const env = createDemoEnv({ now: () => new Date(clock) });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

// Same arithmetic as the seed: a wall-clock hour in India, `days` from now.
const at = (days: number, hour: number, minute = 0) => { const d = new Date(clock + days * DAY + 330 * 60_000); d.setUTCHours(hour, minute, 0, 0); return new Date(d.getTime() - 330 * 60_000).toISOString(); };

async function signIn(audience: 'admin' | 'member', email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown) => { const [p, qs] = path.split('?'); return engine.handle({ method, path: p, body, auth, query: qs ? Object.fromEntries(new URLSearchParams(qs)) : {} }) as Promise<any>; };
const fails = async (p: Promise<unknown>, status: number, code?: string) => { const e: any = await p.then(() => null, (err) => err); assert.ok(e, `expected ${status}`); assert.equal(e.status, status, e.message); if (code) assert.equal(e.code, code); };
const since = (n: number) => env.outbox.slice(n);

test('a wedding reception hires the Fellowship Hall and pays online', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const priya = await signIn('member', 'priya@example.com');
  await fails(call(priya, 'GET', '/admin/rentals'), 403);

  // Nothing is for hire until the office says so.
  let pub = await call(null, 'GET', '/public/rentals');
  assert.deepEqual(pub.spaces, []);
  assert.equal(pub.church.name, 'Grace Community Church');
  let hub = await call(owner, 'GET', '/admin/rentals');
  assert.ok(hub.spaces.some((s: any) => s.resource.id === 'rs_hall' && !s.offer.enabled));
  assert.ok(!hub.spaces.some((s: any) => s.resource.kind === 'equipment'), 'projectors are not for hire');
  assert.match(hub.publicUrl, /\/rent$/);

  await fails(call(owner, 'PUT', '/admin/rentals/spaces/rs_hall', { enabled: true }), 422);
  const space = await call(owner, 'PUT', '/admin/rentals/spaces/rs_hall', { enabled: true, ratePerHour: 150000, minHours: 3, deposit: 500000, blurb: 'Seats 150, kitchen next door.', terms: 'No alcohol. Leave it as you found it.' });
  assert.equal(space.offer.ratePerHour, 150000);
  pub = await call(null, 'GET', '/public/rentals');
  assert.equal(pub.spaces.length, 1);
  assert.equal(pub.spaces[0].name, 'Fellowship Hall');
  assert.equal(pub.spaces[0].deposit, 500000);

  // Bad requests are told what is wrong.
  const bad = await call(null, 'POST', '/public/rentals', { resourceId: 'rs_hall', name: 'Ravi Kumar', phone: '12', startsAt: at(10, 17), endsAt: at(10, 18) }).then(() => null, (e) => e);
  assert.equal(bad.status, 422);
  assert.ok(bad.fields.phone && bad.fields.purpose && bad.fields.endsAt, JSON.stringify(bad.fields));
  await fails(call(null, 'POST', '/public/rentals', { resourceId: 'rs_proj', name: 'x', phone: '9876543210', purpose: 'p', startsAt: at(10, 17), endsAt: at(10, 21) }), 404);
  // The Blood Donation Camp already holds the hall on day 6, 9 to 3.
  await fails(call(null, 'POST', '/public/rentals', { resourceId: 'rs_hall', name: 'Ravi Kumar', phone: '9876543210', purpose: 'Meeting', startsAt: at(6, 10), endsAt: at(6, 14) }), 409, 'taken');

  let n = env.outbox.length;
  const req = await call(null, 'POST', '/public/rentals', { resourceId: 'rs_hall', name: 'Ravi Kumar', phone: '98765 43210', email: 'Ravi@example.com', organisation: 'Kumar family', purpose: 'Wedding reception', guests: 120, startsAt: at(10, 17), endsAt: at(10, 21, 30) });
  assert.equal(req.status, 'requested');
  assert.equal(req.hours, 4.5);
  assert.equal(req.amount, 675000);
  assert.equal(req.total, 1175000);
  assert.ok(req.token.length === 24);
  assert.ok(since(n).some((o) => o.to === 'ravi@example.com' && /we have your request/.test(o.subject) && o.text.includes(`/rent/pay/${req.token}`)), 'renter gets the follow link');
  assert.ok(since(n).some((o) => o.to !== 'ravi@example.com' && /Hire request: Fellowship Hall/.test(o.subject) && /Wedding reception/.test(o.text)), 'office is told');
  const booking = db.all('bookings').find((b) => b.requestedBy === 'public')!;
  assert.equal(booking.status, 'pending');
  assert.deepEqual(booking.resourceIds, ['rs_hall']);

  hub = await call(owner, 'GET', '/admin/rentals?status=open');
  assert.equal(hub.summary.open, 1);
  assert.equal(hub.rentals.length, 1);
  const id = hub.rentals[0].id;
  assert.equal(hub.rentals[0].bookingStatus, 'pending');
  assert.deepEqual(hub.rentals[0].conflicts, []);
  assert.ok(hub.rentals[0].payUrl.endsWith(`/rent/pay/${req.token}`));

  // Not approved yet: the renter cannot pay.
  await fails(call(null, 'POST', `/public/rentals/${req.token}/pay`), 409, 'not_ready');
  await fails(call(null, 'GET', '/public/rentals/nosuchtoken'), 404);

  await call(owner, 'POST', `/admin/rentals/${id}/notes`, { text: 'Spoke to Ravi; 120 guests, caterer brings their own gas.' });
  n = env.outbox.length;
  const approved = await call(owner, 'POST', `/admin/rentals/${id}/approve`, { deposit: 300000, note: 'Deposit reduced, they are a known family.' });
  assert.equal(approved.status, 'awaiting_payment');
  assert.equal(approved.deposit, 300000);
  assert.equal(approved.total, 975000);
  assert.match(approved.notes, /caterer[\s\S]*Deposit reduced/);
  assert.ok(since(n).some((o) => o.to === 'ravi@example.com' && /is available/.test(o.subject) && /9,750/.test(o.text) && o.text.includes(approved.payUrl)), 'renter gets the pay link');
  await fails(call(owner, 'POST', `/admin/rentals/${id}/refund`), 409, 'not_paid');

  let mine = await call(null, 'GET', `/public/rentals/${req.token}`);
  assert.equal(mine.status, 'awaiting_payment');
  assert.equal(mine.total, 975000);
  assert.ok(!('renterPhone' in mine), 'the public view keeps it light');

  // Pay. The demo checkout succeeds at once.
  n = env.outbox.length;
  const pay = await call(null, 'POST', `/public/rentals/${req.token}/pay`);
  assert.equal(pay.rental.status, 'paid');
  assert.ok(pay.rental.paidAt);
  const d = db.all('donations').find((x) => x.rentalId === id)!;
  assert.equal(d.status, 'succeeded');
  assert.equal(d.amount, 975000);
  assert.equal(d.fundId, 'fd_rentals');
  assert.equal(d.receiptNumber, null, 'a hire is not a donation; no 80G receipt');
  assert.equal(db.get('funds', 'fd_rentals')!.taxDeductible, false);
  assert.equal(db.get('bookings', booking.id)!.status, 'approved', 'the slot is now held on the calendar');
  assert.ok(since(n).some((o) => o.to === 'ravi@example.com' && /booking confirmed/.test(o.subject)));
  assert.ok(since(n).some((o) => /Fellowship Hall paid: Ravi Kumar/.test(o.subject)), 'office is told it is paid');
  await fails(call(null, 'POST', `/public/rentals/${req.token}/pay`), 409, 'paid');
  await fails(call(null, 'POST', `/public/rentals/${req.token}/cancel`), 409, 'paid');
  await fails(call(owner, 'POST', `/admin/rentals/${id}/decline`), 409, 'paid');

  // Someone else now asking for the same evening is told it is taken.
  await fails(call(null, 'POST', '/public/rentals', { resourceId: 'rs_hall', name: 'Another', phone: '9000000000', purpose: 'Party', startsAt: at(10, 19), endsAt: at(10, 23) }), 409, 'taken');

  hub = await call(owner, 'GET', '/admin/rentals?status=paid');
  assert.equal(hub.rentals.length, 1);
  assert.equal(hub.summary.paidThisYear, 675000);
  assert.equal(hub.summary.depositsHeld, 300000);

  // The office refunds it; the slot frees up.
  const refunded = await call(owner, 'POST', `/admin/rentals/${id}/refund`, { note: 'Wedding postponed.' });
  assert.equal(refunded.status, 'refunded');
  assert.equal(db.get('bookings', booking.id)!.status, 'cancelled');
  assert.equal(db.get('donations', d.id)!.status, 'refunded');
  hub = await call(owner, 'GET', '/admin/rentals?status=closed');
  assert.ok(hub.rentals.some((x: any) => x.id === id));
  assert.equal(hub.summary.depositsHeld, 0);

  // Paid offline, by bank transfer.
  const r2 = await call(null, 'POST', '/public/rentals', { resourceId: 'rs_hall', name: 'Sunita Rao', phone: '9123456780', purpose: 'Tuition centre annual day', startsAt: at(12, 10), endsAt: at(12, 13) });
  assert.equal(r2.amount, 450000);
  const id2 = db.all('rentals').find((x) => x.token === r2.token)!.id;
  const paid2 = await call(owner, 'POST', `/admin/rentals/${id2}/paid`, { via: 'bank_transfer', reference: 'NEFT/4471' });
  assert.equal(paid2.status, 'paid');
  assert.equal(paid2.bookingStatus, 'approved');
  const d2 = db.all('donations').find((x) => x.rentalId === id2)!;
  assert.equal(d2.method, 'bank_transfer');
  assert.equal(d2.providerRef, 'NEFT/4471');

  // Declined, and withdrawn by the renter.
  const r3 = await call(null, 'POST', '/public/rentals', { resourceId: 'rs_hall', name: 'Promo Events', phone: '9111111111', email: 'promo@example.com', purpose: 'Product launch', startsAt: at(14, 10), endsAt: at(14, 18) });
  const id3 = db.all('rentals').find((x) => x.token === r3.token)!.id;
  n = env.outbox.length;
  const declined = await call(owner, 'POST', `/admin/rentals/${id3}/decline`, { note: 'We do not hire the hall for commercial launches.' });
  assert.equal(declined.status, 'declined');
  assert.equal(declined.bookingStatus, 'declined');
  assert.ok(since(n).some((o) => o.to === 'promo@example.com' && /commercial launches/.test(o.text)));
  await fails(call(owner, 'POST', `/admin/rentals/${id3}/approve`), 409, 'closed');

  const r4 = await call(null, 'POST', '/public/rentals', { resourceId: 'rs_hall', name: 'Meena', phone: '9222222222', purpose: 'Birthday', startsAt: at(15, 16), endsAt: at(15, 19) });
  const gone = await call(null, 'POST', `/public/rentals/${r4.token}/cancel`);
  assert.equal(gone.status, 'cancelled');
  const bk4 = db.all('bookings').find((b) => b.requestedByName === 'Meena')!;
  assert.equal(bk4.status, 'cancelled');

  // Taking the hall off the market hides it, but keeps the record.
  await call(owner, 'PUT', '/admin/rentals/spaces/rs_hall', { enabled: false });
  pub = await call(null, 'GET', '/public/rentals');
  assert.deepEqual(pub.spaces, []);
  hub = await call(owner, 'GET', '/admin/rentals');
  assert.equal(hub.rentals.length, 4);
});
