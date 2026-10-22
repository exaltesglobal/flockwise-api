// Parent pager: the kids' team asks a child's parents to come during the service, by WhatsApp (or SMS
// when WhatsApp is not set up). Pages are listed on the check-in screen until someone marks them done.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { Channel, Collections, PageReason, ParentPage } from '../types.js';
import { age, find, fullName, settings } from '../util.js';
import { channelStatus, deliverAll } from './integrations.js';

const REASONS: Record<Exclude<PageReason, 'custom'>, string> = {
  come: 'please come to the room',
  pickup: 'please come and pick them up',
  feeding: 'they need you for a feed or a nappy change',
};

/** The adults in the child's household with a phone number. */
export function parentsOf(ctx: Ctx, childId: string) {
  const child = ctx.db.get('people', childId);
  if (!child?.householdName) return [];
  return ctx.db
    .all('people')
    .filter((p) => p.id !== childId && p.householdName === child.householdName && !!p.phone && (age(p.birthDate, ctx.now) ?? 30) >= 18);
}

function pageChannel(ctx: Ctx): Channel {
  const st = channelStatus(ctx);
  return st.whatsapp.configured || !st.sms.configured ? 'whatsapp' : 'sms';
}

export async function pageParents(ctx: Ctx, c: Collections['checkins'], reason: PageReason, note: string): Promise<ParentPage> {
  if (!c.isChild || c.checkedOutAt) throw new ApiError(409, 'invalid_state', 'Only children who are checked in can be paged for.');
  const parents = parentsOf(ctx, c.personId);
  if (!parents.length) throw new ApiError(422, 'no_parent', `No parent with a phone number is in ${c.personName}'s household. Add the family in People.`);
  const first = c.personName.split(' ')[0];
  const why = reason === 'custom' ? note : `${REASONS[reason]}${note ? `. ${note}` : ''}`;
  const where = c.roomName ? ` in ${c.roomName}` : '';
  const text = `${settings(ctx).name} kids' team: ${first}${where} is fine, but ${why}. Show code ${c.securityCode ?? ''} at the door.`.replace(/ \./g, '.');
  const channel = pageChannel(ctx);
  const results = await deliverAll(ctx, channel, parents.map((p) => ({ to: p.phone!, name: fullName(p), subject: 'Parent page', text })));
  const page: ParentPage = {
    id: ctx.id('pg'),
    eventId: c.eventId,
    checkinId: c.id,
    childName: c.personName,
    roomName: c.roomName,
    securityCode: c.securityCode,
    reason,
    note,
    text,
    sentTo: parents.map((p, i) => ({ name: fullName(p), to: p.phone!, channel, ok: !!results[i]?.ok, ...(results[i]?.error ? { error: results[i].error } : {}) })),
    at: ctx.now.toISOString(),
    by: ctx.staff?.name ?? '',
    resolvedAt: null,
  };
  ctx.db.put('parentPages', page);
  ctx.audit('sent', 'parent page', page.id, `Paged ${page.sentTo.map((s) => s.name).join(' and ')} for ${c.personName}`);
  return page;
}

export function registerPager(r: Router) {
  r.get('/admin/checkin/checkins/:id/parents', { perm: 'checkin' }, (ctx) => {
    const c = find(ctx, 'checkins', ctx.params[0], 'Check-in');
    return parentsOf(ctx, c.personId).map((p) => ({ id: p.id, name: fullName(p), phone: p.phone }));
  });
  r.post('/admin/checkin/checkins/:id/page', { perm: 'checkin' }, async (ctx) => {
    const c = find(ctx, 'checkins', ctx.params[0], 'Check-in');
    const reason = (ctx.body.reason ?? 'come') as PageReason;
    if (!['come', 'pickup', 'feeding', 'custom'].includes(reason)) throw new ApiError(422, 'invalid', 'Choose why you are paging.');
    const note = String(ctx.body.note ?? '').trim().slice(0, 200);
    if (reason === 'custom' && !note) throw new ApiError(422, 'invalid', 'Type the message for the parents.', { note: 'Required' });
    return pageParents(ctx, c, reason, note);
  });
  r.get('/admin/checkin/:eventId/pages', { perm: 'checkin' }, (ctx) =>
    ctx.db.all('parentPages').filter((p) => p.eventId === ctx.params[0]).sort((a, b) => b.at.localeCompare(a.at)),
  );
  r.post('/admin/checkin/pages/:id/resolve', { perm: 'checkin' }, (ctx) => {
    const p = find(ctx, 'parentPages', ctx.params[0], 'Page');
    return ctx.db.put('parentPages', { ...p, resolvedAt: p.resolvedAt ?? ctx.now.toISOString() });
  });
}
