// Birthdays, wedding anniversaries and baptism anniversaries: the office list with one-tap
// greetings, the daily digest for pastors, and the member app's "celebrations this week" wall.
import { ApiError } from '../errors.js';
import type { Ctx, Router } from '../engine.js';
import { permsOf } from '../perms.js';
import type { Celebration, CelebrationKind, Channel, Collections, MemberCelebrations } from '../types.js';
import { DAY, find, fullName, isChild, localDate, requireFields } from '../util.js';
import { sendDirect } from './comms.js';

const KINDS: CelebrationKind[] = ['birthday', 'anniversary', 'baptism'];
const CHANNELS: Channel[] = ['email', 'sms', 'whatsapp'];
const LABEL: Record<CelebrationKind, string> = { birthday: 'Birthday', anniversary: 'Wedding anniversary', baptism: 'Baptism anniversary' };

const sourceDate = (p: Collections['people'], kind: CelebrationKind) =>
  kind === 'birthday' ? p.birthDate : kind === 'anniversary' ? p.anniversary : p.baptismDate;

/** The next time this month and day comes round, from today (church time). Feb 29 falls on Feb 28 in other years. */
function nextOccurrence(today: string, mmdd: string) {
  const year = Number(today.slice(0, 4));
  const fit = (y: number) => {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return `${y}-${mmdd === '02-29' && !leap ? '02-28' : mmdd}`;
  };
  const thisYear = fit(year);
  return thisYear >= today ? thisYear : fit(year + 1);
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

/** Everyone celebrating something in the next `days` days, soonest first. */
export function upcomingCelebrations(ctx: Ctx, days: number, kinds = KINDS): Celebration[] {
  const today = localDate(ctx, ctx.now);
  const greetings = ctx.db.all('greetings');
  const out: Celebration[] = [];
  for (const p of ctx.db.all('people')) {
    if (p.status === 'inactive') continue;
    for (const kind of kinds) {
      const src = sourceDate(p, kind);
      if (!src || !/^\d{4}-\d{2}-\d{2}/.test(src)) continue;
      const date = nextOccurrence(today, src.slice(5, 10));
      const daysAway = daysBetween(today, date);
      if (daysAway > days) continue;
      const year = Number(date.slice(0, 4));
      const theirs = greetings.filter((g) => g.personId === p.id && g.kind === kind && g.year === year);
      out.push({
        personId: p.id,
        name: fullName(p),
        kind,
        date,
        daysAway,
        years: year - Number(src.slice(0, 4)) || null,
        isChild: isChild(ctx, p),
        phone: p.phone,
        email: p.email,
        householdName: p.householdName,
        greeted: theirs.some((g) => g.channel !== 'wall'),
        wishes: theirs.filter((g) => g.channel === 'wall').length,
      });
    }
  }
  return out.sort((x, y) => x.daysAway - y.daysAway || x.name.localeCompare(y.name));
}

const describe = (c: Celebration) =>
  `${c.name}: ${LABEL[c.kind].toLowerCase()}${c.years ? (c.kind === 'birthday' ? `, turning ${c.years}` : `, ${c.years} years`) : ''}${c.isChild ? ' (child)' : ''}`;

/**
 * Daily email to pastors and care staff. Mondays list the whole window; other days only go
 * out when someone is celebrating today, so the inbox isn't filled with repeats.
 */
export async function sendStaffDigest(ctx: Ctx, daysAhead: number) {
  const list = upcomingCelebrations(ctx, daysAhead);
  const today = list.filter((c) => c.daysAway === 0);
  const monday = new Date(`${localDate(ctx, ctx.now)}T00:00:00Z`).getUTCDay() === 1;
  if (!today.length && !(monday && list.length)) return;
  const staff = ctx.db.all('staff').filter((s) => s.status === 'active' && s.email && permsOf(ctx.db, s).includes('care'));
  if (!staff.length) return;
  const later = monday ? list.filter((c) => c.daysAway > 0) : [];
  const lines = [
    today.length ? `Today\n${today.map((c) => `• ${describe(c)}${c.phone ? ` · ${c.phone}` : ''}`).join('\n')}` : '',
    later.length ? `Coming up\n${later.map((c) => `• ${c.date.slice(8)}/${c.date.slice(5, 7)} ${describe(c)}`).join('\n')}` : '',
  ].filter(Boolean);
  const subject = today.length ? `Celebrating today: ${today.slice(0, 3).map((c) => c.name.split(' ')[0]).join(', ')}${today.length > 3 ? ` and ${today.length - 3} more` : ''}` : 'Birthdays and anniversaries this week';
  await ctx.env
    .deliver('email', staff.map((s) => ({ to: s.email, name: s.name, subject, text: `${lines.join('\n\n')}\n\nSend greetings from the church office: ${ctx.env.webUrl}/admin/celebrations` })))
    .catch(() => undefined);
}

/** People a member may see celebrating: those in the directory, their own groups and their household. */
function visibleTo(ctx: Ctx, me: Collections['people']) {
  const myGroups = new Set(ctx.db.all('groupMembers').filter((m) => m.personId === me.id).map((m) => m.groupId));
  const groupmates = new Set(ctx.db.all('groupMembers').filter((m) => myGroups.has(m.groupId)).map((m) => m.personId));
  return (p: Collections['people']) =>
    p.id === me.id || groupmates.has(p.id) || (!!me.householdName && p.householdName === me.householdName) || (me.consent.directory && p.consent.directory);
}

export function registerCelebrations(r: Router) {
  r.get('/admin/celebrations', { perm: 'people.view' }, (ctx) => {
    const days = Math.min(366, Math.max(0, Number(ctx.query.days ?? 30) || 30));
    const kinds = KINDS.includes(ctx.query.kind as CelebrationKind) ? [ctx.query.kind as CelebrationKind] : KINDS;
    return upcomingCelebrations(ctx, days, kinds).filter((c) => ctx.inScope(c.personId));
  });

  r.post('/admin/celebrations/greet', { perm: 'comms' }, async (ctx) => {
    requireFields(ctx.body, ['personId', 'kind', 'channel', 'body']);
    const p = find(ctx, 'people', String(ctx.body.personId), 'Person');
    const kind = ctx.body.kind as CelebrationKind;
    const channel = ctx.body.channel as Channel;
    if (!KINDS.includes(kind)) throw new ApiError(422, 'invalid', 'Unknown celebration.');
    if (!CHANNELS.includes(channel)) throw new ApiError(422, 'invalid', 'Choose email, SMS or WhatsApp.');
    const c = upcomingCelebrations(ctx, 366, [kind]).find((x) => x.personId === p.id);
    const year = c ? Number(c.date.slice(0, 4)) : Number(localDate(ctx, ctx.now).slice(0, 4));
    const subject = String(ctx.body.subject ?? `Happy ${LABEL[kind].toLowerCase()}!`);
    await sendDirect(ctx, channel, [p.id], subject, String(ctx.body.body).slice(0, 2000), 'manual');
    const g = ctx.db.put('greetings', { id: ctx.id('gt'), personId: p.id, kind, year, fromId: ctx.staff?.id ?? null, fromName: ctx.staff?.name ?? 'Church office', message: String(ctx.body.body).slice(0, 2000), channel, at: ctx.now.toISOString() });
    ctx.audit('sent', 'person', p.id, `Sent ${fullName(p)} ${LABEL[kind].toLowerCase()} greetings by ${channel}`);
    return g;
  });

  r.get('/celebrations', {}, (ctx): MemberCelebrations => {
    const me = find(ctx, 'people', ctx.me(), 'Profile');
    const canSee = visibleTo(ctx, me);
    const visible = new Set(ctx.db.all('people').filter(canSee).map((p) => p.id));
    const greetings = ctx.db.all('greetings');
    const upcoming = upcomingCelebrations(ctx, 7, ['birthday', 'anniversary'])
      .filter((c) => visible.has(c.personId))
      .map((c) => ({
        personId: c.personId,
        name: c.name,
        kind: c.kind,
        date: c.date,
        daysAway: c.daysAway,
        isMe: c.personId === me.id,
        wishedByMe: greetings.some((g) => g.personId === c.personId && g.kind === c.kind && g.year === Number(c.date.slice(0, 4)) && g.fromId === me.id),
        wishes: c.wishes,
      }));
    const weekAgo = new Date(ctx.now.getTime() - 7 * DAY).toISOString();
    const myWishes = greetings
      .filter((g) => g.personId === me.id && g.channel === 'wall' && g.at >= weekAgo)
      .sort((x, y) => y.at.localeCompare(x.at))
      .map((g) => ({ kind: g.kind, fromName: g.fromName, message: g.message, at: g.at }));
    return { upcoming, myWishes };
  });

  r.post('/celebrations/:personId/wish', {}, (ctx) => {
    const me = find(ctx, 'people', ctx.me(), 'Profile');
    const p = find(ctx, 'people', ctx.params[0], 'Person');
    if (p.id === me.id) throw new ApiError(422, 'invalid', 'You can’t wish yourself.');
    if (!visibleTo(ctx, me)(p)) throw new ApiError(404, 'not_found', 'Person not found.');
    const kind = (KINDS.includes(ctx.body.kind) ? ctx.body.kind : 'birthday') as CelebrationKind;
    const c = upcomingCelebrations(ctx, 7, [kind]).find((x) => x.personId === p.id);
    if (!c) throw new ApiError(409, 'not_celebrating', 'There’s nothing to celebrate this week.');
    const year = Number(c.date.slice(0, 4));
    const message = String(ctx.body.message ?? '').trim().slice(0, 280) || (kind === 'birthday' ? 'Happy birthday! God bless you.' : 'Happy anniversary! God bless you both.');
    const existing = ctx.db.all('greetings').find((g) => g.personId === p.id && g.kind === kind && g.year === year && g.fromId === me.id);
    return ctx.db.put('greetings', { id: existing?.id ?? ctx.id('gt'), personId: p.id, kind, year, fromId: me.id, fromName: fullName(me), message, channel: 'wall', at: ctx.now.toISOString() });
  });
}
