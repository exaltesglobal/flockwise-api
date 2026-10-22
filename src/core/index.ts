// Entry point for the shared church engine.
import { Db, type Dump } from './db.js';
import { createEngine, makeCtx, type Env } from './engine.js';
import { registerAuth } from './modules/auth.js';
import { registerCare } from './modules/care.js';
import { registerCheckin } from './modules/checkin.js';
import { registerChurch } from './modules/church.js';
import { registerComms, runDue } from './modules/comms.js';
import { registerGiving } from './modules/giving.js';
import { registerPeople } from './modules/people.js';
import { registerServing } from './modules/serving.js';

export const MODULES = [registerAuth, registerPeople, registerChurch, registerGiving, registerCheckin, registerServing, registerComms, registerCare];

export function createChurchEngine(db: Db, env: Env) {
  const engine = createEngine(db, env, MODULES);
  return {
    ...engine,
    /** Runs scheduled messages and daily automations. Safe to call often. */
    tick: () => runDue(makeCtx(db, env, { auth: null })),
    /** A system context, for adapters (e.g. the payment webhook). */
    systemCtx: () => makeCtx(db, env, { auth: null }),
  };
}

export { Db, type Dump, type Env };
export { ApiError } from './errors.js';
export type { AuthClaims, DeliveryResult, Outgoing, Request } from './engine.js';
export { onDonationSucceeded } from './modules/giving.js';
export { DEMO_CODE } from './modules/auth.js';
export { PERMISSIONS, ROLE_LABELS } from './perms.js';
export { bootstrapChurch } from './bootstrap.js';
