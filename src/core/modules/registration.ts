// Online registration: a public link (and QR code for the notice board or the screen) where a family
// fills in their own details, everyone in the house at once. Nothing reaches People until the
// office looks at it: the list warns when the phone, email or name is already in People, and one tap
// approves the family into People as a household (or declines it).
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import { permsOf } from '../perms.js';
import { checkLimit } from '../plans.js';
import type { Collections, PublicRegistrationForm, Registration, RegistrationMatch, RegistrationMember, RegistrationRelation, RegistrationSettings, RegistrationView, RegistrationsHub } from '../types.js';
import { find, fullName, newPerson, normEmail, normPhone, settings } from '../util.js';
import { notify } from './notify.js';
import { activePeople } from './people.js';
import { logConsent, privacySettings } from './privacy.js';

const META = 'registration:settings';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RELATIONS: RegistrationRelation[] = ['head', 'spouse', 'child', 'parent', 'other'];
const MAX_MEMBERS = 12;
const clean = (v: unknown, max: number) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

export function registrationSettings(ctx: Pick<Ctx, 'db'>): RegistrationSettings {
  const base: RegistrationSettings = { enabled: true, intro: '', askBaptism: true, askPreviousChurch: true, askHowHeard: true, defaultStatus: 'regular', tag: 'Registered online' };
  const raw = ctx.db.get('meta', META)?.value;
  return raw ? { ...base, ...(JSON.parse(raw) as Partial<RegistrationSettings>) } : base;
}

function readSettings(b: Record<string, unknown>, prev: RegistrationSettings): RegistrationSettings {
  const status = ['visitor', 'regular', 'member'].includes(String(b.defaultStatus)) ? (b.defaultStatus as RegistrationSettings['defaultStatus']) : prev.defaultStatus;
  return {
    enabled: b.enabled !== undefined ? !!b.enabled : prev.enabled,
    intro: b.intro !== undefined ? String(b.intro ?? '').trim().slice(0, 600) : prev.intro,
    askBaptism: b.askBaptism !== undefined ? !!b.askBaptism : prev.askBaptism,
    askPreviousChurch: b.askPreviousChurch !== undefined ? !!b.askPreviousChurch : prev.askPreviousChurch,
    askHowHeard: b.askHowHeard !== undefined ? !!b.askHowHeard : prev.askHowHeard,
    defaultStatus: status,
    tag: b.tag !== undefined ? clean(b.tag, 40) : prev.tag,
  };
}

function readMember(v: Record<string, unknown>, i: number, fields: Record<string, string>, today: string): RegistrationMember {
  const firstName = clean(v.firstName, 60);
  const lastName = clean(v.lastName, 60);
  if (!firstName) fields[`members.${i}.firstName`] = 'Required';
  if (!lastName) fields[`members.${i}.lastName`] = 'Required';
  const birthDate = DATE_RE.test(String(v.birthDate ?? '')) ? String(v.birthDate) : null;
  if (birthDate && birthDate > today) fields[`members.${i}.birthDate`] = 'That is in the future';
  const email = clean(v.email, 120).toLowerCase();
  if (email && !EMAIL_RE.test(email)) fields[`members.${i}.email`] = 'Check the email address';
  return {
    firstName, lastName, birthDate,
    gender: v.gender === 'male' || v.gender === 'female' ? v.gender : null,
    relation: RELATIONS.includes(v.relation as RegistrationRelation) ? (v.relation as RegistrationRelation) : i === 0 ? 'head' : 'other',
    phone: clean(v.phone, 20) || null,
    email: email || null,
    baptised: !!v.baptised,
  };
}

/** People already in the church who look like someone on the form. */
function matchesFor(ctx: Ctx, x: Registration): RegistrationMatch[] {
  const out = new Map<string, RegistrationMatch>();
  const people = ctx.db.all('people');
  const phones = new Set([x.phone, ...x.members.map((m) => m.phone)].map((p) => normPhone(p)).filter((p) => p.length === 10));
  const emails = new Set([x.email, ...x.members.map((m) => m.email)].map((e) => normEmail(e)).filter(Boolean));
  const names = new Set(x.members.map((m) => `${m.firstName} ${m.lastName}`.toLowerCase()));
  for (const p of people) {
    if (x.personIds.includes(p.id)) continue;
    const why: RegistrationMatch['why'] | null = phones.has(normPhone(p.phone)) ? 'phone' : emails.has(normEmail(p.email)) ? 'email' : names.has(`${p.firstName} ${p.lastName}`.toLowerCase()) ? 'name' : null;
    if (why && !out.has(p.id)) out.set(p.id, { personId: p.id, name: fullName(p), why });
  }
  return [...out.values()].slice(0, 10);
}
const view = (ctx: Ctx, x: Registration): RegistrationView => ({ ...x, matches: x.status === 'pending' ? matchesFor(ctx, x) : [] });

function officeIds(ctx: Ctx): string[] {
  const out = new Set<string>();
  for (const s of ctx.db.all('staff')) {
    if (s.status !== 'active' || !permsOf(ctx.db, s).includes('people.edit')) continue;
    const p = (s.personId && ctx.db.get('people', s.personId)) || ctx.db.all('people').find((x) => normEmail(x.email) === normEmail(s.email));
    if (p) out.add(p.id);
  }
  return [...out];
}

function approve(ctx: Ctx, x: Registration, b: Record<string, unknown>): Registration {
  const cfg = registrationSettings(ctx);
  const status: Collections['people']['status'] = ['visitor', 'regular', 'member'].includes(String(b.status)) ? (b.status as Collections['people']['status']) : x.wantsMembership ? 'member' : cfg.defaultStatus;
  // Members the office says are already in People are linked, not created again.
  const link = (typeof b.link === 'object' && b.link ? b.link : {}) as Record<string, string>;
  const creating = x.members.filter((_, i) => !link[i] || !ctx.db.get('people', link[i]!)).length;
  checkLimit(ctx.db, ctx.now, 'people', activePeople(ctx.db), creating);
  const householdName = x.members.length > 1 ? x.householdName || `${x.members[0]!.lastName} family` : null;
  const tags = cfg.tag ? [cfg.tag] : [];
  const consent = { email: x.consent.email, sms: x.consent.whatsapp, whatsapp: x.consent.whatsapp, directory: x.consent.directory };
  const personIds: string[] = [];
  x.members.forEach((m, i) => {
    const existing = link[i] ? ctx.db.get('people', link[i]!) : null;
    const adult = m.relation === 'head' || m.relation === 'spouse' || m.relation === 'parent';
    const phone = m.phone ?? (adult ? x.phone || null : null);
    const email = m.email ?? (m.relation === 'head' ? x.email || null : null);
    if (existing) {
      const next = {
        ...existing,
        phone: existing.phone ?? phone, email: existing.email ?? email, birthDate: existing.birthDate ?? m.birthDate, gender: existing.gender ?? m.gender,
        address: existing.address ?? (x.address || null), householdName: existing.householdName ?? householdName,
        tags: [...new Set([...existing.tags, ...tags])],
      };
      ctx.db.put('people', next);
      personIds.push(existing.id);
      return;
    }
    const p = ctx.db.put('people', newPerson(ctx, {
      firstName: m.firstName, lastName: m.lastName, gender: m.gender, birthDate: m.birthDate, phone, email,
      address: [x.address, x.area].filter(Boolean).join(', ') || null, householdName, status, tags, consent,
      notes: [x.previousChurch && `Previous church: ${x.previousChurch}`, m.baptised && 'Says they are baptised', x.howHeard && `Heard about us: ${x.howHeard}`, x.note].filter(Boolean).join('\n') || null,
    }));
    logConsent(ctx, p.id, null, p.consent, 'form');
    personIds.push(p.id);
  });
  const next = ctx.db.put('registrations', { ...x, status: 'approved', personIds, decidedAt: ctx.now.toISOString(), decidedBy: ctx.staff?.name ?? 'Office', decisionNote: clean(b.note, 300) });
  ctx.audit('approved', 'registration', x.id, `${x.householdName} (${x.members.length})`);
  return next;
}

export function registerRegistration(r: Router) {
  // ----- public -----
  r.get('/public/registration', { public: true }, (ctx): PublicRegistrationForm => {
    const s = settings(ctx);
    const cfg = registrationSettings(ctx);
    return {
      church: { name: s.name, logoUrl: s.logoUrl ?? null }, enabled: cfg.enabled,
      intro: cfg.intro || `Welcome to ${s.name}! Tell us about you and your family so we can get to know you and keep in touch.`,
      askBaptism: cfg.askBaptism, askPreviousChurch: cfg.askPreviousChurch, askHowHeard: cfg.askHowHeard,
      privacyNotice: privacySettings(ctx).notice,
    };
  });

  r.post('/public/registration', { public: true }, async (ctx) => {
    const b = ctx.body as Record<string, unknown>;
    if (!registrationSettings(ctx).enabled) throw new ApiError(403, 'closed', 'Online registration is closed. Please speak to the church office.');
    // Bots fill in every field; people never see this one.
    if (clean(b.website, 200)) return { ok: true };
    const today = ctx.now.toISOString().slice(0, 10);
    const fields: Record<string, string> = {};
    const raw = Array.isArray(b.members) ? (b.members as Record<string, unknown>[]) : [];
    if (!raw.length) throw new ApiError(422, 'validation', 'Add at least one person.', { members: 'Required' });
    if (raw.length > MAX_MEMBERS) throw new ApiError(422, 'validation', `Up to ${MAX_MEMBERS} people on one form.`);
    const members = raw.map((m, i) => readMember(m ?? {}, i, fields, today));
    const phone = clean(b.phone, 20);
    const email = clean(b.email, 120).toLowerCase();
    if (phone && phone.replace(/\D/g, '').length < 10) fields.phone = 'A 10-digit mobile number';
    if (email && !EMAIL_RE.test(email)) fields.email = 'Check the email address';
    if (!phone && !email) fields.phone = 'A phone number or email so we can reach you';
    if (!b.agree) fields.agree = 'Please tick to agree';
    if (Object.keys(fields).length) throw new ApiError(422, 'validation', 'Please check the highlighted fields.', fields);
    const consent = (typeof b.consent === 'object' && b.consent ? b.consent : {}) as Record<string, unknown>;
    const x: Registration = {
      id: ctx.id('rg'), status: 'pending',
      householdName: clean(b.householdName, 80) || `${members[0]!.lastName} family`,
      address: clean(b.address, 300), area: clean(b.area, 80), phone, email,
      previousChurch: clean(b.previousChurch, 120), howHeard: clean(b.howHeard, 120), note: clean(b.note, 600),
      members, wantsMembership: !!b.wantsMembership,
      consent: { whatsapp: consent.whatsapp !== false, email: consent.email !== false, directory: !!consent.directory },
      createdAt: ctx.now.toISOString(), decidedAt: null, decidedBy: null, decisionNote: '', personIds: [],
    };
    ctx.db.put('registrations', x);
    ctx.audit('submitted', 'registration', x.id, `${x.householdName} (${members.length})`);
    await notify(ctx, 'registration.new', { personIds: officeIds(ctx), title: `New registration: ${x.householdName}`, body: `${members.map((m) => m.firstName).join(', ')} registered online${x.area ? ` from ${x.area}` : ''}. Check and approve them into People.`, link: '/admin/registrations' });
    return { ok: true, householdName: x.householdName, count: members.length };
  });

  // ----- office -----
  r.get('/admin/registrations', { perm: 'people.view' }, (ctx): RegistrationsHub => {
    const all = ctx.db.all('registrations').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      settings: registrationSettings(ctx),
      publicUrl: `${ctx.env.webUrl}/register`,
      pending: all.filter((x) => x.status === 'pending').map((x) => view(ctx, x)),
      recent: all.filter((x) => x.status !== 'pending').slice(0, 30).map((x) => view(ctx, x)),
    };
  });
  r.put('/admin/registration-settings', { perm: 'people.edit' }, (ctx) => {
    const next = readSettings(ctx.body as Record<string, unknown>, registrationSettings(ctx));
    ctx.db.put('meta', { id: META, value: JSON.stringify(next) });
    return next;
  });
  r.post('/admin/registrations/:id/approve', { perm: 'people.edit' }, (ctx) => {
    const x = find(ctx, 'registrations', ctx.params[0], 'Registration');
    if (x.status !== 'pending') throw new ApiError(409, 'decided', 'This registration was already handled.');
    return view(ctx, approve(ctx, x, ctx.body as Record<string, unknown>));
  });
  r.post('/admin/registrations/:id/decline', { perm: 'people.edit' }, (ctx) => {
    const x = find(ctx, 'registrations', ctx.params[0], 'Registration');
    if (x.status !== 'pending') throw new ApiError(409, 'decided', 'This registration was already handled.');
    ctx.audit('declined', 'registration', x.id, x.householdName);
    return view(ctx, ctx.db.put('registrations', { ...x, status: 'declined', decidedAt: ctx.now.toISOString(), decidedBy: ctx.staff?.name ?? 'Office', decisionNote: clean((ctx.body as Record<string, unknown>).note, 300) }));
  });
  r.del('/admin/registrations/:id', { perm: 'people.edit' }, (ctx) => {
    const x = find(ctx, 'registrations', ctx.params[0], 'Registration');
    ctx.db.del('registrations', x.id);
    ctx.audit('deleted', 'registration', x.id, x.householdName);
    return { ok: true };
  });
}
