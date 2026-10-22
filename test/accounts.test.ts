// Church accounts: expense requests and approvals, budgets, and the Tally export.
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
const today = new Date().toISOString().slice(0, 10);

test('expenses: request, approval rules, payment voucher and budget summary', async () => {
  const worship = await signIn('admin', 'worship@gracechurch.in'); // coordinator
  const fin = await signIn('admin', 'accounts@gracechurch.in');
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const heads = await call(worship, 'GET', '/admin/accounts/heads');
  const media = heads.find((h: any) => h.name.startsWith('Sound'));

  await assert.rejects(call(worship, 'POST', '/admin/expenses', { headId: media.id, amount: '0', payee: 'X', description: 'Y' }), /amount/);
  const req = await call(worship, 'POST', '/admin/expenses', { headId: media.id, amount: '12,500.50', payee: 'Sri Sai Audio', description: 'Cables and stands', paid: true });
  assert.equal(req.status, 'submitted', 'a coordinator cannot record a paid bill');
  assert.equal(req.amount, 1_250_050);
  const mine = await call(worship, 'GET', '/admin/expenses');
  assert.ok(mine.every((e: any) => e.submittedBy === 'David Samuel'), 'without giving access you see only your own');

  await assert.rejects(call(worship, 'POST', `/admin/expenses/${req.id}/decide`, { approve: true }), /owner, an admin or finance/);
  await assert.rejects(call(fin, 'POST', `/admin/expenses/${req.id}/pay`, { method: 'upi' }), /Approve/);
  await assert.rejects(call(fin, 'POST', `/admin/expenses/${req.id}/decide`, { approve: false }), /reason/);
  const ok = await call(fin, 'POST', `/admin/expenses/${req.id}/decide`, { approve: true });
  assert.equal(ok.status, 'approved');
  const paid = await call(fin, 'POST', `/admin/expenses/${req.id}/pay`, { method: 'upi', reference: 'UTR123', date: today });
  assert.match(paid.voucherNumber, /^PV\/\d{4}-\d{2}\/\d{4}$/);
  await assert.rejects(call(worship, 'DELETE', `/admin/expenses/${req.id}`), /stays in the books/);

  const own = await call(fin, 'POST', '/admin/expenses', { headId: media.id, amount: 100, payee: 'Self', description: 'Petty cash' });
  await assert.rejects(call(fin, 'POST', `/admin/expenses/${own.id}/decide`, { approve: true }), /Someone else/);
  await call(owner, 'POST', `/admin/expenses/${own.id}/decide`, { approve: true });

  const direct = await call(fin, 'POST', '/admin/expenses', { headId: media.id, amount: 500, payee: 'BSNL', description: 'Internet', paid: true, method: 'bank_transfer' });
  assert.equal(direct.status, 'paid');

  await call(fin, 'PATCH', `/admin/accounts/heads/${media.id}`, { budget: '400000' });
  const sum = await call(fin, 'GET', '/admin/accounts/summary');
  const row = sum.expenses.find((r: any) => r.headId === media.id);
  assert.equal(row.budget, 40_000_000);
  assert.ok(row.spent >= 1_250_050 + 50_000);
  assert.equal(sum.months.length, 12);
  assert.ok(sum.totals.income > 0 && sum.income.length > 0);
  await assert.rejects(call(worship, 'GET', '/admin/accounts/summary'));
});

test('tally: receipt and payment vouchers balance, names follow the settings', async () => {
  const fin = await signIn('admin', 'accounts@gracechurch.in');
  const fund = db.all('funds')[0];
  await call(fin, 'PATCH', '/admin/accounts/tally', { bankLedger: 'ICICI Current A/c', fundLedgers: { [fund.id]: 'Donations - Building' } });
  const from = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
  const out = await call(fin, 'GET', '/admin/accounts/tally-export', undefined, { from, to: today });
  assert.ok(out.receipts > 5 && out.payments > 5);
  assert.match(out.xml, /^<\?xml version="1.0"/);
  assert.match(out.xml, /<SVCURRENTCOMPANY>Grace Community Church Trust<\/SVCURRENTCOMPANY>/);
  assert.match(out.xml, /<LEDGERNAME>ICICI Current A\/c<\/LEDGERNAME>/);
  assert.match(out.xml, /<LEDGER NAME="Salaries and honorarium" ACTION="Create">/);
  // Every voucher balances: debits (negative) and credits add to zero.
  for (const v of out.xml.match(/<VOUCHER [\s\S]*?<\/VOUCHER>/g)!) {
    const amounts = [...v.matchAll(/<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)].map((m: RegExpMatchArray) => Number(m[1]));
    assert.equal(Math.round(amounts.reduce((s: number, a: number) => s + a, 0) * 100), 0);
  }
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(out.xml), 'XML is escaped');
  const daily = await call(fin, 'GET', '/admin/accounts/tally-export', undefined, { from, to: today, daily: '1', expenses: '0' });
  assert.ok(daily.receipts < out.receipts && daily.payments === 0);
  assert.equal(daily.incomeTotal, out.incomeTotal);
  await assert.rejects(call(fin, 'GET', '/admin/accounts/tally-export', undefined, { from: today, to: from }), /dates/);
});
