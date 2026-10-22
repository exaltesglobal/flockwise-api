// Giving storage on top of the engine database. Confirmed gifts get a receipt number and,
// for event tickets, an RSVP (onDonationSucceeded).
import { onDonationSucceeded, type createChurchEngine } from '../core/index.js';
import type { Store } from './types.js';

type Engine = ReturnType<typeof createChurchEngine>;

export function coreStore(engine: Engine): Store {
  const { db } = engine;
  const all = () => db.all('donations');
  return {
    async getFund(id) {
      return db.get('funds', id) ?? null;
    },
    async insertDonation(d) {
      if (d.providerPaymentId && all().some((x) => x.providerPaymentId === d.providerPaymentId)) return;
      db.put('donations', { ...d });
      if (d.status === 'succeeded') onDonationSucceeded(engine.systemCtx(), db.get('donations', d.id)!);
    },
    async updateDonation(id, patch) {
      const d = db.get('donations', id);
      if (!d) return;
      const next = db.put('donations', { ...d, ...patch });
      if (d.status !== 'succeeded' && next.status === 'succeeded') onDonationSucceeded(engine.systemCtx(), next);
    },
    async findDonation(id) {
      return db.get('donations', id) ?? null;
    },
    async findByProviderRef(ref) {
      return all()
        .filter((d) => d.providerRef === ref)
        .sort((x, y) => x.createdAt.localeCompare(y.createdAt))[0] ?? null;
    },
    async findByPaymentId(pid) {
      return all().find((d) => d.providerPaymentId === pid) ?? null;
    },
    async getPlanId(key) {
      return db.get('meta', `rzp-plan:${key}`)?.value ?? null;
    },
    async savePlanId(key, planId) {
      db.put('meta', { id: `rzp-plan:${key}`, value: planId });
    },
  };
}
