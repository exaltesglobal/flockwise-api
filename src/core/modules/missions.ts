// Missions support: the missionaries a church supports, monthly commitments from members and the church
// budget, money received to each missionary's fund and sent on to them, and field reports that go to
// supporters by email or WhatsApp and show in the member app.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { Channel, Collections, MemberMission, Missionary, MissionaryDetail, MissionaryView, MissionPayout, MissionReport, MissionsOverview, MissionSupport, MissionSupportView, SupportStatus } from '../types.js';
import { dateOnly, find, fiscalYearStart, fullName, giftDate, localDate, requireFields } from '../util.js';
import { channelStatus, deliverAll } from './integrations.js';

// Commitments are giving records, so pastors without giving access don't see them.
const READ = ['giving.view'] as const;
const WRITE = 'giving.edit' as const;
const METHODS: MissionPayout['method'][] = ['bank_transfer', 'upi', 'cheque', 'cash'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const paise = (v: unknown) => Math.max(0, Math.round(Number(v) || 0));
const text = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
const dateOr = (v: unknown, fallback: string) => (typeof v === 'string' && DATE_RE.test(v) ? v : fallback);
const sum = (xs: { amount: number }[]) => xs.reduce((s, x) => s + x.amount, 0);

const giftsTo = (ctx: Ctx, fundId: string) => ctx.db.all('donations').filter((d) => d.fundId === fundId && d.status === 'succeeded');
const payoutsOf = (ctx: Ctx, id: string) => ctx.db.all('missionPayouts').filter((p) => p.missionaryId === id).sort((a, b) => b.date.localeCompare(a.date));
const supportOf = (ctx: Ctx, id: string) => ctx.db.all('missionSupport').filter((s) => s.missionaryId === id);
/** endedOn is the day the commitment stopped. */
const isActive = (ctx: Ctx, s: MissionSupport) => !s.endedOn || s.endedOn > localDate(ctx, ctx.now);
const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));

/** First day of the month n months before the current one. */
function monthStart(ctx: Ctx, n: number) {
  const today = localDate(ctx, ctx.now);
  const d = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 - n, 1));
  return d.toISOString().slice(0, 10);
}

/**
 * Whether a member is keeping their commitment: an AutoPay to the fund counts as kept; otherwise their gifts
 * to the fund over the last three full months (or since they started) should come to at least 90% of it.
 */
function supportView(ctx: Ctx, m: Missionary, s: MissionSupport): MissionSupportView {
  const to = monthStart(ctx, 0);
  // Full months only: a commitment started on the 10th is first due the next month.
  const firstDue = s.startedOn.endsWith('-01') ? s.startedOn : new Date(Date.UTC(Number(s.startedOn.slice(0, 4)), Number(s.startedOn.slice(5, 7)), 1)).toISOString().slice(0, 10);
  const windowStart = [monthStart(ctx, 3), firstDue].sort()[1];
  const from = [monthStart(ctx, 3), s.startedOn].sort()[1];
  const expected3m = s.kind === 'member' ? s.amount * Math.max(0, Math.min(3, monthsBetween(windowStart, to))) : 0;
  const given3m = s.personId ? sum(giftsTo(ctx, m.fundId).filter((d) => d.donorId === s.personId && dateOnly(giftDate(d)) >= from && dateOnly(giftDate(d)) < to)) : 0;
  let status: SupportStatus;
  if (!isActive(ctx, s)) status = 'ended';
  else if (s.kind === 'church') status = 'church';
  else if (s.personId && ctx.db.all('recurring').some((r) => r.donorId === s.personId && r.fundId === m.fundId && r.status === 'active')) status = 'autopay';
  else status = given3m >= expected3m * 0.9 ? 'on_track' : 'behind';
  return { ...s, status, given3m, expected3m };
}

function view(ctx: Ctx, m: Missionary): MissionaryView {
  const fy = fiscalYearStart(ctx).toISOString().slice(0, 10);
  const gifts = giftsTo(ctx, m.fundId);
  const payouts = payoutsOf(ctx, m.id);
  const active = supportOf(ctx, m.id).filter((s) => isActive(ctx, s));
  const committed = sum(active);
  const reports = ctx.db.all('missionReports').filter((r) => r.missionaryId === m.id).sort((a, b) => b.date.localeCompare(a.date));
  return {
    ...m,
    fundName: ctx.db.get('funds', m.fundId)?.name ?? '',
    committed,
    supporters: active.filter((s) => s.kind === 'member').length,
    gap: m.monthlyNeed === null ? null : Math.max(0, m.monthlyNeed - committed),
    receivedFy: sum(gifts.filter((d) => dateOnly(giftDate(d)) >= fy)),
    sentFy: sum(payouts.filter((p) => p.date >= fy)),
    balance: sum(gifts) - sum(payouts),
    lastReportAt: reports[0]?.date ?? null,
    lastPayoutAt: payouts[0]?.date ?? null,
  };
}

function detail(ctx: Ctx, m: Missionary): MissionaryDetail {
  const gifts = giftsTo(ctx, m.fundId);
  const payouts = payoutsOf(ctx, m.id);
  const order: Record<SupportStatus, number> = { behind: 0, on_track: 1, autopay: 2, church: 3, ended: 4 };
  return {
    ...view(ctx, m),
    support: supportOf(ctx, m.id).map((s) => supportView(ctx, m, s)).sort((a, b) => order[a.status] - order[b.status] || b.amount - a.amount),
    reports: ctx.db.all('missionReports').filter((r) => r.missionaryId === m.id).sort((a, b) => b.date.localeCompare(a.date)),
    payouts,
    months: Array.from({ length: 12 }, (_, i) => {
      const month = monthStart(ctx, 11 - i).slice(0, 7);
      return { month, received: sum(gifts.filter((d) => dateOnly(giftDate(d)).startsWith(month))), sent: sum(payouts.filter((p) => p.date.startsWith(month))) };
    }),
  };
}

function missionaryInput(b: Record<string, unknown>): Partial<Missionary> {
  const out: Partial<Missionary> = {};
  if (b.name !== undefined) {
    out.name = text(b.name, 100);
    if (!out.name) throw new ApiError(422, 'validation_failed', 'Give the missionary a name.', { name: 'Required' });
  }
  for (const [k, max] of [['field', 100], ['organisation', 100], ['work', 2000], ['prayerPoints', 2000]] as const) if (b[k] !== undefined) out[k] = text(b[k], max);
  for (const k of ['photoUrl', 'email', 'phone'] as const) if (b[k] !== undefined) out[k] = text(b[k], 300) || null;
  if (b.since !== undefined) out.since = b.since && DATE_RE.test(String(b.since)) ? String(b.since) : null;
  if (b.monthlyNeed !== undefined) out.monthlyNeed = b.monthlyNeed === null || b.monthlyNeed === '' ? null : paise(b.monthlyNeed);
  if (b.showPublic !== undefined) out.showPublic = !!b.showPublic;
  if (b.status === 'active' || b.status === 'ended') out.status = b.status;
  return out;
}

function supportInput(ctx: Ctx, b: Record<string, unknown>): Partial<MissionSupport> {
  const out: Partial<MissionSupport> = {};
  if (b.kind === 'member' || b.kind === 'church') out.kind = b.kind;
  if (b.personId !== undefined) {
    const p = b.personId ? find(ctx, 'people', String(b.personId), 'Person') : null;
    out.personId = p?.id ?? null;
    if (p && b.name === undefined) out.name = fullName(p);
  }
  if (b.name !== undefined) out.name = text(b.name, 100);
  if (b.amount !== undefined) {
    out.amount = paise(b.amount);
    if (!out.amount) throw new ApiError(422, 'validation_failed', 'Enter the monthly amount.', { amount: 'Required' });
  }
  if (b.startedOn !== undefined) out.startedOn = dateOr(b.startedOn, localDate(ctx, ctx.now));
  if (b.endedOn !== undefined) out.endedOn = b.endedOn ? dateOr(b.endedOn, localDate(ctx, ctx.now)) : null;
  return out;
}

function reportInput(b: Record<string, unknown>, fallbackDate: string): Partial<MissionReport> {
  const out: Partial<MissionReport> = {};
  if (b.title !== undefined) {
    out.title = text(b.title, 140);
    if (!out.title) throw new ApiError(422, 'validation_failed', 'Give the report a title.', { title: 'Required' });
  }
  if (b.body !== undefined) out.body = text(b.body, 8000);
  if (b.prayerPoints !== undefined) out.prayerPoints = text(b.prayerPoints, 2000);
  if (b.date !== undefined) out.date = dateOr(b.date, fallbackDate);
  if (b.published !== undefined) out.published = !!b.published;
  return out;
}

/** Each supporter by email when they have one and allow it, otherwise WhatsApp (or SMS). */
async function sendReport(ctx: Ctx, m: Missionary, r: MissionReport) {
  const st = channelStatus(ctx);
  const phoneChannel: Channel = st.whatsapp.configured || !st.sms.configured ? 'whatsapp' : 'sms';
  const people = [...new Set(supportOf(ctx, m.id).filter((s) => s.kind === 'member' && s.personId && isActive(ctx, s)).map((s) => s.personId!))]
    .map((id) => ctx.db.get('people', id))
    .filter((p): p is Collections['people'] => !!p);
  const byEmail = people.filter((p) => p.email && p.consent.email);
  const byPhone = people.filter((p) => !byEmail.includes(p) && p.phone && (p.consent.whatsapp || p.consent.sms));
  const subject = `${m.name}: ${r.title}`;
  const full = [r.body, r.prayerPoints && `Please pray:\n${r.prayerPoints}`].filter(Boolean).join('\n\n');
  const short = `${m.name} (${m.field}): ${r.title}. ${r.body.slice(0, 280)}${r.body.length > 280 ? '…' : ''}${r.prayerPoints ? ` Please pray: ${r.prayerPoints.replace(/\s*\n\s*/g, '; ')}` : ''}`;
  const a = byEmail.length ? await deliverAll(ctx, 'email', byEmail.map((p) => ({ to: p.email!, name: fullName(p), subject, text: full }))) : [];
  const b = byPhone.length ? await deliverAll(ctx, phoneChannel, byPhone.map((p) => ({ to: p.phone!, name: fullName(p), subject, text: short }))) : [];
  const sent = [...a, ...b].filter((x) => x.ok).length;
  return { sent, failed: a.length + b.length - sent, unreachable: people.length - byEmail.length - byPhone.length };
}

function memberMission(ctx: Ctx, m: Missionary, me: string | null): MemberMission {
  const v = view(ctx, m);
  const mine = me ? supportOf(ctx, m.id).find((s) => s.personId === me && isActive(ctx, s)) : undefined;
  return {
    id: m.id,
    name: m.name,
    photoUrl: m.photoUrl,
    field: m.field,
    organisation: m.organisation,
    work: m.work,
    prayerPoints: m.prayerPoints,
    fundId: m.fundId,
    monthlyNeed: m.monthlyNeed,
    committed: v.committed,
    reports: ctx.db.all('missionReports').filter((r) => r.missionaryId === m.id && r.published).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3).map(({ id, date, title, body, prayerPoints }) => ({ id, date, title, body, prayerPoints })),
    mine: mine ? { amount: mine.amount, status: supportView(ctx, m, mine).status } : null,
  };
}

export function registerMissions(r: Router) {
  r.get('/admin/missions', { perm: [...READ] }, (ctx): MissionsOverview => {
    const all = ctx.db.all('missionaries').sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === 'active' ? -1 : 1));
    const views = all.map((m) => view(ctx, m));
    const active = views.filter((m) => m.status === 'active');
    return {
      missionaries: views,
      committed: active.reduce((s, m) => s + m.committed, 0),
      needed: active.reduce((s, m) => s + (m.monthlyNeed ?? 0), 0),
      receivedFy: views.reduce((s, m) => s + m.receivedFy, 0),
      sentFy: views.reduce((s, m) => s + m.sentFy, 0),
      behind: all
        .filter((m) => m.status === 'active')
        .flatMap((m) => supportOf(ctx, m.id).map((s) => supportView(ctx, m, s)).filter((s) => s.status === 'behind').map((s) => ({ missionaryId: m.id, missionaryName: m.name, supportId: s.id, name: s.name }))),
    };
  });

  r.post('/admin/missions', { perm: WRITE }, (ctx) => {
    requireFields(ctx.body, ['name']);
    const input = missionaryInput(ctx.body);
    const fundId = ctx.body.fundId
      ? find(ctx, 'funds', String(ctx.body.fundId), 'Fund').id
      : ctx.db.put('funds', { id: ctx.id('fd'), name: `Missions · ${input.name}`, description: `Support for ${input.name}${input.field ? ` in ${input.field}` : ''}.`, taxDeductible: ctx.body.taxDeductible !== false, active: true, goal: null }).id;
    const m: Missionary = { id: ctx.id('ms'), name: '', photoUrl: null, field: '', organisation: '', work: '', since: null, status: 'active', fundId, monthlyNeed: null, email: null, phone: null, prayerPoints: '', showPublic: true, createdAt: ctx.now.toISOString(), ...input };
    ctx.db.put('missionaries', m);
    return detail(ctx, m);
  });
  r.get('/admin/missions/:id', { perm: [...READ] }, (ctx) => detail(ctx, find(ctx, 'missionaries', ctx.params[0], 'Missionary')));
  r.patch('/admin/missions/:id', { perm: WRITE }, (ctx) => {
    const m = find(ctx, 'missionaries', ctx.params[0], 'Missionary');
    const next = { ...m, ...missionaryInput(ctx.body) };
    ctx.db.put('missionaries', next);
    // Keep the fund's name in step while it is still the one made for this missionary.
    const fund = ctx.db.get('funds', m.fundId);
    if (fund && next.name !== m.name && fund.name === `Missions · ${m.name}`) ctx.db.put('funds', { ...fund, name: `Missions · ${next.name}` });
    if (fund && next.status !== m.status && fund.name.startsWith('Missions · ')) ctx.db.put('funds', { ...fund, active: next.status === 'active' });
    return detail(ctx, next);
  });
  r.del('/admin/missions/:id', { perm: WRITE }, (ctx) => {
    const m = find(ctx, 'missionaries', ctx.params[0], 'Missionary');
    if (giftsTo(ctx, m.fundId).length || payoutsOf(ctx, m.id).length)
      throw new ApiError(409, 'invalid_state', 'Gifts or payments are recorded for this missionary, so keep the record and mark the support as ended instead.');
    for (const k of ['missionSupport', 'missionReports'] as const) for (const x of ctx.db.all(k).filter((x) => x.missionaryId === m.id)) ctx.db.del(k, x.id);
    ctx.db.del('missionaries', m.id);
    return { ok: true };
  });

  r.post('/admin/missions/:id/support', { perm: WRITE }, (ctx) => {
    const m = find(ctx, 'missionaries', ctx.params[0], 'Missionary');
    requireFields(ctx.body, ['amount']);
    const input = supportInput(ctx, ctx.body);
    const kind = input.kind ?? (input.personId ? 'member' : 'church');
    const name = input.name || (kind === 'church' ? 'Church budget' : '');
    if (!name) throw new ApiError(422, 'validation_failed', 'Pick the supporter or type a name.', { name: 'Required' });
    if (input.personId && supportOf(ctx, m.id).some((s) => s.personId === input.personId && isActive(ctx, s)))
      throw new ApiError(409, 'conflict', `${name} already supports ${m.name}. Change their amount instead.`);
    ctx.db.put('missionSupport', { id: ctx.id('mss'), missionaryId: m.id, kind, personId: null, amount: 0, startedOn: localDate(ctx, ctx.now), endedOn: null, createdAt: ctx.now.toISOString(), ...input, name });
    return detail(ctx, m);
  });
  r.patch('/admin/missions/:id/support/:sid', { perm: WRITE }, (ctx) => {
    const m = find(ctx, 'missionaries', ctx.params[0], 'Missionary');
    const s = find(ctx, 'missionSupport', ctx.params[1], 'Commitment');
    if (s.missionaryId !== m.id) throw new ApiError(404, 'not_found', 'Commitment not found.');
    ctx.db.put('missionSupport', { ...s, ...supportInput(ctx, ctx.body), missionaryId: m.id });
    return detail(ctx, m);
  });
  r.del('/admin/missions/:id/support/:sid', { perm: WRITE }, (ctx) => {
    const m = find(ctx, 'missionaries', ctx.params[0], 'Missionary');
    const s = find(ctx, 'missionSupport', ctx.params[1], 'Commitment');
    if (s.missionaryId === m.id) ctx.db.del('missionSupport', s.id);
    return detail(ctx, m);
  });

  r.post('/admin/missions/:id/payouts', { perm: WRITE }, (ctx) => {
    const m = find(ctx, 'missionaries', ctx.params[0], 'Missionary');
    const amount = paise(ctx.body.amount);
    if (!amount) throw new ApiError(422, 'validation_failed', 'Enter the amount sent.', { amount: 'Required' });
    const method = METHODS.includes(ctx.body.method as MissionPayout['method']) ? (ctx.body.method as MissionPayout['method']) : 'bank_transfer';
    const date = dateOr(ctx.body.date, localDate(ctx, ctx.now));
    if (date > localDate(ctx, ctx.now)) throw new ApiError(422, 'validation_failed', 'Record money once it has been sent.', { date: 'In the future' });
    ctx.db.put('missionPayouts', { id: ctx.id('msp'), missionaryId: m.id, date, amount, method, reference: text(ctx.body.reference, 80), note: text(ctx.body.note, 400), by: ctx.staff?.name ?? '', createdAt: ctx.now.toISOString() });
    return detail(ctx, m);
  });
  r.del('/admin/missions/:id/payouts/:pid', { perm: WRITE }, (ctx) => {
    const m = find(ctx, 'missionaries', ctx.params[0], 'Missionary');
    const p = find(ctx, 'missionPayouts', ctx.params[1], 'Payment');
    if (p.missionaryId === m.id) ctx.db.del('missionPayouts', p.id);
    return detail(ctx, m);
  });

  r.post('/admin/missions/:id/reports', { perm: [WRITE, 'comms'] }, async (ctx) => {
    const m = find(ctx, 'missionaries', ctx.params[0], 'Missionary');
    requireFields(ctx.body, ['title']);
    const today = localDate(ctx, ctx.now);
    const rep: MissionReport = { id: ctx.id('msr'), missionaryId: m.id, date: today, title: '', body: '', prayerPoints: '', published: true, sentAt: null, sentCount: 0, createdAt: ctx.now.toISOString(), ...reportInput(ctx.body, today) };
    ctx.db.put('missionReports', rep);
    if (ctx.body.send) {
      const res = await sendReport(ctx, m, rep);
      ctx.db.put('missionReports', { ...rep, sentAt: ctx.now.toISOString(), sentCount: res.sent });
      return { ...detail(ctx, m), delivery: res };
    }
    return detail(ctx, m);
  });
  r.patch('/admin/missions/:id/reports/:rid', { perm: [WRITE, 'comms'] }, (ctx) => {
    const m = find(ctx, 'missionaries', ctx.params[0], 'Missionary');
    const rep = find(ctx, 'missionReports', ctx.params[1], 'Report');
    ctx.db.put('missionReports', { ...rep, ...reportInput(ctx.body, rep.date) });
    return detail(ctx, m);
  });
  r.post('/admin/missions/:id/reports/:rid/send', { perm: [WRITE, 'comms'] }, async (ctx) => {
    const m = find(ctx, 'missionaries', ctx.params[0], 'Missionary');
    const rep = find(ctx, 'missionReports', ctx.params[1], 'Report');
    const res = await sendReport(ctx, m, rep);
    ctx.db.put('missionReports', { ...rep, sentAt: ctx.now.toISOString(), sentCount: rep.sentCount + res.sent });
    return { ...detail(ctx, m), delivery: res };
  });
  r.del('/admin/missions/:id/reports/:rid', { perm: [WRITE, 'comms'] }, (ctx) => {
    const m = find(ctx, 'missionaries', ctx.params[0], 'Missionary');
    const rep = find(ctx, 'missionReports', ctx.params[1], 'Report');
    if (rep.missionaryId === m.id) ctx.db.del('missionReports', rep.id);
    return detail(ctx, m);
  });

  // Members: who the church supports, field news, and their own monthly commitment.
  const listed = (ctx: Ctx) => ctx.db.all('missionaries').filter((m) => m.status === 'active' && m.showPublic).sort((a, b) => a.name.localeCompare(b.name));
  r.get('/missions', {}, (ctx) => listed(ctx).map((m) => memberMission(ctx, m, ctx.me())));
  r.put('/missions/:id/support', {}, (ctx) => {
    const m = listed(ctx).find((x) => x.id === ctx.params[0]);
    if (!m) throw new ApiError(404, 'not_found', 'Missionary not found.');
    const me = find(ctx, 'people', ctx.me(), 'Profile');
    const amount = paise(ctx.body.amount);
    if (amount < 100) throw new ApiError(422, 'validation_failed', 'Enter a monthly amount.', { amount: 'Required' });
    const current = supportOf(ctx, m.id).find((s) => s.personId === me.id && isActive(ctx, s));
    if (current) ctx.db.put('missionSupport', { ...current, amount });
    else ctx.db.put('missionSupport', { id: ctx.id('mss'), missionaryId: m.id, kind: 'member', personId: me.id, name: fullName(me), amount, startedOn: localDate(ctx, ctx.now), endedOn: null, createdAt: ctx.now.toISOString() });
    return memberMission(ctx, m, me.id);
  });
  r.del('/missions/:id/support', {}, (ctx) => {
    const m = listed(ctx).find((x) => x.id === ctx.params[0]);
    if (!m) throw new ApiError(404, 'not_found', 'Missionary not found.');
    const me = ctx.me();
    for (const s of supportOf(ctx, m.id).filter((s) => s.personId === me && isActive(ctx, s))) ctx.db.put('missionSupport', { ...s, endedOn: localDate(ctx, ctx.now) });
    return memberMission(ctx, m, me);
  });
}
