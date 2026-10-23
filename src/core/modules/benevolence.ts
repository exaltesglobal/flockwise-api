// Benevolence fund: a member quietly asks the church for help (medical bill, school fees, rent,
// food, a funeral), the pastors review and approve an amount, and the payment is recorded as a
// voucher against the benevolence head. Only staff with the care permission see the requests.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { AidKind, AidRequest, AidStatus, BenevolenceHub, ExpenseMethod, MyAid } from '../types.js';
import { find, fullName, localDate, money, settings } from '../util.js';
import { heads, nextVoucher } from './accounts.js';
import { notify, pastorIds } from './notify.js';

export const AID_KINDS: AidKind[] = ['medical', 'education', 'rent', 'food', 'funeral', 'other'];
const METHODS: ExpenseMethod[] = ['bank_transfer', 'upi', 'cheque', 'cash'];
const OPEN: AidStatus[] = ['requested', 'reviewing'];
const HEAD = 'Benevolence and welfare';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
const minor = (v: unknown) => { const n = Math.round(Number(v)); if (!Number.isFinite(n) || n <= 0) throw new ApiError(422, 'validation', 'Enter the amount in paise.'); return n; };
const tag = (a: AidRequest) => `aid request ${a.id.slice(-4)} (${a.kind})`;

/** The giving fund that pays for help: chosen in settings, else the first fund that sounds like one. */
export function benevolenceFund(ctx: Ctx) {
  const funds = ctx.db.all('funds');
  const chosen = settings(ctx).benevolenceFundId ? funds.find((f) => f.id === settings(ctx).benevolenceFundId) : null;
  return chosen ?? funds.find((f) => /benevolen|welfare|mercy|compassion|poor|relief|charity/i.test(f.name)) ?? null;
}

function benevolenceHead(ctx: Ctx) {
  return heads(ctx).find((h) => h.name === HEAD) ?? ctx.db.put('accountHeads', { id: ctx.id('ah'), name: HEAD, tallyName: null, tallyGroup: 'Indirect Expenses', budgets: {}, active: true });
}

export function hub(ctx: Ctx, status: string): BenevolenceHub {
  const fund = benevolenceFund(ctx);
  const all = ctx.db.all('aidRequests');
  const received = fund ? ctx.db.all('donations').filter((d) => d.fundId === fund.id && d.status === 'succeeded').reduce((s, d) => s + d.amount, 0) : 0;
  const paid = all.filter((a) => a.status === 'paid').reduce((s, a) => s + (a.approved ?? a.amount), 0);
  const pick = (a: AidRequest) => status === 'open' ? OPEN.includes(a.status) : status === 'approved' ? a.status === 'approved' : status === 'paid' ? a.status === 'paid' : status === 'closed' ? ['declined', 'withdrawn'].includes(a.status) : true;
  return {
    summary: { fundId: fund?.id ?? null, fundName: fund?.name ?? null, received, paid, balance: received - paid, open: all.filter((a) => OPEN.includes(a.status)).length, approvedUnpaid: all.filter((a) => a.status === 'approved').reduce((s, a) => s + (a.approved ?? a.amount), 0) },
    requests: all.filter(pick).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)),
    funds: ctx.db.all('funds').map((f) => ({ id: f.id, name: f.name })),
    kinds: AID_KINDS,
  };
}

function newRequest(ctx: Ctx, personId: string, body: Record<string, unknown>, source: 'member' | 'office', by: string): AidRequest {
  const p = find(ctx, 'people', personId, 'Person');
  const kind = AID_KINDS.includes(body.kind as AidKind) ? (body.kind as AidKind) : 'other';
  const reason = clean(body.reason, 2000);
  if (!reason) throw new ApiError(422, 'validation', 'Say a little about what the help is for.', { reason: 'Required' });
  if (ctx.db.all('aidRequests').some((a) => a.personId === p.id && OPEN.includes(a.status))) throw new ApiError(409, 'duplicate', 'There is already an open request for this person.');
  const a: AidRequest = {
    id: ctx.id('aid'), personId: p.id, personName: fullName(p), phone: p.phone ?? null, kind, amount: minor(body.amount), approved: null, currency: settings(ctx).currency, reason,
    status: 'requested', requestedAt: ctx.now.toISOString(), requestedBy: by, source, decidedBy: null, decidedAt: null, decisionNote: '', paidAt: null, paidBy: null, paidVia: null, paidRef: null, expenseId: null, notes: [],
  };
  ctx.db.put('aidRequests', a);
  ctx.audit('created', 'aid', a.id, `New ${tag(a)} for ${money(ctx, a.amount)}`);
  return a;
}

const mine = (ctx: Ctx): MyAid => ({
  requests: ctx.db.all('aidRequests').filter((a) => a.personId === ctx.me()).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)).map(({ id, kind, amount, approved, currency, reason, status, requestedAt, decisionNote, paidAt }) => ({ id, kind, amount, approved, currency, reason, status, requestedAt, decisionNote, paidAt })),
  kinds: AID_KINDS,
});

export function registerBenevolence(r: Router) {
  // ----- office (care permission; amounts and names never leave this page) -----
  r.get('/admin/benevolence', { perm: 'care' }, (ctx) => hub(ctx, clean(ctx.query.status, 10) || 'open'));
  r.put('/admin/benevolence/settings', { perm: 'care' }, (ctx) => {
    const fundId = ctx.body.fundId === null ? null : find(ctx, 'funds', String(ctx.body.fundId ?? ''), 'Fund').id;
    const s = settings(ctx);
    ctx.db.put('settings', { ...s, benevolenceFundId: fundId });
    ctx.audit('updated', 'settings', 'church', `Benevolence fund set to ${fundId ? ctx.db.get('funds', fundId)?.name : 'none'}`);
    return hub(ctx, 'open').summary;
  });
  r.post('/admin/benevolence', { perm: 'care' }, (ctx) => newRequest(ctx, String(ctx.body.personId ?? ''), ctx.body, 'office', ctx.staff?.name ?? 'office'));
  r.patch('/admin/benevolence/:id', { perm: 'care' }, async (ctx) => {
    const a = find(ctx, 'aidRequests', ctx.params[0], 'Request');
    const status = String(ctx.body.status ?? '');
    const by = ctx.staff?.name ?? 'office';
    const note = clean(ctx.body.note, 1000);
    let next: AidRequest = { ...a };
    if (status === 'reviewing') {
      if (a.status !== 'requested') throw new ApiError(409, 'status', 'Only a new request can be marked as being looked at.');
      next = { ...a, status: 'reviewing' };
    } else if (status === 'approved' || status === 'declined') {
      if (!OPEN.includes(a.status)) throw new ApiError(409, 'status', 'This request has already been decided.');
      const approved = status === 'approved' ? (ctx.body.approved !== undefined ? minor(ctx.body.approved) : a.amount) : null;
      next = { ...a, status, approved, decidedBy: by, decidedAt: ctx.now.toISOString(), decisionNote: note };
      ctx.db.put('aidRequests', next);
      ctx.audit(status, 'aid', a.id, `${tag(a)} ${status}${approved ? ` for ${money(ctx, approved)}` : ''}`);
      await notify(ctx, 'aid.update', {
        personIds: [a.personId], link: '/app/aid',
        title: status === 'approved' ? `${settings(ctx).name}: we can help` : `${settings(ctx).name}: about your request`,
        body: status === 'approved' ? `The church has approved ${money(ctx, approved!)} towards your request.${note ? ` ${note}` : ''} We will be in touch about the payment.` : `We are sorry we cannot help with this request right now.${note ? ` ${note}` : ''} A pastor is happy to talk it through with you.`,
      });
      return next;
    } else if (status === 'withdrawn') {
      if (!OPEN.includes(a.status) && a.status !== 'approved') throw new ApiError(409, 'status', 'A paid request cannot be withdrawn.');
      next = { ...a, status: 'withdrawn', decidedBy: by, decidedAt: ctx.now.toISOString(), decisionNote: note };
    } else if (ctx.body.approved !== undefined && a.status === 'approved') {
      next = { ...a, approved: minor(ctx.body.approved) };
    } else throw new ApiError(422, 'validation', 'Nothing to change.');
    ctx.db.put('aidRequests', next);
    ctx.audit('updated', 'aid', a.id, `${tag(a)} → ${next.status}`);
    return next;
  });
  r.post('/admin/benevolence/:id/pay', { perm: 'care' }, async (ctx) => {
    const a = find(ctx, 'aidRequests', ctx.params[0], 'Request');
    if (a.status !== 'approved') throw new ApiError(409, 'status', 'Approve the request before recording the payment.');
    const via = METHODS.includes(ctx.body.via) ? (ctx.body.via as ExpenseMethod) : null;
    if (!via) throw new ApiError(422, 'validation', 'How was it paid?', { via: 'bank_transfer, upi, cheque or cash' });
    const date = clean(ctx.body.date, 10) || localDate(ctx, ctx.now);
    if (!DATE_RE.test(date)) throw new ApiError(422, 'validation', 'Use YYYY-MM-DD for the date.');
    const amount = ctx.body.amount !== undefined ? minor(ctx.body.amount) : a.approved ?? a.amount;
    const by = ctx.staff?.name ?? 'office';
    const head = benevolenceHead(ctx);
    const e = ctx.db.put('expenses', {
      id: ctx.id('ex'), voucherNumber: nextVoucher(ctx, date), date, headId: head.id, amount, payee: a.personName, description: `Benevolence: ${a.kind} (request ${a.id.slice(-4)})`,
      method: via, reference: clean(ctx.body.reference, 80) || null, fcra: false, billUrl: null, status: 'paid', submittedBy: by, submittedById: ctx.staff?.id ?? null, submittedAt: ctx.now.toISOString(),
      decidedBy: by, decidedAt: ctx.now.toISOString(), decisionNote: null, paidAt: ctx.now.toISOString(),
    });
    const next: AidRequest = { ...a, status: 'paid', approved: amount, paidAt: ctx.now.toISOString(), paidBy: by, paidVia: via, paidRef: e.reference, expenseId: e.id };
    ctx.db.put('aidRequests', next);
    ctx.audit('paid', 'aid', a.id, `${tag(a)} paid ${money(ctx, amount)} (${e.voucherNumber})`);
    await notify(ctx, 'aid.update', { personIds: [a.personId], link: '/app/aid', title: `${settings(ctx).name}: help sent`, body: `${money(ctx, amount)} has been sent to you${via === 'cash' ? ' in cash' : via === 'cheque' ? ' by cheque' : ''}. You are in our prayers.` });
    return next;
  });
  r.post('/admin/benevolence/:id/notes', { perm: 'care' }, (ctx) => {
    const a = find(ctx, 'aidRequests', ctx.params[0], 'Request');
    const text = clean(ctx.body.text, 1000);
    if (!text) throw new ApiError(422, 'validation', 'Write the note.');
    return ctx.db.put('aidRequests', { ...a, notes: [...a.notes, { at: ctx.now.toISOString(), by: ctx.staff?.name ?? 'office', text }] });
  });

  // ----- member app -----
  r.get('/me/aid', {}, (ctx) => mine(ctx));
  r.post('/me/aid', {}, async (ctx) => {
    const a = newRequest(ctx, ctx.me(), ctx.body, 'member', fullName(find(ctx, 'people', ctx.me(), 'Person')));
    await notify(ctx, 'aid.new', { personIds: pastorIds(ctx), link: '/admin/benevolence', title: `${settings(ctx).name}: a request for help`, body: `A member has asked the benevolence fund for ${money(ctx, a.amount)} (${a.kind}). Open the Benevolence page to review it.` });
    return mine(ctx);
  });
  r.del('/me/aid/:id', {}, (ctx) => {
    const a = find(ctx, 'aidRequests', ctx.params[0], 'Request');
    if (a.personId !== ctx.me()) throw new ApiError(404, 'not_found', 'Request not found.');
    if (!OPEN.includes(a.status)) throw new ApiError(409, 'status', 'This request has already been decided.');
    ctx.db.put('aidRequests', { ...a, status: 'withdrawn', decidedAt: ctx.now.toISOString(), decidedBy: 'member', decisionNote: 'Withdrawn by the member' });
    ctx.audit('withdrawn', 'aid', a.id, `${tag(a)} withdrawn by the member`);
    return mine(ctx);
  });
}
