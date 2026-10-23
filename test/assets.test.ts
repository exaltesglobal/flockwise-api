// Asset register: the office lists what the church owns, logs a service, gets reminded a week
// before the next one and a month before an AMC ends, exports the register, and retires an item.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

let clock = Date.parse('2026-11-02T05:00:00.000Z'); // 10:30 am IST, Monday
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
const fails = async (p: Promise<unknown>, status: number) => { const e: any = await p.then(() => null, (err) => err); assert.ok(e, `expected ${status}`); assert.equal(e.status, status, e.message); };
const assetMail = (from: number) => env.outbox.slice(from).filter((o) => /asset reminder/i.test(o.subject ?? '') || /asset reminder/i.test(o.text));

test('the generator, the mixer and 200 chairs go on the register', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const priya = await signIn('member', 'priya@example.com');

  let hub = await call(owner, 'GET', '/admin/assets');
  assert.deepEqual(hub.assets, []);
  assert.equal(hub.summary.count, 0);
  assert.ok(hub.categories.includes('sound'));
  await fails(call(priya, 'GET', '/admin/assets'), 403);
  await fails(call(owner, 'POST', '/admin/assets', { category: 'sound' }), 422);
  await fails(call(owner, 'POST', '/admin/assets', { name: 'X', purchasedOn: '2/3/2026' }), 422);

  const custodian = db.all('people')[1];
  const gen = await call(owner, 'POST', '/admin/assets', {
    name: 'Kirloskar 15 kVA generator', category: 'electrical', location: 'Generator room', vendor: 'Kirloskar Chennai',
    purchasedOn: '2025-11-05', cost: 48500000, warrantyUntil: '2026-11-25', serviceEveryMonths: 6,
    amc: { vendor: 'PowerCare Services', phone: '9840012345', until: '2026-11-30', note: 'Covers two services a year' },
    custodianId: custodian.id, notes: 'Diesel, 15 kVA.',
  });
  assert.equal(gen.tag, 'A-0001');
  assert.equal(gen.custodianId, custodian.id);
  assert.ok(gen.custodianName.length > 2);
  assert.equal(gen.nextServiceOn, '2026-05-05', 'purchase + 6 months when never serviced');
  assert.ok(gen.serviceDueInDays < 0, 'already overdue');
  assert.equal(gen.amcDueInDays, 28);
  assert.equal(gen.warrantyDueInDays, 23);

  const mixer = await call(owner, 'POST', '/admin/assets', { name: 'Yamaha MG16XU mixer', category: 'sound', location: 'Sound desk', cost: 4200000, serial: 'YM-77812', tag: 'SND-01' });
  assert.equal(mixer.tag, 'SND-01');
  await fails(call(owner, 'POST', '/admin/assets', { name: 'Another mixer', tag: 'SND-01' }), 409);
  const chairs = await call(owner, 'POST', '/admin/assets', { name: 'Nilkamal plastic chairs', category: 'furniture', quantity: 200, cost: 45000, location: 'Main hall' });
  assert.equal(chairs.tag, 'A-0002', 'auto tags skip custom ones');

  hub = await call(owner, 'GET', '/admin/assets');
  assert.equal(hub.assets.length, 3);
  assert.equal(hub.summary.count, 202);
  assert.equal(hub.summary.value, 48500000 + 4200000 + 200 * 45000);
  assert.equal(hub.summary.serviceDue, 1);
  assert.equal(hub.summary.amcExpiring, 1);
  assert.equal(hub.summary.needsRepair, 0);
  assert.equal((await call(owner, 'GET', '/admin/assets?category=sound')).assets.length, 1);
  assert.equal((await call(owner, 'GET', '/admin/assets?q=generator')).assets[0].id, gen.id);
  assert.equal((await call(owner, 'GET', '/admin/assets?q=powercare')).assets.length, 1, 'search covers the AMC vendor');

  // The daily tick reminds the keepers once: the service is overdue, the AMC and the warranty end within a month.
  let from = env.outbox.length;
  await engine.tick();
  let mail = assetMail(from);
  assert.ok(mail.length >= 1, 'a reminder went out');
  assert.match(mail[0].text, /generator \(A-0001\) service was due/);
  assert.match(mail[0].text, /AMC with PowerCare Services ends in 28 days/);
  assert.match(mail[0].text, /warranty ends in 23 days/);
  assert.ok(mail.some((o) => o.channel === 'email' || o.channel === 'push'));

  clock += 86_400_000; from = env.outbox.length;
  await engine.tick();
  assert.equal(assetMail(from).length, 0, 'not repeated the next day');

  // Logging a service moves the next due date and the reminder comes again a week before that.
  const serviced = await call(owner, 'POST', `/admin/assets/${gen.id}/log`, { kind: 'service', text: 'Oil and filter change', date: '2026-11-03', cost: 650000 });
  assert.equal(serviced.lastServicedOn, '2026-11-03');
  assert.equal(serviced.nextServiceOn, '2027-05-03');
  assert.equal(serviced.log[0].kind, 'service');
  assert.equal(serviced.log[0].cost, 650000);

  clock = Date.parse('2027-04-27T05:00:00.000Z'); from = env.outbox.length;
  await engine.tick();
  mail = assetMail(from);
  assert.ok(mail.some((o) => /service is due in 6 days/.test(o.text)), 'service reminder a week before');

  // Repairs: mark it, then a repair log entry clears it.
  const broken = await call(owner, 'PATCH', `/admin/assets/${mixer.id}`, { condition: 'needs_repair' });
  assert.equal(broken.condition, 'needs_repair');
  assert.equal((await call(owner, 'GET', '/admin/assets')).summary.needsRepair, 1);
  const fixed = await call(owner, 'POST', `/admin/assets/${mixer.id}/log`, { kind: 'repair', text: 'Channel 3 fader replaced', cost: 180000 });
  assert.equal(fixed.condition, 'good');
  await fails(call(owner, 'POST', `/admin/assets/${mixer.id}/log`, { kind: 'note', text: '' }), 422);
  const moved = await call(owner, 'POST', `/admin/assets/${chairs.id}/log`, { kind: 'moved', text: 'For the youth camp', location: 'Camp site store' });
  assert.equal(moved.location, 'Camp site store');

  // Edits keep what was not sent, and a tag clash is refused.
  const edited = await call(owner, 'PATCH', `/admin/assets/${chairs.id}`, { quantity: 180, notes: '20 broken and thrown away' });
  assert.equal(edited.quantity, 180);
  assert.equal(edited.location, 'Camp site store');
  assert.equal(edited.category, 'furniture');
  await fails(call(owner, 'PATCH', `/admin/assets/${chairs.id}`, { tag: 'SND-01' }), 409);

  // Export the whole register as CSV.
  const csv = await call(owner, 'GET', '/admin/assets/export.csv');
  assert.equal(csv.__raw, true);
  assert.match(csv.contentType, /text\/csv/);
  const lines = csv.body.split('\r\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^Tag,Name,Category,Qty/);
  assert.ok(lines.some((l: string) => l.startsWith('A-0001,Kirloskar 15 kVA generator,electrical,1,Generator room') && l.includes('485000,2026-11-25,PowerCare Services')));

  // Retire the mixer; it leaves the active list and the totals, and can be found under retired.
  await call(owner, 'DELETE', `/admin/assets/${mixer.id}`, { reason: 'Replaced by a digital mixer' });
  hub = await call(owner, 'GET', '/admin/assets');
  assert.equal(hub.assets.length, 2);
  assert.equal(hub.summary.value, 48500000 + 180 * 45000);
  const retired = await call(owner, 'GET', '/admin/assets?status=retired');
  assert.equal(retired.assets.length, 1);
  assert.equal(retired.assets[0].status, 'retired');
  assert.equal(retired.assets[0].log[0].kind, 'retired');
  assert.equal((await call(owner, 'GET', '/admin/assets?status=all')).assets.length, 3);
  const back = await call(owner, 'PATCH', `/admin/assets/${mixer.id}`, { status: 'active' });
  assert.equal(back.status, 'active');
  assert.equal(back.condition, 'good');

  await fails(call(owner, 'PATCH', '/admin/assets/as_nope', { name: 'x' }), 404);
});
