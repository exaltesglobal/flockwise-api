// WhatsApp by Chitthi, bought with the plan: the church asks for it on the plans page, the Flockwise
// team makes the Chitthi workspace, registers the number with Meta and pastes the key here, and
// every WhatsApp the church sends then goes through its own workspace with nothing else to set up.
import type { Db } from '../db.js';
import type { Ctx } from '../engine.js';
import { ApiError } from '../errors.js';
import type { ChitthiSetup, ChitthiSetupStatus } from '../types.js';
import { connectChitthi } from './integrations.js';

const STATUSES: ChitthiSetupStatus[] = ['requested', 'in_progress', 'ready', 'cancelled'];

export const getChitthiSetup = (db: Db) => (db.get('integrations', 'chitthiSetup') as ChitthiSetup | undefined) ?? null;

/** The church asks the team to set WhatsApp up. Asking again updates the number and name. */
export function requestChitthiSetup(ctx: Ctx, body: Record<string, unknown>): ChitthiSetup {
  const phone = String(body.phone ?? '').replace(/[^\d+ ]/g, '').trim().slice(0, 20);
  if (phone.replace(/\D/g, '').length < 10) throw new ApiError(422, 'invalid', 'Give the WhatsApp number the church will send from, with the country code.', { phone: 'Number with country code' });
  const businessName = String(body.businessName ?? '').trim().slice(0, 120);
  if (!businessName) throw new ApiError(422, 'invalid', 'Give the name people should see on WhatsApp.', { businessName: 'Required' });
  const cur = getChitthiSetup(ctx.db);
  const next: ChitthiSetup = cur && cur.status !== 'cancelled'
    ? { ...cur, phone, businessName }
    : { id: 'chitthiSetup', status: 'requested', requestedAt: ctx.now.toISOString(), requestedBy: ctx.staff?.name ?? '', requestedByEmail: ctx.staff?.email ?? '', phone, businessName, readyAt: null, teamNote: '' };
  ctx.db.put('integrations', next);
  if (!cur || cur.status === 'cancelled') ctx.audit('requested', 'integration', 'chitthi', `Asked for WhatsApp by Chitthi on ${phone}`);
  return next;
}

export function cancelChitthiSetup(ctx: Ctx) {
  const cur = getChitthiSetup(ctx.db);
  if (cur && cur.status !== 'ready') ctx.db.put('integrations', { ...cur, status: 'cancelled' });
}

// ----- for the Flockwise team panel -----

export function teamChitthiRow(db: Db) {
  const s = getChitthiSetup(db);
  if (!s) return null;
  return { ...s, connected: !!db.get('integrations', 'chitthi') };
}

/** The team moves the setup along; pasting the workspace key connects it and marks it ready. */
export async function teamUpdateChitthi(ctx: Ctx, body: Record<string, unknown>) {
  const s = getChitthiSetup(ctx.db);
  if (!s) throw new ApiError(404, 'not_found', 'This church has not asked for WhatsApp by Chitthi.');
  const next: ChitthiSetup = { ...s };
  if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
    await connectChitthi(ctx, body.apiKey, {}, 'Flockwise team');
    next.status = 'ready';
    next.readyAt = next.readyAt ?? ctx.now.toISOString();
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status as ChitthiSetupStatus)) throw new ApiError(422, 'invalid', 'Unknown status.');
    next.status = body.status as ChitthiSetupStatus;
    if (next.status === 'ready' && !next.readyAt) next.readyAt = ctx.now.toISOString();
  }
  if (typeof body.teamNote === 'string') next.teamNote = body.teamNote.slice(0, 1000);
  ctx.db.put('integrations', next);
  return teamChitthiRow(ctx.db)!;
}
