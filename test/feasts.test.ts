// Love-feast and kitchen planner: the RSVP count for the Youth Night becomes a shopping list
// with quantities and a cost estimate, split per head or per family when the church is not paying.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { roundQty, shoppingList } from '../src/core/modules/feasts.js';
import { seedDemo } from '../src/core/seed.js';

const clock = Date.parse('2026-11-02T05:00:00.000Z');
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

test('rounding and the shopping list maths', () => {
  assert.equal(roundQty(2.3, 'kg'), 2.5);
  assert.equal(roundQty(2.5, 'kg'), 2.5);
  assert.equal(roundQty(0.1, 'l'), 0.25);
  assert.equal(roundQty(123, 'g'), 130);
  assert.equal(roundQty(10.2, 'pcs'), 11);
  assert.equal(roundQty(3, 'pcs'), 3);
  const list = shoppingList([
    { id: 'a', name: 'Biryani', cookId: null, cookName: '', ingredients: [{ name: 'Onions', perHead: 0.05, unit: 'kg', costPerUnit: 4000 }, { name: 'Rice', perHead: 0.12, unit: 'kg', costPerUnit: 11000 }] },
    { id: 'b', name: 'Raita', cookId: null, cookName: '', ingredients: [{ name: 'onions', perHead: 0.02, unit: 'kg', costPerUnit: null }, { name: 'Curd', perHead: 0.06, unit: 'kg', costPerUnit: null }] },
  ], 100);
  assert.deepEqual(list.map((i) => [i.name, i.qty, i.cost, i.dishes]), [['Curd', 6, null, ['Raita']], ['Onions', 7, 28000, ['Biryani', 'Raita']], ['Rice', 12, 132000, ['Biryani']]]);
});

test('the Youth Night gets a biryani plan sized by RSVPs', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const priya = await signIn('member', 'priya@example.com');
  const event = db.get('events', 'ev_3')!;

  // Priya and two others RSVP; one shares Priya's household.
  await call(priya, 'PUT', `/events/${event.id}/rsvp`, { status: 'going' });
  const priyaRow = db.all('people').find((p) => p.email === 'priya@example.com')!;
  const others = db.all('people').filter((p) => p.id !== priyaRow.id && p.status !== 'inactive').slice(0, 2);
  db.put('people', { ...others[0], householdName: priyaRow.householdName ?? 'Thomas' });
  if (!priyaRow.householdName) db.put('people', { ...db.get('people', priyaRow.id)!, householdName: 'Thomas' });
  for (const p of others) db.put('rsvps', { id: `rsvp_test_${p.id}`, eventId: event.id, personId: p.id, at: new Date(clock).toISOString() });

  let hub = await call(owner, 'GET', '/admin/feasts');
  assert.deepEqual(hub.feasts, []);
  assert.ok(hub.templates.some((t: any) => t.id === 'biryani'));
  const going = db.all('rsvps').filter((r) => r.eventId === event.id).length;
  const famKey = (p: any) => (p.householdName ? `h:${p.householdName}` : `solo:${p.id}`);
  const families = new Set(db.all('rsvps').filter((r) => r.eventId === event.id).map((r) => famKey(db.get('people', r.personId)))).size;
  assert.ok(going >= 3 && families >= 2 && families < going, `seed gives a mix: ${going} going in ${families} families`);
  assert.ok(hub.events.some((e: any) => e.id === event.id && e.going === going), 'event picker shows the RSVP count');
  await fails(call(priya, 'GET', '/admin/feasts'), 403);
  await fails(call(owner, 'POST', '/admin/feasts', { eventId: 'ev_nope', template: 'biryani' }), 404);

  let f = await call(owner, 'POST', '/admin/feasts', { eventId: event.id, template: 'biryani', extraHeads: 5 });
  assert.equal(f.name, 'Chicken biryani lunch');
  assert.equal(f.event.title, 'Youth Night');
  assert.equal(f.rsvps, going);
  assert.equal(f.families, families);
  assert.equal(f.heads, going + 5);
  assert.equal(f.menu.length, 4);
  f = await call(owner, 'PATCH', `/admin/feasts/${f.id}`, { headsOverride: 20 });
  assert.equal(f.heads, 20, 'an override pins the headcount');
  assert.ok(f.menu[0].id.startsWith('dish'));
  const chicken = f.shopping.find((i: any) => i.name === 'Chicken');
  assert.equal(chicken.qty, 4, '0.2 kg × 20');
  assert.equal(chicken.cost, 4 * 24000);
  const onions = f.shopping.find((i: any) => i.name === 'Onions');
  assert.deepEqual(onions.dishes, ['Chicken biryani', 'Onion raita']);
  assert.equal(onions.qty, 1.75, '(0.06 + 0.02) × 20 = 1.6 → quarter kg');
  assert.ok(f.estimatedCost > 100000 && f.estimatedCost < 1000000, `plausible total ${f.estimatedCost}`);
  assert.equal(f.perHead, Math.ceil(f.estimatedCost / 20 / 100) * 100);
  assert.equal(f.perFamily, Math.ceil(f.estimatedCost / families / 100) * 100);
  await fails(call(owner, 'POST', '/admin/feasts', { eventId: event.id, template: 'teasnacks' }), 409);

  // Without the override another RSVP grows the list on its own.
  f = await call(owner, 'PATCH', `/admin/feasts/${f.id}`, { headsOverride: 100, split: 'per_family', notes: 'Sister Mary brings the raita.' });
  assert.equal(f.heads, 100);
  assert.equal(f.shopping.find((i: any) => i.name === 'Chicken').qty, 20);
  assert.equal(f.split, 'per_family');
  f = await call(owner, 'PATCH', `/admin/feasts/${f.id}`, { headsOverride: null, extraHeads: 0 });
  assert.equal(f.heads, going);
  const another = db.all('people').find((p) => p.status !== 'inactive' && !db.all('rsvps').some((r) => r.eventId === event.id && r.personId === p.id))!;
  db.put('rsvps', { id: 'rsvp_test_more', eventId: event.id, personId: another.id, at: new Date(clock).toISOString() });
  f = await call(owner, 'GET', `/admin/feasts/${f.id}`);
  assert.equal(f.heads, going + 1);
  f = await call(owner, 'PATCH', `/admin/feasts/${f.id}`, { headsOverride: 21 });

  // Edit the menu: drop the sweet, add a dish with a cook, price an ingredient.
  const cook = others[1];
  const menu = f.menu.filter((d: any) => d.name !== 'Gulab jamun').concat([{ name: 'Fruit custard', cookId: cook.id, ingredients: [{ name: 'Custard', perHead: 0.08, unit: 'l', costPerUnit: 9000 }, { name: 'Bananas', perHead: 1, unit: 'pcs', costPerUnit: 500 }] }]);
  f = await call(owner, 'PATCH', `/admin/feasts/${f.id}`, { menu });
  assert.equal(f.menu.length, 4);
  assert.equal(f.menu[3].cookName, `${cook.firstName} ${cook.lastName}`.trim());
  assert.ok(f.menu[3].id.startsWith('dish'));
  assert.equal(f.shopping.find((i: any) => i.name === 'Bananas').qty, 21);
  assert.equal(f.shopping.find((i: any) => i.name === 'Custard').qty, 1.75);
  assert.ok(!f.shopping.some((i: any) => i.name === 'Gulab jamun'));
  await fails(call(owner, 'PATCH', `/admin/feasts/${f.id}`, { menu: [{ name: '', ingredients: [] }] }), 422);
  await fails(call(owner, 'PATCH', `/admin/feasts/${f.id}`, { menu: [{ name: 'X', cookId: 'p_nope', ingredients: [] }] }), 404);

  const csv = await call(owner, 'GET', `/admin/feasts/${f.id}/list.csv`);
  assert.equal(csv.__raw, true);
  const lines = csv.body.split('\r\n');
  assert.equal(lines[0], 'Item,Quantity,Unit,For,Rate (₹),Cost (₹)');
  assert.ok(lines.some((l: string) => l.startsWith('Chicken,4.25,kg,Chicken biryani,240,1020')));
  assert.match(lines[lines.length - 1], /21 heads,Total,/);

  hub = await call(owner, 'GET', '/admin/feasts');
  assert.equal(hub.feasts.length, 1);
  assert.ok(!hub.events.some((e: any) => e.id === event.id), 'an event with a plan leaves the picker');
  await call(owner, 'DELETE', `/admin/feasts/${f.id}`);
  assert.deepEqual((await call(owner, 'GET', '/admin/feasts')).feasts, []);
});
