// First-run setup for a new church: settings, starter funds and rooms, and the owner login.
import type { Db } from './db.js';
import type { Env } from './engine.js';
import { DEFAULT_AUTOMATIONS } from './modules/comms.js';
import type { ChurchSettings, Currency } from './types.js';

export type BootstrapInput = { id: string; name: string; country: string; currency: Currency; city?: string; ownerName?: string; ownerEmail?: string };

export function bootstrapChurch(db: Db, env: Env, input: BootstrapInput) {
  if (!db.get('settings', 'church')) {
    const settings: ChurchSettings & { id: string } = {
      id: 'church',
      name: input.name,
      city: input.city ?? '',
      country: input.country,
      currency: input.currency,
      logoUrl: null,
      paymentProvider: input.country === 'IN' ? 'razorpay' : 'stripe',
      address: '',
      phone: '',
      email: '',
      website: '',
      timezone: input.country === 'IN' ? 'Asia/Kolkata' : 'UTC',
      languages: ['en'],
      payments: { provider: input.country === 'IN' ? 'razorpay' : 'stripe', connected: false, accountId: null },
      fcra: { registered: false, registrationNumber: null, accountLast4: null },
      receipts80g: { enabled: false, registrationNumber: null, pan: null },
      childAgeLimit: 13,
    };
    // The church id clients see stays the configured one.
    db.put('settings', { ...settings, id: 'church' });
  }
  if (!db.get('meta', 'churchId')) db.put('meta', { id: 'churchId', value: input.id });
  if (!db.get('automations', 'church')) db.put('automations', { id: 'church', ...DEFAULT_AUTOMATIONS });
  if (!db.count('funds')) {
    db.put('funds', { id: 'fd_tithe', name: 'Tithes & Offerings', description: 'General ministry of the church.', taxDeductible: true, active: true, goal: null });
    db.put('funds', { id: 'fd_building', name: 'Building Fund', description: 'Building and maintenance.', taxDeductible: true, active: true, goal: null });
    db.put('funds', { id: 'fd_missions', name: 'Missions', description: 'Outreach and church planting.', taxDeductible: false, active: true, goal: null });
  }
  if (!db.count('rooms')) {
    db.put('rooms', { id: 'rm_nursery', name: 'Nursery (0-2)', minAge: 0, maxAge: 2, capacity: 15 });
    db.put('rooms', { id: 'rm_tots', name: 'Little Lambs (3-5)', minAge: 3, maxAge: 5, capacity: 25 });
    db.put('rooms', { id: 'rm_kids', name: 'Kids Church (6-12)', minAge: 6, maxAge: 12, capacity: 60 });
  }
  const email = input.ownerEmail?.trim().toLowerCase();
  if (email && !db.all('staff').some((s) => s.email.toLowerCase() === email)) {
    const hasOwner = db.all('staff').some((s) => s.role === 'owner');
    db.put('staff', { id: env.newId('st'), personId: null, name: input.ownerName || email.split('@')[0], email, phone: null, role: hasOwner ? 'admin' : 'owner', status: 'invited', lastActiveAt: null });
  }
}
