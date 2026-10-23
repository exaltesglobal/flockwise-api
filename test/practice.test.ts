// Choir practice: the worship leader records who came and what was sung, puts part recordings on
// songs, and singers see their parts and attendance; the evening before a rehearsal the team is nudged.
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
const fails = async (p: Promise<unknown>, status: number) => { const e: any = await p.then(() => null, (err) => err); assert.ok(e, `expected ${status}`); assert.equal(e.status, status, e.message); };

test('Thursday practice: attendance, part recordings, the singer’s view and the reminder', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const priya = await signIn('member', 'priya@example.com');
  await fails(call(priya, 'GET', '/admin/practices'), 403);

  let hub = await call(owner, 'GET', '/admin/practices');
  assert.equal(hub.teamId, 'tm_worship', 'the singing team is picked by default');
  assert.deepEqual(hub.practices, []);
  assert.ok(hub.members.length > 5 && hub.members.every((m: any) => m.total === 0));
  assert.ok(hub.nextRehearsal && hub.nextRehearsal.eventId === 'ev_1' && hub.nextRehearsal.songs.length >= 3, 'the rehearsal comes from the service plan');
  assert.deepEqual(hub.songsWithParts, []);
  assert.ok(hub.parts.includes('soprano'));

  // Part recordings on the first song of Sunday's plan.
  const song = hub.nextRehearsal.songs[0];
  await fails(call(owner, 'POST', `/admin/songs/${song.id}/parts`, { part: 'baritone', url: 'https://x' }), 422);
  await fails(call(owner, 'POST', `/admin/songs/${song.id}/parts`, { part: 'alto', url: 'not a link' }), 422);
  let s = await call(owner, 'POST', `/admin/songs/${song.id}/parts`, { part: 'soprano', url: 'https://drive.google.com/file/d/abc/view' });
  s = await call(owner, 'POST', `/admin/songs/${song.id}/parts`, { part: 'alto', url: 'https://youtu.be/xyz', name: 'Alto (Mary, slow)' });
  assert.equal(s.parts.length, 2);
  assert.equal(s.parts[1].name, 'Alto (Mary, slow)');
  assert.equal(s.parts[0].name, 'Soprano');
  const media = db.all('media')[0];
  if (media) { s = await call(owner, 'POST', `/admin/songs/${song.id}/parts`, { part: 'full', mediaId: media.id }); assert.equal(s.parts.at(-1).url, media.url); }
  const removed = await call(owner, 'DELETE', `/admin/songs/${song.id}/parts/${s.parts[0].id}`);
  assert.ok(!removed.parts.some((p: any) => p.part === 'soprano'));
  assert.equal(db.get('songs', song.id)!.parts!.length, removed.parts.length);
  // The musicians' view carries them.
  const band = await call(owner, 'GET', `/present/ev_1/band`).catch(() => null);
  if (band) assert.ok(JSON.stringify(band).includes('youtu.be/xyz'), 'band view has the recordings');

  // Last Thursday's practice: who came.
  const team = db.get('teams', 'tm_worship')!;
  const ids = team.members.map((m) => m.personId);
  const came = ids.filter((id) => id !== 'p_priya').slice(0, 5);
  await fails(call(owner, 'POST', '/admin/practices', { teamId: 'tm_worship', presentIds: came }), 422);
  const last = await call(owner, 'POST', '/admin/practices', { teamId: 'tm_worship', at: '2026-10-29T13:30:00.000Z', eventId: 'ev_7', presentIds: [...came, 'nobody'], notes: 'Worked on harmonies for Amazing Grace.' });
  assert.equal(last.present, 5, 'strangers are dropped');
  assert.equal(last.roster, ids.length);
  assert.equal(last.teamName, 'Worship');
  assert.ok(last.songs.length >= 3, 'songs default to the service plan');
  assert.equal(last.minutes, 90);
  // This week's, with Priya present and an explicit song list.
  const thisWeek = await call(owner, 'POST', '/admin/practices', { teamId: 'tm_worship', at: '2026-11-05T13:30:00.000Z', eventId: 'ev_1', presentIds: [...came.slice(0, 3), 'p_priya'], songIds: [song.id], minutes: 75 });
  assert.deepEqual(thisWeek.songs.map((x: any) => x.id), [song.id]);
  const edited = await call(owner, 'PATCH', `/admin/practices/${thisWeek.id}`, { notes: 'Alto section needs the bridge again.' });
  assert.equal(edited.notes, 'Alto section needs the bridge again.');
  assert.equal(edited.presentIds.length, 4, 'patching notes keeps attendance');

  hub = await call(owner, 'GET', '/admin/practices?teamId=tm_worship');
  assert.equal(hub.practices.length, 2);
  assert.equal(hub.practices[0].id, thisWeek.id, 'newest first');
  const pm = hub.members.find((m: any) => m.personId === 'p_priya');
  assert.equal(pm.present, 1); assert.equal(pm.total, 2); assert.equal(pm.missedInARow, 0);
  const absent = hub.members.find((m: any) => m.personId === came[4]);
  assert.equal(absent.present, 1); assert.equal(absent.missedInARow, 1);
  const never = hub.members.find((m: any) => !came.includes(m.personId) && m.personId !== 'p_priya');
  assert.equal(never.missedInARow, 2);
  assert.equal(hub.members[0].missedInARow, 2, 'the ones slipping away sort first');
  assert.equal(hub.songsWithParts.length, 1);

  const csv = await call(owner, 'GET', '/admin/practices/attendance.csv?teamId=tm_worship');
  assert.ok(csv.__raw && csv.body.startsWith('"Name","Parts","Present","Of","2026-11-05","2026-10-29"'), csv.body.slice(0, 80));
  assert.ok(csv.body.includes('"Priya Thomas"'));

  // Priya's view: her parts, the next rehearsal, songs with recordings, her attendance.
  db.put('teams', { ...team, leaderId: came[0] }); // the seed happens to make her the leader; hand it to someone else first
  let mine = await call(priya, 'GET', '/me/practice');
  assert.equal(mine.teams.length, 1);
  assert.deepEqual(mine.teams[0].myParts, ['Vocals']);
  assert.equal(mine.teams[0].isLeader, false);
  assert.equal(mine.nextRehearsal.eventId, 'ev_1');
  assert.equal(mine.songs[0].id, song.id, 'songs with parts, the next service first');
  assert.ok(mine.songs[0].parts.some((p: any) => p.part === 'alto'));
  assert.deepEqual(mine.attendance, { present: 1, total: 2, lastAt: '2026-11-05T13:30:00.000Z' });
  assert.equal(mine.recent.length, 2);
  assert.equal(mine.recent[1].wasPresent, false);
  await fails(call(priya, 'POST', '/me/practice', { teamId: 'tm_worship', at: '2026-11-06T13:30:00.000Z', presentIds: ['p_priya'] }), 403);

  // Make Priya the team leader: she can record attendance from the Team app.
  db.put('teams', { ...team, leaderId: 'p_priya' });
  const fromApp = await call(priya, 'POST', '/me/practice', { teamId: 'tm_worship', at: '2026-11-06T13:30:00.000Z', presentIds: ['p_priya', came[0]], notes: 'Extra run-through.' });
  assert.equal(fromApp.present, 2);
  assert.equal(fromApp.recordedBy, 'Priya Thomas');
  const fixed = await call(priya, 'PATCH', `/me/practice/${fromApp.id}`, { presentIds: ['p_priya'] });
  assert.equal(fixed.present, 1);
  mine = await call(priya, 'GET', '/me/practice');
  assert.equal(mine.teams[0].isLeader, true);
  assert.ok(mine.teams[0].roster.length === ids.length);

  // Wednesday morning: the team is told about Thursday's rehearsal, once, with the songs.
  await call(priya, 'POST', '/me/devices', { token: 'ExponentPushToken[priya]', platform: 'android', app: 'member' });
  clock += 2 * 86_400_000; // Wed 4 Nov, 10:30 am IST
  let n = env.outbox.length;
  await engine.tick();
  const sent = env.outbox.slice(n).filter((o) => /Practice tomorrow/.test(o.subject));
  assert.ok(sent.length > 0, 'the team is nudged');
  assert.ok(sent.some((o) => o.channel === 'push' && /♪/.test(o.text)), JSON.stringify(sent.slice(0, 2)));
  assert.ok(sent.some((o) => /Thu, 7:00 pm/.test(o.subject)), sent[0].subject);
  n = env.outbox.length;
  await engine.tick();
  assert.equal(env.outbox.slice(n).filter((o) => /Practice tomorrow/.test(o.subject)).length, 0, 'only once');

  await call(owner, 'DELETE', `/admin/practices/${fromApp.id}`);
  hub = await call(owner, 'GET', '/admin/practices');
  assert.equal(hub.practices.length, 2);
  const exp = await call(priya, 'GET', '/me/privacy/export');
  assert.equal(exp.practices.length, 1);
});
