// With only RAZORPAY_* set, those keys are Flockwise's billing account and never collect church gifts.
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.RAZORPAY_KEY_ID = 'rzp_live_flockwise';
process.env.RAZORPAY_KEY_SECRET = 'flockwise-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'flockwise-wh';
delete process.env.BILLING_RAZORPAY_KEY_ID;

const { config } = await import('../src/config.js');

test('RAZORPAY_* alone is the billing account, not gift keys', () => {
  assert.equal(config.billing?.keyId, 'rzp_live_flockwise');
  assert.equal(config.billing?.webhookSecret, 'flockwise-wh');
  assert.equal(config.razorpay.main, null);
});
