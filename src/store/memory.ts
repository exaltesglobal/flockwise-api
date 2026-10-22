// In-memory store for local development and tests. Data is lost on restart.
import type { Donation, DonationFilter, Fund, Store } from './types.js';

export function memoryStore(churchId: string): Store {
  const funds: Fund[] = [
    { id: 'fd_tithe', churchId, name: 'Tithes & Offerings', description: 'General ministry of the church.', taxDeductible: true, active: true, goal: null },
    { id: 'fd_building', churchId, name: 'Building Fund', description: 'New sanctuary construction.', taxDeductible: true, active: true, goal: null },
    { id: 'fd_missions', churchId, name: 'Missions', description: 'Church planting in North India.', taxDeductible: false, active: true, goal: null },
  ];
  const donations: Donation[] = [];
  const plans = new Map<string, string>();

  return {
    async listFunds(c) {
      return funds.filter((f) => f.churchId === c);
    },
    async getFund(c, id) {
      return funds.find((f) => f.churchId === c && f.id === id) ?? null;
    },
    async insertDonation(d) {
      if (d.providerPaymentId && donations.some((x) => x.providerPaymentId === d.providerPaymentId)) return;
      donations.unshift({ ...d });
    },
    async updateDonation(id, patch) {
      const d = donations.find((x) => x.id === id);
      if (d) Object.assign(d, patch);
    },
    async findDonation(id) {
      return donations.find((d) => d.id === id) ?? null;
    },
    async findByProviderRef(ref) {
      return [...donations].reverse().find((d) => d.providerRef === ref) ?? null;
    },
    async findByPaymentId(pid) {
      return donations.find((d) => d.providerPaymentId === pid) ?? null;
    },
    async listDonations(f: DonationFilter) {
      const q = f.q?.toLowerCase();
      const all = donations
        .filter((d) => d.churchId === f.churchId)
        .filter((d) => !f.memberId || d.memberId === f.memberId)
        .filter((d) => !f.fundId || d.fundId === f.fundId)
        .filter((d) => !f.from || d.createdAt.slice(0, 10) >= f.from)
        .filter((d) => !f.to || d.createdAt.slice(0, 10) <= f.to)
        .filter((d) => !q || d.donorName.toLowerCase().includes(q) || (d.pan ?? '').toLowerCase().includes(q));
      const offset = f.offset ?? 0;
      return {
        rows: all.slice(offset, offset + (f.limit ?? 50)),
        total: all.length,
        totalAmount: all.filter((d) => d.status === 'succeeded').reduce((s, d) => s + d.amount, 0),
      };
    },
    async getPlanId(key) {
      return plans.get(key) ?? null;
    },
    async savePlanId(key, id) {
      plans.set(key, id);
    },
  };
}
