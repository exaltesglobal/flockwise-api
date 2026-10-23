// Team app logins are limited per plan (Seed 10, Grow 50, Thrive 200, Cathedral unlimited);
// founding churches have no limit.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { Db } from '../src/core/index.js';
import { checkLimit, getSubscription, limitsFor, PLANS, saveSubscription } from '../src/core/plans.js';
import { seedDemo } from '../src/core/seed.js';

const now = new Date('2026-11-02T05:00:00.000Z');
const env = createDemoEnv({ now: () => now });
const db = new Db();
seedDemo(db, env);

test('each plan caps Team app logins; founding churches and Cathedral do not', () => {
  assert.equal(PLANS.seed.limits.teamLogins, 10);
  assert.equal(PLANS.grow.limits.teamLogins, 50);
  assert.equal(PLANS.thrive.limits.teamLogins, 200);
  assert.ok(PLANS.cathedral.limits.teamLogins >= 1_000_000);
  assert.ok(limitsFor(db, now).teamLogins >= 1_000_000, 'the demo church is a founding church');

  saveSubscription(db, { ...getSubscription(db), founding: false, plan: 'seed', status: 'active', interval: 'monthly', providerRef: null });
  assert.equal(limitsFor(db, now).teamLogins, 10);
  assert.doesNotThrow(() => checkLimit(db, now, 'teamLogins', 9));
  assert.throws(() => checkLimit(db, now, 'teamLogins', 10), (e: any) => e.status === 402 && e.code === 'plan_limit' && /Team app logins/.test(e.message));
  saveSubscription(db, { ...getSubscription(db), plan: 'thrive' });
  assert.doesNotThrow(() => checkLimit(db, now, 'teamLogins', 199));
  assert.throws(() => checkLimit(db, now, 'teamLogins', 200));
});
