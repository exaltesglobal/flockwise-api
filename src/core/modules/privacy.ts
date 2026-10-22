// Privacy under India's Digital Personal Data Protection Act, 2023: every consent change is recorded,
// members can download their data and ask for it to be corrected or erased, and the office answers
// those requests with a due date. The church names a grievance officer members can contact.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { Collections, Consent, ConsentPurpose, ConsentSource, DataRequest, DataRequestKind, MemberPrivacy, PrivacyOverview, PrivacySettings } from '../types.js';
import { age, DAY, find, fullName, normPhone, settings } from '../util.js';
import { removePerson } from './people.js';

const PURPOSES: ConsentPurpose[] = ['email', 'sms', 'whatsapp', 'directory'];
const KINDS: DataRequestKind[] = ['access', 'correction', 'erasure', 'grievance'];
const DUE_DAYS = 30;

export function privacySettings(ctx: Ctx): PrivacySettings {
  const s = settings(ctx);
  const p = s.privacy ?? {};
  return {
    officerName: p.officerName ?? '',
    officerEmail: p.officerEmail ?? s.email ?? '',
    officerPhone: p.officerPhone ?? s.phone ?? '',
    notice:
      p.notice ||
      `${s.name} keeps your contact details, family, attendance, serving and giving records to care for you as a church family and to issue tax receipts. We never sell your data. You can change what we contact you about below, download your data, or ask us to correct or delete it.`,
    reviewAfterMonths: p.reviewAfterMonths ?? 24,
  };
}

/** Records each consent that changed. Call it whenever a person's consent is saved. */
export function logConsent(ctx: Ctx, personId: string, before: Consent | null | undefined, after: Consent, source: ConsentSource) {
  const by = source === 'member' ? 'Self' : source === 'whatsapp' ? 'WhatsApp reply' : ctx.staff?.name ?? 'Office';
  for (const purpose of PURPOSES) {
    if (before && before[purpose] === after[purpose]) continue;
    ctx.db.put('consentLog', { id: ctx.id('cl'), personId, at: ctx.now.toISOString(), purpose, granted: !!after[purpose], source, by });
  }
}

/** Everything the church holds about one person, for the right of access. Confidential pastoral notes stay out. */
export function personData(ctx: Ctx, p: Collections['people']) {
  const id = p.id;
  const events = new Map(ctx.db.all('events').map((e) => [e.id, e.title]));
  const groups = new Map(ctx.db.all('groups').map((g) => [g.id, g.name]));
  const teams = new Map(ctx.db.all('teams').map((t) => [t.id, t.name]));
  return {
    exportedAt: ctx.now.toISOString(),
    church: settings(ctx).name,
    profile: { ...p, checkinCode: undefined },
    household: p.householdName ? ctx.db.all('people').filter((x) => x.householdName === p.householdName && x.id !== id).map((x) => fullName(x)) : [],
    consent: p.consent,
    consentHistory: ctx.db.all('consentLog').filter((c) => c.personId === id).map(({ at, purpose, granted, source }) => ({ at, purpose, granted, source })),
    groups: ctx.db.all('groupMembers').filter((m) => m.personId === id).map((m) => ({ group: groups.get(m.groupId) ?? m.groupId, since: m.since })),
    attendance: ctx.db.all('checkins').filter((c) => c.personId === id).map((c) => ({ event: events.get(c.eventId) ?? c.eventId, at: c.at })),
    rsvps: ctx.db.all('rsvps').filter((r) => r.personId === id).map((r) => ({ event: events.get(r.eventId) ?? r.eventId, at: r.at })),
    serving: ctx.db.all('assignments').filter((a) => a.personId === id).map((a) => ({ event: events.get(a.eventId) ?? a.eventId, team: teams.get(a.teamId) ?? a.teamId, status: a.status })),
    giving: ctx.db.all('donations').filter((d) => d.donorId === id).map((d) => ({ date: d.paidAt ?? d.createdAt, fund: d.fundName, amount: d.amount / 100, currency: d.currency, method: d.method, status: d.status, pan: d.pan, receipt: d.receiptNumber })),
    pledges: ctx.db.all('pledges').filter((x) => x.personId === id).map((x) => ({ fund: x.fundName, amount: x.amount / 100, from: x.startDate, to: x.endDate })),
    monthlyGifts: ctx.db.all('recurring').filter((g) => g.donorId === id).map((g) => ({ fund: g.fundName, amount: g.amount / 100, status: g.status, since: g.createdAt })),
    prayerRequests: ctx.db.all('prayer').filter((x) => x.personId === id).map((x) => ({ at: x.createdAt, text: x.text, status: x.status })),
    formResponses: ctx.db.all('formResponses').filter((x) => x.personId === id).map((x) => ({ form: ctx.db.get('forms', x.formId)?.title ?? x.formId, at: x.createdAt, answers: x.answers })),
    registers: ctx.db.all('registers').filter((x) => x.personId === id || x.spouseId === id).map((x) => ({ register: x.kind, number: x.number, date: x.date })),
    whatsapp: ctx.db.all('botMessages').filter((m) => m.personId === id || (p.phone && normPhone(m.phone) === normPhone(p.phone))).map((m) => ({ at: m.at, message: m.text })),
    pastoralCare: ctx.db.all('care').filter((c) => c.personId === id && !c.confidential).map((c) => ({ title: c.title, status: c.status, openedAt: c.createdAt })),
  };
}

/** Erases a person. Gift records stay, with the name and PAN only, because the Income Tax Act requires them
 * (DPDP section 8(7) allows keeping data a law requires). Church registers are permanent records and stay too. */
export function erasePerson(ctx: Ctx, p: Collections['people']) {
  const id = p.id;
  removePerson(ctx, id);
  for (const kind of ['checkins', 'consentLog', 'formResponses', 'prayer'] as const) for (const x of ctx.db.all(kind)) if (x.personId === id) ctx.db.del(kind, x.id);
  for (const c of ctx.db.all('care')) if (c.personId === id) ctx.db.put('care', { ...c, personId: null, personName: 'Erased person', notes: [] });
  for (const d of ctx.db.all('donations')) if (d.donorId === id) ctx.db.put('donations', { ...d, donorId: null, donorEmail: null, donorPhone: null });
  for (const g of ctx.db.all('recurring')) if (g.donorId === id) ctx.db.put('recurring', { ...g, donorId: `erased:${id}` });
  for (const e of ctx.db.all('envelopes')) if (e.personId === id) ctx.db.put('envelopes', { ...e, personId: null });
  if (p.phone) for (const m of ctx.db.all('botMessages')) if (normPhone(m.phone) === normPhone(p.phone)) ctx.db.del('botMessages', m.id);
  for (const s of ctx.db.all('staff')) if (s.personId === id) ctx.db.del('staff', s.id);
}

function overview(ctx: Ctx): PrivacyOverview {
  const people = ctx.db.all('people');
  const cfg = privacySettings(ctx);
  const cutoff = new Date(ctx.now.getTime() - cfg.reviewAfterMonths * 30 * DAY).toISOString();
  const requests = ctx.db.all('dataRequests').sort((a, b) => (a.status === 'open') === (b.status === 'open') ? b.createdAt.localeCompare(a.createdAt) : a.status === 'open' ? -1 : 1);
  const now = ctx.now.toISOString();
  return {
    settings: cfg,
    requests: requests.slice(0, 200),
    open: requests.filter((r) => r.status === 'open').length,
    overdue: requests.filter((r) => r.status === 'open' && r.dueAt < now).length,
    optedOut: Object.fromEntries(PURPOSES.map((k) => [k, people.filter((p) => !p.consent[k]).length])) as Record<ConsentPurpose, number>,
    people: people.length,
    toReview: people.filter((p) => p.status === 'inactive' || (p.lastAttendedAt ? p.lastAttendedAt < cutoff : p.joinedAt < cutoff)).length,
    // Children's data needs a parent's consent under the Act; children should not have their own contact details.
    minorsWithContact: people.filter((p) => {
      const a = age(p.birthDate, ctx.now);
      if (a === null || a >= 18 || (!p.email && !p.phone)) return false;
      // A parent's number saved on the child's record is fine; the child's own is not.
      const adults = people.filter((x) => x.householdName && x.householdName === p.householdName && (age(x.birthDate, ctx.now) ?? 30) >= 18);
      return !adults.some((x) => (p.phone && normPhone(x.phone) === normPhone(p.phone)) || (p.email && x.email === p.email));
    }).length,
  };
}

function newRequest(ctx: Ctx, input: { personId: string | null; personName: string; contact: string; kind: unknown; details: unknown }) {
  const kind = input.kind as DataRequestKind;
  if (!KINDS.includes(kind)) throw new ApiError(422, 'invalid', 'Choose what you are asking for.', { kind: 'Invalid' });
  const details = String(input.details ?? '').trim().slice(0, 2000);
  if (kind !== 'erasure' && kind !== 'access' && !details) throw new ApiError(422, 'invalid', 'Tell us what you would like changed.', { details: 'Required' });
  const open = ctx.db.all('dataRequests').find((r) => r.personId && r.personId === input.personId && r.kind === kind && r.status === 'open');
  if (open) return open;
  const r: DataRequest = { id: ctx.id('dr'), personId: input.personId, personName: input.personName, contact: input.contact, kind, details, status: 'open', createdAt: ctx.now.toISOString(), dueAt: new Date(ctx.now.getTime() + DUE_DAYS * DAY).toISOString(), closedAt: null, closedBy: null, response: '' };
  ctx.db.put('dataRequests', r);
  ctx.audit('created', 'data request', r.id, `${r.personName} asked for ${kind === 'access' ? 'a copy of their data' : kind === 'erasure' ? 'their data to be erased' : kind === 'correction' ? 'a correction to their data' : 'help with a privacy concern'}`);
  return r;
}

export function registerPrivacy(r: Router) {
  // ----- members -----
  r.get('/me/privacy', {}, (ctx): MemberPrivacy => {
    const p = find(ctx, 'people', ctx.me(), 'Profile');
    const cfg = privacySettings(ctx);
    return {
      consent: p.consent,
      log: ctx.db.all('consentLog').filter((c) => c.personId === p.id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50),
      requests: ctx.db.all('dataRequests').filter((x) => x.personId === p.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      officer: { name: cfg.officerName, email: cfg.officerEmail, phone: cfg.officerPhone },
      notice: cfg.notice,
      church: settings(ctx).name,
    };
  });
  r.get('/me/privacy/export', {}, (ctx) => {
    const p = find(ctx, 'people', ctx.me(), 'Profile');
    ctx.audit('exported', 'person', p.id, `${fullName(p)} downloaded their data`);
    return personData(ctx, p);
  });
  r.post('/me/privacy/requests', {}, (ctx) => {
    const p = find(ctx, 'people', ctx.me(), 'Profile');
    return newRequest(ctx, { personId: p.id, personName: fullName(p), contact: p.email ?? p.phone ?? '', kind: ctx.body.kind, details: ctx.body.details });
  });

  // ----- office -----
  r.get('/admin/privacy', { perm: 'people.edit' }, (ctx) => overview(ctx));
  r.put('/admin/privacy/settings', { perm: 'settings' }, (ctx) => {
    const cur = privacySettings(ctx);
    const b = ctx.body;
    const next: PrivacySettings = {
      officerName: String(b.officerName ?? cur.officerName).trim().slice(0, 100),
      officerEmail: String(b.officerEmail ?? cur.officerEmail).trim().slice(0, 200),
      officerPhone: String(b.officerPhone ?? cur.officerPhone).trim().slice(0, 40),
      notice: String(b.notice ?? cur.notice).trim().slice(0, 2000),
      reviewAfterMonths: Math.min(120, Math.max(6, Math.round(Number(b.reviewAfterMonths ?? cur.reviewAfterMonths) || 24))),
    };
    ctx.db.put('settings', { ...settings(ctx), privacy: next });
    ctx.audit('updated', 'settings', null, 'Updated privacy settings');
    return overview(ctx);
  });
  r.post('/admin/privacy/requests', { perm: 'people.edit' }, (ctx) => {
    // A request that came by phone, letter or in person.
    const p = ctx.body.personId ? find(ctx, 'people', String(ctx.body.personId), 'Person') : null;
    const name = p ? fullName(p) : String(ctx.body.personName ?? '').trim();
    if (!name) throw new ApiError(422, 'invalid', 'Choose the person or type their name.', { personName: 'Required' });
    return newRequest(ctx, { personId: p?.id ?? null, personName: name, contact: String(ctx.body.contact ?? p?.email ?? p?.phone ?? ''), kind: ctx.body.kind, details: ctx.body.details });
  });
  r.patch('/admin/privacy/requests/:id', { perm: 'people.edit' }, (ctx) => {
    const req = find(ctx, 'dataRequests', ctx.params[0], 'Request');
    const status = ctx.body.status as DataRequest['status'] | undefined;
    if (status && !['open', 'done', 'declined'].includes(status)) throw new ApiError(422, 'invalid', 'Unknown status.');
    if (status === 'declined' && !String(ctx.body.response ?? req.response).trim()) throw new ApiError(422, 'invalid', 'Say why, so the person knows.', { response: 'Required' });
    const closing = status && status !== 'open' && req.status === 'open';
    const next = ctx.db.put('dataRequests', {
      ...req,
      status: status ?? req.status,
      response: ctx.body.response !== undefined ? String(ctx.body.response).trim().slice(0, 2000) : req.response,
      closedAt: status === 'open' ? null : closing ? ctx.now.toISOString() : req.closedAt,
      closedBy: status === 'open' ? null : closing ? ctx.staff?.name ?? '' : req.closedBy,
    });
    if (closing) ctx.audit('updated', 'data request', req.id, `${status === 'done' ? 'Completed' : 'Declined'} ${req.personName}'s ${req.kind} request`);
    return next;
  });
  r.post('/admin/privacy/requests/:id/erase', { perm: 'people.edit' }, (ctx) => {
    if (!['owner', 'admin'].includes(ctx.role ?? '')) throw new ApiError(403, 'forbidden', 'Only the owner or an admin can erase a person.');
    const req = find(ctx, 'dataRequests', ctx.params[0], 'Request');
    if (req.kind !== 'erasure' || req.status !== 'open') throw new ApiError(409, 'invalid_state', 'This is not an open erasure request.');
    const p = req.personId ? ctx.db.get('people', req.personId) : undefined;
    if (p) {
      if (ctx.db.all('staff').some((s) => s.personId === p.id && s.role === 'owner')) throw new ApiError(422, 'owner', 'The church owner cannot be erased. Hand over ownership first.');
      erasePerson(ctx, p);
    }
    ctx.audit('deleted', 'person', req.personId, `Erased ${req.personName}'s data on request (gift records kept for the Income Tax Act)`);
    return ctx.db.put('dataRequests', { ...req, status: 'done', closedAt: ctx.now.toISOString(), closedBy: ctx.staff?.name ?? '', response: req.response || 'Your data has been erased. Records of your gifts are kept with your name and PAN only, because the Income Tax Act requires it.' });
  });
  r.get('/admin/people/:id/export', { perm: 'people.edit' }, (ctx) => {
    const p = find(ctx, 'people', ctx.params[0], 'Person');
    ctx.audit('exported', 'person', p.id, `Downloaded ${fullName(p)}'s data`);
    return personData(ctx, p);
  });
  r.get('/admin/people/:id/consent', { perm: 'people.view' }, (ctx) => ctx.db.all('consentLog').filter((c) => c.personId === ctx.params[0]).sort((a, b) => b.at.localeCompare(a.at)));
}
