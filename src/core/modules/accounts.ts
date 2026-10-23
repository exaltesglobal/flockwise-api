// Church accounts: expense heads with yearly budgets, expense requests that a treasurer approves
// and pays, a budget-versus-actual summary, and export to Tally as receipt and payment vouchers.
import { ApiError } from '../errors.js';
import type { Ctx, Router } from '../engine.js';
import type { AccountHead, AccountsSummary, Collections, Expense, ExpenseMethod, ExpenseView, TallySettings } from '../types.js';
import { find, fiscalYearRange, localDate, settings } from '../util.js';

export const DEFAULT_HEADS = [
  'Salaries and honorarium',
  'Electricity and water',
  'Rent and lease',
  'Maintenance and repairs',
  'Missions support',
  'Benevolence and charity',
  'Events and programmes',
  'Sound, media and equipment',
  'Printing and stationery',
  'Travel and conveyance',
  'Bank charges',
  'Building fund expenses',
];
const METHODS: ExpenseMethod[] = ['bank_transfer', 'upi', 'cheque', 'cash'];
const APPROVERS = ['owner', 'admin', 'finance'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (v: unknown, max = 300) => String(v ?? '').trim().slice(0, max);

export function heads(ctx: Ctx) {
  let all = ctx.db.all('accountHeads');
  if (!all.length) {
    for (const name of DEFAULT_HEADS) ctx.db.put('accountHeads', { id: ctx.id('ah'), name, tallyName: null, tallyGroup: 'Indirect Expenses', budgets: {}, active: true });
    all = ctx.db.all('accountHeads');
  }
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

export function tallySettings(ctx: Ctx): TallySettings {
  const s = settings(ctx);
  return { companyName: s.name, bankLedger: 'Bank Account', cashLedger: 'Cash', fcraBankLedger: 'FCRA Bank Account', fundLedgers: {}, incomeGroup: 'Indirect Incomes', ...(s.tally ?? {}) };
}

const view = (ctx: Ctx, e: Expense): ExpenseView => ({ ...e, headName: ctx.db.get('accountHeads', e.headId)?.name ?? 'Unknown head', mine: !!e.submittedById && e.submittedById === ctx.staff?.id });

/** Amount in minor units from rupees typed by a person (e.g. "1,250.50"). */
function toMinor(v: unknown) {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[,₹\s]/g, ''));
  if (!Number.isFinite(n) || n <= 0) throw new ApiError(422, 'invalid', 'Enter the amount.', { amount: 'Enter an amount above zero' });
  return Math.round(n * 100);
}

export function nextVoucher(ctx: Ctx, date: string) {
  const fy = fiscalYearRange(ctx, undefined);
  const d = new Date(`${date}T00:00:00Z`);
  const year = d < fy.from ? fy.start - 1 : d >= fy.to ? fy.start + 1 : fy.start;
  const label = fiscalYearRange(ctx, String(year)).label;
  const key = `voucher:pv:${label}`;
  const n = Number(ctx.db.get('meta', key)?.value ?? 0) + 1;
  ctx.db.put('meta', { id: key, value: String(n) });
  return `PV/${label}/${String(n).padStart(4, '0')}`;
}

function summary(ctx: Ctx, fyLabel?: string): AccountsSummary {
  const fy = fiscalYearRange(ctx, fyLabel);
  const inYear = (iso: string) => {
    const t = new Date(iso).getTime();
    return t >= fy.from.getTime() && t < fy.to.getTime();
  };
  const gifts = ctx.db.all('donations').filter((d) => d.status === 'succeeded' && inYear(d.paidAt ?? d.createdAt));
  const income = new Map<string, { fundId: string; name: string; amount: number; gifts: number }>();
  for (const d of gifts) {
    const row = income.get(d.fundId) ?? { fundId: d.fundId, name: ctx.db.get('funds', d.fundId)?.name ?? d.fundName, amount: 0, gifts: 0 };
    row.amount += d.amount;
    row.gifts++;
    income.set(d.fundId, row);
  }
  const expenses = ctx.db.all('expenses').filter((e) => inYear(`${e.date}T00:00:00Z`));
  const headRows = heads(ctx)
    .map((h) => ({
      headId: h.id,
      name: h.name,
      budget: h.budgets[fy.label] ?? 0,
      spent: expenses.filter((e) => e.headId === h.id && e.status === 'paid').reduce((s, e) => s + e.amount, 0),
      committed: expenses.filter((e) => e.headId === h.id && e.status === 'approved').reduce((s, e) => s + e.amount, 0),
    }))
    .filter((r) => r.budget || r.spent || r.committed || ctx.db.get('accountHeads', r.headId)?.active);
  const months: AccountsSummary['months'] = [];
  for (let i = 0; i < 12; i++) {
    const m = new Date(Date.UTC(fy.from.getUTCFullYear(), fy.from.getUTCMonth() + i, 1)).toISOString().slice(0, 7);
    months.push({
      month: m,
      income: gifts.filter((d) => (d.paidAt ?? d.createdAt).slice(0, 7) === m).reduce((s, d) => s + d.amount, 0),
      expense: expenses.filter((e) => e.status === 'paid' && e.date.slice(0, 7) === m).reduce((s, e) => s + e.amount, 0),
    });
  }
  return {
    fy: fy.label,
    income: [...income.values()].sort((a, b) => b.amount - a.amount),
    expenses: headRows,
    months,
    totals: {
      income: gifts.reduce((s, d) => s + d.amount, 0),
      expense: expenses.filter((e) => e.status === 'paid').reduce((s, e) => s + e.amount, 0),
      budget: headRows.reduce((s, r) => s + r.budget, 0),
      pendingApproval: ctx.db.all('expenses').filter((e) => e.status === 'submitted').reduce((s, e) => s + e.amount, 0),
    },
  };
}

// ----- Tally -----
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const amt = (minor: number) => (minor / 100).toFixed(2);
const tallyDate = (iso: string) => iso.slice(0, 10).replace(/-/g, '');

function entry(ledger: string, minor: number, debit: boolean) {
  // Tally: debits are negative with ISDEEMEDPOSITIVE Yes; credits positive with No.
  return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${debit ? '-' : ''}${amt(minor)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
}

function voucher(type: 'Receipt' | 'Payment', date: string, number: string, party: string, narration: string, lines: string[]) {
  return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${type}" ACTION="Create" OBJVIEW="Accounting Voucher View"><DATE>${tallyDate(date)}</DATE><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME><VOUCHERNUMBER>${esc(number)}</VOUCHERNUMBER><PARTYLEDGERNAME>${esc(party)}</PARTYLEDGERNAME><NARRATION>${esc(narration)}</NARRATION>${lines.join('')}</VOUCHER></TALLYMESSAGE>`;
}

const ledgerMaster = (name: string, parent: string) =>
  `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${esc(name)}" ACTION="Create"><NAME.LIST><NAME>${esc(name)}</NAME></NAME.LIST><PARENT>${esc(parent)}</PARENT></LEDGER></TALLYMESSAGE>`;

export function tallyExport(ctx: Ctx, from: string, to: string, opts: { gifts: boolean; expenses: boolean; ledgers: boolean; daily: boolean }) {
  const t = tallySettings(ctx);
  const fundLedger = (fundId: string, fallback: string) => t.fundLedgers[fundId] || ctx.db.get('funds', fundId)?.name || fallback;
  const headLedger = (h: AccountHead | undefined) => h?.tallyName || h?.name || 'Miscellaneous Expenses';
  const within = (d: string) => d >= from && d <= to;
  const messages: string[] = [];
  const usedIncome = new Set<string>();
  const usedExpense = new Map<string, string>();
  let receipts = 0;
  let payments = 0;
  let incomeTotal = 0;
  let expenseTotal = 0;

  if (opts.gifts) {
    const gifts = ctx.db
      .all('donations')
      .filter((d) => d.status === 'succeeded' && within(localDate(ctx, new Date(d.paidAt ?? d.createdAt))))
      .sort((a, b) => (a.paidAt ?? a.createdAt).localeCompare(b.paidAt ?? b.createdAt));
    const account = (d: Collections['donations']) => (d.method === 'cash' ? t.cashLedger : d.fcra ? t.fcraBankLedger : t.bankLedger);
    if (opts.daily) {
      // One receipt per day, fund and account: lighter for churches with many small gifts.
      const groups = new Map<string, { date: string; fund: string; account: string; amount: number; count: number }>();
      for (const d of gifts) {
        const date = localDate(ctx, new Date(d.paidAt ?? d.createdAt));
        const fund = fundLedger(d.fundId, d.fundName);
        const key = `${date}|${fund}|${account(d)}`;
        const g = groups.get(key) ?? { date, fund, account: account(d), amount: 0, count: 0 };
        g.amount += d.amount;
        g.count++;
        groups.set(key, g);
      }
      let n = 0;
      for (const g of groups.values()) {
        usedIncome.add(g.fund);
        incomeTotal += g.amount;
        receipts++;
        messages.push(voucher('Receipt', g.date, `FW-${g.date.replace(/-/g, '')}-${++n}`, g.account, `${g.count} gift${g.count === 1 ? '' : 's'} to ${g.fund} (Flockwise)`, [entry(g.account, g.amount, true), entry(g.fund, g.amount, false)]));
      }
    } else {
      for (const d of gifts) {
        const fund = fundLedger(d.fundId, d.fundName);
        usedIncome.add(fund);
        incomeTotal += d.amount;
        receipts++;
        const bits = [d.receiptNumber ? `80G receipt ${d.receiptNumber}` : null, d.method?.replace('_', ' '), d.pan ? `PAN ${d.pan}` : null, d.fcra ? 'FCRA' : null].filter(Boolean).join(', ');
        messages.push(voucher('Receipt', localDate(ctx, new Date(d.paidAt ?? d.createdAt)), d.receiptNumber ?? d.id, account(d), `Donation from ${d.donorName}${bits ? ` (${bits})` : ''}`, [entry(account(d), d.amount, true), entry(fund, d.amount, false)]));
      }
    }
  }

  if (opts.expenses) {
    for (const e of ctx.db.all('expenses').filter((x) => x.status === 'paid' && within(x.date)).sort((a, b) => a.date.localeCompare(b.date))) {
      const h = ctx.db.get('accountHeads', e.headId);
      const ledger = headLedger(h);
      usedExpense.set(ledger, h?.tallyGroup || 'Indirect Expenses');
      const account = e.method === 'cash' ? t.cashLedger : e.fcra ? t.fcraBankLedger : t.bankLedger;
      expenseTotal += e.amount;
      payments++;
      messages.push(voucher('Payment', e.date, e.voucherNumber ?? e.id, account, `${e.payee}: ${e.description}${e.reference ? ` (ref ${e.reference})` : ''}`, [entry(ledger, e.amount, true), entry(account, e.amount, false)]));
    }
  }

  const masters = opts.ledgers ? [...[...usedIncome].map((l) => ledgerMaster(l, t.incomeGroup)), ...[...usedExpense].map(([l, g]) => ledgerMaster(l, g))] : [];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(t.companyName)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${masters.join('')}${messages.join('')}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>\n`;
  return { filename: `flockwise-tally-${from}-to-${to}.xml`, xml, receipts, payments, incomeTotal, expenseTotal, ledgers: masters.length };
}

function readHead(ctx: Ctx, base?: AccountHead): Omit<AccountHead, 'id'> {
  const name = ctx.body.name !== undefined ? clean(ctx.body.name, 80) : (base?.name ?? '');
  if (!name) throw new ApiError(422, 'invalid', 'Name the expense head.', { name: 'Required' });
  const budgets = { ...(base?.budgets ?? {}) };
  if (ctx.body.budget !== undefined) {
    const fy = fiscalYearRange(ctx, ctx.body.fy ? String(ctx.body.fy) : undefined).label;
    const n = Number(String(ctx.body.budget).replace(/[,₹\s]/g, ''));
    if (!Number.isFinite(n) || n < 0) throw new ApiError(422, 'invalid', 'Budget should be an amount.', { budget: 'Enter an amount' });
    budgets[fy] = Math.round(n * 100);
  }
  return {
    name,
    tallyName: ctx.body.tallyName !== undefined ? clean(ctx.body.tallyName, 100) || null : (base?.tallyName ?? null),
    tallyGroup: ctx.body.tallyGroup !== undefined ? clean(ctx.body.tallyGroup, 60) || 'Indirect Expenses' : (base?.tallyGroup ?? 'Indirect Expenses'),
    budgets,
    active: ctx.body.active !== undefined ? !!ctx.body.active : (base?.active ?? true),
  };
}

export function registerAccounts(r: Router) {
  r.get('/admin/accounts/summary', { perm: 'giving.view' }, (ctx) => summary(ctx, ctx.query.fy));

  r.get('/admin/accounts/heads', { staff: true }, (ctx) => heads(ctx));
  r.post('/admin/accounts/heads', { perm: 'giving.edit' }, (ctx) => {
    heads(ctx);
    const h = ctx.db.put('accountHeads', { id: ctx.id('ah'), ...readHead(ctx) });
    ctx.audit('created', 'account', h.id, `Added expense head ${h.name}`);
    return h;
  });
  r.patch('/admin/accounts/heads/:id', { perm: 'giving.edit' }, (ctx) => {
    const h = find(ctx, 'accountHeads', ctx.params[0], 'Expense head');
    const next = ctx.db.put('accountHeads', { ...h, ...readHead(ctx, h) });
    ctx.audit('updated', 'account', h.id, `Updated expense head ${next.name}`);
    return next;
  });

  r.get('/admin/accounts/tally', { perm: 'giving.view' }, (ctx) => tallySettings(ctx));
  r.patch('/admin/accounts/tally', { perm: 'giving.edit' }, (ctx) => {
    const cur = tallySettings(ctx);
    const next: TallySettings = { ...cur };
    for (const k of ['companyName', 'bankLedger', 'cashLedger', 'fcraBankLedger', 'incomeGroup'] as const) if (ctx.body[k] !== undefined) next[k] = clean(ctx.body[k], 100) || cur[k];
    if (ctx.body.fundLedgers && typeof ctx.body.fundLedgers === 'object') {
      next.fundLedgers = {};
      for (const [id, name] of Object.entries(ctx.body.fundLedgers as Record<string, unknown>)) if (ctx.db.get('funds', id) && clean(name)) next.fundLedgers[id] = clean(name, 100);
    }
    ctx.db.put('settings', { ...settings(ctx), tally: next });
    ctx.audit('updated', 'settings', null, 'Updated Tally ledger names');
    return next;
  });

  r.get('/admin/accounts/tally-export', { perm: 'giving.view' }, (ctx) => {
    const from = clean(ctx.query.from, 10);
    const to = clean(ctx.query.to, 10);
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) throw new ApiError(422, 'invalid', 'Choose the dates to export.', { from: 'Use YYYY-MM-DD' });
    const out = tallyExport(ctx, from, to, { gifts: ctx.query.gifts !== '0', expenses: ctx.query.expenses !== '0', ledgers: ctx.query.ledgers !== '0', daily: ctx.query.daily === '1' });
    ctx.audit('exported', 'account', null, `Exported ${out.receipts} receipts and ${out.payments} payments to Tally (${from} to ${to})`);
    return out;
  });

  // ----- expenses -----
  r.get('/admin/expenses', { staff: true }, (ctx) => {
    const all = ctx.can('giving.view');
    const mine = !all || ctx.query.mine === '1';
    return ctx.db
      .all('expenses')
      .filter((e) => !mine || e.submittedById === ctx.staff?.id)
      .filter((e) => !ctx.query.status || e.status === ctx.query.status)
      .filter((e) => !ctx.query.headId || e.headId === ctx.query.headId)
      .sort((a, b) => b.date.localeCompare(a.date) || b.submittedAt.localeCompare(a.submittedAt))
      .slice(0, 500)
      .map((e) => view(ctx, e));
  });

  // Any staff member can ask for money; the treasurer can also record a bill already paid.
  r.post('/admin/expenses', { staff: true }, (ctx) => {
    const head = find(ctx, 'accountHeads', String(ctx.body.headId ?? ''), 'Expense head');
    const date = clean(ctx.body.date, 10) || localDate(ctx, ctx.now);
    if (!DATE_RE.test(date)) throw new ApiError(422, 'invalid', 'Enter the date.', { date: 'Use YYYY-MM-DD' });
    const payee = clean(ctx.body.payee, 120);
    const description = clean(ctx.body.description, 500);
    if (!payee || !description) throw new ApiError(422, 'invalid', 'Say who is paid and what for.', { ...(payee ? {} : { payee: 'Required' }), ...(description ? {} : { description: 'Required' }) });
    const paidNow = ctx.body.paid === true && ctx.can('giving.edit');
    const method = METHODS.includes(ctx.body.method) ? (ctx.body.method as ExpenseMethod) : null;
    if (paidNow && !method) throw new ApiError(422, 'invalid', 'How was it paid?', { method: 'Choose how it was paid' });
    const now = ctx.now.toISOString();
    const by = ctx.staff?.name ?? 'Church office';
    const e = ctx.db.put('expenses', {
      id: ctx.id('ex'),
      voucherNumber: paidNow ? nextVoucher(ctx, date) : null,
      date,
      headId: head.id,
      amount: toMinor(ctx.body.amount),
      payee,
      description,
      method,
      reference: clean(ctx.body.reference, 80) || null,
      fcra: !!ctx.body.fcra,
      billUrl: /^https?:\/\//.test(String(ctx.body.billUrl ?? '')) ? clean(ctx.body.billUrl, 500) : null,
      status: paidNow ? 'paid' : 'submitted',
      submittedBy: by,
      submittedById: ctx.staff?.id ?? null,
      submittedAt: now,
      decidedBy: paidNow ? by : null,
      decidedAt: paidNow ? now : null,
      decisionNote: null,
      paidAt: paidNow ? now : null,
    });
    ctx.audit('created', 'expense', e.id, `${paidNow ? 'Recorded' : 'Requested'} ₹${amt(e.amount)} to ${e.payee} (${head.name})`);
    return view(ctx, e);
  });

  r.post('/admin/expenses/:id/decide', { staff: true }, (ctx) => {
    const e = find(ctx, 'expenses', ctx.params[0], 'Expense');
    if (!APPROVERS.includes(ctx.role ?? '')) throw new ApiError(403, 'forbidden', 'Only the owner, an admin or finance can approve expenses.');
    if (e.submittedById && e.submittedById === ctx.staff?.id) throw new ApiError(403, 'own_request', 'Someone else needs to approve your own request.');
    if (e.status !== 'submitted') throw new ApiError(409, 'decided', 'This request has already been decided.');
    const approve = ctx.body.approve === true;
    const note = clean(ctx.body.note, 300) || null;
    if (!approve && !note) throw new ApiError(422, 'invalid', 'Give a reason for turning it down.', { note: 'Required' });
    const next = ctx.db.put('expenses', { ...e, status: approve ? 'approved' : 'rejected', decidedBy: ctx.staff?.name ?? 'Church office', decidedAt: ctx.now.toISOString(), decisionNote: note });
    ctx.audit('updated', 'expense', e.id, `${approve ? 'Approved' : 'Turned down'} ₹${amt(e.amount)} to ${e.payee}`);
    return view(ctx, next);
  });

  r.post('/admin/expenses/:id/pay', { perm: 'giving.edit' }, (ctx) => {
    const e = find(ctx, 'expenses', ctx.params[0], 'Expense');
    if (e.status !== 'approved') throw new ApiError(409, 'not_approved', e.status === 'paid' ? 'This is already paid.' : 'Approve the request before paying it.');
    const method = METHODS.includes(ctx.body.method) ? (ctx.body.method as ExpenseMethod) : null;
    if (!method) throw new ApiError(422, 'invalid', 'How was it paid?', { method: 'Choose how it was paid' });
    const date = DATE_RE.test(String(ctx.body.date)) ? String(ctx.body.date) : localDate(ctx, ctx.now);
    const next = ctx.db.put('expenses', { ...e, status: 'paid', method, date, reference: clean(ctx.body.reference, 80) || e.reference, fcra: ctx.body.fcra !== undefined ? !!ctx.body.fcra : e.fcra, paidAt: ctx.now.toISOString(), voucherNumber: nextVoucher(ctx, date) });
    ctx.audit('updated', 'expense', e.id, `Paid ₹${amt(e.amount)} to ${e.payee} (${next.voucherNumber})`);
    return view(ctx, next);
  });

  // Requests can be withdrawn before they are paid; paid vouchers stay.
  r.del('/admin/expenses/:id', { staff: true }, (ctx) => {
    const e = find(ctx, 'expenses', ctx.params[0], 'Expense');
    if (e.status === 'paid') throw new ApiError(409, 'paid', 'A paid voucher stays in the books.');
    if (e.submittedById !== ctx.staff?.id && !ctx.can('giving.edit')) throw new ApiError(403, 'forbidden', 'Only the person who asked or the treasurer can withdraw this.');
    ctx.db.del('expenses', e.id);
    ctx.audit('deleted', 'expense', e.id, `Withdrew the request for ₹${amt(e.amount)} to ${e.payee}`);
  });
}
