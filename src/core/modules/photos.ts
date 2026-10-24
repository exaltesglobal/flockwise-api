// Profile photos and avatars. A member (or the office) uploads a photo that the browser has already
// cropped to a square and shrunk; it is kept apart from the person so lists stay light, and served
// from a link that changes with every new photo. People without a photo get one of 100 drawn avatars,
// picked from their id unless they chose one.
import type { Ctx, RawResult, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { Collections } from '../types.js';
import { find, photoUrlOf } from '../util.js';

export const AVATAR_COUNT = 100;
const MAX_BYTES = 300_000;
const KEY_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** Accepts a data URL (JPEG, PNG or WebP) the browser made after cropping. */
function parseImage(v: unknown): { contentType: string; data: string } {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(v ?? ''));
  if (!m) throw new ApiError(422, 'invalid', 'Choose a JPG, PNG or WebP picture.', { image: 'Picture required' });
  if (m[2].length * 0.75 > MAX_BYTES) throw new ApiError(413, 'too_large', 'That picture is too big. Crop it smaller and try again.');
  return { contentType: m[1], data: m[2] };
}

function savePhoto(ctx: Ctx, person: Collections['people'], image: unknown) {
  const img = parseImage(image);
  ctx.db.put('photos', { id: person.id, ...img, updatedAt: ctx.now.toISOString() });
  return ctx.db.put('people', { ...person, photoKey: ctx.env.random(16, KEY_ALPHABET) });
}

function removePhoto(ctx: Ctx, person: Collections['people']) {
  ctx.db.del('photos', person.id);
  return ctx.db.put('people', { ...person, photoKey: null });
}

function cleanAvatar(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n >= AVATAR_COUNT) throw new ApiError(422, 'invalid', `Avatar should be 0–${AVATAR_COUNT - 1}.`, { avatar: 'Pick an avatar' });
  return n;
}

const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export function registerPhotos(r: Router) {
  const reply = (ctx: Ctx, p: Collections['people']) => ({ id: p.id, avatar: p.avatar ?? null, photoUrl: photoUrlOf(ctx, p) });

  r.put('/me/photo', {}, (ctx) => reply(ctx, savePhoto(ctx, find(ctx, 'people', ctx.me(), 'Profile'), ctx.body.image)));
  r.del('/me/photo', {}, (ctx) => reply(ctx, removePhoto(ctx, find(ctx, 'people', ctx.me(), 'Profile'))));
  r.put('/me/avatar', {}, (ctx) => { const p = find(ctx, 'people', ctx.me(), 'Profile'); return reply(ctx, ctx.db.put('people', { ...p, avatar: cleanAvatar(ctx.body.avatar) })); });

  r.put('/admin/people/:id/photo', { perm: 'people.edit' }, (ctx) => {
    const p = savePhoto(ctx, find(ctx, 'people', ctx.params[0], 'Person'), ctx.body.image);
    ctx.audit('updated', 'person', p.id, `Changed the photo of ${p.firstName} ${p.lastName}`.trim());
    return reply(ctx, p);
  });
  r.del('/admin/people/:id/photo', { perm: 'people.edit' }, (ctx) => reply(ctx, removePhoto(ctx, find(ctx, 'people', ctx.params[0], 'Person'))));
  r.put('/admin/people/:id/avatar', { perm: 'people.edit' }, (ctx) => { const p = find(ctx, 'people', ctx.params[0], 'Person'); return reply(ctx, ctx.db.put('people', { ...p, avatar: cleanAvatar(ctx.body.avatar) })); });

  // Every face the office screens may need, in one small reply: people with a photo or a chosen avatar.
  r.get('/admin/faces', { staff: true }, (ctx) => {
    const out: Record<string, { p: string | null; a: number | null }> = {};
    for (const p of ctx.db.all('people')) if (p.photoKey || p.avatar != null) out[p.id] = { p: photoUrlOf(ctx, p), a: p.avatar ?? null };
    return out;
  });

  // The photo itself. The key in the link changes with each upload, so it can be cached for good.
  r.get('/public/photos/:id/:key', { public: true }, (ctx): RawResult => {
    const p = ctx.db.get('people', ctx.params[0]);
    const ph = p?.photoKey && p.photoKey === ctx.params[1] ? ctx.db.get('photos', p.id) : undefined;
    if (!ph) throw new ApiError(404, 'not_found', 'No photo.');
    return { __raw: true, contentType: ph.contentType, body: '', bytes: decode(ph.data), cache: 'public, max-age=31536000, immutable' };
  });
}
