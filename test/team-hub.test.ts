// Team hub: office notices reach volunteers in the Team app, volunteers chat back, tasks are ticked.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

// The clock moves a second per call so "read" markers sort before later posts.
let clock = Date.parse('2026-10-22T05:00:00.000Z');
const env = createDemoEnv({ now: () => new Date((clock += 1000)) });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(audience: 'admin' | 'member', email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown, query?: Record<string, string>) => engine.handle({ method, path, body, auth, query }) as Promise<any>;
const fails = async (p: Promise<unknown>, status: number) => { const e: any = await p.then(() => null, (err) => err); assert.ok(e, `expected ${status}, got a result`); assert.equal(e.status, status, e.message); };
/** A worship singer who is neither Priya (the leader) nor the pastor. */
const singerEmail = () => { const team = db.get('teams', 'tm_worship')!; const id = team.members.map((m) => m.personId).find((pid) => pid !== 'p_priya' && pid !== 'p_samuel' && db.get('people', pid)?.email)!; return db.get('people', id)!.email!; };

test('the office sees its channels, Priya sees only her team', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const hub = await call(owner, 'GET', '/admin/team-hub');
  assert.ok(hub.channels.some((c: any) => c.id === 'hub_staff'), 'office channel');
  assert.ok(hub.channels.some((c: any) => c.id === 'hub_team_tm_worship'), 'owner oversees the worship team');
  assert.ok(hub.people.some((p: any) => p.key === 'p:p_priya'), 'volunteers can be added to threads');
  const worship = hub.channels.find((c: any) => c.id === 'hub_team_tm_worship');
  assert.ok(worship.unread >= 1, 'Priya’s DI box question is unread');

  const priya = await signIn('member', 'priya@example.com');
  const threads = await call(priya, 'GET', '/team/tm_worship/threads');
  assert.equal(threads[0].id, 'hub_team_tm_worship');
  assert.ok(threads[0].members.some((m: any) => m.key === 'p:p_priya'));
  // Another team she is not on.
  const other = db.all('teams').find((t) => t.id !== 'tm_worship')!;
  await fails(call(priya, 'GET', `/team/${other.id}/threads`), 403);
  await fails(call(priya, 'GET', '/admin/team-hub'), 403);
});

test('a notice from the office reaches the team; a reply shows up unread in the office', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const priya = await signIn('member', 'priya@example.com');
  const before = env.outbox.length;
  const notice = await call(owner, 'POST', '/admin/team-hub/channels/hub_team_tm_worship/posts', { kind: 'notice', text: 'Sound check at 4.30 pm on Sunday, please be early.' });
  assert.equal(notice.kind, 'notice');
  assert.equal(notice.pinned, true);
  const sent = env.outbox.slice(before);
  assert.ok(sent.some((o) => /Sound check/.test(o.text) && (o.channel === 'push' || o.to === 'priya@example.com')), 'Priya is told');

  const notices = await call(priya, 'GET', '/team/tm_worship/notices');
  assert.equal(notices[0].id, notice.id);

  // Opening the thread clears her unread count; her reply shows unread for the office.
  const detail = await call(priya, 'GET', '/team/tm_worship/threads/hub_team_tm_worship/messages');
  assert.ok(detail.pinned.some((p: any) => p.id === notice.id));
  assert.equal(detail.channel.unread, 0);
  // Priya leads the worship team in the demo, so her notices stay notices; another singer's is a plain message.
  const lead = await call(priya, 'POST', '/team/tm_worship/threads/hub_team_tm_worship/messages', { kind: 'notice', text: 'Vocals, warm up at 4.15.' });
  assert.equal(lead.kind, 'notice');
  const singer = await signIn('member', singerEmail());
  const reply = await call(singer, 'POST', '/team/tm_worship/threads/hub_team_tm_worship/messages', { kind: 'notice', text: 'Noted, I will be there by 4.' });
  assert.equal(reply.kind, 'message', 'volunteers cannot post notices');
  const hub = await call(owner, 'GET', '/admin/team-hub');
  const worship = hub.channels.find((c: any) => c.id === 'hub_team_tm_worship');
  assert.ok(worship.unread >= 1);
  assert.match(worship.lastText, /: Noted/);
  const opened = await call(owner, 'GET', '/admin/team-hub/channels/hub_team_tm_worship');
  assert.ok(opened.posts.some((p: any) => p.id === reply.id));
  const again = await call(owner, 'GET', '/admin/team-hub');
  assert.equal(again.channels.find((c: any) => c.id === 'hub_team_tm_worship').unread, 0);
});

test('a task goes to Priya, shows in /me/tasks and can be ticked only by her', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const priya = await signIn('member', 'priya@example.com');
  const before = env.outbox.length;
  const task = await call(owner, 'POST', '/admin/team-hub/channels/hub_team_tm_worship/posts', { kind: 'task', text: 'Bring the spare DI box on Saturday.', task: { assigneeKey: 'p:p_priya', dueAt: '2026-10-24' } });
  assert.equal(task.task.assigneeName, 'Priya Thomas');
  assert.ok(env.outbox.slice(before).some((o) => /spare DI box/.test(o.text)), 'assignee is told');
  // Someone outside the channel cannot be assigned.
  await fails(call(owner, 'POST', '/admin/team-hub/channels/hub_team_tm_worship/posts', { kind: 'task', text: 'x', task: { assigneeKey: 'p:nobody' } }), 422);

  const mine = await call(priya, 'GET', '/me/tasks');
  assert.equal(mine[0].id, task.id);
  assert.equal(mine[0].teamId, 'tm_worship');
  assert.equal(mine[0].channelName, 'Worship');
  const other = await signIn('member', singerEmail());
  await fails(call(other, 'PATCH', `/me/tasks/${task.id}`, { done: true }), 403);
  const done = await call(priya, 'PATCH', `/me/tasks/${task.id}`, { done: true });
  assert.equal(done.task.done, true);
  assert.equal(done.task.doneByName, 'Priya Thomas');
  const hub = await call(owner, 'GET', '/admin/team-hub');
  assert.equal(hub.channels.find((c: any) => c.id === 'hub_team_tm_worship').openTasks, 0);
});

test('custom threads: members only, tagged to a team, everyone in it is told', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const priya = await signIn('member', 'priya@example.com');
  await fails(call(owner, 'POST', '/admin/team-hub/channels', { name: 'Lonely', memberKeys: [] }), 422);
  const th = await call(owner, 'POST', '/admin/team-hub/channels', { name: 'Christmas carols', memberKeys: ['p:p_priya', 's:st_2'], teamId: 'tm_worship' });
  assert.equal(th.kind, 'custom');
  assert.equal(th.members.length, 3);
  // Thread messages go out by push, so Priya's phone has to be registered.
  await call(priya, 'POST', '/me/devices', { token: 'expo-token-priya', platform: 'android', app: 'team' });
  const before = env.outbox.length;
  const msg = await call(owner, 'POST', `/admin/team-hub/channels/${th.id}/posts`, { text: 'First carol practice on 1 December.' });
  assert.equal(msg.kind, 'message');
  const sent = env.outbox.slice(before);
  assert.ok(sent.some((o) => o.channel === 'push' && o.to === 'expo-token-priya' && /carol practice/.test(o.text)), 'members of a custom thread are told by push');
  // Priya sees it under her team; an outsider does not.
  const threads = await call(priya, 'GET', '/team/tm_worship/threads');
  assert.ok(threads.some((t: any) => t.id === th.id));
  const detail = await call(priya, 'GET', `/team/tm_worship/threads/${th.id}/messages`);
  assert.equal(detail.posts[0].id, msg.id);
  const other = await signIn('member', singerEmail());
  await fails(call(other, 'GET', `/team/tm_worship/threads/${th.id}/messages`), 403);
  // Priya can start her own thread with team mates; the office can archive a custom thread.
  const mine = await call(priya, 'POST', '/team/tm_worship/threads', { name: 'Vocals', memberKeys: ['p:p_samuel'] });
  assert.equal(mine.teamId, 'tm_worship');
  const archived = await call(owner, 'PATCH', `/admin/team-hub/channels/${th.id}`, { archived: true });
  assert.equal(archived.archived, true);
  await fails(call(priya, 'GET', `/team/tm_worship/threads/${th.id}/messages`), 403);
  // Mentions.
  const m = await call(owner, 'POST', '/admin/team-hub/channels/hub_staff/posts', { text: '@Leena can you check the projector today?' });
  assert.deepEqual(m.mentions, ['s:st_2']);
});
