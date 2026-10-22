// The counting room: a denomination count sheet, two signatures, and loose cash recorded on commit.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const env = createDemoEnv({ now: () => new Date('2026-10-25T06:00:00.000Z') });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function owner() {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email: 'pastor@gracechurch.in', audience: 'admin' }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const fails = async (p: Promise<unknown>, status: number, code?: string) => { const e: any = await p.then(() => null, (err) => err); assert.ok(e, `expected ${status}`); assert.equal(e.status, status, e.message); if (code) assert.equal(e.code, code); };

test('count the plate, two people sign, commit records the loose offering so the books match', async () => {
  const auth = await owner();
  const call = (method: string, path: string, body?: unknown) => engine.handle({ method, path, body, auth }) as Promise<any>;
  const b = await call('POST', '/admin/giving/batches', { name: 'Sunday 25 Oct', date: '2026-10-25' });
  assert.equal(b.loose, 0);
  assert.equal(b.signed, 0);

  // Two named gifts entered from envelopes: ₹2,000 + ₹1,000.
  const funds = await call('GET', '/admin/giving/funds');
  const fund = funds.find((f: any) => /tithe|offering/i.test(f.name)) ?? funds[0];
  for (const amount of [200_000, 100_000]) await call('POST', '/admin/giving/donations', { donorName: 'Envelope', fundId: fund.id, amount, method: 'cash', batchId: b.id, date: '2026-10-25' });

  // The counters find ₹9,340 in notes and coins plus ₹1,500 by UPI.
  await fails(call('PUT', `/admin/giving/batches/${b.id}/count`, { notes: { '500': -1 } }), 422);
  await fails(call('PUT', `/admin/giving/batches/${b.id}/count`, { notes: {}, photoUrl: 'http://x/y.jpg' }), 422);
  let v = await call('PUT', `/admin/giving/batches/${b.id}/count`, { notes: { '500': 12, '200': 10, '100': 10, '50': 4, '20': 2, '10': 0 }, coins: 10_000, cheques: 0, upi: 150_000, photoUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' });
  assert.equal(v.sheet.total, (12 * 500 + 10 * 200 + 10 * 100 + 4 * 50 + 2 * 20) * 100 + 10_000 + 150_000);
  assert.equal(v.expectedTotal, v.sheet.total, 'the counted total is what the batch should add up to');
  assert.equal(v.loose, v.sheet.total - 300_000);
  assert.deepEqual(Object.keys(v.sheet.notes).sort(), ['100', '20', '200', '50', '500'], 'zero rows are dropped');

  // Nobody has signed: committing is refused unless forced.
  await fails(call('POST', `/admin/giving/batches/${b.id}/commit`, {}), 409, 'unsigned');
  v = await call('POST', `/admin/giving/batches/${b.id}/sign`, { name: 'Mercy Daniel' });
  assert.equal(v.signed, 1);
  await fails(call('POST', `/admin/giving/batches/${b.id}/sign`, { name: 'mercy daniel' }), 409, 'same_person');
  v = await call('POST', `/admin/giving/batches/${b.id}/sign`, {});
  assert.equal(v.signed, 2);
  assert.equal(v.sheet.counters[1].name, 'Pastor Samuel Raj', 'the signed-in staff member by default');
  await fails(call('POST', `/admin/giving/batches/${b.id}/sign`, { name: 'Third' }), 409, 'signed');

  // Changing the count clears the signatures.
  v = await call('PUT', `/admin/giving/batches/${b.id}/count`, { notes: { '500': 12, '200': 10, '100': 10, '50': 4, '20': 2 }, coins: 10_000, upi: 150_000 });
  assert.equal(v.signed, 0);
  assert.equal(v.sheet.photoUrl, 'data:image/jpeg;base64,/9j/4AAQSkZJRg==', 'the photo stays');
  await call('POST', `/admin/giving/batches/${b.id}/sign`, { name: 'Mercy Daniel' });
  await call('POST', `/admin/giving/batches/${b.id}/sign`, { name: 'Leena George' });

  // Commit: the loose ₹7,840 becomes one anonymous cash offering in the batch; nothing is left over.
  const before = db.all('donations').length;
  const done = await call('POST', `/admin/giving/batches/${b.id}/commit`, { looseFundId: fund.id });
  assert.equal(done.status, 'committed');
  assert.equal(done.loose, 0);
  assert.equal(done.difference, 0);
  assert.equal(done.total, done.sheet.total);
  const loose = db.all('donations').slice(before).find((d) => d.batchId === b.id);
  assert.ok(loose && loose.donorName === 'Loose offering' && loose.method === 'cash' && loose.amount === done.sheet.total - 300_000 && loose.fundId === fund.id);
  const detail = await call('GET', `/admin/giving/batches/${b.id}`);
  assert.equal(detail.donations.length, 3);
  await fails(call('PUT', `/admin/giving/batches/${b.id}/count`, { notes: {} }), 409);

  // A batch without a count sheet commits the old way.
  const plain = await call('POST', '/admin/giving/batches', { name: 'Plain', date: '2026-10-25' });
  await call('POST', '/admin/giving/donations', { donorName: 'Envelope', fundId: fund.id, amount: 50_000, method: 'cash', batchId: plain.id, date: '2026-10-25' });
  assert.equal((await call('POST', `/admin/giving/batches/${plain.id}/commit`, {})).status, 'committed');
});
