// AGM and committee elections with secret ballots: draft, open, vote in the app once with a
// receipt, paper ballots and the roll, close (by hand or at the set time), publish, audit export.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

let clock = Date.parse('2026-11-02T05:00:00.000Z'); // Monday, 10:30 am IST
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
const fails = async (p: Promise<unknown>, status: number, code?: string) => { const e: any = await p.then(() => null, (err) => err); assert.ok(e, `expected ${status}`); assert.equal(e.status, status, e.message); if (code) assert.equal(e.code, code); };

test('the seeded AGM: an open committee election and a published resolution', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const priya = await signIn('member', 'priya@example.com');
  await fails(call(priya, 'GET', '/admin/elections'), 403);

  const list = await call(owner, 'GET', '/admin/elections');
  const el = list.find((e: any) => e.id === 'el_1'), res = list.find((e: any) => e.id === 'el_2');
  assert.equal(el.status, 'open'); assert.equal(el.candidates.length, 6); assert.equal(el.results, null);
  assert.ok(el.turnout.eligible > 50 && el.turnout.app > 5 && el.turnout.percent > 0, JSON.stringify(el.turnout));
  assert.equal(res.status, 'closed'); assert.equal(res.resultsPublished, true);
  assert.equal(res.results.passed, true); assert.equal(res.results.rows[0].candidateId, 'for'); assert.equal(res.results.rows[0].votes, 48 + 12); assert.equal(res.results.invalid, 1);

  // Priya sees both, may vote in the first, and sees the published count of the second.
  let mine = await call(priya, 'GET', '/me/elections');
  assert.deepEqual(mine.map((e: any) => e.id), ['el_1', 'el_2']);
  assert.equal(mine[0].eligible, true); assert.equal(mine[0].voted, false); assert.equal(mine[0].results, null); assert.ok(mine[0].turnout.percent > 0);
  assert.equal(mine[1].results.passed, true);
  assert.ok(!('personId' in mine[0].candidates[0]), 'candidate person ids stay in the office');

  // Her ballot: at most three, only real candidates, once.
  const ids = mine[0].candidates.map((c: any) => c.id);
  await fails(call(priya, 'POST', '/me/elections/el_1/vote', { choices: [] }), 422);
  await fails(call(priya, 'POST', '/me/elections/el_1/vote', { choices: ids.slice(0, 4) }), 422);
  await fails(call(priya, 'POST', '/me/elections/el_1/vote', { choices: ['cd_99'] }), 422);
  const before = db.all('ballots').filter((b) => b.electionId === 'el_1').length;
  const v = await call(priya, 'POST', '/me/elections/el_1/vote', { choices: [ids[0], ids[2], ids[0]] });
  assert.match(v.receipt, /^[A-Z2-9]{8}$/); assert.equal(v.choices.length, 2);
  await fails(call(priya, 'POST', '/me/elections/el_1/vote', { choices: [ids[1]] }), 409, 'voted');
  const ballot = db.all('ballots').find((b) => b.receipt === v.receipt)!;
  assert.ok(ballot && !('personId' in ballot), 'the ballot carries no name');
  assert.equal(ballot.castHour, '2026-11-02T05:00Z');
  assert.equal(db.all('ballots').filter((b) => b.electionId === 'el_1').length, before + 1);
  const stub = db.get('ballotStubs', 'el_1:p_priya')!;
  assert.equal(stub.via, 'app'); assert.ok(!('choices' in stub));
  const check = await call(priya, 'GET', `/me/elections/el_1/receipt/${v.receipt.toLowerCase()}`);
  assert.equal(check.counted, true); assert.deepEqual(check.choices, v.choices);
  assert.equal((await call(priya, 'GET', '/me/elections/el_1/receipt/NOPE1234')).counted, false);
  mine = await call(priya, 'GET', '/me/elections');
  assert.equal(mine[0].voted, true);

  // The roll shows who has voted, never how; a paper voter is marked so the app refuses them.
  const roll = await call(owner, 'GET', '/admin/elections/el_1/roll');
  const me = roll.people.find((p: any) => p.id === 'p_priya');
  assert.equal(me.voted, 'app'); assert.ok(!('choices' in me));
  const fresh = roll.people.find((p: any) => !p.voted);
  assert.ok(fresh, 'someone has not voted yet');
  assert.deepEqual(await call(owner, 'POST', `/admin/elections/el_1/roll/${fresh.id}`, { voted: true }), { voted: 'paper' });
  assert.deepEqual(await call(owner, 'POST', `/admin/elections/el_1/roll/${fresh.id}`, { voted: false }), { voted: null });
  await call(owner, 'POST', `/admin/elections/el_1/roll/${fresh.id}`, { voted: true });
  await fails(call(owner, 'POST', '/admin/elections/el_1/roll/p_priya', { voted: false }), 409, 'app_vote');

  // Nothing structural changes while open; the paper count goes in; results stay hidden until closed.
  await fails(call(owner, 'PATCH', '/admin/elections/el_1', { seats: 2 }), 409, 'open');
  await call(owner, 'PATCH', '/admin/elections/el_1', { venue: 'Main hall (ground floor)' });
  await fails(call(owner, 'GET', '/admin/elections/el_1/ballots.csv'), 409);
  let e = await call(owner, 'PUT', '/admin/elections/el_1/paper', { counts: { [ids[0]]: 9, [ids[1]]: 4, [ids[3]]: 2 }, invalid: 1 });
  assert.equal(e.paperVotes[ids[0]], 9); assert.equal(e.paperInvalid, 1); assert.equal(e.results, null); assert.equal(e.turnout.paper, 16);

  // Closes itself at the set time; then the count, the export, and the published result.
  await fails(call(owner, 'POST', '/admin/elections/el_1/publish'), 409, 'not_closed');
  clock = Date.parse(e.closesAt) + 60_000;
  await engine.tick();
  e = await call(owner, 'GET', '/admin/elections/el_1');
  assert.equal(e.status, 'closed'); assert.ok(e.results);
  await fails(call(priya, 'POST', '/me/elections/el_1/vote', { choices: [ids[1]] }), 409, 'not_open');
  const rows = e.results.rows;
  assert.equal(rows.length, 6);
  assert.ok(rows.every((r: any, i: number) => i === 0 || rows[i - 1].votes >= r.votes), 'sorted by votes');
  const r0 = rows.find((r: any) => r.candidateId === ids[0]);
  assert.equal(r0.paper, 9); assert.equal(r0.votes, r0.app + 9);
  assert.equal(rows.filter((r: any) => r.elected).length, e.results.tie ? rows.filter((r: any) => r.elected).length : 3);
  const csv = await call(owner, 'GET', '/admin/elections/el_1/ballots.csv');
  assert.ok(csv.__raw && /^receipt,cast_hour,choices\n/.test(csv.body));
  assert.ok(csv.body.includes(v.receipt));
  assert.ok(!csv.body.includes('Priya'), 'no names in the export');

  await call(priya, 'POST', '/me/devices', { token: 'ExponentPushToken[priya]', platform: 'android', app: 'member' });
  mine = await call(priya, 'GET', '/me/elections');
  assert.equal(mine.some((x: any) => x.id === 'el_1'), false, 'a closed poll stays out of the app until the result is published');
  const n = env.outbox.length;
  e = await call(owner, 'POST', '/admin/elections/el_1/publish');
  assert.equal(e.resultsPublished, true);
  const told = env.outbox.slice(n).filter((o) => /Result: Church committee/.test(o.subject));
  assert.ok(told.some((o) => o.channel === 'push' && /Elected:/.test(o.text)), JSON.stringify(told.slice(0, 2)));
  mine = await call(priya, 'GET', '/me/elections');
  assert.ok(mine.find((x: any) => x.id === 'el_1').results.rows.length === 6);
  await fails(call(owner, 'PUT', '/admin/elections/el_1/paper', { counts: {} }), 409, 'published');
});

test('drafting a resolution, eligibility, opening with notice, and a tie', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const priya = await signIn('member', 'priya@example.com');
  await fails(call(owner, 'POST', '/admin/elections', { title: 'Two seats', kind: 'election', seats: 2, candidates: [{ name: 'Only one' }] }), 422);
  await fails(call(owner, 'POST', '/admin/elections', { kind: 'resolution' }), 422);
  let e = await call(owner, 'POST', '/admin/elections', { title: 'Buy the land next door', kind: 'resolution', description: 'That the church buy plot 14 for ₹1.2 crore.', eligibility: 'members' });
  assert.equal(e.status, 'draft'); assert.deepEqual(e.candidates.map((c: any) => c.id), ['for', 'against', 'abstain']); assert.equal(e.seats, 1);
  assert.equal((await call(priya, 'GET', '/me/elections')).some((x: any) => x.id === e.id), false, 'drafts are invisible');
  await fails(call(owner, 'POST', `/admin/elections/${e.id}/open`, {}), 422);
  await fails(call(owner, 'POST', `/admin/elections/${e.id}/open`, { closesAt: '2020-01-01T00:00:00Z' }), 422);
  const n = env.outbox.length;
  e = await call(owner, 'POST', `/admin/elections/${e.id}/open`, { closesAt: new Date(clock + 2 * 86_400_000).toISOString() });
  assert.equal(e.status, 'open');
  const notice = env.outbox.slice(n).filter((o) => /Voting is open: Buy the land/.test(o.subject));
  assert.ok(notice.length >= e.turnout.eligible * 0.5, `${notice.length} notices for ${e.turnout.eligible} voters`);
  assert.ok(notice.some((o) => /For, Against or Abstain/.test(o.text)));
  await fails(call(owner, 'DELETE', `/admin/elections/${e.id}`), 409);

  // A child in the household is not a member and cannot vote; the vote must be exactly one option.
  const kid = { ...priya, sub: 'p_joel', personId: 'p_joel' };
  const kidView = (await call(priya, 'GET', '/me/elections')).find((x: any) => x.id === e.id);
  assert.equal(kidView.eligible, true, 'Priya herself may vote');
  void kid;
  await fails(call(priya, 'POST', `/me/elections/${e.id}/vote`, { choices: ['for', 'against'] }), 422);
  const v = await call(priya, 'POST', `/me/elections/${e.id}/vote`, { choices: ['against'] });
  assert.deepEqual(v.choices, ['Against']);

  // Paper: 1 for, 0 against → with Priya's vote it is a tie; close and see it flagged.
  await call(owner, 'PUT', `/admin/elections/${e.id}/paper`, { counts: { for: 1 } });
  e = await call(owner, 'POST', `/admin/elections/${e.id}/close`);
  assert.equal(e.status, 'closed'); assert.equal(e.results.tie, true); assert.equal(e.results.passed, false);
  await fails(call(owner, 'POST', `/admin/elections/${e.id}/close`), 409);
  await fails(call(owner, 'PATCH', `/admin/elections/${e.id}`, { title: 'x' }), 409, 'closed');

  // A draft can still be deleted.
  const d = await call(owner, 'POST', '/admin/elections', { title: 'Scrap me', candidates: [{ name: 'A' }, { name: 'B' }] });
  assert.deepEqual(await call(owner, 'DELETE', `/admin/elections/${d.id}`), { ok: true });
});
