// Hall and ground rental to outsiders: the office marks a hall, ground or room as for hire with an
// hourly rate, minimum hours and a deposit; anyone can ask for a date from the church's public
// page; the office approves and the renter pays online through the church's own Razorpay. A paid
// rental becomes an approved booking on the calendar, so nothing else can be put in that slot.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { Booking, Collections, PublicRental, PublicRentalSpace, Rental, RentalOffer, RentalStatus, RentalView, RentalsHub } from '../types.js';
import { permsOf } from '../perms.js';
import { find, money, normEmail, settings } from '../util.js';
import { conflictsFor } from './calendar.js';
import { deliverAll } from './integrations.js';
import { notify } from './notify.js';

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const HOUR = 3_600_000;
const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
const minor = (v: unknown) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 ? n : 0; };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ensureRentalFund(ctx: Ctx) {
  return ctx.db.get('funds', 'fd_rentals') ?? ctx.db.put('funds', { id: 'fd_rentals', name: 'Hall rentals', description: 'Hire of the hall, ground and rooms by outsiders. Not a donation.', taxDeductible: false, active: false, goal: null, system: true });
}

function offerOf(ctx: Ctx, resourceId: string): RentalOffer {
  return ctx.db.get('rentalOffers', resourceId) ?? { id: resourceId, enabled: false, ratePerHour: 0, minHours: 2, deposit: 0, blurb: '', terms: '', photoUrl: null };
}

/** What the public page shows: enabled spaces with their rates. */
export function spacesForHire(ctx: Ctx): PublicRentalSpace[] {
  return ctx.db.all('rentalOffers').filter((o) => o.enabled && o.ratePerHour > 0).map((o) => {
    const r = ctx.db.get('resources', o.id);
    return r ? { id: r.id, name: r.name, kind: r.kind, capacity: r.capacity, description: r.description, blurb: o.blurb, terms: o.terms, photoUrl: o.photoUrl, ratePerHour: o.ratePerHour, minHours: o.minHours, deposit: o.deposit, currency: settings(ctx).currency } : null;
  }).filter((x): x is PublicRentalSpace => !!x).sort((a, b) => a.name.localeCompare(b.name));
}

const hoursBetween = (a: string, b: string) => Math.max(0, Math.round(((Date.parse(b) - Date.parse(a)) / HOUR) * 2) / 2);

function view(ctx: Ctx, x: Rental): RentalView {
  const booking = x.bookingId ? ctx.db.get('bookings', x.bookingId) : null;
  const conflicts = booking && x.status !== 'declined' && x.status !== 'cancelled' ? conflictsFor(ctx, booking).filter((c) => c.status === 'approved') : [];
  return { ...x, total: x.amount + x.deposit, payUrl: `${ctx.env.webUrl}/rent/pay/${x.token}`, bookingStatus: booking?.status ?? null, conflicts };
}

function officeIds(ctx: Ctx): string[] {
  const out = new Set<string>();
  for (const s of ctx.db.all('staff')) {
    if (s.status !== 'active' || !permsOf(ctx.db, s).includes('events')) continue;
    const p = (s.personId && ctx.db.get('people', s.personId)) || ctx.db.all('people').find((x) => normEmail(x.email) === normEmail(s.email));
    if (p) out.add(p.id);
  }
  return [...out];
}

/** Email (and WhatsApp when the office has it) to the renter, who is not a member. Never throws. */
async function tellRenter(ctx: Ctx, x: Rental, subject: string, text: string) {
  const church = settings(ctx).name;
  const body = `Dear ${x.renterName},\n\n${text}\n\n${church}${settings(ctx).phone ? ` · ${settings(ctx).phone}` : ''}`;
  try {
    if (x.renterEmail) await ctx.env.deliver('email', [{ to: x.renterEmail, name: x.renterName, subject, text: body }]);
    if (x.renterPhone) await deliverAll(ctx, 'whatsapp', [{ to: x.renterPhone, name: x.renterName, subject, text: `${subject}\n${body}` }]);
  } catch { /* logged on the channel */ }
}

const when = (x: Pick<Rental, 'startsAt' | 'endsAt'>, ctx: Ctx) => {
  const tz = settings(ctx).timezone || 'Asia/Kolkata';
  const f = (iso: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-IN', { timeZone: tz, ...o }).format(new Date(iso));
  return `${f(x.startsAt, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}, ${f(x.startsAt, { hour: 'numeric', minute: '2-digit' })} to ${f(x.endsAt, { hour: 'numeric', minute: '2-digit' })}`;
};

function setBooking(ctx: Ctx, x: Rental, status: Booking['status'], by: string) {
  const b = x.bookingId ? ctx.db.get('bookings', x.bookingId) : null;
  if (b) ctx.db.put('bookings', { ...b, status, decidedBy: by, decidedAt: ctx.now.toISOString() });
}

/** Called when the rental's payment succeeds (checkout or webhook): confirm the booking and tell everyone. */
export function onRentalPaid(ctx: Ctx, d: Collections['donations']) {
  const x = d.rentalId ? ctx.db.get('rentals', d.rentalId) : null;
  if (!x || x.status === 'paid') return;
  const paid = ctx.db.put('rentals', { ...x, status: 'paid', paidAt: ctx.now.toISOString(), donationId: d.id });
  setBooking(ctx, paid, 'approved', 'Online payment');
  ctx.audit('paid', 'rental', x.id, `${x.renterName} paid ${money(ctx, x.amount + x.deposit)} for ${x.resourceName} on ${when(x, ctx)}`);
  void tellRenter(ctx, paid, `${settings(ctx).name}: booking confirmed`, `Thank you. Your payment of ${money(ctx, x.amount + x.deposit)} is received and ${x.resourceName} is booked for ${when(x, ctx)}.${x.deposit ? ` The deposit of ${money(ctx, x.deposit)} is returned after the event, less any damage.` : ''}`);
  void notify(ctx, 'rental.new', { personIds: officeIds(ctx), title: `${x.resourceName} paid: ${x.renterName}`, body: `${x.renterName} paid ${money(ctx, x.amount + x.deposit)} for ${x.resourceName}, ${when(x, ctx)}. The booking is now on the calendar.`, link: '/admin/rentals' });
}

export function registerRentals(r: Router) {
  const EDIT = ['events', 'settings'] as ('events' | 'settings')[];

  // ----- office -----
  r.get('/admin/rentals', { staff: true }, (ctx): RentalsHub => {
    const status = ctx.query.status;
    const rentals = ctx.db.all('rentals')
      .filter((x) => (status === 'open' ? ['requested', 'awaiting_payment'].includes(x.status) : status === 'paid' ? x.status === 'paid' : status === 'closed' ? ['declined', 'cancelled', 'refunded'].includes(x.status) : true))
      .map((x) => view(ctx, x))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const spaces = ctx.db.all('resources').filter((x) => x.kind === 'room' || x.kind === 'other').sort((a, b) => a.name.localeCompare(b.name)).map((x) => ({ resource: x, offer: offerOf(ctx, x.id) }));
    const paid = ctx.db.all('rentals').filter((x) => x.status === 'paid');
    return {
      rentals, spaces,
      summary: { open: ctx.db.all('rentals').filter((x) => x.status === 'requested').length, awaitingPayment: ctx.db.all('rentals').filter((x) => x.status === 'awaiting_payment').length, paidThisYear: paid.filter((x) => (x.paidAt ?? '').startsWith(String(ctx.now.getUTCFullYear()))).reduce((s, x) => s + x.amount, 0), depositsHeld: paid.reduce((s, x) => s + x.deposit, 0) },
      publicUrl: `${ctx.env.webUrl}/rent`,
    };
  });
  r.put('/admin/rentals/spaces/:id', { perm: EDIT }, (ctx) => {
    const res = find(ctx, 'resources', ctx.params[0], 'Resource');
    const cur = offerOf(ctx, res.id);
    const b = ctx.body;
    const next: RentalOffer = {
      id: res.id,
      enabled: b.enabled === undefined ? cur.enabled : !!b.enabled,
      ratePerHour: b.ratePerHour === undefined ? cur.ratePerHour : minor(b.ratePerHour),
      minHours: b.minHours === undefined ? cur.minHours : Math.max(1, Math.min(24, Math.round(Number(b.minHours)) || 1)),
      deposit: b.deposit === undefined ? cur.deposit : minor(b.deposit),
      blurb: b.blurb === undefined ? cur.blurb : clean(b.blurb, 300),
      terms: b.terms === undefined ? cur.terms : clean(b.terms, 2000),
      photoUrl: b.photoUrl === undefined ? cur.photoUrl : /^https?:\/\//.test(String(b.photoUrl ?? '')) ? clean(b.photoUrl, 500) : null,
    };
    if (next.enabled && next.ratePerHour <= 0) throw new ApiError(422, 'validation', 'Set an hourly rate before offering it for hire.', { ratePerHour: 'Required' });
    ctx.db.put('rentalOffers', next);
    ctx.audit('updated', 'rental-space', res.id, `${res.name} ${next.enabled ? `for hire at ${money(ctx, next.ratePerHour)}/hour` : 'no longer for hire'}`);
    return { resource: res, offer: next };
  });
  r.post('/admin/rentals/:id/approve', { perm: EDIT }, async (ctx) => {
    const x = find(ctx, 'rentals', ctx.params[0], 'Rental');
    if (x.status !== 'requested' && x.status !== 'awaiting_payment') throw new ApiError(409, 'closed', 'This request has already been decided.');
    const v = view(ctx, x);
    if (v.conflicts.length && !ctx.body.force) throw new ApiError(409, 'conflict', `${x.resourceName} is already booked for “${v.conflicts[0].title}” at that time.`);
    const amount = ctx.body.amount === undefined ? x.amount : minor(ctx.body.amount);
    const deposit = ctx.body.deposit === undefined ? x.deposit : minor(ctx.body.deposit);
    const next = ctx.db.put('rentals', { ...x, amount, deposit, status: 'awaiting_payment', decidedBy: ctx.staff?.name ?? 'office', decidedAt: ctx.now.toISOString(), notes: ctx.body.note ? `${x.notes ? `${x.notes}\n` : ''}${clean(ctx.body.note, 500)}` : x.notes });
    const nv = view(ctx, next);
    ctx.audit('approved', 'rental', x.id, `Approved ${x.resourceName} for ${x.renterName}, ${money(ctx, nv.total)} to pay`);
    await tellRenter(ctx, next, `${settings(ctx).name}: ${x.resourceName} is available`, `${x.resourceName} is available for ${when(x, ctx)}. The hire is ${money(ctx, amount)}${deposit ? ` plus a refundable deposit of ${money(ctx, deposit)}` : ''}, ${money(ctx, nv.total)} in all.\n\nPay here to confirm the booking: ${nv.payUrl}\n\nThe date is held for you for 3 days.`);
    return nv;
  });
  r.post('/admin/rentals/:id/decline', { perm: EDIT }, async (ctx) => {
    const x = find(ctx, 'rentals', ctx.params[0], 'Rental');
    if (x.status === 'paid') throw new ApiError(409, 'paid', 'It is paid. Refund it instead.');
    const note = clean(ctx.body.note, 500);
    const next = ctx.db.put('rentals', { ...x, status: 'declined', decidedBy: ctx.staff?.name ?? 'office', decidedAt: ctx.now.toISOString(), notes: note ? `${x.notes ? `${x.notes}\n` : ''}${note}` : x.notes });
    setBooking(ctx, next, 'declined', ctx.staff?.name ?? 'office');
    ctx.audit('declined', 'rental', x.id, `Declined ${x.resourceName} for ${x.renterName}${note ? `: ${note}` : ''}`);
    await tellRenter(ctx, next, `${settings(ctx).name}: ${x.resourceName} request`, `Sorry, we cannot offer ${x.resourceName} for ${when(x, ctx)}.${note ? `\n\n${note}` : ''}`);
    return view(ctx, next);
  });
  r.post('/admin/rentals/:id/paid', { perm: EDIT }, (ctx) => {
    // Paid offline: cash, bank transfer, cheque.
    const x = find(ctx, 'rentals', ctx.params[0], 'Rental');
    if (x.status === 'paid') throw new ApiError(409, 'paid', 'Already paid.');
    if (x.status === 'declined' || x.status === 'cancelled' || x.status === 'refunded') throw new ApiError(409, 'closed', 'This request is closed.');
    const fund = ensureRentalFund(ctx);
    const s = settings(ctx);
    const d = ctx.db.put('donations', {
      id: ctx.id('dn'), donorId: null, donorName: x.renterName, donorEmail: x.renterEmail || null, donorPhone: x.renterPhone || null, fundId: fund.id, fundName: `Hire: ${x.resourceName}`,
      amount: x.amount + x.deposit, currency: s.currency, frequency: 'once', status: 'succeeded', method: ['cash', 'bank_transfer', 'cheque', 'upi'].includes(ctx.body.via) ? ctx.body.via : 'cash', pan: null, donorCitizenship: 'IN', fcra: false,
      provider: 'offline', providerRef: clean(ctx.body.reference, 80) || null, providerPaymentId: null, createdAt: ctx.now.toISOString(), paidAt: ctx.now.toISOString(), eventId: null, receiptNumber: null, rentalId: x.id,
    });
    onRentalPaid(ctx, d);
    return view(ctx, ctx.db.get('rentals', x.id)!);
  });
  r.post('/admin/rentals/:id/refund', { perm: EDIT }, (ctx) => {
    const x = find(ctx, 'rentals', ctx.params[0], 'Rental');
    if (x.status !== 'paid') throw new ApiError(409, 'not_paid', 'Only a paid rental can be refunded.');
    const next = ctx.db.put('rentals', { ...x, status: 'refunded', notes: ctx.body.note ? `${x.notes ? `${x.notes}\n` : ''}${clean(ctx.body.note, 500)}` : x.notes });
    setBooking(ctx, next, 'cancelled', ctx.staff?.name ?? 'office');
    if (x.donationId) { const d = ctx.db.get('donations', x.donationId); if (d) ctx.db.put('donations', { ...d, status: 'refunded' }); }
    ctx.audit('refunded', 'rental', x.id, `Refunded ${x.renterName} for ${x.resourceName}; the slot is free again`);
    return view(ctx, next);
  });
  r.post('/admin/rentals/:id/notes', { perm: EDIT }, (ctx) => {
    const x = find(ctx, 'rentals', ctx.params[0], 'Rental');
    const text = clean(ctx.body.text, 500);
    if (!text) throw new ApiError(422, 'validation', 'Write the note.');
    return view(ctx, ctx.db.put('rentals', { ...x, notes: `${x.notes ? `${x.notes}\n` : ''}${text}` }));
  });

  // ----- public -----
  r.get('/public/rentals', { public: true }, (ctx) => ({ church: { name: settings(ctx).name, phone: settings(ctx).phone, email: settings(ctx).email }, spaces: spacesForHire(ctx) }));
  r.post('/public/rentals', { public: true }, async (ctx) => {
    const b = ctx.body;
    const space = spacesForHire(ctx).find((s) => s.id === String(b.resourceId ?? ''));
    if (!space) throw new ApiError(404, 'not_found', 'That space is not for hire.');
    const fields: Record<string, string> = {};
    const renterName = clean(b.name, 80); if (!renterName) fields.name = 'Required';
    const renterPhone = clean(b.phone, 20); if (renterPhone.replace(/\D/g, '').length < 10) fields.phone = 'A phone number we can reach you on';
    const renterEmail = clean(b.email, 120).toLowerCase(); if (renterEmail && !EMAIL_RE.test(renterEmail)) fields.email = 'Check the email address';
    const purpose = clean(b.purpose, 300); if (!purpose) fields.purpose = 'Tell us what the booking is for';
    const startsAt = new Date(String(b.startsAt ?? '')); const endsAt = new Date(String(b.endsAt ?? ''));
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) fields.startsAt = 'Pick the date and time';
    else if (startsAt.getTime() < ctx.now.getTime()) fields.startsAt = 'That is in the past';
    else if (hoursBetween(startsAt.toISOString(), endsAt.toISOString()) < space.minHours) fields.endsAt = `Minimum ${space.minHours} hours`;
    if (Object.keys(fields).length) throw new ApiError(422, 'validation', 'Please check the highlighted fields.', fields);
    const hours = hoursBetween(startsAt.toISOString(), endsAt.toISOString());
    const booking: Booking = { id: ctx.id('bk'), title: `Hire: ${renterName} (${purpose.slice(0, 40)})`, resourceIds: [space.id], startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), eventId: null, requestedBy: 'public', requestedByName: renterName, status: 'pending', notes: `Outside hire. ${purpose}`, setupMinutes: 0, createdAt: ctx.now.toISOString(), decidedBy: null, decidedAt: null, decisionNote: null };
    if (conflictsFor(ctx, booking).some((c) => c.status === 'approved')) throw new ApiError(409, 'taken', `${space.name} is already booked at that time. Try another day or time.`);
    ctx.db.put('bookings', booking);
    const x: Rental = {
      id: ctx.id('rt'), token: ctx.env.random(24, ALPHABET), resourceId: space.id, resourceName: space.name, renterName, renterPhone, renterEmail, organisation: clean(b.organisation, 120), purpose,
      guests: Math.max(0, Math.round(Number(b.guests)) || 0), startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), hours, ratePerHour: space.ratePerHour, amount: Math.round(space.ratePerHour * hours), deposit: space.deposit, currency: space.currency,
      status: 'requested', bookingId: booking.id, donationId: null, notes: '', source: 'public', createdAt: ctx.now.toISOString(), decidedBy: null, decidedAt: null, paidAt: null,
    };
    ctx.db.put('rentals', x);
    ctx.audit('requested', 'rental', x.id, `${renterName} asked for ${space.name} on ${when(x, ctx)}`);
    await notify(ctx, 'rental.new', { personIds: officeIds(ctx), title: `Hire request: ${space.name}`, body: `${renterName}${x.organisation ? ` (${x.organisation})` : ''} asks for ${space.name} on ${when(x, ctx)} for ${purpose}. ${money(ctx, x.amount)}${x.deposit ? ` + ${money(ctx, x.deposit)} deposit` : ''}. Approve it and they get a payment link.`, link: '/admin/rentals' });
    await tellRenter(ctx, x, `${settings(ctx).name}: we have your request`, `Thank you for asking about ${space.name} for ${when(x, ctx)}. The church office will confirm within a day or two and send you a link to pay ${money(ctx, x.amount)}${x.deposit ? ` plus a refundable deposit of ${money(ctx, x.deposit)}` : ''}.\n\nYou can follow it here: ${ctx.env.webUrl}/rent/pay/${x.token}`);
    return publicView(ctx, x);
  });
  r.get('/public/rentals/:token', { public: true }, (ctx) => publicView(ctx, byToken(ctx, ctx.params[0])));
  r.post('/public/rentals/:token/pay', { public: true }, async (ctx) => {
    const x = byToken(ctx, ctx.params[0]);
    if (x.status === 'paid') throw new ApiError(409, 'paid', 'This booking is already paid.');
    if (x.status !== 'awaiting_payment') throw new ApiError(409, 'not_ready', 'The church office has not approved this booking yet.');
    const fund = ensureRentalFund(ctx);
    const s = settings(ctx);
    const d: Collections['donations'] = {
      id: ctx.id('dn'), donorId: null, donorName: x.renterName, donorEmail: x.renterEmail || null, donorPhone: x.renterPhone || null, fundId: fund.id, fundName: `Hire: ${x.resourceName}`,
      amount: x.amount + x.deposit, currency: s.currency, frequency: 'once', status: 'pending', method: null, pan: null, donorCitizenship: 'IN', fcra: false,
      provider: 'demo', providerRef: null, providerPaymentId: null, createdAt: ctx.now.toISOString(), paidAt: null, eventId: null, receiptNumber: null, rentalId: x.id,
    };
    const co = await ctx.env.checkout(d, { description: `${x.resourceName} hire · ${s.name}`, fundTaxDeductible: false });
    const saved = ctx.db.put('donations', { ...d, providerRef: co.providerRef, provider: co.provider, status: co.status ?? 'pending', paidAt: co.status === 'succeeded' ? ctx.now.toISOString() : null, method: co.status === 'succeeded' ? 'upi' : null });
    ctx.db.put('rentals', { ...x, donationId: saved.id });
    if (saved.status === 'succeeded') onRentalPaid(ctx, saved);
    return { checkoutUrl: co.checkoutUrl, rental: publicView(ctx, ctx.db.get('rentals', x.id)!) };
  });
  r.post('/public/rentals/:token/cancel', { public: true }, async (ctx) => {
    const x = byToken(ctx, ctx.params[0]);
    if (x.status === 'paid') throw new ApiError(409, 'paid', 'It is paid; please call the church office to cancel.');
    if (x.status === 'requested' || x.status === 'awaiting_payment') {
      const next = ctx.db.put('rentals', { ...x, status: 'cancelled' });
      setBooking(ctx, next, 'cancelled', 'Renter');
      ctx.audit('cancelled', 'rental', x.id, `${x.renterName} withdrew the request for ${x.resourceName}`);
      await notify(ctx, 'rental.new', { personIds: officeIds(ctx), title: `Hire request withdrawn: ${x.resourceName}`, body: `${x.renterName} no longer needs ${x.resourceName} on ${when(x, ctx)}.`, link: '/admin/rentals' });
    }
    return publicView(ctx, ctx.db.get('rentals', x.id)!);
  });

  function byToken(ctx: Ctx, token: string): Rental {
    const x = ctx.db.all('rentals').find((r) => r.token === token);
    if (!x) throw new ApiError(404, 'not_found', 'We could not find that booking. Check the link, or call the church office.');
    return x;
  }
  function publicView(ctx: Ctx, x: Rental): PublicRental {
    const s = settings(ctx);
    return { id: x.id, token: x.token, church: { name: s.name, phone: s.phone, email: s.email }, resourceName: x.resourceName, renterName: x.renterName, purpose: x.purpose, startsAt: x.startsAt, endsAt: x.endsAt, hours: x.hours, amount: x.amount, deposit: x.deposit, total: x.amount + x.deposit, currency: x.currency, status: x.status as RentalStatus, paidAt: x.paidAt };
  }
}
