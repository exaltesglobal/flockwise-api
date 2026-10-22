// Team hub: notices, chat threads and tasks for the office and the serving teams. The office uses it
// at /admin/team-hub; volunteers see their own teams' channels in the Team app (/team/:teamId/...).
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import { isBuiltIn } from '../perms.js';
import type { Collections, HubChannel, HubChannelDetail, HubChannelView, HubKey, HubMember, HubPost, HubPostKind, HubView, MyTask, NotificationKind } from '../types.js';
import { find, page, requireFields, settings } from '../util.js';
import { notify, ruleFor } from './notify.js';

const STAFF_CHANNEL = 'hub_staff';
const MAX_TEXT = 4000;

const personName = (p: Collections['people']) => `${p.firstName} ${p.lastName}`.trim();
const personMember = (p: Collections['people']): HubMember => ({ key: `p:${p.id}`, personId: p.id, staffId: null, name: personName(p) });
const staffMember = (s: Collections['staff']): HubMember => (s.personId ? { key: `p:${s.personId}`, personId: s.personId, staffId: s.id, name: s.name } : { key: `s:${s.id}`, personId: null, staffId: s.id, name: s.name });

/** Who is asking: an office login (by person when it has one) or a member of the church. */
export function meKey(ctx: Ctx): HubMember {
  if (ctx.staff) return staffMember(ctx.staff);
  const p = ctx.db.get('people', ctx.me());
  if (!p) throw new ApiError(401, 'unauthorized', 'Please sign in again.');
  return personMember(p);
}

/** Resolves a key back to a member, for names on tasks and mentions. */
function memberOf(ctx: Ctx, key: HubKey): HubMember | null {
  if (key.startsWith('p:')) {
    const p = ctx.db.get('people', key.slice(2));
    if (!p) return null;
    const staff = ctx.db.all('staff').find((s) => s.personId === p.id);
    return { ...personMember(p), staffId: staff?.id ?? null };
  }
  const s = ctx.db.get('staff', key.slice(2));
  return s ? staffMember(s) : null;
}

const dedupe = (list: HubMember[]) => [...new Map(list.map((m) => [m.key, m])).values()].sort((a, b) => a.name.localeCompare(b.name));

/** The office logins that oversee every team channel. */
const overseers = (ctx: Ctx) => ctx.db.all('staff').filter((s) => s.status === 'active' && (s.role === 'owner' || s.role === 'admin' || s.role === 'pastor'));

export function channelMembers(ctx: Ctx, ch: HubChannel): HubMember[] {
  if (ch.kind === 'staff') return dedupe(ctx.db.all('staff').filter((s) => s.status === 'active').map(staffMember));
  if (ch.kind === 'team') {
    const t = ch.teamId ? ctx.db.get('teams', ch.teamId) : undefined;
    if (!t) return [];
    const ids = [...t.members.map((m) => m.personId), ...(t.leaderId ? [t.leaderId] : [])];
    const people = ids.map((id) => ctx.db.get('people', id)).filter((p): p is Collections['people'] => !!p).map(personMember);
    return dedupe([...people, ...overseers(ctx).map(staffMember)]);
  }
  return dedupe(ch.memberKeys.map((k) => memberOf(ctx, k)).filter((m): m is HubMember => !!m));
}

const isMember = (ctx: Ctx, ch: HubChannel, me: HubMember) => channelMembers(ctx, ch).some((m) => m.key === me.key);

/** Every serving team has one channel; it is made the first time anyone looks. */
export function teamChannel(ctx: Ctx, teamId: string): HubChannel {
  const existing = ctx.db.all('hubChannels').find((c) => c.kind === 'team' && c.teamId === teamId);
  if (existing) return existing;
  const t = find(ctx, 'teams', teamId, 'Team');
  return ctx.db.put('hubChannels', { id: `hub_team_${t.id}`, name: t.name, kind: 'team', teamId: t.id, memberKeys: [], createdBy: 'system', createdAt: ctx.now.toISOString(), archived: false });
}
function staffChannel(ctx: Ctx): HubChannel {
  return ctx.db.get('hubChannels', STAFF_CHANNEL) ?? ctx.db.put('hubChannels', { id: STAFF_CHANNEL, name: 'Office team', kind: 'staff', teamId: null, memberKeys: [], createdBy: 'system', createdAt: ctx.now.toISOString(), archived: false });
}

const readKey = (me: HubMember, channelId: string) => `hub-read:${me.key}:${channelId}`;
const lastRead = (ctx: Ctx, me: HubMember, channelId: string) => ctx.db.get('meta', readKey(me, channelId))?.value ?? '';
const markRead = (ctx: Ctx, me: HubMember, channelId: string) => ctx.db.put('meta', { id: readKey(me, channelId), value: ctx.now.toISOString() });

function channelView(ctx: Ctx, ch: HubChannel, me: HubMember): HubChannelView {
  const posts = ctx.db.all('hubPosts').filter((p) => p.channelId === ch.id);
  const since = lastRead(ctx, me, ch.id);
  const last = posts.reduce<HubPost | null>((a, p) => (!a || p.at > a.at ? p : a), null);
  return {
    ...ch,
    members: channelMembers(ctx, ch),
    teamName: ch.teamId ? ctx.db.get('teams', ch.teamId)?.name ?? null : null,
    unread: posts.filter((p) => p.at > since && p.authorKey !== me.key).length,
    lastAt: last?.at ?? null,
    lastText: last ? `${last.authorName.split(' ')[0]}: ${last.text.slice(0, 80)}` : '',
    openTasks: posts.filter((p) => p.task && !p.task.done).length,
  };
}

/** Channels this person can see: the office channel for staff, their teams' channels, and custom threads they are in. */
export function myChannels(ctx: Ctx, me: HubMember): HubChannel[] {
  const out: HubChannel[] = [];
  if (ctx.staff) out.push(staffChannel(ctx));
  const teams = ctx.db.all('teams').filter((t) => (me.personId && (t.leaderId === me.personId || t.members.some((m) => m.personId === me.personId))) || (ctx.staff && overseers(ctx).some((s) => s.id === ctx.staff!.id)));
  for (const t of teams) out.push(teamChannel(ctx, t.id));
  for (const c of ctx.db.all('hubChannels')) if (c.kind === 'custom' && !c.archived && c.memberKeys.includes(me.key)) out.push(c);
  return out;
}

function openChannel(ctx: Ctx, id: string, me: HubMember): HubChannel {
  const ch = find(ctx, 'hubChannels', id, 'Channel');
  if (ch.archived || !isMember(ctx, ch, me)) throw new ApiError(403, 'forbidden', 'You are not in this channel.');
  return ch;
}

/** Finds "@First Last" or "@First" in the text among the channel's members. */
function mentionsIn(text: string, members: HubMember[]): HubKey[] {
  const lower = text.toLowerCase();
  return members.filter((m) => lower.includes(`@${m.name.toLowerCase()}`) || lower.includes(`@${m.name.split(' ')[0].toLowerCase()}`)).map((m) => m.key);
}

/** Tells members: people through the usual channels; office logins without a person record by email. */
async function tell(ctx: Ctx, kind: NotificationKind, members: HubMember[], except: HubMember, title: string, body: string, link: string) {
  const targets = members.filter((m) => m.key !== except.key);
  await notify(ctx, kind, { personIds: targets.map((m) => m.personId).filter((id): id is string => !!id), title, body, link });
  if (!ruleFor(ctx, kind).email) return;
  const mails = targets.filter((m) => !m.personId && m.staffId).map((m) => ctx.db.get('staff', m.staffId!)).filter((s): s is Collections['staff'] => !!s?.email);
  if (mails.length) await ctx.env.deliver('email', mails.map((s) => ({ to: s.email, name: s.name, subject: title, text: `${body}\n\n${ctx.env.webUrl}/admin/team-hub` }))).catch(() => undefined);
}

function postView(p: HubPost) { return p; }

async function createPost(ctx: Ctx, ch: HubChannel, me: HubMember, body: Record<string, unknown>): Promise<HubPost> {
  const text = String(body.text ?? '').trim().slice(0, MAX_TEXT);
  if (!text) throw new ApiError(422, 'invalid', 'Write something first.', { text: 'Required' });
  const kind = (['message', 'notice', 'task'].includes(String(body.kind)) ? body.kind : 'message') as HubPostKind;
  const members = channelMembers(ctx, ch);
  let task: HubPost['task'] = null;
  if (kind === 'task') {
    const t = (body.task ?? {}) as { assigneeKey?: string; dueAt?: string | null };
    const assignee = members.find((m) => m.key === t.assigneeKey);
    if (!assignee) throw new ApiError(422, 'invalid', 'Pick who this task is for.', { assigneeKey: 'Pick someone in this channel' });
    task = { assigneeKey: assignee.key, assigneeName: assignee.name, dueAt: t.dueAt ? String(t.dueAt) : null, done: false, doneAt: null, doneByName: null };
  }
  const post = ctx.db.put('hubPosts', { id: ctx.id('hp'), channelId: ch.id, kind, text, authorKey: me.key, authorName: me.name, at: ctx.now.toISOString(), pinned: kind === 'notice' && body.pinned !== false, mentions: mentionsIn(text, members), task });
  markRead(ctx, me, ch.id);
  const church = settings(ctx).name;
  const link = ch.teamId ? `/app/team/${ch.teamId}/threads/${ch.id}` : `/app/team/threads/${ch.id}`;
  if (kind === 'notice') await tell(ctx, 'team.notice', members, me, `${ch.name}: notice from ${me.name.split(' ')[0]}`, text.slice(0, 300), link);
  else if (kind === 'task' && task) await tell(ctx, 'task.assigned', members.filter((m) => m.key === task!.assigneeKey), me, `${church}: a task from ${me.name.split(' ')[0]}`, `${text.slice(0, 300)}${task.dueAt ? ` (by ${task.dueAt.slice(0, 10)})` : ''}`, `/app/tasks/${post.id}`);
  else {
    const named = members.filter((m) => post.mentions.includes(m.key));
    const targets = ch.kind === 'custom' ? members : named;
    if (targets.length) await tell(ctx, 'team.message', targets, me, `${ch.name}: ${me.name.split(' ')[0]}`, text.slice(0, 300), link);
  }
  return post;
}

function channelDetail(ctx: Ctx, ch: HubChannel, me: HubMember, cursor?: string | null): HubChannelDetail {
  const all = ctx.db.all('hubPosts').filter((p) => p.channelId === ch.id).sort((a, b) => b.at.localeCompare(a.at));
  const view = channelView(ctx, ch, me);
  markRead(ctx, me, ch.id);
  const paged = page(all.filter((p) => !p.pinned), cursor, 50);
  return { channel: { ...view, unread: 0 }, pinned: all.filter((p) => p.pinned).map(postView), posts: paged.data.map(postView), nextCursor: paged.nextCursor };
}

function myTasks(ctx: Ctx, me: HubMember): MyTask[] {
  return ctx.db
    .all('hubPosts')
    .filter((p) => p.task && p.task.assigneeKey === me.key)
    .sort((a, b) => Number(a.task!.done) - Number(b.task!.done) || (a.task!.dueAt ?? '9').localeCompare(b.task!.dueAt ?? '9') || b.at.localeCompare(a.at))
    .map((p) => { const ch = ctx.db.get('hubChannels', p.channelId); return { ...p, channelName: ch?.name ?? '', teamId: ch?.teamId ?? null }; });
}

function updatePost(ctx: Ctx, me: HubMember, body: Record<string, unknown>, id: string): HubPost {
  const p = find(ctx, 'hubPosts', id, 'Post');
  const ch = openChannel(ctx, p.channelId, me);
  const mine = p.authorKey === me.key;
  const admin = !!ctx.staff && isBuiltIn(ctx.staff.role) && ['owner', 'admin', 'pastor'].includes(ctx.staff.role);
  const next = { ...p };
  if (body.text !== undefined) {
    if (!mine && !admin) throw new ApiError(403, 'forbidden', 'Only the writer can change this.');
    next.text = String(body.text).trim().slice(0, MAX_TEXT) || p.text;
    next.mentions = mentionsIn(next.text, channelMembers(ctx, ch));
  }
  if (body.pinned !== undefined) {
    if (!mine && !admin) throw new ApiError(403, 'forbidden', 'Only the writer or the office can pin this.');
    next.pinned = !!body.pinned;
  }
  if (body.done !== undefined && p.task) {
    if (p.task.assigneeKey !== me.key && !mine && !admin) throw new ApiError(403, 'forbidden', 'Only the person it is for can tick this.');
    next.task = { ...p.task, done: !!body.done, doneAt: body.done ? ctx.now.toISOString() : null, doneByName: body.done ? me.name : null };
  }
  return ctx.db.put('hubPosts', next);
}

export function registerTeamHub(r: Router) {
  // ----- office -----
  r.get('/admin/team-hub', { staff: true }, (ctx): HubView => {
    const me = meKey(ctx);
    const channels = myChannels(ctx, me).map((c) => channelView(ctx, c, me)).sort((a, b) => (b.lastAt ?? b.createdAt).localeCompare(a.lastAt ?? a.createdAt));
    // Everyone the office can start a thread with: office logins and volunteers on teams.
    const people = dedupe([...ctx.db.all('staff').filter((s) => s.status === 'active').map(staffMember), ...ctx.db.all('teams').flatMap((t) => t.members.map((m) => ctx.db.get('people', m.personId))).filter((p): p is Collections['people'] => !!p).map(personMember)]);
    return { me, channels, tasks: myTasks(ctx, me), people };
  });
  r.post('/admin/team-hub/channels', { staff: true }, (ctx) => {
    requireFields(ctx.body, ['name']);
    const me = meKey(ctx);
    const keys = [...new Set([me.key, ...((ctx.body.memberKeys as unknown[]) ?? []).map(String)])].filter((k) => memberOf(ctx, k));
    if (keys.length < 2) throw new ApiError(422, 'invalid', 'Add at least one other person.', { memberKeys: 'Add someone' });
    const teamId = ctx.body.teamId ? find(ctx, 'teams', String(ctx.body.teamId), 'Team').id : null;
    const ch = ctx.db.put('hubChannels', { id: ctx.id('hub'), name: String(ctx.body.name).trim().slice(0, 80), kind: 'custom', teamId, memberKeys: keys, createdBy: me.key, createdAt: ctx.now.toISOString(), archived: false });
    return channelView(ctx, ch, me);
  });
  r.get('/admin/team-hub/channels/:id', { staff: true }, (ctx) => { const me = meKey(ctx); return channelDetail(ctx, openChannel(ctx, ctx.params[0], me), me, ctx.query.cursor); });
  r.post('/admin/team-hub/channels/:id/posts', { staff: true }, (ctx) => { const me = meKey(ctx); return createPost(ctx, openChannel(ctx, ctx.params[0], me), me, ctx.body); });
  r.patch('/admin/team-hub/channels/:id', { staff: true }, (ctx) => {
    const me = meKey(ctx);
    const ch = openChannel(ctx, ctx.params[0], me);
    if (ch.kind !== 'custom') throw new ApiError(422, 'invalid', 'Team and office channels cannot be changed.');
    const next = { ...ch };
    if (ctx.body.name !== undefined) next.name = String(ctx.body.name).trim().slice(0, 80) || ch.name;
    if (Array.isArray(ctx.body.memberKeys)) next.memberKeys = [...new Set([ch.createdBy, ...(ctx.body.memberKeys as unknown[]).map(String)])].filter((k) => memberOf(ctx, k));
    if (ctx.body.archived !== undefined) next.archived = !!ctx.body.archived;
    return channelView(ctx, ctx.db.put('hubChannels', next), me);
  });
  r.patch('/admin/team-hub/posts/:id', { staff: true }, (ctx) => updatePost(ctx, meKey(ctx), ctx.body, ctx.params[0]));
  r.del('/admin/team-hub/posts/:id', { staff: true }, (ctx) => {
    const me = meKey(ctx);
    const p = find(ctx, 'hubPosts', ctx.params[0], 'Post');
    openChannel(ctx, p.channelId, me);
    const admin = !!ctx.staff && ['owner', 'admin', 'pastor'].includes(ctx.staff.role);
    if (p.authorKey !== me.key && !admin) throw new ApiError(403, 'forbidden', 'Only the writer or the office can remove this.');
    ctx.db.del('hubPosts', p.id);
    return undefined;
  });

  // ----- team app (member token; only the person's own teams) -----
  const teamFor = (ctx: Ctx, me: HubMember, teamId: string) => {
    const t = find(ctx, 'teams', teamId, 'Team');
    if (!(me.personId && (t.leaderId === me.personId || t.members.some((m) => m.personId === me.personId)))) throw new ApiError(403, 'forbidden', 'You are not on this team.');
    return t;
  };
  r.get('/team/:teamId/notices', {}, (ctx) => {
    const me = meKey(ctx);
    const t = teamFor(ctx, me, ctx.params[0]);
    const ch = teamChannel(ctx, t.id);
    return ctx.db.all('hubPosts').filter((p) => p.channelId === ch.id && (p.kind === 'notice' || p.pinned)).sort((a, b) => b.at.localeCompare(a.at)).map(postView);
  });
  r.get('/team/:teamId/threads', {}, (ctx) => {
    const me = meKey(ctx);
    const t = teamFor(ctx, me, ctx.params[0]);
    const main = teamChannel(ctx, t.id);
    const threads = [main, ...ctx.db.all('hubChannels').filter((c) => c.kind === 'custom' && !c.archived && c.teamId === t.id && c.memberKeys.includes(me.key))];
    return threads.map((c) => channelView(ctx, c, me));
  });
  r.post('/team/:teamId/threads', {}, (ctx) => {
    requireFields(ctx.body, ['name']);
    const me = meKey(ctx);
    const t = teamFor(ctx, me, ctx.params[0]);
    const allowed = new Set(channelMembers(ctx, teamChannel(ctx, t.id)).map((m) => m.key));
    const keys = [...new Set([me.key, ...((ctx.body.memberKeys as unknown[]) ?? []).map(String)])].filter((k) => allowed.has(k));
    if (keys.length < 2) throw new ApiError(422, 'invalid', 'Add at least one other person from the team.', { memberKeys: 'Add someone' });
    const ch = ctx.db.put('hubChannels', { id: ctx.id('hub'), name: String(ctx.body.name).trim().slice(0, 80), kind: 'custom', teamId: t.id, memberKeys: keys, createdBy: me.key, createdAt: ctx.now.toISOString(), archived: false });
    return channelView(ctx, ch, me);
  });
  r.get('/team/:teamId/threads/:id/messages', {}, (ctx) => {
    const me = meKey(ctx);
    teamFor(ctx, me, ctx.params[0]);
    const ch = openChannel(ctx, ctx.params[1], me);
    if (ch.teamId !== ctx.params[0]) throw new ApiError(404, 'not_found', 'Thread not found.');
    return channelDetail(ctx, ch, me, ctx.query.cursor);
  });
  r.post('/team/:teamId/threads/:id/messages', {}, (ctx) => {
    const me = meKey(ctx);
    teamFor(ctx, me, ctx.params[0]);
    const ch = openChannel(ctx, ctx.params[1], me);
    if (ch.teamId !== ctx.params[0]) throw new ApiError(404, 'not_found', 'Thread not found.');
    // Volunteers write messages and tasks; notices come from the office or the team leader.
    const t = ctx.db.get('teams', ch.teamId!);
    const body = { ...ctx.body };
    if (body.kind === 'notice' && !(ctx.staff || t?.leaderId === me.personId)) body.kind = 'message';
    return createPost(ctx, ch, me, body);
  });
  r.get('/me/tasks', {}, (ctx) => myTasks(ctx, meKey(ctx)));
  r.patch('/me/tasks/:id', {}, (ctx) => {
    const me = meKey(ctx);
    const p = find(ctx, 'hubPosts', ctx.params[0], 'Task');
    if (!p.task || p.task.assigneeKey !== me.key) throw new ApiError(403, 'forbidden', 'This task is not yours.');
    return updatePost(ctx, me, { done: ctx.body.done }, p.id);
  });
}
