// Christmas carol rounds: a season, homes asking for a visit, routes by zone and team, the
// night-before reminder, offerings at the door.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { nightDates } from '../src/core/modules/carols.js';
import { seedDemo } from '../src/core/seed.js';

// Church time is IST; 05:00Z is 10:30 am, after the daily jobs' 8 am gate.
let clock = Date.parse('2026-12-09T05:00:00.000Z');
const env = createDemoEnv({ now: () => new Date(clock) });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(audience: 'admin' | 'member', email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown) => engine.handle({ method, path, body, auth }) as Promise<any>;
const fails = async (p: Promise<unknown>, status: number) => { const e: any = await p.then(() => null, (err) => err); assert.ok(e, `expected ${status}`); assert.equal(e.status, status, e.message); };

test('a season, a request from Priya, routes by zone and team, offerings in the ledger', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const priya = await signIn('member', 'priya@example.com');

  let hub = await call(owner, 'GET', '/admin/carols');
  assert.equal(hub.season, null);
  assert.ok(hub.zones.length >= 2 && hub.zones.every((z: any) => z.homes >= 0));
  const fund = hub.funds[0];
  await fails(call(owner, 'POST', '/admin/carols/seasons', { from: '2026-12-20', to: '2026-12-10' }), 422);
  const season = await call(owner, 'POST', '/admin/carols/seasons', { from: '2026-12-10', to: '2026-12-23', startTime: '18:30', minutesPerHouse: 15, travelMinutes: 10, housesPerNight: 4, offDays: [0], fundId: fund.id });
  assert.equal(season.name, 'Christmas carols 2026');
  assert.equal(season.fundName, fund.name);
  assert.ok(!season.dates.includes('2026-12-13'), 'Sunday 13 Dec is an off day');
  assert.ok(season.dates.includes('2026-12-14'));
  assert.deepEqual(nightDates(season).slice(0, 3), ['2026-12-10', '2026-12-11', '2026-12-12']);

  // Priya asks for a visit and picks two nights.
  let mine = await call(priya, 'GET', '/me/carols');
  assert.equal(mine.season.name, 'Christmas carols 2026');
  assert.equal(mine.visit, null);
  const req = await call(priya, 'POST', '/me/carols/request', { preferredDates: ['2026-12-13', '2026-12-16', '2026-12-18'], note: 'After 7 please' });
  assert.deepEqual(req.preferredDates, ['2026-12-16', '2026-12-18'], 'the Sunday is dropped');
  hub = await call(owner, 'GET', '/admin/carols');
  assert.equal(hub.season.totals.requests, 1);
  assert.equal(hub.season.waiting[0].familyName, req.familyName);

  // Plan: two zones, two teams.
  const zoneIds = hub.zones.filter((z: any) => z.homes > 0).slice(0, 2).map((z: any) => z.id);
  const teamIds = hub.teams.slice(0, 2).map((t: any) => t.id);
  const planned = await call(owner, 'POST', `/admin/carols/seasons/${season.id}/plan`, { zoneIds, teamIds });
  assert.ok(planned.nights.length >= 2, 'several nights');
  assert.ok(planned.nights.every((n: any) => n.stops.length <= 4));
  assert.ok(planned.nights.every((n: any) => teamIds.includes(n.teamId)));
  assert.ok(planned.nights.every((n: any) => season.dates.includes(n.date)));
  const priyaNight = planned.nights.find((n: any) => n.stops.some((s: any) => s.familyKey === req.familyKey));
  assert.ok(priyaNight, 'the home that asked is on a route even if outside the chosen zones');
  const priyaStop = priyaNight.stops.find((s: any) => s.familyKey === req.familyKey);
  assert.equal(priyaNight.stops[0].eta, '18:30');
  if (priyaNight.stops.length > 1) assert.equal(priyaNight.stops[1].eta, '18:55');
  assert.equal(planned.waiting.length, 0);
  assert.match(priyaNight.mapsUrl, /^https:\/\/www\.google\.com\/maps\/dir\//);

  mine = await call(priya, 'GET', '/me/carols');
  assert.equal(mine.visit.date, priyaNight.date);
  assert.equal(mine.visit.eta, priyaStop.eta);

  // Reorder: move Priya's home to the front; her ETA becomes the start time.
  const order = [req.familyKey, ...priyaNight.stops.map((s: any) => s.familyKey).filter((k: string) => k !== req.familyKey)];
  const reordered = await call(owner, 'PATCH', `/admin/carols/nights/${priyaNight.id}`, { order, startTime: '19:00' });
  assert.equal(reordered.stops[0].familyKey, req.familyKey);
  assert.equal(reordered.stops[0].eta, '19:00');

  // The night before, the household is told.
  clock = Date.parse(`${priyaNight.date}T05:00:00.000Z`) - 86_400_000;
  const before = env.outbox.length;
  await engine.tick();
  const sent = env.outbox.slice(before).filter((o) => /carol singers tomorrow/i.test(o.subject) || /carol team/i.test(o.text));
  assert.ok(sent.some((o) => o.to === 'priya@example.com' || o.to === '+91 98765 43210'), 'Priya is told');

  // The team marks the stop visited with an offering of ₹500: a cash gift lands in the fund.
  const teamId = priyaNight.teamId;
  const t = db.get('teams', teamId)!;
  const singerEmail = db.get('people', t.leaderId ?? t.members[0].personId)!.email!;
  const singer = await signIn('member', singerEmail);
  const route = await call(singer, 'GET', `/team/${teamId}/carols`);
  assert.ok(route.nights.some((n: any) => n.id === priyaNight.id));
  const donationsBefore = db.all('donations').length;
  const marked = await call(singer, 'PATCH', `/team/${teamId}/carols/${priyaNight.id}/stops/${encodeURIComponent(req.familyKey)}`, { status: 'visited', offering: 50_000 });
  assert.equal(marked.visited, 1);
  assert.equal(marked.offering, 50_000);
  const gift = db.all('donations').slice(donationsBefore).find((d) => d.fundId === fund.id);
  assert.ok(gift, 'a gift was recorded');
  assert.equal(gift!.amount, 50_000);
  assert.equal(gift!.method, 'cash');
  // Correcting to ₹300 records the difference, so the ledger total matches the stop.
  await call(owner, 'PATCH', `/admin/carols/nights/${priyaNight.id}/stops/${encodeURIComponent(req.familyKey)}`, { offering: 30_000 });
  const total = db.all('donations').slice(donationsBefore).filter((d) => d.fundId === fund.id).reduce((n, d) => n + d.amount, 0);
  assert.equal(total, 30_000);
  const view = await call(owner, 'GET', `/admin/carols/seasons/${season.id}`);
  assert.equal(view.totals.offering, 30_000);
  assert.equal(view.totals.visited, 1);

  // Planning again keeps the night with a visited stop and rebuilds the rest.
  const again = await call(owner, 'POST', `/admin/carols/seasons/${season.id}/plan`, { zoneIds, teamIds });
  assert.ok(again.nights.some((n: any) => n.id === priyaNight.id));

  // Someone on another team cannot touch this route.
  const other = hub.teams.find((x: any) => x.id !== teamId)!;
  const ot = db.get('teams', other.id)!;
  const outsider = await signIn('member', db.get('people', ot.members.find((m) => m.personId !== t.leaderId && !t.members.some((x) => x.personId === m.personId))!.personId)!.email!);
  await fails(call(outsider, 'PATCH', `/team/${other.id}/carols/${priyaNight.id}/stops/${encodeURIComponent(req.familyKey)}`, { status: 'skipped' }), 403);
});
