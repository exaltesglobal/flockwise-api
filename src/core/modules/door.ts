// Door QR attendance: a leader opens the door code on their phone at the entrance, and members scan
// it with the Flockwise app as they walk in. The code changes every minute and is tied to the event,
// so a photo of it does not work next week. Each scan is a normal check-in with method "qr".
import { ApiError } from '../errors.js';
import type { Ctx, Router } from '../engine.js';
import type { DoorQr, FamilyCheckinResult } from '../types.js';
import { checkinsFor, find, fullName } from '../util.js';
import { checkIn } from './checkin.js';
import { checkinEvent, parent } from './family.js';
import { notify } from './notify.js';

const SLOT_MS = 60_000;
/** The code is accepted for this many slots after it was shown (a slow phone, a queue at the door). */
const GRACE_SLOTS = 3;
const BEFORE_MS = 3 * 3_600_000;
const AFTER_MS = 3_600_000;

function tokenFor(ctx: Ctx, eventId: string, slot: number) {
  return ctx.env.hash(`door:${eventId}:${slot}`).replace(/[^a-z0-9]/gi, '').slice(-8).toUpperCase();
}
const slotNow = (ctx: Ctx) => Math.floor(ctx.now.getTime() / SLOT_MS);

function requireToken(ctx: Ctx, eventId: string, token: unknown) {
  const t = String(token ?? '').trim().toUpperCase();
  const now = slotNow(ctx);
  for (let s = now; s > now - GRACE_SLOTS; s--) if (t && tokenFor(ctx, eventId, s) === t) return;
  throw new ApiError(410, 'door_expired', 'This door code has expired. Scan the QR at the door again.');
}

function requireOpen(ctx: Ctx, ev: { startsAt: string; endsAt: string; checkinEnabled: boolean }) {
  if (!ev.checkinEnabled) throw new ApiError(422, 'checkin_closed', 'Check-in is turned off for this event.');
  const t = ctx.now.getTime();
  if (t < new Date(ev.startsAt).getTime() - BEFORE_MS || t > new Date(ev.endsAt).getTime() + AFTER_MS) throw new ApiError(422, 'not_open', 'The door code works from three hours before the service until an hour after.');
}

export function registerDoor(r: Router) {
  // ----- the leader's phone -----
  r.get('/admin/checkin/:eventId/door', { perm: 'checkin' }, (ctx): DoorQr => {
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    const done = checkinsFor(ctx, ev.id);
    const scanned = done.filter((c) => c.method === 'qr').sort((x, y) => y.at.localeCompare(x.at));
    return {
      token: tokenFor(ctx, ev.id, slotNow(ctx)),
      path: `/app/door?e=${encodeURIComponent(ev.id)}&t=${tokenFor(ctx, ev.id, slotNow(ctx))}`,
      rotatesInSeconds: Math.ceil(((slotNow(ctx) + 1) * SLOT_MS - ctx.now.getTime()) / 1000),
      present: done.length,
      scanned: scanned.length,
      recent: scanned.slice(0, 6).map((c) => ({ name: c.personName, at: c.at })),
    };
  });

  // ----- the member's phone, after scanning -----
  r.get('/door/:eventId', {}, (ctx) => {
    const me = parent(ctx);
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    requireToken(ctx, ev.id, ctx.query.t);
    requireOpen(ctx, ev);
    return checkinEvent(ctx, me, ev);
  });
  r.post('/door/:eventId', {}, (ctx): FamilyCheckinResult => {
    const me = parent(ctx);
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    requireToken(ctx, ev.id, ctx.body.token);
    requireOpen(ctx, ev);
    const view = checkinEvent(ctx, me, ev);
    const mine = new Set(view.members.map((m) => m.id));
    const asked = Array.isArray(ctx.body.personIds) ? (ctx.body.personIds as unknown[]).map(String) : [me.id];
    const ids = asked.filter((id) => mine.has(id));
    if (!ids.length) throw new ApiError(422, 'invalid', 'Choose who is here.');
    const res = checkIn(ctx, ev, ids, 'qr');
    if (res.checkins.length) ctx.audit('checked_in', 'checkin', ev.id, `${fullName(me)} scanned the door QR for ${res.checkins.map((c) => c.personName).join(', ')}`);
    const after = checkinEvent(ctx, me, ev);
    const code = res.securityCode ?? after.members.find((m) => ids.includes(m.id) && m.securityCode)?.securityCode ?? null;
    if (res.checkins.length) void notify(ctx, 'door.scanned', { personIds: after.members.filter((m) => !m.isChild).map((m) => m.id), title: `${res.checkins.map((c) => c.personName.split(' ')[0]).join(', ')} arrived`, body: `Checked in at the door for ${ev.title}.`, except: me.id });
    return { securityCode: code, checkedIn: res.checkins.map((c) => c.personId), event: after };
  });
}
