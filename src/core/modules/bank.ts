// Bank reconciliation: the treasurer uploads the bank's statement export and Flockwise matches
// each line to a gift, a committed batch deposit or a paid voucher, flags Razorpay settlements
// and bank charges, and records anything the office missed in one step. Parsing of the file is
// shared with the browser in ../bank-presets.ts.
import { ApiError } from '../errors.js';
import type { Ctx, Router } from '../engine.js';
import { narrationKind, narrationPhone, narrationRef, narrationVpa, type BankLineInput } from '../bank-presets.js';
import type { BankAccountId, BankLine, BankLineView, BankMatchKind, BankStatement, BankSuggestion, BankUploadResult, BankView, Collections, ExpenseMethod } from '../types.js';
import { find, fullName, normPhone, settings } from '../util.js';
import { nextVoucher } from './accounts.js';
import { recordGift } from './giving.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;
const BANK_METHODS = new Set(['cheque', 'bank_transfer', 'upi']);
const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / DAY;
const money = (minor: number, c: string) => `${c === 'INR' ? '₹' : c + ' '}${(Math.abs(minor) / 100).toLocaleString('en-IN')}`;

const accountOf = (v: unknown): BankAccountId => (v === 'fcra' ? 'fcra' : 'main');
const lineKey = (account: BankAccountId, l: BankLineInput) => `${account}|${l.date}|${l.amount}|${l.narration.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40)}`;

/** Ids already matched by some line, so one gift cannot explain two credits. */
function matchedIds(ctx: Ctx, kind: BankMatchKind, except?: string) {
  return new Set(ctx.db.all('bankLines').filter((l) => l.id !== except && l.match?.kind === kind && l.match.id).map((l) => l.match!.id as string));
}

const giftDate = (d: Collections['donations']) => (d.paidAt ?? d.createdAt).slice(0, 10);

/** Possible matches for one line, best first. Amounts must agree exactly; the rest is evidence. */
function suggest(ctx: Ctx, line: BankLine): BankSuggestion[] {
  const out: (BankSuggestion & { score: number })[] = [];
  const ref = narrationRef(line.narration);
  const phone = narrationPhone(line.narration);
  const vpa = narrationVpa(line.narration);
  const narr = line.narration.toLowerCase();
  if (line.amount > 0) {
    const usedGifts = matchedIds(ctx, 'gift', line.id);
    for (const d of ctx.db.all('donations')) {
      if (d.status !== 'succeeded' || d.amount !== line.amount || usedGifts.has(d.id) || d.fcra !== (line.account === 'fcra')) continue;
      if (d.provider === 'razorpay' || d.provider === 'stripe' || d.provider === 'demo') continue; // settled in bulk by the gateway
      if (!d.method || !BANK_METHODS.has(d.method) || d.batchId) continue;
      const gap = days(giftDate(d), line.date);
      if (gap > 10) continue;
      let score = 1 - gap / 20;
      const why: string[] = ['same amount'];
      const refs = [d.providerRef, d.receiptNumber, d.providerPaymentId?.replace(/^import:/, '')].filter((x): x is string => !!x && x.length >= 4);
      if (ref && refs.some((r) => r.toUpperCase() === ref.toUpperCase())) { score += 10; why.push('same reference'); }
      else if (refs.some((r) => narr.includes(r.toLowerCase()))) { score += 8; why.push('reference in narration'); }
      if (phone && d.donorPhone && normPhone(d.donorPhone) === phone) { score += 6; why.push('giver’s mobile'); }
      if (vpa && d.upiVpa && d.upiVpa === vpa) { score += 6; why.push('giver’s UPI id'); }
      const surname = d.donorName.split(/\s+/).filter((w) => w.length > 3).map((w) => w.toLowerCase());
      if (surname.some((w) => narr.includes(w))) { score += 3; why.push('name in narration'); }
      if (gap === 0) why.push('same day');
      out.push({ kind: 'gift', id: d.id, label: `${d.donorName} · ${d.fundName}`, date: giftDate(d), amount: d.amount, why: why.join(', '), score });
    }
    const usedBatches = matchedIds(ctx, 'batch', line.id);
    for (const b of ctx.db.all('batches')) {
      if (b.status !== 'committed' || usedBatches.has(b.id)) continue;
      const counted = ctx.db.all('donations').filter((d) => d.batchId === b.id && d.status === 'succeeded').reduce((s, d) => s + d.amount, 0);
      const total = b.sheet ? Math.max(b.sheet.total, counted) : counted; // the sheet includes loose cash
      if (!total || total !== line.amount) continue;
      const gap = days(b.date, line.date);
      if (gap > 14) continue;
      const kind = narrationKind(line.narration);
      out.push({ kind: 'batch', id: b.id, label: `Batch deposit · ${b.name}`, date: b.date, amount: total, why: kind === 'cash' ? 'same amount, cash deposit' : 'same amount', score: 1 - gap / 28 + (kind === 'cash' || kind === 'cheque' ? 4 : 0) });
    }
  } else {
    const used = matchedIds(ctx, 'expense', line.id);
    for (const e of ctx.db.all('expenses')) {
      if (e.status !== 'paid' || e.amount !== -line.amount || used.has(e.id) || e.method === 'cash' || e.fcra !== (line.account === 'fcra')) continue;
      const gap = days(e.date, line.date);
      if (gap > 10) continue;
      let score = 1 - gap / 20;
      const why: string[] = ['same amount'];
      if (ref && e.reference && e.reference.toUpperCase() === ref.toUpperCase()) { score += 10; why.push('same reference'); }
      else if (e.reference && e.reference.length >= 4 && narr.includes(e.reference.toLowerCase())) { score += 8; why.push('reference in narration'); }
      const words = e.payee.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
      if (words.some((w) => narr.includes(w))) { score += 4; why.push('payee in narration'); }
      out.push({ kind: 'expense', id: e.id, label: `${e.payee} · ${e.voucherNumber ?? e.description.slice(0, 30)}`, date: e.date, amount: e.amount, why: why.join(', '), score });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 4).map(({ score, ...s }) => ({ ...s, why: score >= 4 ? `${s.why} (strong)` : s.why }));
}

/** Decides a line by itself when the evidence is clear; otherwise leaves it for the treasurer. */
function autoMatch(ctx: Ctx, line: BankLine): BankLine {
  const kind = narrationKind(line.narration);
  const set = (m: BankLine['match']) => ctx.db.put('bankLines', { ...line, match: m });
  if (kind === 'razorpay' && line.amount > 0) return set({ kind: 'settlement', id: null, label: 'Razorpay settlement (gifts already recorded online)', by: 'auto', note: null });
  if (kind === 'charges' && line.amount < 0 && line.amount > -500000) return set({ kind: 'charges', id: null, label: 'Bank charges', by: 'auto', note: null });
  if (kind === 'interest' && line.amount > 0) return set({ kind: 'interest', id: null, label: 'Bank interest', by: 'auto', note: null });
  const s = suggest(ctx, line);
  if (!s.length) return line;
  const strong = s[0].why.includes('(strong)');
  if (strong || s.length === 1) {
    const top = s[0];
    return set({ kind: top.kind, id: top.id, label: top.label, by: 'auto', note: top.why.replace(' (strong)', '') });
  }
  return line;
}

function view(ctx: Ctx, l: BankLine): BankLineView {
  return { ...l, kind: narrationKind(l.narration), suggestions: l.match ? [] : suggest(ctx, l) };
}

function upload(ctx: Ctx): BankUploadResult {
  const b = ctx.body as { account?: string; bankName?: string; lines?: BankLineInput[] };
  const account = accountOf(b.account);
  if (account === 'fcra' && !settings(ctx).fcra.registered) throw new ApiError(422, 'invalid', 'This church has no FCRA account on record.', { account: 'Choose the main account' });
  const rows = Array.isArray(b.lines) ? b.lines : [];
  if (!rows.length) throw new ApiError(422, 'invalid', 'The file has no statement lines.', { lines: 'Required' });
  if (rows.length > 5000) throw new ApiError(422, 'invalid', 'Upload at most 5,000 lines at a time (a few months of statements).');
  const clean: BankLineInput[] = [];
  for (const r of rows) {
    const date = String(r?.date ?? '').slice(0, 10);
    const amount = Math.round(Number(r?.amount));
    if (!DATE_RE.test(date) || !Number.isFinite(amount) || amount === 0) continue;
    clean.push({ date, narration: String(r.narration ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || 'No narration', ref: r.ref ? String(r.ref).slice(0, 60) : null, amount, balance: Number.isFinite(Number(r.balance)) && r.balance !== null ? Math.round(Number(r.balance)) : null });
  }
  if (!clean.length) throw new ApiError(422, 'invalid', 'No line had both a date and an amount.');
  const existing = new Set(ctx.db.all('bankLines').map((l) => l.key));
  const dates = clean.map((l) => l.date).sort();
  const st: BankStatement = ctx.db.put('bankStatements', {
    id: ctx.id('bs'),
    account,
    bankName: String(b.bankName ?? '').trim().slice(0, 40) || 'Bank',
    from: dates[0],
    to: dates[dates.length - 1],
    lines: 0,
    uploadedAt: ctx.now.toISOString(),
    uploadedBy: ctx.staff?.name ?? 'Office',
  });
  let added = 0, skipped = 0, matched = 0;
  for (const l of clean) {
    const key = lineKey(account, l);
    if (existing.has(key)) { skipped++; continue; }
    existing.add(key);
    const line = ctx.db.put('bankLines', { id: ctx.id('bl'), statementId: st.id, account, ...l, key, match: null, createdAt: ctx.now.toISOString() });
    if (autoMatch(ctx, line).match) matched++;
    added++;
  }
  if (!added) {
    // Everything was uploaded before; keep no empty statement around.
    ctx.db.del('bankStatements', st.id);
    return { statement: st, added, skipped, matched };
  }
  const saved = ctx.db.put('bankStatements', { ...st, lines: added });
  ctx.audit('uploaded', 'bankStatements', st.id, `Uploaded ${saved.bankName} statement ${saved.from} to ${saved.to}: ${added} lines, ${matched} matched by themselves`);
  return { statement: saved, added, skipped, matched };
}

function bankView(ctx: Ctx): BankView {
  const s = settings(ctx);
  const account = accountOf(ctx.query.account);
  const all = ctx.db.all('bankLines').filter((l) => l.account === account);
  const sorted = [...all].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const q = ctx.query;
  const to = DATE_RE.test(q.to ?? '') ? q.to! : (sorted[0]?.date ?? ctx.now.toISOString().slice(0, 10));
  const from = DATE_RE.test(q.from ?? '') ? q.from! : new Date(Date.parse(to) - 60 * DAY).toISOString().slice(0, 10);
  const lines = sorted.filter((l) => l.date >= from && l.date <= to).map((l) => view(ctx, l));
  const credits = lines.filter((l) => l.amount > 0);
  const debits = lines.filter((l) => l.amount < 0);
  const sum = (xs: BankLine[]) => xs.reduce((t, l) => t + Math.abs(l.amount), 0);
  const giftIds = matchedIds(ctx, 'gift');
  const expIds = matchedIds(ctx, 'expense');
  const fcra = account === 'fcra';
  const missingGifts = ctx.db
    .all('donations')
    .filter((d) => d.status === 'succeeded' && d.provider === 'offline' && d.method && BANK_METHODS.has(d.method) && !d.batchId && d.fcra === fcra && !giftIds.has(d.id))
    .filter((d) => giftDate(d) >= from && giftDate(d) <= to)
    .sort((a, b) => giftDate(b).localeCompare(giftDate(a)))
    .map((d) => ({ id: d.id, date: giftDate(d), label: `${d.donorName} · ${d.fundName} · ${d.method}`, amount: d.amount }));
  const missingExpenses = ctx.db
    .all('expenses')
    .filter((e) => e.status === 'paid' && e.method && e.method !== 'cash' && e.fcra === fcra && !expIds.has(e.id) && e.date >= from && e.date <= to)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((e) => ({ id: e.id, date: e.date, label: `${e.payee} · ${e.voucherNumber ?? ''}`, amount: e.amount }));
  return {
    accounts: [{ id: 'main', label: 'Main account' }, ...(s.fcra.registered ? [{ id: 'fcra' as const, label: `FCRA account${s.fcra.accountLast4 ? ` ····${s.fcra.accountLast4}` : ''}` }] : [])],
    account,
    from,
    to,
    statements: ctx.db.all('bankStatements').filter((x) => x.account === account).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)),
    lines,
    totals: { credits: sum(credits), debits: sum(debits), matchedCredits: sum(credits.filter((l) => l.match)), matchedDebits: sum(debits.filter((l) => l.match)), unmatched: lines.filter((l) => !l.match).length, lines: lines.length },
    missing: { gifts: missingGifts, expenses: missingExpenses },
    funds: ctx.db.all('funds').filter((f) => f.active && !f.system).map((f) => ({ id: f.id, name: f.name })),
    heads: ctx.db.all('accountHeads').filter((h) => h.active).map((h) => ({ id: h.id, name: h.name })),
  };
}

const methodFor = (l: BankLine): ExpenseMethod & ('upi' | 'cheque' | 'bank_transfer') => {
  const k = narrationKind(l.narration);
  return k === 'upi' ? 'upi' : k === 'cheque' ? 'cheque' : 'bank_transfer';
};

export function registerBank(r: Router) {
  r.get('/admin/bank', { perm: 'giving.view' }, (ctx) => bankView(ctx));
  r.post('/admin/bank/statements', { perm: 'giving.edit' }, (ctx) => upload(ctx));
  r.del('/admin/bank/statements/:id', { perm: 'giving.edit' }, (ctx) => {
    const st = find(ctx, 'bankStatements', ctx.params[0], 'Statement');
    for (const l of ctx.db.all('bankLines').filter((l) => l.statementId === st.id)) ctx.db.del('bankLines', l.id);
    ctx.db.del('bankStatements', st.id);
    ctx.audit('deleted', 'bankStatements', st.id, `Removed ${st.bankName} statement ${st.from} to ${st.to}`);
  });

  r.post('/admin/bank/lines/:id/match', { perm: 'giving.edit' }, (ctx) => {
    const l = find(ctx, 'bankLines', ctx.params[0], 'Statement line');
    const b = ctx.body as { kind?: string; id?: string };
    const kind = b.kind as BankSuggestion['kind'];
    const id = String(b.id ?? '');
    let label: string;
    if (kind === 'gift') { const d = find(ctx, 'donations', id, 'Gift'); label = `${d.donorName} · ${d.fundName}`; if (d.amount !== l.amount) throw new ApiError(422, 'amount', 'That gift is a different amount from the bank line.'); }
    else if (kind === 'expense') { const e = find(ctx, 'expenses', id, 'Voucher'); label = `${e.payee} · ${e.voucherNumber ?? ''}`; if (e.amount !== -l.amount) throw new ApiError(422, 'amount', 'That voucher is a different amount from the bank line.'); }
    else if (kind === 'batch') { const bt = find(ctx, 'batches', id, 'Batch'); label = `Batch deposit · ${bt.name}`; }
    else throw new ApiError(422, 'invalid', 'Choose a gift, a voucher or a batch.', { kind: 'Required' });
    if (matchedIds(ctx, kind, l.id).has(id)) throw new ApiError(409, 'used', 'Another statement line is already matched to that.');
    const next = ctx.db.put('bankLines', { ...l, match: { kind, id, label, by: 'manual', note: null } });
    return view(ctx, next);
  });

  r.post('/admin/bank/lines/:id/unmatch', { perm: 'giving.edit' }, (ctx) => {
    const l = find(ctx, 'bankLines', ctx.params[0], 'Statement line');
    return view(ctx, ctx.db.put('bankLines', { ...l, match: null }));
  });

  // Bank charges, interest, a transfer between the church's own accounts: nothing to record here.
  r.post('/admin/bank/lines/:id/ignore', { perm: 'giving.edit' }, (ctx) => {
    const l = find(ctx, 'bankLines', ctx.params[0], 'Statement line');
    const b = ctx.body as { as?: string; note?: string };
    const as: BankMatchKind = b.as === 'charges' || b.as === 'interest' || b.as === 'settlement' ? b.as : 'ignored';
    const label = as === 'charges' ? 'Bank charges' : as === 'interest' ? 'Bank interest' : as === 'settlement' ? 'Razorpay settlement (gifts already recorded online)' : 'Not a gift or an expense';
    return view(ctx, ctx.db.put('bankLines', { ...l, match: { kind: as, id: null, label, by: 'manual', note: String(b.note ?? '').trim().slice(0, 200) || null } }));
  });

  // A credit the office never recorded: make it a gift on the spot (cheque, NEFT or UPI to the account).
  r.post('/admin/bank/lines/:id/record-gift', { perm: 'giving.edit' }, (ctx) => {
    const l = find(ctx, 'bankLines', ctx.params[0], 'Statement line');
    if (l.amount <= 0) throw new ApiError(422, 'invalid', 'Only a credit can be recorded as a gift.');
    if (l.match?.kind === 'gift') throw new ApiError(409, 'matched', 'This line is already a gift.');
    const b = ctx.body as { fundId?: string; donorId?: string | null; donorName?: string; pan?: string };
    const donor = b.donorId ? ctx.db.get('people', b.donorId) : undefined;
    const donorName = String(b.donorName ?? '').trim() || (donor ? fullName(donor) : '') || (narrationVpa(l.narration) ? `UPI ${narrationVpa(l.narration)}` : 'Unknown giver');
    const d = recordGift(ctx, { donorName, donorId: donor?.id ?? null, fundId: b.fundId, amount: l.amount, method: methodFor(l), receivedAt: `${l.date}T06:30:00.000Z`, pan: b.pan || undefined, donorCitizenship: l.account === 'fcra' ? 'OTHER' : 'IN' });
    const next = ctx.db.put('bankLines', { ...l, match: { kind: 'gift', id: d.id, label: `${d.donorName} · ${d.fundName}`, by: 'manual', note: 'Recorded from the statement' } });
    ctx.audit('recorded', 'donation', d.id, `Recorded ${money(l.amount, settings(ctx).currency)} from the bank statement as a gift from ${d.donorName}`);
    return { line: view(ctx, next), gift: d };
  });

  // A debit with no voucher: a paid voucher now, numbered like any other.
  r.post('/admin/bank/lines/:id/record-expense', { perm: 'giving.edit' }, (ctx) => {
    const l = find(ctx, 'bankLines', ctx.params[0], 'Statement line');
    if (l.amount >= 0) throw new ApiError(422, 'invalid', 'Only a debit can be recorded as an expense.');
    if (l.match?.kind === 'expense') throw new ApiError(409, 'matched', 'This line is already a voucher.');
    const b = ctx.body as { headId?: string; payee?: string; description?: string };
    const head = find(ctx, 'accountHeads', String(b.headId ?? ''), 'Expense head');
    const payee = String(b.payee ?? '').trim().slice(0, 120) || l.narration.slice(0, 60);
    const description = String(b.description ?? '').trim().slice(0, 500) || `From the bank statement: ${l.narration.slice(0, 120)}`;
    const now = ctx.now.toISOString();
    const by = ctx.staff?.name ?? 'Church office';
    const e = ctx.db.put('expenses', {
      id: ctx.id('ex'),
      voucherNumber: nextVoucher(ctx, l.date),
      date: l.date,
      headId: head.id,
      amount: -l.amount,
      payee,
      description,
      method: methodFor(l),
      reference: narrationRef(l.narration) ?? l.ref,
      fcra: l.account === 'fcra',
      billUrl: null,
      status: 'paid',
      submittedBy: by,
      submittedById: ctx.staff?.id ?? null,
      submittedAt: now,
      decidedBy: by,
      decidedAt: now,
      decisionNote: null,
      paidAt: now,
    });
    const next = ctx.db.put('bankLines', { ...l, match: { kind: 'expense', id: e.id, label: `${e.payee} · ${e.voucherNumber}`, by: 'manual', note: 'Recorded from the statement' } });
    ctx.audit('created', 'expense', e.id, `Recorded ${money(l.amount, settings(ctx).currency)} to ${payee} (${head.name}) from the bank statement`);
    return { line: view(ctx, next), expense: { ...e, headName: head.name, mine: false } };
  });
}
