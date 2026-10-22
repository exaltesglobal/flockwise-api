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
