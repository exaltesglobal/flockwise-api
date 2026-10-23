// Automatic notifications: when something happens that a person should hear about (they were put
// on a rota, a service moved, a prayer request came in), Flockwise tells them by email, by push to
// the member or team app, and optionally on WhatsApp. The office chooses the channels per kind.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import { permsOf } from '../perms.js';
import type { Collections, NotificationCatalogEntry, NotificationKind, NotificationRule, NotificationsView } from '../types.js';
import { normEmail, requireFields, settings } from '../util.js';
import { deliverAll } from './integrations.js';

type Entry = { label: string; description: string; audience: string; rule: NotificationRule };
export const CATALOG: Record<NotificationKind, Entry> = {
  'rota.assigned': { label: 'Put on a rota', description: 'A volunteer is scheduled for a service or event.', audience: 'The volunteer', rule: { email: true, push: true, whatsapp: false } },
  'event.changed': { label: 'Service or event moved', description: 'The time or place of an event changed.', audience: 'People who RSVPed or are serving', rule: { email: true, push: true, whatsapp: false } },
  'announcement.published': { label: 'New announcement', description: 'An announcement is published in the app.', audience: 'Everyone in the church', rule: { email: false, push: true, whatsapp: false } },
  'prayer.new': { label: 'New prayer request', description: 'Someone asks for prayer in the app.', audience: 'Pastors and care team', rule: { email: true, push: true, whatsapp: false } },
  'prayer.chain': { label: 'Prayer chain', description: 'The office sends a request to everyone on the prayer chain. On WhatsApp they reply PRAYED.', audience: 'People who joined the prayer chain', rule: { email: false, push: true, whatsapp: true } },
  'care.assigned': { label: 'Care case assigned', description: 'A follow-up or visit is given to a team member.', audience: 'The assigned team member', rule: { email: true, push: true, whatsapp: false } },
  'visitor.new': { label: 'New visitor', description: 'A newcomer signs up in the app or is added as a visitor.', audience: 'Pastors and care team', rule: { email: true, push: true, whatsapp: false } },
  'door.scanned': { label: 'Family arrived', description: 'Someone in the family scanned the door QR.', audience: 'Other adults in the household', rule: { email: false, push: true, whatsapp: false } },
  'team.notice': { label: 'Team notice', description: 'A notice is posted on the team hub.', audience: 'Everyone in that channel', rule: { email: true, push: true, whatsapp: false } },
  'team.message': { label: 'Team hub mention or thread message', description: 'Someone is named with @ or gets a message in a small thread.', audience: 'The people named or in the thread', rule: { email: false, push: true, whatsapp: false } },
  'carol.visit': { label: 'Carol singers tomorrow', description: 'The night before the carol team comes, the home is told roughly when.', audience: 'Everyone in that household', rule: { email: true, push: true, whatsapp: true } },
  'tithe.reminder': { label: 'Salary-day tithe reminder', description: 'On the day a member picked as their salary day, a nudge to give; skipped while a monthly gift is active.', audience: 'Members who set a salary day in the app', rule: { email: false, push: true, whatsapp: true } },
  'ride.update': { label: 'Sunday lift arranged or changed', description: 'A household is matched to a driver, a driver drops out, or the day-before reminder.', audience: 'The household and the driver', rule: { email: false, push: true, whatsapp: true } },
  'aid.new': { label: 'Request for help', description: 'A member asks the benevolence fund for help. Names and amounts stay on the Benevolence page.', audience: 'Pastors and care team', rule: { email: true, push: true, whatsapp: false } },
  'aid.update': { label: 'Help request decided or paid', description: 'The member is told when their request is approved, declined or paid.', audience: 'The member who asked', rule: { email: true, push: true, whatsapp: false } },
  'library.due': { label: 'Library book due', description: 'The day before a borrowed book is due, and once when it becomes overdue.', audience: 'The member who borrowed it', rule: { email: true, push: true, whatsapp: false } },
  'library.request': { label: 'Library book request', description: 'A member asks to borrow a book from the app; and the member is told when it is ready to collect.', audience: 'Library keepers, and the member', rule: { email: false, push: true, whatsapp: false } },
  'occasion.request': { label: 'Pastoral service request', description: 'A member asks for a wedding, funeral, dedication or house blessing from the app.', audience: 'Pastoral care team', rule: { email: true, push: true, whatsapp: false } },
  'occasion.scheduled': { label: 'Pastoral service confirmed', description: 'The office confirms the date and pastor for a requested service, and the pastor is told it is theirs.', audience: 'The member who asked, and the pastor', rule: { email: true, push: true, whatsapp: false } },
  'occasion.reminder': { label: 'Pastoral service tomorrow', description: 'The day before a wedding, funeral or other service, with open checklist items.', audience: 'The pastor taking it', rule: { email: true, push: true, whatsapp: false } },
  'camp.signup': { label: 'Camp sign-up', description: 'A member signs their family up for a camp or retreat from the app.', audience: 'Camp organisers', rule: { email: false, push: true, whatsapp: false } },
  'mentor.nudge': { label: 'Time to meet your disciple', description: 'When a mentor has not logged a meeting with someone they disciple for longer than the agreed rhythm.', audience: 'Mentors', rule: { email: false, push: true, whatsapp: true } },
  'vigil.reminder': { label: 'Prayer vigil slot', description: 'Shortly before a prayer or fasting slot the member took: 30 minutes before a prayer hour, the evening before a fasting day.', audience: 'Members who took a vigil slot', rule: { email: false, push: true, whatsapp: true } },
  'reading.today': { label: 'Today’s Bible reading', description: 'Each morning, the day’s passage from a reading plan the member joined, in their language.', audience: 'Members who joined a reading plan', rule: { email: false, push: true, whatsapp: false } },
  'verse.week': { label: "This week's memory verse", description: 'Monday morning: the verse their child is learning this week, with a nudge to play it in the app.', audience: 'Parents of Sunday school children', rule: { email: false, push: true, whatsapp: false } },
  'election.open': { label: 'Voting is open', description: 'An AGM resolution or committee election opens for a secret ballot in the app, with the closing time.', audience: 'Everyone eligible to vote', rule: { email: true, push: true, whatsapp: true } },
  'election.result': { label: 'Election result', description: 'The result is declared after the count.', audience: 'Everyone eligible to vote', rule: { email: true, push: true, whatsapp: false } },
  'greeting.video': { label: "Pastor's video greeting", description: 'On their birthday or anniversary, a personal link to the pastor’s recorded greeting with their name on it. Parents get it for a child.', audience: 'The person celebrating', rule: { email: true, push: true, whatsapp: true } },
  'recap.ready': { label: 'Sunday in 60 seconds', description: 'The Sunday recap is published: a card and a short reel of the service to watch and share on WhatsApp status.', audience: 'Everyone active', rule: { email: false, push: true, whatsapp: false } },
  'practice.reminder': { label: 'Choir practice tomorrow', description: 'The evening before a rehearsal: the time, the songs, and a nudge to listen to their part.', audience: 'Members of the teams that rehearse', rule: { email: false, push: true, whatsapp: true } },
  'rental.new': { label: 'Hall hire request', description: 'An outsider asks to hire the hall or ground, pays, or withdraws.', audience: 'Staff with the events permission', rule: { email: true, push: true, whatsapp: false } },
  'asset.due': { label: 'Asset service or AMC due', description: 'A week before an asset is due a service, and a month before an AMC or warranty ends.', audience: 'Staff who keep the asset register', rule: { email: true, push: true, whatsapp: false } },
  'task.assigned': { label: 'Task given', description: 'A task on the team hub is given to someone.', audience: 'The person it is given to', rule: { email: true, push: true, whatsapp: false } },
};
export const KINDS = Object.keys(CATALOG) as NotificationKind[];

export const ruleFor = (ctx: Ctx, kind: NotificationKind): NotificationRule => ({ ...CATALOG[kind].rule, ...settings(ctx).notifications?.[kind] });

/** Office staff who look after people: active, with the care permission, matched to their person record. */
export function pastorIds(ctx: Ctx): string[] {
  const out = new Set<string>();
  for (const s of ctx.db.all('staff')) {
    if (s.status !== 'active' || !permsOf(ctx.db, s).includes('care')) continue;
    const p = ctx.db.get('people', s.personId) ?? ctx.db.all('people').find((x) => normEmail(x.email) === normEmail(s.email));
    if (p) out.add(p.id);
  }
  return [...out];
}

export type Notice = { personIds: string[]; title: string; body: string; /** Path in the member app, e.g. /app/serving. */ link?: string; /** Someone who should not be told about their own action. */ except?: string | null };

/**
 * Tells people about `kind`, on the channels the office chose. Never throws: a failed send is
 * logged on the channel, not surfaced to the person whose action triggered it.
 */
export async function notify(ctx: Ctx, kind: NotificationKind, n: Notice): Promise<void> {
  try {
    const rule = ruleFor(ctx, kind);
    const ids = [...new Set(n.personIds)].filter((id) => id && id !== n.except);
    const people = ids.map((id) => ctx.db.get('people', id)).filter((p): p is Collections['people'] => !!p);
    if (!people.length) return;
    const link = n.link ? `${ctx.env.webUrl}${n.link}` : '';
    const text = link ? `${n.body}\n\n${link}` : n.body;
    const church = settings(ctx).name;
    const jobs: Promise<unknown>[] = [];
    if (rule.email) {
      const batch = people.filter((p) => p.email && p.consent?.email !== false).map((p) => ({ to: p.email!, name: `${p.firstName} ${p.lastName}`.trim(), subject: n.title, text: `Hi ${p.firstName},\n\n${text}\n\n${church}` }));
      if (batch.length) jobs.push(ctx.env.deliver('email', batch));
    }
    if (rule.whatsapp) {
      const batch = people.filter((p) => p.phone && p.consent?.whatsapp !== false).map((p) => ({ to: p.phone!, name: `${p.firstName} ${p.lastName}`.trim(), subject: n.title, text: `${n.title}\n${text}` }));
      if (batch.length) jobs.push(deliverAll(ctx, 'whatsapp', batch));
    }
    if (rule.push && ctx.env.push) {
      const want = new Set(people.map((p) => p.id));
      const devices = ctx.db.all('devices').filter((d) => want.has(d.personId));
      if (devices.length) {
        jobs.push(
          ctx.env.push(devices.map((d) => ({ token: d.token, title: n.title, body: n.body, data: { kind, ...(n.link ? { link: n.link } : {}) } }))).then((res) => {
            res.forEach((r, i) => {
              if (r.gone) ctx.db.del('devices', devices[i].id);
            });
          }),
        );
      }
    }
    if (!jobs.length) return;
    const s = settings(ctx);
    ctx.db.put('settings', { ...s, notificationCounts: { ...s.notificationCounts, [kind]: (s.notificationCounts?.[kind] ?? 0) + people.length } });
    await Promise.all(jobs.map((j) => j.catch(() => undefined)));
  } catch {
    /* notifications never break the action that caused them */
  }
}

function view(ctx: Ctx): NotificationsView {
  const s = settings(ctx);
  const devices = ctx.db.all('devices');
  const email = ctx.db.get('integrations', 'email') as { from?: string } | undefined;
  return {
    rules: KINDS.map((kind): NotificationCatalogEntry => ({ kind, ...CATALOG[kind], rule: ruleFor(ctx, kind), sentCount: s.notificationCounts?.[kind] ?? 0 })),
    devices: { member: devices.filter((d) => d.app === 'member').length, team: devices.filter((d) => d.app === 'team').length },
    emailFrom: email?.from ?? null,
  };
}

export function registerNotify(r: Router) {
  r.get('/admin/notifications', { perm: 'settings' }, (ctx) => view(ctx));
  r.put('/admin/notifications/:kind', { perm: 'settings' }, (ctx) => {
    const kind = ctx.params[0] as NotificationKind;
    if (!KINDS.includes(kind)) throw new ApiError(404, 'not_found', 'Unknown notification.');
    const s = settings(ctx);
    const rule: NotificationRule = { email: !!ctx.body.email, push: !!ctx.body.push, whatsapp: !!ctx.body.whatsapp };
    ctx.db.put('settings', { ...s, notifications: { ...s.notifications, [kind]: rule } });
    ctx.audit('updated', 'settings', null, `Changed the "${CATALOG[kind].label}" notification`);
    return view(ctx);
  });

  // The member and team apps register the phone for push; the same token can only belong to one person.
  r.post('/me/devices', {}, (ctx) => {
    requireFields(ctx.body, ['token']);
    const token = String(ctx.body.token).trim().slice(0, 300);
    const platform = ['android', 'ios', 'web'].includes(ctx.body.platform) ? ctx.body.platform : 'android';
    const app = ctx.body.app === 'team' ? 'team' : 'member';
    const existing = ctx.db.all('devices').find((d) => d.token === token);
    const d = ctx.db.put('devices', { id: existing?.id ?? ctx.id('dev'), personId: ctx.me(), token, platform, app, createdAt: existing?.createdAt ?? ctx.now.toISOString(), lastSeenAt: ctx.now.toISOString() });
    return { id: d.id, platform: d.platform, app: d.app };
  });
  r.del('/me/devices', {}, (ctx) => {
    const token = String(ctx.query.token ?? ctx.body?.token ?? '');
    for (const d of ctx.db.all('devices')) if (d.personId === ctx.me() && (!token || d.token === token)) ctx.db.del('devices', d.id);
    return undefined;
  });
}
