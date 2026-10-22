// Deposit batches, the live service timer and CCLI report, group conversations and
// resources, the sermon library, and the public church page with its group finder.
import { ApiError } from '../errors.js';
import type { Ctx, Router } from '../engine.js';
import type { Batch, BatchView, CcliRow, Collections, GroupDetailMember, LiveState, LiveView, PublicChurch, PublicGroup, PublicPage, Sermon } from '../types.js';
import { adminDonation, bySoonest, church, DAY, eventView, find, fullName, giftDate, matchOrCreatePerson, memberGroup, pick, requireFields, settings, upcoming } from '../util.js';
import { formForEvent } from './forms.js';
import { liveCampaigns, publicCampaign } from './offerings.js';

// ----- deposit batches -----

function batchView(ctx: Ctx, b: Batch): BatchView {
  const gifts = ctx.db.all('donations').filter((d) => d.batchId === b.id && d.status === 'succeeded');
  const total = gifts.reduce((s, d) => s + d.amount, 0);
  const byMethod = new Map<string, { count: number; total: number }>();
  for (const d of gifts) {
    const m = byMethod.get(d.method ?? 'other') ?? { count: 0, total: 0 };
    byMethod.set(d.method ?? 'other', { count: m.count + 1, total: m.total + d.amount });
  }
  return { ...b, count: gifts.length, total, byMethod: [...byMethod].map(([method, v]) => ({ method, ...v })), difference: b.expectedTotal === null ? null : total - b.expectedTotal };
}

// ----- live service -----

function liveFor(ctx: Ctx, eventId: string): LiveState {
  return ctx.db.get('live', eventId) ?? { id: eventId, eventId, itemIndex: 0, startedAt: null, itemStartedAt: null, endedAt: null };
}

export function liveView(ctx: Ctx, ev: Collections['events']): LiveView {
  const plan = ctx.db.all('plans').find((p) => p.eventId === ev.id) ?? { id: '', eventId: ev.id, theme: '', notes: '', items: [], updatedAt: ctx.now.toISOString() };
  const live = liveFor(ctx, ev.id);
  const item = plan.items[live.itemIndex];
  const itemEndsAt = live.itemStartedAt && item && !live.endedAt ? new Date(new Date(live.itemStartedAt).getTime() + item.minutes * 60_000).toISOString() : null;
  const remaining = plan.items.slice(live.itemIndex + 1).reduce((s, i) => s + i.minutes, 0);
  const serviceEndsAt = itemEndsAt ? new Date(new Date(itemEndsAt).getTime() + remaining * 60_000).toISOString() : null;
  return { event: eventView(ctx, ev), plan, live, itemEndsAt, serviceEndsAt };
}

// ----- groups -----

function isLeader(ctx: Ctx, groupId: string, personId: string) {
  const g = ctx.db.get('groups', groupId);
  return !!g && (g.leaderId === personId || ctx.db.all('staff').some((s) => s.personId === personId && s.status === 'active' && ['owner', 'admin', 'pastor'].includes(s.role)));
}

function requireMember(ctx: Ctx, groupId: string, personId: string) {
  const member = ctx.db.all('groupMembers').some((m) => m.groupId === groupId && m.personId === personId);
  if (!member && !isLeader(ctx, groupId, personId)) throw new ApiError(403, 'forbidden', 'Only group members can see this.');
}

function publicGroup(ctx: Ctx, g: Collections['groups']): PublicGroup {
  const leader = g.leaderId ? ctx.db.get('people', g.leaderId) : null;
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    meetingSchedule: g.meetingSchedule,
    // Homes are private: show the area, not the street address.
    location: g.zone || g.location.split(',').slice(-1)[0]?.trim() || '',
    type: g.type,
    zone: g.zone,
    leaderName: leader ? leader.firstName : g.leaderName.split(' ')[0],
    memberCount: ctx.db.all('groupMembers').filter((m) => m.groupId === g.id).length,
  };
}

// ----- publishing -----

const DEFAULT_PAGE: PublicPage = { enabled: false, tagline: '', about: '', serviceTimes: '', heroImageUrl: '', showEvents: true, showGroups: true, showSermons: true, showGiving: true };
export const publicPageOf = (ctx: Ctx): PublicPage => ({ ...DEFAULT_PAGE, ...(settings(ctx).publicPage ?? {}) });

function cleanSermon(body: Record<string, unknown>): Partial<Sermon> {
  const input = pick<Sermon>(body, ['title', 'speaker', 'date', 'series', 'scripture', 'description', 'videoUrl', 'audioUrl', 'notesUrl', 'imageUrl', 'published', 'eventId']);
  for (const k of ['videoUrl', 'audioUrl', 'notesUrl', 'imageUrl'] as const) if (input[k] && !/^https?:\/\//.test(String(input[k]))) throw new ApiError(422, 'invalid', 'Links should start with https://', { [k]: 'Use a full link' });
  if (input.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(input.date))) throw new ApiError(422, 'invalid', 'Use a date.', { date: 'YYYY-MM-DD' });
  return input;
}

const sermonsPublished = (ctx: Ctx) => ctx.db.all('sermons').filter((s) => s.published).sort((x, y) => y.date.localeCompare(x.date));

export function registerMinistry(r: Router) {
  // ----- giving: deposit batches -----
  r.get('/admin/giving/batches', { perm: 'giving.view' }, (ctx) => ctx.db.all('batches').sort((x, y) => y.date.localeCompare(x.date) || y.createdAt.localeCompare(x.createdAt)).map((b) => batchView(ctx, b)));
  r.post('/admin/giving/batches', { perm: 'giving.edit' }, (ctx) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(ctx.body.date)) ? String(ctx.body.date) : ctx.now.toISOString().slice(0, 10);
    const b = ctx.db.put('batches', {
      id: ctx.id('bt'),
      name: String(ctx.body.name ?? '').trim() || `Sunday offering ${date}`,
      date,
      status: 'open',
      expectedTotal: ctx.body.expectedTotal ? Math.round(Number(ctx.body.expectedTotal)) : null,
      notes: String(ctx.body.notes ?? ''),
      createdBy: ctx.staff?.name ?? '',
      createdAt: ctx.now.toISOString(),
      committedAt: null,
      committedBy: null,
    });
    ctx.audit('created', 'batch', b.id, `Opened the batch “${b.name}”`);
    return batchView(ctx, b);
  });
  r.get('/admin/giving/batches/:id', { perm: 'giving.view' }, (ctx) => {
    const b = find(ctx, 'batches', ctx.params[0], 'Batch');
    const gifts = ctx.db.all('donations').filter((d) => d.batchId === b.id).sort((x, y) => giftDate(y).localeCompare(giftDate(x)));
    return { batch: batchView(ctx, b), donations: gifts.map(adminDonation) };
  });
  r.patch('/admin/giving/batches/:id', { perm: 'giving.edit' }, (ctx) => {
    const b = find(ctx, 'batches', ctx.params[0], 'Batch');
    const patch = pick<Batch>(ctx.body, ['name', 'notes', 'expectedTotal', 'date']);
    if (patch.expectedTotal !== undefined) patch.expectedTotal = patch.expectedTotal ? Math.round(Number(patch.expectedTotal)) : null;
    return batchView(ctx, ctx.db.put('batches', { ...b, ...patch }));
  });
  r.post('/admin/giving/batches/:id/commit', { perm: 'giving.edit' }, (ctx) => {
    const b = find(ctx, 'batches', ctx.params[0], 'Batch');
    const v = batchView(ctx, b);
    if (!v.count) throw new ApiError(422, 'empty', 'Add gifts to the batch before committing it.');
    if (v.difference && !ctx.body.force) throw new ApiError(409, 'mismatch', `The gifts add up to ${(v.total / 100).toFixed(2)}, which doesn't match the counted total. Check the entries or commit anyway.`);
    ctx.audit('committed', 'batch', b.id, `Committed the batch “${b.name}” (${v.count} gifts)`);
    return batchView(ctx, ctx.db.put('batches', { ...b, status: 'committed', committedAt: ctx.now.toISOString(), committedBy: ctx.staff?.name ?? '' }));
  });
  r.post('/admin/giving/batches/:id/reopen', { perm: 'giving.edit' }, (ctx) => {
    const b = find(ctx, 'batches', ctx.params[0], 'Batch');
    ctx.audit('reopened', 'batch', b.id, `Reopened the batch “${b.name}”`);
    return batchView(ctx, ctx.db.put('batches', { ...b, status: 'open', committedAt: null, committedBy: null }));
  });
  r.del('/admin/giving/batches/:id', { perm: 'giving.edit' }, (ctx) => {
    const b = find(ctx, 'batches', ctx.params[0], 'Batch');
    if (ctx.db.all('donations').some((d) => d.batchId === b.id)) throw new ApiError(409, 'not_empty', 'Only empty batches can be deleted.');
    ctx.db.del('batches', b.id);
    return undefined;
  });

  // ----- services: live timer and CCLI -----
  r.get('/admin/services/:eventId/live', { perm: ['services', 'volunteers', 'checkin'] }, (ctx) => liveView(ctx, find(ctx, 'events', ctx.params[0], 'Service')));
  r.post('/admin/services/:eventId/live', { perm: 'services' }, (ctx) => {
    const ev = find(ctx, 'events', ctx.params[0], 'Service');
    const plan = ctx.db.all('plans').find((p) => p.eventId === ev.id);
    if (!plan?.items.length) throw new ApiError(422, 'no_plan', 'Add items to the order of service first.');
    const live = liveFor(ctx, ev.id);
    const now = ctx.now.toISOString();
    const last = plan.items.length - 1;
    let next: LiveState = live;
    switch (ctx.body.action) {
      case 'start':
        next = { ...live, itemIndex: 0, startedAt: now, itemStartedAt: now, endedAt: null };
        break;
      case 'next':
        next = live.itemIndex >= last ? { ...live, endedAt: now } : { ...live, itemIndex: live.itemIndex + 1, itemStartedAt: now, startedAt: live.startedAt ?? now };
        break;
      case 'prev':
        next = { ...live, itemIndex: Math.max(0, live.itemIndex - 1), itemStartedAt: now, endedAt: null };
        break;
      case 'goto':
        next = { ...live, itemIndex: Math.min(last, Math.max(0, Number(ctx.body.index) || 0)), itemStartedAt: now, startedAt: live.startedAt ?? now, endedAt: null };
        break;
      case 'stop':
        next = { ...live, endedAt: now };
        break;
      case 'reset':
        next = { ...live, itemIndex: 0, startedAt: null, itemStartedAt: null, endedAt: null };
        break;
      default:
        throw new ApiError(422, 'invalid', 'Unknown action.');
    }
    ctx.db.put('live', next);
    return liveView(ctx, ev);
  });
  r.get('/admin/songs/ccli-report', { perm: ['services', 'volunteers'] }, (ctx): { from: string; to: string; rows: CcliRow[] } => {
    const to = ctx.query.to ?? ctx.now.toISOString().slice(0, 10);
    const from = ctx.query.from ?? new Date(new Date(to).getTime() - 180 * DAY).toISOString().slice(0, 10);
    const rows = new Map<string, CcliRow>();
    for (const plan of ctx.db.all('plans')) {
      const ev = ctx.db.get('events', plan.eventId);
      const date = ev?.startsAt.slice(0, 10);
      if (!date || date < from || date > to || date > ctx.now.toISOString().slice(0, 10)) continue;
      for (const item of plan.items) {
        const song = item.songId ? ctx.db.get('songs', item.songId) : null;
        if (!song) continue;
        const row = rows.get(song.id) ?? { songId: song.id, title: song.title, author: song.author, ccli: song.ccli, uses: 0, dates: [] };
        row.uses++;
        if (!row.dates.includes(date)) row.dates.push(date);
        rows.set(song.id, row);
      }
    }
    return { from, to, rows: [...rows.values()].sort((x, y) => y.uses - x.uses || x.title.localeCompare(y.title)) };
  });

  // ----- groups: members' space -----
  r.get('/groups/:id', {}, (ctx): GroupDetailMember => {
    const me = ctx.me();
    const g = find(ctx, 'groups', ctx.params[0], 'Group');
    const view = memberGroup(ctx, g, me);
    const member = view.membership === 'member' || isLeader(ctx, g.id, me);
    if (!g.isOpen && !member) throw new ApiError(404, 'not_found', 'Group not found.');
    const members = member
      ? ctx.db.all('groupMembers').filter((m) => m.groupId === g.id).map((m) => ctx.db.get('people', m.personId)).filter((p): p is Collections['people'] => !!p).map((p) => ({ id: p.id, name: fullName(p) }))
      : [];
    const meetings = ctx.db.all('groupMeetings').filter((m) => m.groupId === g.id).sort((x, y) => y.date.localeCompare(x.date));
    return {
      group: view,
      isLeader: isLeader(ctx, g.id, me),
      members,
      posts: member ? ctx.db.all('groupPosts').filter((p) => p.groupId === g.id).sort((x, y) => Number(y.pinned) - Number(x.pinned) || y.at.localeCompare(x.at)).slice(0, 100) : [],
      resources: member ? ctx.db.all('groupResources').filter((x) => x.groupId === g.id).sort((x, y) => y.at.localeCompare(x.at)) : [],
      nextMeeting: meetings[0]?.date ?? null,
    };
  });
  r.post('/groups/:id/posts', {}, (ctx) => {
    const me = find(ctx, 'people', ctx.me(), 'Profile');
    const g = find(ctx, 'groups', ctx.params[0], 'Group');
    requireMember(ctx, g.id, me.id);
    requireFields(ctx.body, ['text']);
    return ctx.db.put('groupPosts', { id: ctx.id('gp'), groupId: g.id, authorId: me.id, authorName: fullName(me), text: String(ctx.body.text).trim().slice(0, 4000), at: ctx.now.toISOString(), pinned: false });
  });
  r.patch('/groups/:id/posts/:postId', {}, (ctx) => {
    const me = ctx.me();
    const post = find(ctx, 'groupPosts', ctx.params[1], 'Post');
    if (!isLeader(ctx, post.groupId, me)) throw new ApiError(403, 'forbidden', 'Only group leaders can pin posts.');
    return ctx.db.put('groupPosts', { ...post, pinned: !!ctx.body.pinned });
  });
  r.del('/groups/:id/posts/:postId', {}, (ctx) => {
    const me = ctx.me();
    const post = find(ctx, 'groupPosts', ctx.params[1], 'Post');
    if (post.authorId !== me && !isLeader(ctx, post.groupId, me)) throw new ApiError(403, 'forbidden', 'You can only delete your own posts.');
    ctx.db.del('groupPosts', post.id);
    return undefined;
  });
  r.post('/groups/:id/resources', {}, (ctx) => {
    const me = find(ctx, 'people', ctx.me(), 'Profile');
    const g = find(ctx, 'groups', ctx.params[0], 'Group');
    if (!isLeader(ctx, g.id, me.id)) throw new ApiError(403, 'forbidden', 'Only group leaders can add files.');
    requireFields(ctx.body, ['name', 'url']);
    if (!/^https?:\/\//.test(String(ctx.body.url))) throw new ApiError(422, 'invalid', 'Paste a full link starting with https://', { url: 'Use a full link' });
    return ctx.db.put('groupResources', { id: ctx.id('gr'), groupId: g.id, name: String(ctx.body.name).slice(0, 120), url: String(ctx.body.url), addedBy: me.id, addedByName: fullName(me), at: ctx.now.toISOString() });
  });
  r.del('/groups/:id/resources/:resId', {}, (ctx) => {
    const me = ctx.me();
    const res = find(ctx, 'groupResources', ctx.params[1], 'File');
    if (!isLeader(ctx, res.groupId, me)) throw new ApiError(403, 'forbidden', 'Only group leaders can remove files.');
    ctx.db.del('groupResources', res.id);
    return undefined;
  });
  // Office view of a group's conversation, for moderation.
  r.get('/admin/groups/:id/posts', { perm: 'groups' }, (ctx) => ({
    posts: ctx.db.all('groupPosts').filter((p) => p.groupId === ctx.params[0]).sort((x, y) => y.at.localeCompare(x.at)),
    resources: ctx.db.all('groupResources').filter((x) => x.groupId === ctx.params[0]),
  }));
  r.del('/admin/groups/posts/:postId', { perm: 'groups' }, (ctx) => {
    const post = find(ctx, 'groupPosts', ctx.params[0], 'Post');
    ctx.db.del('groupPosts', post.id);
    ctx.audit('deleted', 'group', post.groupId, `Removed a post by ${post.authorName}`);
    return undefined;
  });

  // ----- sermons -----
  r.get('/sermons', {}, (ctx) => sermonsPublished(ctx));
  r.get('/admin/sermons', { perm: ['comms', 'services'] }, (ctx) => ctx.db.all('sermons').sort((x, y) => y.date.localeCompare(x.date)));
  r.post('/admin/sermons', { perm: ['comms', 'services'] }, (ctx) => {
    requireFields(ctx.body, ['title']);
    const s = ctx.db.put('sermons', {
      title: '',
      speaker: '',
      date: ctx.now.toISOString().slice(0, 10),
      series: '',
      scripture: '',
      description: '',
      videoUrl: '',
      audioUrl: '',
      notesUrl: '',
      imageUrl: '',
      published: true,
      eventId: null,
      ...cleanSermon(ctx.body),
      id: ctx.id('sm'),
      createdAt: ctx.now.toISOString(),
    });
    ctx.audit('created', 'sermon', s.id, `Added the sermon “${s.title}”`);
    return s;
  });
  r.patch('/admin/sermons/:id', { perm: ['comms', 'services'] }, (ctx) => {
    const s = find(ctx, 'sermons', ctx.params[0], 'Sermon');
    return ctx.db.put('sermons', { ...s, ...cleanSermon(ctx.body) });
  });
  r.del('/admin/sermons/:id', { perm: ['comms', 'services'] }, (ctx) => {
    const s = find(ctx, 'sermons', ctx.params[0], 'Sermon');
    ctx.db.del('sermons', s.id);
    ctx.audit('deleted', 'sermon', s.id, `Deleted the sermon “${s.title}”`);
    return undefined;
  });

  // ----- public church page -----
  r.get('/admin/public-page', { perm: 'settings' }, (ctx) => publicPageOf(ctx));
  r.put('/admin/public-page', { perm: 'settings' }, (ctx) => {
    const patch = pick<PublicPage>(ctx.body, ['enabled', 'tagline', 'about', 'serviceTimes', 'heroImageUrl', 'showEvents', 'showGroups', 'showSermons', 'showGiving']);
    const next = { ...publicPageOf(ctx), ...patch };
    ctx.db.put('settings', { ...settings(ctx), publicPage: next });
    ctx.audit('updated', 'settings', null, `${next.enabled ? 'Updated' : 'Turned off'} the public church page`);
    return next;
  });
  r.get('/public/church', { public: true }, (ctx): PublicChurch => {
    const page = publicPageOf(ctx);
    if (!page.enabled) throw new ApiError(404, 'not_found', 'This church has not published its page yet.');
    const s = settings(ctx);
    const events = page.showEvents
      ? ctx.db.all('events').filter((e) => e.published && upcoming(ctx, e)).sort(bySoonest).slice(0, 12).map((e) => ({ id: e.id, title: e.title, startsAt: e.startsAt, endsAt: e.endsAt, location: e.location, description: e.description, formId: (() => { const f = formForEvent(ctx, e.id); return f?.isPublic ? f.id : null; })() }))
      : [];
    return {
      church: church(ctx),
      page,
      contact: { address: s.address, phone: s.phone, email: s.email, website: s.website },
      events,
      sermons: page.showSermons ? sermonsPublished(ctx).slice(0, 12) : [],
      groups: page.showGroups ? ctx.db.all('groups').filter((g) => g.isOpen).map((g) => publicGroup(ctx, g)) : [],
      forms: ctx.db.all('forms').filter((f) => f.isPublic && f.status === 'open' && !f.eventId).map((f) => ({ id: f.id, title: f.title, description: f.description })),
      campaigns: liveCampaigns(ctx).map((c) => publicCampaign(ctx, c)),
    };
  });
  r.get('/public/sermons', { public: true }, (ctx) => {
    if (!publicPageOf(ctx).enabled) throw new ApiError(404, 'not_found', 'Not published.');
    return sermonsPublished(ctx);
  });
  r.get('/public/groups', { public: true }, (ctx) => {
    if (!publicPageOf(ctx).enabled) throw new ApiError(404, 'not_found', 'Not published.');
    return ctx.db.all('groups').filter((g) => g.isOpen).map((g) => publicGroup(ctx, g));
  });
  r.post('/public/groups/:id/interest', { public: true }, (ctx) => {
    const g = find(ctx, 'groups', ctx.params[0], 'Group');
    if (!g.isOpen || !publicPageOf(ctx).enabled) throw new ApiError(404, 'not_found', 'Group not found.');
    requireFields(ctx.body, ['name', 'email']);
    if (!/^\S+@\S+\.\S+$/.test(String(ctx.body.email))) throw new ApiError(422, 'invalid', 'Enter a valid email.', { email: 'Enter a valid email' });
    const p = matchOrCreatePerson(ctx, { name: String(ctx.body.name).slice(0, 120), email: String(ctx.body.email), phone: ctx.body.phone ? String(ctx.body.phone) : null });
    const already = ctx.db.all('joinRequests').some((j) => j.groupId === g.id && j.person.id === p.id) || ctx.db.all('groupMembers').some((m) => m.groupId === g.id && m.personId === p.id);
    if (!already) ctx.db.put('joinRequests', { id: ctx.id('jr'), groupId: g.id, person: { id: p.id, name: fullName(p), phone: p.phone }, requestedAt: ctx.now.toISOString() });
    if (ctx.body.message) ctx.audit('requested', 'group', g.id, `${fullName(p)} asked to join ${g.name}: “${String(ctx.body.message).slice(0, 300)}”`);
    return { ok: true, message: `Thanks! The ${g.name} leader will get in touch with you.` };
  });
}
