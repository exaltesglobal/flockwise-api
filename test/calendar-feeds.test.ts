// Calendar subscribe links: the church feed, a team's rota feed and a member's own feed.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db, isRaw } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const env = createDemoEnv({ now: () => new Date('2026-10-22T05:00:00.000Z'), webUrl: 'https://app.flockwise.church/c/grace' });
(env as any).apiUrl = 'https://api.flockwise.church/v1';
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
const fetchIcs = async (url: string) => {
  const token = /\/public\/calendar\/([^?]+)/.exec(url)![1];
  const res = await engine.handle({ method: 'GET', path: `/public/calendar/${token}`, auth: null });
  assert.ok(isRaw(res), 'a raw .ics body');
  return res.body;
};

test('church and team feeds: events, who serves, rehearsals; lines folded; reset kills the old link', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const feeds = await call(owner, 'GET', '/admin/calendar/feeds');
  assert.match(feeds.church.url, /^https:\/\/api\.flockwise\.church\/v1\/public\/calendar\/[a-z2-9]{28}\.ics\?church=grace$/);
  assert.match(feeds.church.webcal, /^webcal:\/\//);
  assert.match(feeds.church.google, /^https:\/\/calendar\.google\.com\/calendar\/r\?cid=webcal/);
  assert.ok(feeds.teams.length >= 2 && feeds.teams.every((t: any) => t.kind === 'team' && t.url.includes('/public/calendar/')));
  const again = await call(owner, 'GET', '/admin/calendar/feeds');
  assert.equal(again.church.url, feeds.church.url, 'the same link every time');

  const ics = await fetchIcs(feeds.church.url);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.match(ics, /X-WR-CALNAME:Grace Community Church/);
  assert.match(ics, /X-WR-TIMEZONE:Asia\/Kolkata/);
  const events = ics.split('BEGIN:VEVENT').length - 1;
  assert.ok(events >= 3, `upcoming events in the feed (${events})`);
  assert.match(ics, /DTSTART:\d{8}T\d{6}Z/);
  assert.match(ics, /URL:https:\/\/app\.flockwise\.church\/c\/grace\/app\/events\/ev_/);
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `folded: ${line.slice(0, 40)}`);

  // The worship team's feed lists who serves and the rehearsal once one is set.
  const worship = feeds.teams.find((t: any) => /worship/i.test(t.name));
  const { plan } = await call(owner, 'GET', '/admin/services/ev_7');
  await call(owner, 'PUT', '/admin/services/ev_7', { ...plan, rehearsalAt: '2026-10-24T11:30:00.000Z', rehearsalNotes: 'Learn Amazing Grace in G' });
  const team = await fetchIcs(worship.url);
  assert.match(team, /X-WR-CALNAME:Grace Community Church · Worship/);
  assert.match(team, /DESCRIPTION:Worship\\n/);
  assert.match(team, /SUMMARY:Rehearsal: /);
  assert.match(team, /Learn Amazing Grace in G/);
  assert.ok(!/Harvest/i.test(team) || team.split('BEGIN:VEVENT').length < ics.split('BEGIN:VEVENT').length, 'only services the team serves at');

  // Reset: a new token, the old link is dead.
  const reset = await call(owner, 'POST', `/admin/calendar/feeds/${feeds.church.id}/reset`);
  assert.notEqual(reset.url, feeds.church.url);
  await fails(engine.handle({ method: 'GET', path: `/public/calendar/${/calendar\/([^?]+)/.exec(feeds.church.url)![1]}`, auth: null }), 404);
  assert.ok((await fetchIcs(reset.url)).includes('BEGIN:VEVENT'));
  await fails(engine.handle({ method: 'GET', path: '/public/calendar/nope.ics', auth: null }), 404);
});

test('a member gets their own Sundays and serving in one feed', async () => {
  const priya = await signIn('member', 'priya@example.com');
  const mine = await call(priya, 'GET', '/me/calendar');
  assert.equal(mine.kind, 'person');
  const ics = await fetchIcs(mine.url);
  assert.match(ics, /X-WR-CALNAME:Grace Community Church · Priya/);
  assert.match(ics, /You serve: Worship/);
  const reset = await call(priya, 'POST', '/me/calendar/reset');
  assert.notEqual(reset.url, mine.url);
});
