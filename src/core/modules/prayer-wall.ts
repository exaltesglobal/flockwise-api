// Prayer wall kiosk and QR prayer cards: anyone can send a prayer request from /pray (the QR on
// printed cards in the pews and the lobby), and a tablet in the lobby shows the wall of shared
// requests with an "I prayed" button. Requests land with the pastors like any other; the kiosk
// link carries a key so the wall is only on the church's own screen.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { Collections, PrayerKiosk, PrayerWall, PrayerWallStats, PublicPrayerInfo, WallRequest } from '../types.js';
import { DAY, find, fullName, normPhone, settings } from '../util.js';
import { notify, pastorIds } from './notify.js';

const KEY_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

function kioskKey(ctx: Ctx, rotate = false) {
  const s = settings(ctx);
  if (s.prayerKioskKey && !rotate) return s.prayerKioskKey;
  const key = ctx.env.random(20, KEY_ALPHABET);
  ctx.db.put('settings', { ...s, prayerKioskKey: key });
  return key;
}

/** "Priya T." on the wall, "A friend" when they gave no name. */
const wallName = (name: string) => { const parts = name.trim().split(/\s+/).filter(Boolean); return parts.length === 0 || /^a visitor$/i.test(name) ? 'A friend' : parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0]}.`; };

function stats(ctx: Ctx): PrayerWallStats {
  const week = ctx.now.getTime() - 7 * DAY;
  const all = ctx.db.all('prayer');
  return { open: all.filter((p) => p.status === 'open').length, requestsThisWeek: all.filter((p) => Date.parse(p.createdAt) > week).length, prayedThisWeek: all.filter((p) => Date.parse(p.createdAt) > week || p.status === 'open').reduce((n, p) => n + p.prayedBy.length, 0) };
}

const info = (ctx: Ctx): PublicPrayerInfo => { const s = settings(ctx); return { church: { name: s.name, logoUrl: s.logoUrl ?? null, phone: s.phone }, enabled: s.publicPrayer !== false, stats: stats(ctx) }; };
const wallView = (p: Collections['prayer'], device: string): WallRequest => ({ id: p.id, name: wallName(p.name), text: p.text, prayedCount: p.prayedBy.length, iPrayed: !!device && p.prayedBy.includes(`kiosk:${device}`), createdAt: p.createdAt, status: p.status, answeredNote: p.answeredNote });

export function registerPrayerWall(r: Router) {
  const requireKey = (ctx: Ctx) => { if (!ctx.query.k || ctx.query.k !== settings(ctx).prayerKioskKey) throw new ApiError(403, 'forbidden', 'This screen needs the kiosk link from the church office.'); };

  r.get('/public/prayer', { public: true }, (ctx) => info(ctx));
  r.post('/public/prayer', { public: true }, async (ctx) => {
    if (settings(ctx).publicPrayer === false) throw new ApiError(404, 'not_found', 'This church takes prayer requests in person.');
    const text = clean(ctx.body.text, 1000);
    if (text.length < 5) throw new ApiError(422, 'validation', 'Write a few words about what to pray for.', { text: 'Required' });
    const name = clean(ctx.body.name, 80);
    const phone = normPhone(clean(ctx.body.phone, 20));
    const match = phone.length === 10 ? ctx.db.all('people').find((p) => normPhone(p.phone) === phone) : undefined;
    const source = ctx.body.source === 'kiosk' ? 'kiosk' : 'card';
    const p = ctx.db.put('prayer', {
      id: ctx.id('pr'), personId: match?.id ?? null, name: match ? fullName(match) : name || 'A visitor', text, visibility: ctx.body.share ? 'church' : 'pastors', status: 'open', prayedBy: [], createdAt: ctx.now.toISOString(), answeredNote: null,
      source, contact: phone.length === 10 && !match ? clean(ctx.body.phone, 20) : null,
    });
    await notify(ctx, 'prayer.new', { personIds: pastorIds(ctx), title: `Prayer request from ${p.name}${source === 'kiosk' ? ' (lobby kiosk)' : ' (prayer card)'}`, body: text.slice(0, 200), link: '/admin/care?tab=prayer' });
    return { ok: true as const, id: p.id, message: `Thank you${name ? `, ${name.split(' ')[0]}` : ''}. The pastors will pray for this${ctx.body.share ? ', and the church will join them' : ''}.` };
  });
  r.get('/public/prayer/wall', { public: true }, (ctx): PrayerWall => {
    requireKey(ctx);
    const device = clean(ctx.query.device, 60);
    const requests = ctx.db.all('prayer')
      .filter((p) => p.visibility === 'church' && (p.status === 'open' || ctx.now.getTime() - Date.parse(p.createdAt) < 14 * DAY))
      .sort((x, y) => (x.status === 'answered' ? 1 : 0) - (y.status === 'answered' ? 1 : 0) || y.createdAt.localeCompare(x.createdAt))
      .slice(0, 60).map((p) => wallView(p, device));
    return { ...info(ctx), requests };
  });
  r.post('/public/prayer/wall/:id/pray', { public: true }, (ctx) => {
    requireKey(ctx);
    const device = clean(ctx.body.device, 60) || 'kiosk';
    const p = find(ctx, 'prayer', ctx.params[0], 'Prayer request');
    if (p.visibility !== 'church') throw new ApiError(404, 'not_found', 'Prayer request not found.');
    const tag = `kiosk:${device}`;
    const next = p.prayedBy.includes(tag) ? p : ctx.db.put('prayer', { ...p, prayedBy: [...p.prayedBy, tag] });
    return wallView(next, device);
  });

  // ----- office -----
  const kiosk = (ctx: Ctx): PrayerKiosk => {
    const key = kioskKey(ctx);
    const all = ctx.db.all('prayer');
    return { enabled: settings(ctx).publicPrayer !== false, publicUrl: `${ctx.env.webUrl}/pray`, kioskUrl: `${ctx.env.webUrl}/pray/wall?k=${key}`, key, stats: { ...stats(ctx), fromCards: all.filter((p) => p.source === 'card').length, fromKiosk: all.filter((p) => p.source === 'kiosk').length } };
  };
  r.get('/admin/prayer/kiosk', { perm: 'care' }, (ctx) => kiosk(ctx));
  r.post('/admin/prayer/kiosk', { perm: 'care' }, (ctx) => {
    if (ctx.body.enabled !== undefined) ctx.db.put('settings', { ...settings(ctx), publicPrayer: !!ctx.body.enabled });
    if (ctx.body.rotate) { kioskKey(ctx, true); ctx.audit('updated', 'settings', 'prayer-kiosk', 'New prayer-wall kiosk link; the old one stops working'); }
    return kiosk(ctx);
  });
}
