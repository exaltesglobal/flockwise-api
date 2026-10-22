// Small helpers and the "view" functions that turn stored records into API shapes.
import type { Ctx } from './engine.js';
import { ApiError } from './errors.js';
import type { AdminDonation, AdminEvent, AdminFund, AdminGroup, Church, ChurchEvent, Collections, DonationRecord, Group, Member, Person } from './types.js';

export const DAY = 86_400_000;
export const PAGE = 50;

export const fullName = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`.trim();

export function age(birthDate: string | null | undefined, now: Date): number | null {
  if (!birthDate) return null;
  const [y, m, d] = birthDate.split('-').map(Number);
  if (!y) return null;
  let a = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) a--;
  return a;
}

export const isChild = (ctx: Ctx, p: { birthDate: string | null }) => {
  const a = age(p.birthDate, ctx.now);
  return a !== null && a < settings(ctx).childAgeLimit;
};

/** Indian financial year starts on 1 April. Other countries use the calendar year. */
export function fiscalYearStart(ctx: Ctx, at = ctx.now): Date {
  if (settings(ctx).country !== 'IN') return new Date(Date.UTC(at.getUTCFullYear(), 0, 1));
  const y = at.getUTCMonth() >= 3 ? at.getUTCFullYear() : at.getUTCFullYear() - 1;
  return new Date(Date.UTC(y, 3, 1));
}

export function fiscalYearRange(ctx: Ctx, fy?: string) {
  const start = Number((fy ?? '').slice(0, 4)) || fiscalYearStart(ctx).getUTCFullYear();
  const india = settings(ctx).country === 'IN';
  const from = india ? new Date(Date.UTC(start, 3, 1)) : new Date(Date.UTC(start, 0, 1));
  const to = india ? new Date(Date.UTC(start + 1, 3, 1)) : new Date(Date.UTC(start + 1, 0, 1));
  return { start, from, to, label: india ? `${start}-${String(start + 1).slice(2)}` : String(start) };
}

export function page<T>(items: T[], cursor?: string | null, size = PAGE) {
  const start = Number(cursor ?? 0) || 0;
  return { data: items.slice(start, start + size), nextCursor: start + size < items.length ? String(start + size) : null, total: items.length };
}

export function requireFields(body: Record<string, unknown>, fields: string[]) {
  const missing: Record<string, string> = {};
  for (const f of fields) if (body?.[f] === undefined || body[f] === null || String(body[f]).trim() === '') missing[f] = 'Required';
  if (Object.keys(missing).length) throw new ApiError(422, 'invalid', 'Please fill in the required fields.', missing);
}

export function find<K extends keyof Collections>(ctx: Ctx, kind: K, id: string, what: string): Collections[K] {
  const item = ctx.db.get(kind, id);
  if (!item) throw new ApiError(404, 'not_found', `${what} not found.`);
  return item;
}

/** Copies only the listed keys from an untrusted body. */
export function pick<T extends object>(body: Record<string, unknown>, keys: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (body?.[k as string] !== undefined) (out as Record<string, unknown>)[k as string] = body[k as string];
  return out;
}

export const settings = (ctx: Ctx) => ctx.db.get('settings', 'church')!;
/** The church's public id (the settings record itself is always stored under "church"). */
export const churchId = (ctx: Ctx) => ctx.db.get('meta', 'churchId')?.value ?? 'church';
export const iso = (d: Date) => d.toISOString();
export const dateOnly = (d: Date | string) => (typeof d === 'string' ? d : d.toISOString()).slice(0, 10);
export const normPhone = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '').slice(-10);
export const normEmail = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();

export function church(ctx: Ctx): Church {
  const s = settings(ctx);
  return { id: churchId(ctx), name: s.name, city: s.city, country: s.country, currency: s.currency, logoUrl: s.logoUrl, paymentProvider: s.paymentProvider };
}

export function personView(ctx: Ctx, p: Collections['people']): Person {
  const memberOf = new Set(ctx.db.all('groupMembers').filter((m) => m.personId === p.id).map((m) => m.groupId));
  const groups = ctx.db.all('groups').filter((g) => memberOf.has(g.id)).map((g) => ({ id: g.id, name: g.name }));
  return { ...p, groups };
}

export function memberProfile(p: Collections['people']): Member {
  return { id: p.id, firstName: p.firstName, lastName: p.lastName, phone: p.phone, email: p.email, language: p.language, householdName: p.householdName, photoUrl: null };
}

export const rsvpsFor = (ctx: Ctx, eventId: string) => ctx.db.all('rsvps').filter((r) => r.eventId === eventId);
export const checkinsFor = (ctx: Ctx, eventId: string) => ctx.db.all('checkins').filter((c) => c.eventId === eventId);

export function eventView(ctx: Ctx, ev: Collections['events']): AdminEvent {
  return {
    ...ev,
    goingCount: rsvpsFor(ctx, ev.id).length,
    checkinCount: checkinsFor(ctx, ev.id).length,
    campusName: ctx.db.get('campuses', ev.campusId)?.name ?? null,
  };
}

export function memberEvent(ctx: Ctx, ev: Collections['events'], personId: string): ChurchEvent {
  const v = eventView(ctx, ev);
  return {
    id: v.id,
    kind: v.kind,
    title: v.title,
    description: v.description,
    startsAt: v.startsAt,
    endsAt: v.endsAt,
    location: v.location,
    imageUrl: v.imageUrl ?? null,
    goingCount: v.goingCount,
    capacity: v.capacity ?? null,
    price: v.price ?? null,
    campusName: v.campusName,
    myRsvp: ctx.db.all('rsvps').some((r) => r.eventId === ev.id && r.personId === personId) ? 'going' : null,
    checkedIn: ctx.db.all('checkins').some((c) => c.eventId === ev.id && c.personId === personId),
    registrationFormId: ctx.db.all('forms').find((f) => f.eventId === ev.id && f.status === 'open')?.id ?? null,
  };
}

export const upcoming = (ctx: Ctx, ev: { endsAt: string }) => new Date(ev.endsAt).getTime() > ctx.now.getTime();
export const bySoonest = (x: { startsAt: string }, y: { startsAt: string }) => x.startsAt.localeCompare(y.startsAt);

export function groupView(ctx: Ctx, g: Collections['groups']): AdminGroup {
  return {
    ...g,
    memberCount: ctx.db.all('groupMembers').filter((m) => m.groupId === g.id).length,
    pendingRequests: ctx.db.all('joinRequests').filter((j) => j.groupId === g.id).length,
    leaderName: g.leaderId ? (ctx.db.get('people', g.leaderId) ? fullName(ctx.db.get('people', g.leaderId)!) : g.leaderName) : g.leaderName,
  };
}

export function memberGroup(ctx: Ctx, g: Collections['groups'], personId: string): Group {
  const v = groupView(ctx, g);
  const isMember = ctx.db.all('groupMembers').some((m) => m.groupId === g.id && m.personId === personId);
  const requested = ctx.db.all('joinRequests').some((j) => j.groupId === g.id && j.person.id === personId);
  return {
    id: v.id,
    name: v.name,
    description: v.description,
    meetingSchedule: v.meetingSchedule,
    location: v.location,
    leaderName: v.leaderName,
    memberCount: v.memberCount,
    type: v.type,
    membership: isMember ? 'member' : requested ? 'requested' : 'none',
  };
}

export function adminDonation(d: DonationRecord): AdminDonation {
  return {
    id: d.id,
    fundName: d.fundName,
    amount: d.amount,
    currency: d.currency,
    frequency: d.frequency,
    status: d.status,
    createdAt: d.paidAt ?? d.createdAt,
    receiptUrl: null,
    donorId: d.donorId,
    donorName: d.donorName,
    fundId: d.fundId,
    method: d.method ?? 'upi',
    pan: d.pan,
    donorCitizenship: d.donorCitizenship,
    fcra: d.fcra,
    receiptNumber: d.receiptNumber,
  };
}

/** Gifts newest first, by the date the money arrived. */
export const donationsSorted = (ctx: Ctx) => ctx.db.all('donations').sort((x, y) => (y.paidAt ?? y.createdAt).localeCompare(x.paidAt ?? x.createdAt));
export const giftDate = (d: DonationRecord) => d.paidAt ?? d.createdAt;

export function fundView(ctx: Ctx, f: Collections['funds']): AdminFund {
  const from = fiscalYearStart(ctx);
  const raisedThisYear = ctx.db
    .all('donations')
    .filter((d) => d.fundId === f.id && d.status === 'succeeded' && new Date(giftDate(d)) >= from)
    .reduce((s, d) => s + d.amount, 0);
  const pledged = ctx.db.all('pledges').filter((p) => p.fundId === f.id && p.endDate >= dateOnly(ctx.now)).reduce((s, p) => s + p.amount, 0);
  return { id: f.id, name: f.name, description: f.description, taxDeductible: f.taxDeductible, active: f.active, goal: f.goal, raisedThisYear, pledged };
}

/** 80G: not for FCRA gifts, non-80G funds, or cash above Rs 2,000 (Income Tax Act s.80G(5D)). */
export function eligible80g(ctx: Ctx, d: DonationRecord) {
  const fund = ctx.db.get('funds', d.fundId);
  return d.status === 'succeeded' && !!fund?.taxDeductible && !d.fcra && !(d.method === 'cash' && d.amount > 200000) && !d.eventId && !d.formResponseId;
}

export function nextReceiptNumber(ctx: Ctx) {
  const fy = fiscalYearRange(ctx).label;
  const key = `receipt:${fy}`;
  const n = Number(ctx.db.get('meta', key)?.value ?? 0) + 1;
  ctx.db.put('meta', { id: key, value: String(n) });
  return `${fy}/${String(n).padStart(5, '0')}`;
}

export function newPerson(ctx: Ctx, input: Partial<Collections['people']> & { firstName: string; lastName: string }): Collections['people'] {
  return {
    phone: null,
    email: null,
    gender: null,
    birthDate: null,
    status: 'visitor',
    householdName: null,
    address: null,
    language: 'en',
    tags: [],
    notes: null,
    campusId: null,
    baptismDate: null,
    anniversary: null,
    allergies: null,
    medicalNotes: null,
    lastAttendedAt: null,
    ...input,
    consent: { email: true, sms: true, whatsapp: true, directory: false, ...(input.consent ?? {}) },
    id: ctx.id('p'),
    joinedAt: ctx.now.toISOString(),
    checkinCode: ctx.env.random(8, 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'),
  };
}

/** Marks a person as having attended today (check-in, group meeting). */
export function touchAttendance(ctx: Ctx, personId: string, at = ctx.now) {
  const p = ctx.db.get('people', personId);
  if (!p) return;
  if (!p.lastAttendedAt || p.lastAttendedAt < at.toISOString()) ctx.db.put('people', { ...p, lastAttendedAt: at.toISOString() });
}

const tz = (ctx: Ctx) => settings(ctx).timezone || 'Asia/Kolkata';
/** The calendar date (YYYY-MM-DD) at the church, in its time zone. */
export function localDate(ctx: Ctx, d: Date) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz(ctx), year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}
export function localHour(ctx: Ctx, d: Date) {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz(ctx), hour: '2-digit', hourCycle: 'h23' }).format(d));
  } catch {
    return d.getUTCHours();
  }
}

/** Finds a person by email (then phone), or adds them as a visitor. Used by public forms and the group finder. */
export function matchOrCreatePerson(ctx: Ctx, input: { name: string; email?: string | null; phone?: string | null }): Collections['people'] {
  const email = normEmail(input.email);
  const phone = normPhone(input.phone);
  const people = ctx.db.all('people');
  const found = (email && people.find((p) => normEmail(p.email) === email)) || (phone.length === 10 && people.find((p) => normPhone(p.phone) === phone));
  if (found) {
    if (!found.email && email) return ctx.db.put('people', { ...found, email });
    return found;
  }
  const [firstName, ...rest] = input.name.trim().split(/\s+/);
  const p = ctx.db.put('people', newPerson(ctx, { firstName: firstName || 'Guest', lastName: rest.join(' '), email: email || null, phone: input.phone?.trim() || null, status: 'visitor' }));
  ctx.audit('created', 'person', p.id, `Added ${fullName(p)} from a public form`);
  return p;
}

export const money = (ctx: Ctx, minor: number) => {
  const c = settings(ctx).currency;
  try {
    return new Intl.NumberFormat(c === 'INR' ? 'en-IN' : 'en', { style: 'currency', currency: c, maximumFractionDigits: minor % 100 ? 2 : 0 }).format(minor / 100);
  } catch {
    return `${c} ${(minor / 100).toFixed(2)}`;
  }
};
