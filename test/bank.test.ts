// Bank reconciliation: statement lines match gifts, batch deposits and vouchers; the rest is recorded or set aside.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findHeaderRow, guessBankColumns, rowsToBankLines } from '../src/core/bank-presets.js';
import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const clock = Date.parse('2026-10-23T05:00:00.000Z');
const env = createDemoEnv({ now: () => new Date(clock), webUrl: 'https://app.example.church' });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience: 'admin' }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown, query: Record<string, string> = {}) => engine.handle({ method, path, body, auth, query }) as Promise<any>;

test('an SBI export is read past its preamble and matched to recorded gifts and vouchers', async () => {
  const owner = await signIn('pastor@gracechurch.in');
  // The office recorded a cheque gift and paid a voucher; both should be found on the statement.
  const gift = await call(owner, 'POST', '/admin/giving/donations', { donorName: 'Priya Thomas', donorId: 'p_priya', fundId: 'fd_building', amount: 2500000, method: 'cheque', receivedAt: '2026-10-10T06:30:00.000Z' });
  const heads = await call(owner, 'GET', '/admin/accounts/heads');
  const exp = await call(owner, 'POST', '/admin/expenses', { headId: heads[0].id, date: '2026-10-11', amount: 18500, payee: 'TSSPDCL electricity', description: 'October power bill', method: 'bank_transfer', reference: 'UTR9988776655', paid: true });
  assert.equal(exp.status, 'paid');

  const table = [
    ['Account Name', ':', 'GRACE COMMUNITY CHURCH'],
    ['Account Number', ':', '0000123456'],
    [],
    ['Txn Date', 'Value Date', 'Description', 'Ref No./Cheque No.', 'Debit', 'Credit', 'Balance'],
    ['10 Oct 2026', '10 Oct 2026', 'CHQ DEP - PRIYA THOMAS - 000123', '000123', '', '25,000.00', '5,25,000.00'],
    ['11 Oct 2026', '11 Oct 2026', 'NEFT DR TSSPDCL UTR9988776655', 'UTR9988776655', '18,500.00', '', '5,06,500.00'],
    ['12 Oct 2026', '12 Oct 2026', 'UPI/CR/528812345678/SAMUEL RAJ/okaxis/Offering', '528812345678', '', '1,000.00', '5,07,500.00'],
    ['13 Oct 2026', '13 Oct 2026', 'BY TRANSFER-NEFT*HDFC0000001*N286261234567*RAZORPAY SOFTWARE PVT LTD', 'N286261234567', '', '48,230.50', '5,55,730.50'],
    ['14 Oct 2026', '14 Oct 2026', 'SMS CHARGES', '', '15.00', '', '5,55,715.50'],
    ['15 Oct 2026', '15 Oct 2026', 'NEFT DR GENERATOR SERVICE', 'N123', '7,200.00', '', '5,48,515.50'],
    ['', '', 'Total', '', '25,715.00', '74,230.50', ''],
  ];
  const h = findHeaderRow(table);
  assert.equal(h, 3);
  const mapping = guessBankColumns(table[h]);
  const { lines, problems } = rowsToBankLines(mapping, table.slice(h + 1));
  assert.equal(lines.length, 6);
  assert.deepEqual(problems, []);
  assert.equal(lines[0].amount, 2500000);
  assert.equal(lines[1].amount, -1850000);

  const up = await call(owner, 'POST', '/admin/bank/statements', { account: 'main', bankName: 'SBI', lines });
  assert.equal(up.added, 6);
  assert.equal(up.skipped, 0);
  assert.ok(up.matched >= 4, `matched ${up.matched}`); // cheque gift, voucher, settlement, charges

  let v = await call(owner, 'GET', '/admin/bank', undefined, { account: 'main', from: '2026-10-01', to: '2026-10-31' });
  assert.equal(v.lines.length, 6);
  const by = (n: string) => v.lines.find((l: any) => l.narration.includes(n));
  assert.equal(by('PRIYA THOMAS').match.kind, 'gift');
  assert.equal(by('PRIYA THOMAS').match.id, gift.id);
  assert.equal(by('TSSPDCL').match.kind, 'expense');
  assert.equal(by('TSSPDCL').match.id, exp.id);
  assert.equal(by('RAZORPAY').match.kind, 'settlement');
  assert.equal(by('SMS CHARGES').match.kind, 'charges');
  assert.equal(by('SAMUEL RAJ').match, null);
  assert.equal(by('GENERATOR').match, null);
  assert.equal(v.totals.unmatched, 2);
  assert.equal(v.totals.credits, 2500000 + 100000 + 4823050);
  assert.equal(v.missing.gifts.some((g: any) => g.id === gift.id), false, 'the cheque gift was found on the statement');

  // Record the UPI credit as a gift and the generator debit as a voucher.
  const rg = await call(owner, 'POST', `/admin/bank/lines/${by('SAMUEL RAJ').id}/record-gift`, { fundId: 'fd_tithe', donorName: 'Samuel Raj' });
  assert.equal(rg.gift.method, 'upi');
  assert.equal(rg.gift.amount, 100000);
  assert.ok(rg.gift.receiptNumber);
  assert.equal(rg.line.match.kind, 'gift');
  const re = await call(owner, 'POST', `/admin/bank/lines/${by('GENERATOR').id}/record-expense`, { headId: heads[1].id, payee: 'Sri Sai Generators', description: 'Generator service' });
  assert.equal(re.expense.status, 'paid');
  assert.equal(re.expense.amount, 720000);
  assert.equal(re.expense.method, 'bank_transfer');
  assert.ok(re.expense.voucherNumber.startsWith('PV/'));
  v = await call(owner, 'GET', '/admin/bank', undefined, { account: 'main', from: '2026-10-01', to: '2026-10-31' });
  assert.equal(v.totals.unmatched, 0);

  // Uploading the same file again adds nothing.
  const again = await call(owner, 'POST', '/admin/bank/statements', { account: 'main', bankName: 'SBI', lines });
  assert.equal(again.added, 0);
  assert.equal(again.skipped, 6);

  // Unmatch, then match by hand; a gift cannot be used for two lines.
  const line = by('PRIYA THOMAS');
  const un = await call(owner, 'POST', `/admin/bank/lines/${line.id}/unmatch`);
  assert.equal(un.match, null);
  assert.ok(un.suggestions.some((s: any) => s.id === gift.id), 'the gift is suggested again');
  await call(owner, 'POST', `/admin/bank/lines/${line.id}/match`, { kind: 'gift', id: gift.id });
  const other = await call(owner, 'POST', '/admin/bank/statements', { account: 'main', bankName: 'SBI', lines: [{ date: '2026-10-12', narration: 'CHQ DEP DUPLICATE', ref: null, amount: 2500000, balance: null }] });
  assert.equal(other.added, 1);
  v = await call(owner, 'GET', '/admin/bank', undefined, { account: 'main', from: '2026-10-01', to: '2026-10-31' });
  const dup = v.lines.find((l: any) => l.narration === 'CHQ DEP DUPLICATE');
  assert.equal(dup.match, null);
  assert.equal(dup.suggestions.some((s: any) => s.id === gift.id), false, 'a matched gift is not offered twice');
  await assert.rejects(call(owner, 'POST', `/admin/bank/lines/${dup.id}/match`, { kind: 'gift', id: gift.id }), /already matched/);
  await call(owner, 'POST', `/admin/bank/lines/${dup.id}/ignore`, { as: 'ignored', note: 'Bank reversed it' });

  // Removing a statement removes its lines.
  await call(owner, 'DELETE', `/admin/bank/statements/${other.statement.id}`);
  v = await call(owner, 'GET', '/admin/bank', undefined, { account: 'main' });
  assert.equal(v.statements.length, 1);
  assert.equal(v.accounts[0].id, 'main');
});

test('a committed cash batch is matched to its deposit', async () => {
  const owner = await signIn('pastor@gracechurch.in');
  const batch = await call(owner, 'POST', '/admin/giving/batches', { name: 'Sunday 18 Oct', date: '2026-10-18' });
  await call(owner, 'POST', '/admin/giving/donations', { donorName: 'Anonymous', fundId: 'fd_tithe', amount: 1200000, method: 'cash', receivedAt: '2026-10-18T06:30:00.000Z', batchId: batch.id });
  await call(owner, 'POST', `/admin/giving/batches/${batch.id}/commit`, {});
  const up = await call(owner, 'POST', '/admin/bank/statements', { account: 'main', bankName: 'SBI', lines: [{ date: '2026-10-19', narration: 'CASH DEP CDM KONDAPUR', ref: null, amount: 1200000, balance: null }] });
  assert.equal(up.matched, 1);
  const v = await call(owner, 'GET', '/admin/bank', undefined, { account: 'main', from: '2026-10-19', to: '2026-10-19' });
  assert.equal(v.lines[0].match.kind, 'batch');
  assert.equal(v.lines[0].match.id, batch.id);
});
