export type Fund = { id: string; churchId: string; name: string; description: string; taxDeductible: boolean; active: boolean; goal: number | null };

export type DonationStatus = 'pending' | 'succeeded' | 'failed' | 'refunded';
export type PaymentMethod = 'upi' | 'card' | 'netbanking' | 'wallet' | 'cash' | 'cheque' | 'bank_transfer';

export type Donation = {
  id: string;
  churchId: string;
  memberId: string | null;
  donorName: string;
  donorEmail: string | null;
  donorPhone: string | null;
  fundId: string;
  fundName: string;
  amount: number; // minor units
  currency: string;
  frequency: 'once' | 'monthly';
  status: DonationStatus;
  method: PaymentMethod | null;
  pan: string | null;
  donorCitizenship: 'IN' | 'OTHER';
  fcra: boolean;
  provider: 'razorpay' | 'fake' | 'offline';
  /** Razorpay payment link id (plink_…) or subscription id (sub_…). Shared by every charge of a subscription. */
  providerRef: string | null;
  /** Razorpay payment id (pay_…). Unique, so webhook retries cannot double count. */
  providerPaymentId: string | null;
  createdAt: string;
  paidAt: string | null;
};

export type DonationFilter = { churchId: string; memberId?: string; fundId?: string; from?: string; to?: string; q?: string; offset?: number; limit?: number };

export interface Store {
  listFunds(churchId: string): Promise<Fund[]>;
  getFund(churchId: string, id: string): Promise<Fund | null>;
  insertDonation(d: Donation): Promise<void>;
  updateDonation(id: string, patch: Partial<Donation>): Promise<void>;
  findDonation(id: string): Promise<Donation | null>;
  /** The donation row created when the intent was made (first match by providerRef). */
  findByProviderRef(ref: string): Promise<Donation | null>;
  findByPaymentId(paymentId: string): Promise<Donation | null>;
  listDonations(f: DonationFilter): Promise<{ rows: Donation[]; total: number; totalAmount: number }>;
  getPlanId(key: string): Promise<string | null>;
  savePlanId(key: string, planId: string): Promise<void>;
}
