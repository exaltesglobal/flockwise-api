// AGM and committee elections with secret ballots on phones. The office drafts the election or
// resolution, opens it, and the eligible members vote in the app; the ballot is stored without the
// voter's name and the voter keeps a receipt. The returning officer adds the hall's paper ballots,
// marks who voted on paper so nobody votes twice, closes the poll (or it closes itself at the set
// time), and publishes the result. Nobody, including the office, can see who voted for whom.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { Ballot, Candidate, Collections, Election, ElectionEligibility, ElectionKind, ElectionResults, ElectionRoll, ElectionTurnout, ElectionView, MemberElection, ReceiptCheck, VoteReceipt } from '../types.js';
import { age, DAY, find, fullName, requireFields } from '../util.js';
import { notify } from './notify.js';

const EDIT = ['settings', 'people.edit'] as ('settings' | 'people.edit')[];
const RECEIPT_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const RESOLUTION_OPTIONS: Candidate[] = [
  { id: 'for', personId: null, name: 'For', note: '' },
  { id: 'against', personId: null, name: 'Against', note: '' },
  { id: 'abstain', personId: null, name: 'Abstain', note: '' },
];

/** Who may vote: communicant members, adult members, or every adult on the roll. */
export function eligibleVoters(ctx: Ctx, e: Pick<Election, 'eligibility'>): Collections['people'][] {
  return ctx.db.all('people').filter((p) => {
    if (p.status === 'inactive') return false;
    const adult = (age(p.birthDate, ctx.now) ?? 30) >= 18;
    if (e.eligibility === 'members') return p.status === 'member';
    if (e.eligibility === 'members_18') return p.status === 'member' && adult;
    return adult && p.status !== 'visitor';
  });
}
function whyNot(ctx: Ctx, e: Election, p: Collections['people']): string | null {
  if (eligibleVoters(ctx, e).some((x) => x.id === p.id)) return null;
  if (p.status === 'inactive') return 'Your record is marked inactive. Please speak to the office.';
  if ((age(p.birthDate, ctx.now) ?? 30) < 18) return 'Voting is for members aged 18 and over.';
  return 'Voting is for communicant members. Please speak to the office if you think this is a mistake.';
}

const stubs = (ctx: Ctx, id: string) => ctx.db.all('ballotStubs').filter((s) => s.electionId === id);
const ballots = (ctx: Ctx, id: string) => ctx.db.all('ballots').filter((b) => b.electionId === id);

export function turnout(ctx: Ctx, e: Election): ElectionTurnout {
  const eligible = eligibleVoters(ctx, e).length;
  const s = stubs(ctx, e.id);
  const app = s.filter((x) => x.via === 'app').length;
  const paper = Object.values(e.paperVotes).reduce((a, b) => a + b, 0) + e.paperInvalid;
  const voted = app + Math.max(paper, s.filter((x) => x.via === 'paper').length);
  return { eligible, app, paper, voted, percent: eligible ? Math.round((voted * 100) / eligible) : 0 };
}

/** The count: app ballots plus the hall's paper count, top `seats` elected, ties flagged at the line. */
export function results(ctx: Ctx, e: Election): ElectionResults {
  const bs = ballots(ctx, e.id);
  const counts = new Map<string, number>(e.candidates.map((c) => [c.id, 0]));
  for (const b of bs) for (const c of b.choices) counts.set(c, (counts.get(c) ?? 0) + 1);
  const rows = e.candidates
    .map((c) => ({ candidateId: c.id, name: c.name, note: c.note, app: counts.get(c.id) ?? 0, paper: e.paperVotes[c.id] ?? 0, votes: (counts.get(c.id) ?? 0) + (e.paperVotes[c.id] ?? 0), percent: 0, elected: false }))
    .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));
  const total = rows.reduce((n, r) => n + r.votes, 0);
  for (const r of rows) r.percent = total ? Math.round((r.votes * 1000) / total) / 10 : 0;
  let tie = false, passed: boolean | null = null;
  if (e.kind === 'resolution') {
    const f = rows.find((r) => r.candidateId === 'for')?.votes ?? 0, a = rows.find((r) => r.candidateId === 'against')?.votes ?? 0;
    passed = f > a; tie = f === a && f > 0;
    for (const r of rows) r.elected = passed === true && r.candidateId === 'for';
  } else {
    const seats = Math.min(e.seats, rows.length);
    const line = rows[seats - 1]?.votes ?? 0;
    tie = seats < rows.length && rows[seats].votes === line && line > 0;
    rows.forEach((r, i) => { r.elected = i < seats && r.votes > 0 && !(tie && r.votes === line); });
  }
  return { rows, ballots: bs.length + Object.values(e.paperVotes).reduce((a, b) => a + b, 0), invalid: e.paperInvalid, tie, passed };
}

export const view = (ctx: Ctx, e: Election): ElectionView => ({ ...e, turnout: turnout(ctx, e), results: e.status === 'closed' ? results(ctx, e) : null });

function memberView(ctx: Ctx, e: Election, me: Collections['people']): MemberElection {
  const reason = whyNot(ctx, e, me);
  const published = e.status === 'closed' && e.resultsPublished;
  return {
    id: e.id, title: e.title, kind: e.kind, description: e.description, seats: e.seats,
    candidates: e.candidates.map((c) => ({ id: c.id, name: c.name, note: c.note })),
    status: e.status, meetingAt: e.meetingAt, venue: e.venue, closesAt: e.closesAt,
    eligible: !reason, reason, voted: !!ctx.db.get('ballotStubs', `${e.id}:${me.id}`),
    results: published ? results(ctx, e) : null, turnout: published || e.status === 'open' ? turnout(ctx, e) : null,
  };
}

function cleanCandidates(ctx: Ctx, kind: ElectionKind, raw: unknown, existing: Candidate[] = []): Candidate[] {
  if (kind === 'resolution') return RESOLUTION_OPTIONS;
  if (!Array.isArray(raw)) return existing;
  const out: Candidate[] = [];
  for (const c of raw.slice(0, 40)) {
    const personId = typeof c?.personId === 'string' && ctx.db.get('people', c.personId) ? c.personId : null;
    const name = String(c?.name ?? (personId ? fullName(ctx.db.get('people', personId)!) : '')).trim().slice(0, 80);
    if (!name) continue;
    const prev = existing.find((x) => x.id === c?.id);
    out.push({ id: prev?.id ?? ctx.id('cd'), personId, name, note: String(c?.note ?? '').trim().slice(0, 200) });
  }
  if (out.length < 2) throw new ApiError(422, 'validation', 'An election needs at least two candidates.', { candidates: 'At least two' });
  return out;
}

function input(ctx: Ctx, b: Record<string, unknown>, cur?: Election): Partial<Election> {
  const out: Partial<Election> = {};
  if (b.title !== undefined) out.title = String(b.title).trim().slice(0, 140);
  if (b.description !== undefined) out.description = String(b.description ?? '').trim().slice(0, 2000);
  if (b.kind !== undefined && !cur) out.kind = b.kind === 'resolution' ? 'resolution' : 'election';
  const kind = out.kind ?? cur?.kind ?? 'election';
  if (b.seats !== undefined) out.seats = kind === 'resolution' ? 1 : Math.min(20, Math.max(1, Math.round(Number(b.seats)) || 1));
  if (b.candidates !== undefined || out.kind) out.candidates = cleanCandidates(ctx, kind, b.candidates, cur?.candidates);
  if (b.eligibility !== undefined) out.eligibility = (['members', 'members_18', 'everyone_18'] as ElectionEligibility[]).includes(b.eligibility as ElectionEligibility) ? (b.eligibility as ElectionEligibility) : 'members_18';
  if (b.meetingAt !== undefined) out.meetingAt = b.meetingAt ? new Date(String(b.meetingAt)).toISOString() : null;
  if (b.venue !== undefined) out.venue = String(b.venue ?? '').trim().slice(0, 140);
  if (b.closesAt !== undefined) out.closesAt = b.closesAt ? new Date(String(b.closesAt)).toISOString() : null;
  if (b.returningOfficer !== undefined) out.returningOfficer = String(b.returningOfficer ?? '').trim().slice(0, 80);
  if (out.seats && kind === 'election' && (out.candidates ?? cur?.candidates ?? []).length && out.seats > (out.candidates ?? cur!.candidates).length) throw new ApiError(422, 'validation', 'More seats than candidates.', { seats: 'Too many' });
  return out;
}

async function tellVoters(ctx: Ctx, e: Election, kind: 'election.open' | 'election.result', title: string, body: string) {
  await notify(ctx, kind, { personIds: eligibleVoters(ctx, e).map((p) => p.id), title, body, link: '/app/vote' });
}

/** The daily tick, every run: a poll whose closing time has passed closes itself. */
export async function closeDueElections(ctx: Ctx) {
  for (const e of ctx.db.all('elections')) {
    if (e.status !== 'open' || !e.closesAt || e.closesAt > ctx.now.toISOString()) continue;
    ctx.db.put('elections', { ...e, status: 'closed', closedAt: ctx.now.toISOString() });
    ctx.audit('closed', 'election', e.id, `${e.title} closed at the set time`);
  }
}

export function registerElections(r: Router) {
  r.get('/admin/elections', { perm: EDIT }, (ctx) => ctx.db.all('elections').sort((a, b) => (b.closesAt ?? b.createdAt).localeCompare(a.closesAt ?? a.createdAt)).map((e) => view(ctx, e)));

  r.post('/admin/elections', { perm: EDIT }, (ctx) => {
    requireFields(ctx.body, ['title']);
    const base: Election = {
      id: ctx.id('el'), title: '', kind: 'election', description: '', seats: 1, candidates: [], eligibility: 'members_18', status: 'draft',
      meetingAt: null, venue: '', opensAt: null, closesAt: null, closedAt: null, paperVotes: {}, paperInvalid: 0, returningOfficer: ctx.staff?.name ?? '',
      resultsPublished: false, createdAt: ctx.now.toISOString(), createdBy: ctx.staff?.name ?? '',
    };
    const patch = input(ctx, { kind: 'election', ...ctx.body }, undefined);
    const e: Election = { ...base, ...patch };
    if (e.kind === 'resolution') { e.candidates = RESOLUTION_OPTIONS; e.seats = 1; }
    if (e.kind === 'election' && e.candidates.length < 2) throw new ApiError(422, 'validation', 'An election needs at least two candidates.', { candidates: 'At least two' });
    ctx.db.put('elections', e);
    ctx.audit('created', 'election', e.id, e.title);
    return view(ctx, e);
  });

  r.get('/admin/elections/:id', { perm: EDIT }, (ctx) => view(ctx, find(ctx, 'elections', ctx.params[0], 'Election')));

  r.patch('/admin/elections/:id', { perm: EDIT }, (ctx) => {
    const e = find(ctx, 'elections', ctx.params[0], 'Election');
    if (e.status === 'closed') throw new ApiError(409, 'closed', 'A closed poll cannot be changed.');
    const patch = input(ctx, ctx.body, e);
    if (e.status === 'open') for (const k of ['candidates', 'seats', 'eligibility', 'kind'] as const) if (k in patch) throw new ApiError(409, 'open', `You cannot change the ${k} while voting is open. Close it and start a fresh poll.`);
    const next = { ...e, ...patch };
    ctx.db.put('elections', next);
    ctx.audit('updated', 'election', e.id, e.title);
    return view(ctx, next);
  });

  r.del('/admin/elections/:id', { perm: EDIT }, (ctx) => {
    const e = find(ctx, 'elections', ctx.params[0], 'Election');
    if (e.status !== 'draft') throw new ApiError(409, 'not_draft', 'Only a draft can be deleted. A poll that has run stays on record.');
    ctx.db.del('elections', e.id);
    ctx.audit('deleted', 'election', e.id, e.title);
    return { ok: true };
  });

  // Open: the closing time is required so the poll cannot stay open by accident; everyone eligible is told.
  r.post('/admin/elections/:id/open', { perm: EDIT }, async (ctx) => {
    const e = find(ctx, 'elections', ctx.params[0], 'Election');
    if (e.status !== 'draft') throw new ApiError(409, 'not_draft', 'This poll has already been opened.');
    const closesAt = ctx.body?.closesAt ? new Date(String(ctx.body.closesAt)).toISOString() : e.closesAt;
    if (!closesAt || closesAt <= ctx.now.toISOString()) throw new ApiError(422, 'validation', 'Set a closing time in the future.', { closesAt: 'Required' });
    if (e.kind === 'election' && e.candidates.length < 2) throw new ApiError(422, 'validation', 'Add at least two candidates first.');
    const next: Election = { ...e, status: 'open', opensAt: ctx.now.toISOString(), closesAt };
    ctx.db.put('elections', next);
    ctx.audit('opened', 'election', e.id, `${e.title} open until ${closesAt}`);
    const when = new Date(closesAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    await tellVoters(ctx, next, 'election.open', `Voting is open: ${e.title}`, e.kind === 'resolution' ? `Vote For, Against or Abstain in the app before ${when}. Your ballot is secret.` : `Choose up to ${e.seats} of ${e.candidates.length} candidates in the app before ${when}. Your ballot is secret.`);
    return view(ctx, next);
  });

  r.post('/admin/elections/:id/close', { perm: EDIT }, (ctx) => {
    const e = find(ctx, 'elections', ctx.params[0], 'Election');
    if (e.status !== 'open') throw new ApiError(409, 'not_open', 'This poll is not open.');
    const next: Election = { ...e, status: 'closed', closedAt: ctx.now.toISOString() };
    ctx.db.put('elections', next);
    ctx.audit('closed', 'election', e.id, `${e.title} closed by ${ctx.staff?.name ?? 'office'}`);
    return view(ctx, next);
  });

  // The hall's paper ballots, counted by the returning officer; allowed until the result is published.
  r.put('/admin/elections/:id/paper', { perm: EDIT }, (ctx) => {
    const e = find(ctx, 'elections', ctx.params[0], 'Election');
    if (e.status === 'draft') throw new ApiError(409, 'not_open', 'Open the poll first.');
    if (e.resultsPublished) throw new ApiError(409, 'published', 'The result has been published.');
    const counts: Record<string, number> = {};
    const raw = (ctx.body?.counts ?? {}) as Record<string, unknown>;
    for (const c of e.candidates) counts[c.id] = Math.max(0, Math.round(Number(raw[c.id]) || 0));
    const next: Election = { ...e, paperVotes: counts, paperInvalid: Math.max(0, Math.round(Number(ctx.body?.invalid) || 0)) };
    ctx.db.put('elections', next);
    ctx.audit('counted', 'election', e.id, `Paper ballots entered for ${e.title}`);
    return view(ctx, next);
  });

  // The roll: who is eligible and whether they have voted (never how). Marking "voted on paper" blocks a second vote in the app.
  r.get('/admin/elections/:id/roll', { perm: EDIT }, (ctx): ElectionRoll => {
    const e = find(ctx, 'elections', ctx.params[0], 'Election');
    const s = new Map(stubs(ctx, e.id).map((x) => [x.personId, x]));
    return { election: { id: e.id, title: e.title }, people: eligibleVoters(ctx, e).map((p) => ({ id: p.id, name: fullName(p), phone: p.phone ?? null, voted: s.get(p.id)?.via ?? null, castAt: s.get(p.id)?.castAt ?? null })).sort((a, b) => a.name.localeCompare(b.name)) };
  });
  r.post('/admin/elections/:id/roll/:personId', { perm: EDIT }, (ctx) => {
    const e = find(ctx, 'elections', ctx.params[0], 'Election');
    if (e.status !== 'open') throw new ApiError(409, 'not_open', 'This poll is not open.');
    const p = find(ctx, 'people', ctx.params[1], 'Person');
    const id = `${e.id}:${p.id}`;
    const cur = ctx.db.get('ballotStubs', id);
    if (ctx.body?.voted === false) {
      if (cur?.via === 'app') throw new ApiError(409, 'app_vote', 'They voted in the app; that cannot be undone.');
      if (cur) ctx.db.del('ballotStubs', id);
      return { voted: null };
    }
    if (cur) return { voted: cur.via };
    ctx.db.put('ballotStubs', { id, electionId: e.id, personId: p.id, castAt: ctx.now.toISOString(), via: 'paper', markedBy: ctx.staff?.name ?? null });
    return { voted: 'paper' };
  });

  r.post('/admin/elections/:id/publish', { perm: EDIT }, async (ctx) => {
    const e = find(ctx, 'elections', ctx.params[0], 'Election');
    if (e.status !== 'closed') throw new ApiError(409, 'not_closed', 'Close the poll before publishing the result.');
    const next: Election = { ...e, resultsPublished: true };
    ctx.db.put('elections', next);
    const res = results(ctx, next);
    const line = e.kind === 'resolution' ? (res.tie ? 'The vote was tied.' : res.passed ? 'The resolution was carried.' : 'The resolution was not carried.') : `Elected: ${res.rows.filter((r) => r.elected).map((r) => r.name).join(', ') || 'see the result'}${res.tie ? ' (a tie remains to be settled)' : ''}.`;
    ctx.audit('published', 'election', e.id, `${e.title}: ${line}`);
    await tellVoters(ctx, next, 'election.result', `Result: ${e.title}`, `${line} ${res.ballots} ballots counted, ${turnout(ctx, next).percent}% turnout. Full result in the app.`);
    return view(ctx, next);
  });

  // The anonymous ballots for an audit, in receipt order so nothing lines up with the roll.
  r.get('/admin/elections/:id/ballots.csv', { perm: EDIT }, (ctx) => {
    const e = find(ctx, 'elections', ctx.params[0], 'Election');
    if (e.status !== 'closed') throw new ApiError(409, 'not_closed', 'Ballots can be exported after the poll closes.');
    const names = new Map(e.candidates.map((c) => [c.id, c.name]));
    const lines = ['receipt,cast_hour,choices', ...ballots(ctx, e.id).sort((a, b) => a.receipt.localeCompare(b.receipt)).map((b) => `${b.receipt},${b.castHour},"${b.choices.map((c) => names.get(c) ?? c).join('; ')}"`)];
    return { __raw: true as const, contentType: 'text/csv; charset=utf-8', filename: `ballots-${e.id}.csv`, body: lines.join('\n') };
  });

  // Members: open polls and recent published results; cast a secret ballot; check a receipt.
  r.get('/me/elections', {}, (ctx): MemberElection[] => {
    const me = find(ctx, 'people', ctx.me(), 'Profile');
    const cutoff = new Date(ctx.now.getTime() - 90 * DAY).toISOString();
    return ctx.db.all('elections')
      .filter((e) => e.status === 'open' || (e.status === 'closed' && e.resultsPublished && (e.closedAt ?? '') >= cutoff))
      .sort((a, b) => (a.status === b.status ? (b.closesAt ?? '').localeCompare(a.closesAt ?? '') : a.status === 'open' ? -1 : 1))
      .map((e) => memberView(ctx, e, me));
  });

  r.post('/me/elections/:id/vote', {}, (ctx): VoteReceipt => {
    const e = find(ctx, 'elections', ctx.params[0], 'Election');
    const me = find(ctx, 'people', ctx.me(), 'Profile');
    if (e.status !== 'open' || (e.closesAt && e.closesAt <= ctx.now.toISOString())) throw new ApiError(409, 'not_open', 'Voting is closed.');
    const reason = whyNot(ctx, e, me);
    if (reason) throw new ApiError(403, 'not_eligible', reason);
    const stubId = `${e.id}:${me.id}`;
    if (ctx.db.get('ballotStubs', stubId)) throw new ApiError(409, 'voted', 'You have already voted in this poll.');
    const valid = new Set(e.candidates.map((c) => c.id));
    const raw: unknown[] = Array.isArray(ctx.body?.choices) ? ctx.body.choices : [];
    const choices: string[] = [...new Set(raw.map((c) => String(c)))].filter((c) => valid.has(c));
    if (!choices.length) throw new ApiError(422, 'validation', e.kind === 'resolution' ? 'Choose For, Against or Abstain.' : 'Choose at least one candidate.');
    if (choices.length > e.seats) throw new ApiError(422, 'validation', `Choose at most ${e.seats}.`);
    const receipt = ctx.env.random(8, RECEIPT_ALPHABET);
    const castHour = `${ctx.now.toISOString().slice(0, 13)}:00Z`;
    const ballot: Ballot = { id: `bl_${ctx.env.random(14, 'abcdefghijklmnopqrstuvwxyz0123456789')}`, electionId: e.id, choices, receipt, castHour, via: 'app' };
    ctx.db.put('ballots', ballot);
    ctx.db.put('ballotStubs', { id: stubId, electionId: e.id, personId: me.id, castAt: ctx.now.toISOString(), via: 'app', markedBy: null });
    const names = new Map(e.candidates.map((c) => [c.id, c.name]));
    return { receipt, choices: choices.map((c) => names.get(c) ?? c), message: `Your ballot is in. Receipt ${receipt}: keep it to check your vote was counted after the result.` };
  });

  r.get('/me/elections/:id/receipt/:code', {}, (ctx): ReceiptCheck => {
    const e = find(ctx, 'elections', ctx.params[0], 'Election');
    const code = String(ctx.params[1] ?? '').toUpperCase();
    const b = ballots(ctx, e.id).find((x) => x.receipt === code);
    const names = new Map(e.candidates.map((c) => [c.id, c.name]));
    return { counted: !!b, election: e.title, choices: b ? b.choices.map((c) => names.get(c) ?? c) : [] };
  });
}
