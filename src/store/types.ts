// The giving storage the Razorpay code needs. Implemented over the engine's database.
import type { DonationRecord, FundRecord } from '../core/types.js';

export type Donation = DonationRecord;
export type Fund = FundRecord;
export type { PaymentMethod } from '../core/types.js';

export interface Store {
  getFund(id: string): Promise<Fund | null>;
  insertDonation(d: Donation): Promise<void>;
  updateDonation(id: string, patch: Partial<Donation>): Promise<void>;
  findDonation(id: string): Promise<Donation | null>;
  /** The donation row created when the checkout was made (first match by providerRef). */
  findByProviderRef(ref: string): Promise<Donation | null>;
  findByPaymentId(paymentId: string): Promise<Donation | null>;
  getPlanId(key: string): Promise<string | null>;
  savePlanId(key: string, planId: string): Promise<void>;
}
