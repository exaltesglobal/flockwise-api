// Messaging: email, SMS and WhatsApp broadcasts to segments, templates, and automations
// (birthdays, anniversaries, welcome, missing members, volunteer reminders).
// Consent is respected per channel (India's DPDP Act): people who opted out are skipped.
import { ApiError } from '../errors.js';
import type { Ctx, Router } from '../engine.js';
import type { Audience, AudiencePreview, Automations, Channel, Collections, Message, MessageInput } from '../types.js';
import { checkinsFor, DAY, find, fullName, localDate, localHour, pick, requireFields, rsvpsFor, settings } from '../util.js';
import { carolReminders } from './carols.js';
import { sendStaffDigest } from './celebrations.js';
import { channelStatus, deliverAll } from './integrations.js';
import { notify } from './notify.js';
import { setBotState } from './whatsapp-bot.js';
import { listMembers, runListWorkflows } from './workflows.js';

const CHANNELS: Channel[] = ['email', 'sms', 'whatsapp'];

export function resolveAudience(ctx: Ctx, a: Audience): Collections['people'][] {
  const people = ctx.db.all('people').filter((p) => p.status !== 'inactive' || (a.type === 'status' && a.ids.includes('inactive')));
  const ids = new Set(a.ids);
  switch (a.type) {
    case 'everyone':
      return people;
    case 'status':
      return people.filter((p) => ids.has(p.status));
    case 'tag':
      return people.filter((p) => p.tags.some((t) => ids.has(t)));
    case 'campus':
      return people.filter((p) => p.campusId && ids.has(p.campusId));
    case 'people':
      return people.filter((p) => ids.has(p.id));
    case 'group': {
      const members = new Set(ctx.db.all('groupMembers').filter((m) => ids.has(m.groupId)).map((m) => m.personId));
      return people.filter((p) => members.has(p.id));
    }
    case 'team': {
      const members = new Set(ctx.db.all('teams').filter((t) => ids.has(t.id)).flatMap((t) => t.members.map((m) => m.personId)));
      return people.filter((p) => members.has(p.id));
    }
    case 'list': {
      const members = new Set(a.ids.flatMap((id) => { const l = ctx.db.get('smartLists', id); return l ? listMembers(ctx, l).map((p) => p.id) : []; }));
      return people.filter((p) => members.has(p.id));
    }
    case 'event': {
      const going = new Set([...a.ids.flatMap((id) => rsvpsFor(ctx, id).map((r) => r.personId)), ...a.ids.flatMap((id) => checkinsFor(ctx, id).map((c) => c.personId))]);
      return people.filter((p) => going.has(p.id));
    }
  }
}

export function audienceLabel(ctx: Ctx, a: Audience) {
  const names = (kind: 'groups' | 'teams' | 'campuses' | 'events') => a.ids.map((id) => (ctx.db.get(kind, id) as { name?: string; title?: string } | undefined)).map((x) => x?.name ?? x?.title ?? '').filter(Boolean).join(', ');
  switch (a.type) {
    case 'everyone':
      return 'Everyone';
    case 'status':
      return a.ids.map((s) => s[0].toUpperCase() + s.slice(1) + 's').join(', ');
    case 'tag':
      return `Tagged ${a.ids.join(', ')}`;
    case 'campus':
      return names('campuses');
    case 'group':
      return names('groups');
    case 'team':
      return names('teams');
    case 'event':
      return `Going to ${names('events')}`;
    case 'list':
      return a.ids.map((id) => ctx.db.get('smartLists', id)?.name ?? '').filter(Boolean).join(', ');
    case 'people':
      return `${a.ids.length} ${a.ids.length === 1 ? 'person' : 'people'}`;
  }
}

const contactFor = (p: Collections['people'], ch: Channel) => (ch === 'email' ? p.email : p.phone);

function split(people: Collections['people'][], ch: Channel) {
  const optedOut = people.filter((p) => !p.consent[ch]);
  const noContact = people.filter((p) => p.consent[ch] && !contactFor(p, ch));
  const reachable = people.filter((p) => p.consent[ch] && contactFor(p, ch));
  return { optedOut, noContact, reachable };
}

export function render(ctx: Ctx, text: string, p: Collections['people']) {
  const s = settings(ctx);
  return text
    .replace(/\{\{\s*firstName\s*\}\}/g, p.firstName)
    .replace(/\{\{\s*lastName\s*\}\}/g, p.lastName)
    .replace(/\{\{\s*fullName\s*\}\}/g, fullName(p))
    .replace(/\{\{\s*church\s*\}\}/g, s.name)
    .replace(/\{\{\s*appLink\s*\}\}/g, `${ctx.env.webUrl}/app`);
}

async function deliver(ctx: Ctx, msg: Message, people: Collections['people'][]): Promise<Message> {
  const { optedOut, noContact, reachable } = split(people, msg.channel);
  const batch = reachable.map((p) => ({ to: contactFor(p, msg.channel)!, name: fullName(p), subject: render(ctx, msg.subject, p), text: render(ctx, msg.body, p) }));
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < batch.length; i += 100) {
    const results = await deliverAll(ctx, msg.channel, batch.slice(i, i + 100)).catch(() => batch.slice(i, i + 100).map(() => ({ ok: false })));
    for (const r of results) r.ok ? sent++ : failed++;
  }
  const simulated = !channelStatus(ctx)[msg.channel].configured;
  return ctx.db.put('messages', {
    ...msg,
    status: failed && !sent ? 'failed' : 'sent',
    sentAt: ctx.env.now().toISOString(),
    stats: { recipients: people.length, sent, failed, skipped: optedOut.length + noContact.length },
    simulated,
  });
}

/** Sends a message to specific people right away (rota requests, automations). */
export async function sendDirect(ctx: Ctx, channel: Channel, personIds: string[], subject: string, body: string, source: Message['source']) {
  const audience: Audience = { type: 'people', ids: personIds };
  const msg = ctx.db.put('messages', {
    id: ctx.id('ms'),
    channel,
    audience,
    audienceLabel: audienceLabel(ctx, audience),
    subject,
    body,
    status: 'sending',
    scheduledAt: null,
    sentAt: null,
    createdAt: ctx.now.toISOString(),
    createdBy: ctx.staff?.name ?? 'Flockwise',
    stats: { recipients: 0, sent: 0, failed: 0, skipped: 0 },
    simulated: false,
    source,
  });
  return deliver(ctx, msg, resolveAudience(ctx, audience));
}

function cleanInput(ctx: Ctx, body: Record<string, unknown>): MessageInput {
  requireFields(body, ['channel', 'body']);
  const channel = body.channel as Channel;
  if (!CHANNELS.includes(channel)) throw new ApiError(422, 'invalid', 'Choose email, SMS or WhatsApp.');
  const audience = body.audience as Audience | undefined;
  if (!audience || !audience.type || !Array.isArray(audience.ids)) throw new ApiError(422, 'invalid', 'Choose who to send to.', { audience: 'Required' });
  if (channel === 'email' && !String(body.subject ?? '').trim()) throw new ApiError(422, 'invalid', 'Emails need a subject.', { subject: 'Required' });
  if (channel === 'sms' && String(body.body).length > 640) throw new ApiError(422, 'invalid', 'SMS messages can be up to 640 characters.', { body: 'Too long' });
  void ctx;
  return { channel, audience, subject: String(body.subject ?? ''), body: String(body.body), scheduledAt: body.scheduledAt ? new Date(String(body.scheduledAt)).toISOString() : null, send: !!body.send };
}

export const DEFAULT_AUTOMATIONS: Automations = {
  birthday: { enabled: true, channel: 'whatsapp', subject: 'Happy birthday!', body: 'Happy birthday, {{firstName}}! Everyone at {{church}} is praying for a blessed year ahead. 🎂' },
  anniversary: { enabled: false, channel: 'whatsapp', subject: 'Happy anniversary!', body: 'Happy wedding anniversary, {{firstName}}! May God keep blessing your family. From all of us at {{church}}.' },
  welcome: { enabled: true, channel: 'email', subject: 'Welcome to {{church}}', body: 'Hi {{firstName}},\n\nIt was wonderful to have you with us! You can see what is on, join a group and more in our app: {{appLink}}\n\nSee you soon,\n{{church}}', createFollowUp: true },
  missing: { enabled: true, channel: 'whatsapp', subject: 'We miss you', body: 'Hi {{firstName}}, we have missed you at {{church}}! Is there anything we can pray about with you?', weeks: 3, createFollowUp: true },
  volunteerReminder: { enabled: true, channel: 'email', subject: 'Reminder: you are serving soon', body: 'Hi {{firstName}}, a reminder that you are serving this week. Check the details in the app: {{appLink}}', daysBefore: 2 },
  staffDigest: { enabled: true, daysAhead: 7 },
};

// Older saved settings may predate newer automations, so defaults fill the gaps.
export const automations = (ctx: Ctx) => ({ id: 'church', ...DEFAULT_AUTOMATIONS, ...(ctx.db.get('automations', 'church') ?? {}) });


/**
 * Runs scheduled messages and the daily automations. The server calls it every minute;
 * each daily job records the day it last ran, so it is safe to call as often as you like.
 */
export async function runDue(ctx: Ctx) {
  runListWorkflows(ctx);
  for (const m of ctx.db.all('messages')) {
    if (m.status === 'scheduled' && m.scheduledAt && m.scheduledAt <= ctx.now.toISOString()) {
      ctx.db.put('messages', { ...m, status: 'sending' });
      await deliver(ctx, m, resolveAudience(ctx, m.audience));
    }
  }
  const today = localDate(ctx, ctx.now);
  const hour = localHour(ctx, ctx.now);
  if (hour < 8) return; // daily jobs run after 8 am church time
  const done = ctx.db.get('meta', 'automations:lastRun')?.value;
  if (done === today) return;
  ctx.db.put('meta', { id: 'automations:lastRun', value: today });
  const a = automations(ctx);
  const mmdd = today.slice(5);
  const people = ctx.db.all('people').filter((p) => p.status !== 'inactive');

  if (a.birthday.enabled) {
    const ids = people.filter((p) => p.birthDate?.slice(5) === mmdd).map((p) => p.id);
    if (ids.length) await sendDirect(ctx, a.birthday.channel, ids, a.birthday.subject, a.birthday.body, 'automation');
  }
  if (a.anniversary.enabled) {
    const ids = people.filter((p) => p.anniversary?.slice(5) === mmdd).map((p) => p.id);
    if (ids.length) await sendDirect(ctx, a.anniversary.channel, ids, a.anniversary.subject, a.anniversary.body, 'automation');
  }
  if (a.staffDigest.enabled) await sendStaffDigest(ctx, a.staffDigest.daysAhead);
  await carolReminders(ctx, today);
  if (a.welcome.enabled) {
    const welcomed = new Set((ctx.db.get('meta', 'automations:welcomed')?.value ?? '').split(',').filter(Boolean));
    const fresh = people.filter((p) => p.status === 'visitor' && !welcomed.has(p.id) && ctx.now.getTime() - new Date(p.joinedAt).getTime() < 7 * DAY);
    if (fresh.length) {
      await sendDirect(ctx, a.welcome.channel, fresh.map((p) => p.id), a.welcome.subject, a.welcome.body, 'automation');
      if (a.welcome.createFollowUp)
        for (const p of fresh)
          if (!ctx.db.all('care').some((c) => c.personId === p.id && c.status !== 'closed'))
            ctx.db.put('care', newCase(ctx, p, 'visitor', `Follow up with new visitor ${fullName(p)}`, 2));
      ctx.db.put('meta', { id: 'automations:welcomed', value: [...welcomed, ...fresh.map((p) => p.id)].slice(-5000).join(',') });
    }
  }
  if (a.missing.enabled && a.missing.weeks > 0) {
    const cutoff = ctx.now.getTime() - a.missing.weeks * 7 * DAY;
    const flagged = new Set((ctx.db.get('meta', 'automations:missing')?.value ?? '').split(',').filter(Boolean));
    const missing = people.filter((p) => (p.status === 'member' || p.status === 'regular') && p.lastAttendedAt && new Date(p.lastAttendedAt).getTime() < cutoff && !flagged.has(`${p.id}@${p.lastAttendedAt.slice(0, 10)}`));
    if (missing.length) {
      // On WhatsApp the message asks how they are; the reply lands on the care case (see the assistant).
      const ask = a.missing.channel === 'whatsapp' && a.missing.askReply !== false;
      const body = ask ? `${a.missing.body}\n\nReply 1 if all is well, 2 if you are travelling, or 3 if you would like someone to call you.` : a.missing.body;
      await sendDirect(ctx, a.missing.channel, missing.map((p) => p.id), a.missing.subject, body, 'automation');
      if (ask) for (const p of missing) if (p.phone && p.consent?.whatsapp !== false) setBotState(ctx, p.phone, 'checkin');
      if (a.missing.createFollowUp)
        for (const p of missing)
          if (!ctx.db.all('care').some((c) => c.personId === p.id && c.status !== 'closed')) {
            const c = newCase(ctx, p, 'absent', `${p.firstName} has not been in for ${a.missing.weeks}+ weeks`, 5);
            const leader = a.missing.assignLeader !== false ? zoneLeaderStaff(ctx, p) : null;
            ctx.db.put('care', leader ? { ...c, assignedTo: leader.id, assignedName: leader.name } : c);
            if (leader?.personId) void notify(ctx, 'care.assigned', { personIds: [leader.personId], title: `Care: ${c.title}`, body: `${fullName(p)} is in your zone and has not been in for ${a.missing.weeks} weeks. Could you check in on them?`, link: '/admin/care' });
          }
      ctx.db.put('meta', { id: 'automations:missing', value: [...flagged, ...missing.map((p) => `${p.id}@${p.lastAttendedAt!.slice(0, 10)}`)].slice(-5000).join(',') });
    }
  }
  if (a.volunteerReminder.enabled) {
    const target = localDate(ctx, new Date(ctx.now.getTime() + a.volunteerReminder.daysBefore * DAY));
    const events = ctx.db.all('events').filter((e) => localDate(ctx, new Date(e.startsAt)) === target);
    const ids = [...new Set(ctx.db.all('assignments').filter((x) => x.status === 'accepted' && events.some((e) => e.id === x.eventId)).map((x) => x.personId))];
    if (ids.length) await sendDirect(ctx, a.volunteerReminder.channel, ids, a.volunteerReminder.subject, a.volunteerReminder.body, 'automation');
  }
  // Housekeeping: drop old sign-in records.
  const old = new Date(ctx.now.getTime() - 2 * DAY).toISOString();
  for (const o of ctx.db.all('otps')) if (o.expiresAt < old) ctx.db.del('otps', o.id);
  for (const t of ctx.db.all('refreshTokens')) if (t.expiresAt < ctx.now.toISOString() || (t.revoked && t.createdAt < old)) ctx.db.del('refreshTokens', t.id);
}

/** A zone leader who can hold a care case: the first of the person's zone leaders with an active office login. */
function zoneLeaderStaff(ctx: Ctx, p: Collections['people']) {
  const zone = p.zoneId ? ctx.db.get('zones', p.zoneId) : null;
  if (!zone) return null;
  const staff = ctx.db.all('staff').filter((s) => s.status === 'active' && ['owner', 'admin', 'pastor', 'leader'].includes(s.role));
  for (const id of zone.leaderIds) {
    const s = staff.find((x) => x.personId === id);
    if (s) return s;
  }
  return null;
}

export function newCase(ctx: Ctx, p: Collections['people'], type: Collections['care']['type'], title: string, dueDays: number): Collections['care'] {
  return {
    id: ctx.id('cc'),
    personId: p.id,
    personName: fullName(p),
    type,
    title,
    status: 'open',
    priority: 'normal',
    assignedTo: null,
    assignedName: null,
    dueAt: new Date(ctx.now.getTime() + dueDays * DAY).toISOString(),
    createdAt: ctx.now.toISOString(),
    closedAt: null,
    notes: [],
    source: 'automation',
    confidential: false,
  };
}

export function registerComms(r: Router) {
  r.get('/admin/messages', { perm: 'comms' }, (ctx) => ({ data: ctx.db.all('messages').sort((x, y) => (y.sentAt ?? y.scheduledAt ?? y.createdAt).localeCompare(x.sentAt ?? x.scheduledAt ?? x.createdAt)).slice(0, 200), nextCursor: null }));
  r.get('/admin/messages/channels', { perm: 'comms' }, (ctx) => channelStatus(ctx));
  r.post('/admin/messages/audience', { perm: 'comms' }, (ctx): AudiencePreview => {
    const channel = (CHANNELS.includes(ctx.body.channel) ? ctx.body.channel : 'email') as Channel;
    const people = resolveAudience(ctx, ctx.body.audience ?? { type: 'everyone', ids: [] });
    const { optedOut, noContact, reachable } = split(people, channel);
    return { total: people.length, reachable: reachable.length, optedOut: optedOut.length, noContact: noContact.length, sample: reachable.slice(0, 5).map(fullName) };
  });
  r.post('/admin/messages', { perm: 'comms' }, async (ctx) => {
    const input = cleanInput(ctx, ctx.body);
    const msg = ctx.db.put('messages', {
      id: ctx.id('ms'),
      channel: input.channel,
      audience: input.audience,
      audienceLabel: audienceLabel(ctx, input.audience),
      subject: input.subject ?? '',
      body: input.body,
      status: input.send ? (input.scheduledAt && input.scheduledAt > ctx.now.toISOString() ? 'scheduled' : 'sending') : 'draft',
      scheduledAt: input.scheduledAt ?? null,
      sentAt: null,
      createdAt: ctx.now.toISOString(),
      createdBy: ctx.staff?.name ?? '',
      stats: { recipients: 0, sent: 0, failed: 0, skipped: 0 },
      simulated: false,
      source: 'manual',
    });
    ctx.audit(msg.status === 'draft' ? 'drafted' : msg.status === 'scheduled' ? 'scheduled' : 'sent', 'message', msg.id, `${msg.status === 'draft' ? 'Drafted' : msg.status === 'scheduled' ? 'Scheduled' : 'Sent'} ${msg.channel} to ${msg.audienceLabel}`);
    if (msg.status === 'sending') return deliver(ctx, msg, resolveAudience(ctx, msg.audience));
    return msg;
  });
  r.patch('/admin/messages/:id', { perm: 'comms' }, async (ctx) => {
    const m = find(ctx, 'messages', ctx.params[0], 'Message');
    if (m.status !== 'draft' && m.status !== 'scheduled') throw new ApiError(422, 'sent', 'This message has already gone out.');
    const input = cleanInput(ctx, { ...m, ...ctx.body });
    const next = ctx.db.put('messages', {
      ...m,
      channel: input.channel,
      audience: input.audience,
      audienceLabel: audienceLabel(ctx, input.audience),
      subject: input.subject ?? '',
      body: input.body,
      scheduledAt: input.scheduledAt ?? null,
      status: input.send ? (input.scheduledAt && input.scheduledAt > ctx.now.toISOString() ? 'scheduled' : 'sending') : ctx.body.status === 'draft' ? 'draft' : m.status,
    });
    if (next.status === 'sending') {
      ctx.audit('sent', 'message', next.id, `Sent ${next.channel} to ${next.audienceLabel}`);
      return deliver(ctx, next, resolveAudience(ctx, next.audience));
    }
    return next;
  });
  r.del('/admin/messages/:id', { perm: 'comms' }, (ctx) => {
    const m = find(ctx, 'messages', ctx.params[0], 'Message');
    if (m.status === 'sent' || m.status === 'sending') throw new ApiError(422, 'sent', 'Sent messages are kept for your records.');
    ctx.db.del('messages', m.id);
    return undefined;
  });
  r.get('/admin/messages/templates', { perm: 'comms' }, (ctx) => ctx.db.all('templates').sort((x, y) => x.name.localeCompare(y.name)));
  r.post('/admin/messages/templates', { perm: 'comms' }, (ctx) => {
    requireFields(ctx.body, ['name', 'channel', 'body']);
    return ctx.db.put('templates', { id: ctx.id('tp'), name: String(ctx.body.name), channel: ctx.body.channel, subject: String(ctx.body.subject ?? ''), body: String(ctx.body.body) });
  });
  r.patch('/admin/messages/templates/:id', { perm: 'comms' }, (ctx) => {
    const t = find(ctx, 'templates', ctx.params[0], 'Template');
    return ctx.db.put('templates', { ...t, ...pick(ctx.body, ['name', 'channel', 'subject', 'body']) });
  });
  r.del('/admin/messages/templates/:id', { perm: 'comms' }, (ctx) => {
    ctx.db.del('templates', ctx.params[0]);
    return undefined;
  });
  r.get('/admin/messages/automations', { perm: 'comms' }, (ctx) => automations(ctx));
  r.put('/admin/messages/automations', { perm: 'comms' }, (ctx) => {
    const cur = automations(ctx);
    const next = { ...cur };
    for (const k of ['birthday', 'anniversary', 'welcome', 'missing', 'volunteerReminder'] as const) {
      if (!ctx.body[k]) continue;
      const patch = pick(ctx.body[k], ['enabled', 'channel', 'subject', 'body', 'createFollowUp', 'weeks', 'daysBefore', 'askReply', 'assignLeader']) as Record<string, unknown>;
      if (patch.channel && !CHANNELS.includes(patch.channel as Channel)) delete patch.channel;
      (next as Record<string, unknown>)[k] = { ...cur[k], ...patch };
    }
    if (ctx.body.staffDigest) {
      const d = ctx.body.staffDigest;
      next.staffDigest = { enabled: typeof d.enabled === 'boolean' ? d.enabled : cur.staffDigest.enabled, daysAhead: d.daysAhead ? Math.min(31, Math.max(1, Math.round(Number(d.daysAhead)))) : cur.staffDigest.daysAhead };
    }
    ctx.audit('updated', 'automations', null, 'Updated message automations');
    return ctx.db.put('automations', next);
  });
}
