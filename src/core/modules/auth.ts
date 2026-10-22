// Passwordless sign-in with a one-time code sent by email (email only, by decision; the team
// mobile app is the one exception and lives in team-auth.ts).
// Staff sign in to the church office with the email their admin invited; members sign in
// with the email on their church record, and newcomers are added as visitors.
import { ApiError } from '../errors.js';
import type { Ctx, Router } from '../engine.js';
import { permsOf, ROLE_LABELS, scopeOf } from '../perms.js';
import type { Collections, Session } from '../types.js';
import { church, DAY, memberProfile, newPerson, normEmail, settings } from '../util.js';
import { notify, pastorIds } from './notify.js';

const OTP_TTL_MIN = 10;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 5;
const ACCESS_REFRESH_DAYS = 60;
export const DEMO_CODE = '123456';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function issueSession(ctx: Ctx, person: Collections['people'], staff: Collections['staff'] | null, scope: 'admin' | 'member'): Session {
  const raw = ctx.env.random(48, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  const rec: Collections['refreshTokens'] = {
    id: ctx.id('rt'),
    tokenHash: ctx.env.hash(raw),
    personId: person.id,
    staffId: staff?.id ?? null,
    scope,
    createdAt: ctx.now.toISOString(),
    expiresAt: new Date(ctx.now.getTime() + ACCESS_REFRESH_DAYS * DAY).toISOString(),
    revoked: false,
  };
  ctx.db.put('refreshTokens', rec);
  const access = ctx.env.signAccess({ sub: person.id, staffId: staff?.id ?? null, scope });
  return {
    accessToken: access.token,
    refreshToken: `${rec.id}.${raw}`,
    expiresAt: access.expiresAt,
    member: memberProfile(person),
    church: church(ctx),
    staff: scope === 'admin' && staff ? { role: staff.role, permissions: permsOf(ctx.db, staff), roleName: staff.role === 'custom' ? ctx.db.get('roles', staff.roleId ?? '')?.name ?? 'Custom role' : ROLE_LABELS[staff.role], scope: (() => { const sc = scopeOf(ctx.db, staff); return sc ? { kind: sc.kind, ids: sc.ids } : null; })() } : null,
  };
}

function findPersonByEmail(ctx: Ctx, email: string) {
  return ctx.db.all('people').find((p) => normEmail(p.email) === email);
}

function findStaffByEmail(ctx: Ctx, email: string) {
  return ctx.db.all('staff').find((s) => normEmail(s.email) === email);
}

/** Links a staff login to a person record, creating one if needed. */
function personForStaff(ctx: Ctx, staff: Collections['staff']) {
  let person = ctx.db.get('people', staff.personId) ?? findPersonByEmail(ctx, normEmail(staff.email));
  if (!person) {
    const [firstName, ...rest] = staff.name.split(' ');
    person = ctx.db.put('people', newPerson(ctx, { firstName, lastName: rest.join(' '), email: staff.email, phone: staff.phone, status: 'member' }));
  }
  if (staff.personId !== person.id || staff.status !== 'active') {
    ctx.db.put('staff', { ...staff, personId: person.id, status: 'active', lastActiveAt: ctx.now.toISOString() });
  }
  return person;
}

export function registerAuth(r: Router) {
  r.post('/auth/otp/request', { public: true }, async (ctx) => {
    const raw = String(ctx.body.email ?? ctx.body.identifier ?? '');
    const email = normEmail(raw);
    if (!email) throw new ApiError(422, 'invalid', 'Enter your email address.', { email: 'Required' });
    if (!EMAIL_RE.test(email)) throw new ApiError(422, 'email_required', 'Sign in with your email address. We send the code by email.', { email: 'Enter a valid email address' });
    const audience = ctx.body.audience === 'admin' ? 'admin' : 'member';

    if (audience === 'admin' && !findStaffByEmail(ctx, email) && !ctx.env.demo)
      throw new ApiError(404, 'not_staff', 'This email is not on the church office team. Ask your church admin to invite you.');

    const hourAgo = new Date(ctx.now.getTime() - 3600_000).toISOString();
    const recent = ctx.db.all('otps').filter((o) => o.email === email && o.createdAt > hourAgo);
    if (recent.length >= MAX_CODES_PER_HOUR && !ctx.env.demo) throw new ApiError(429, 'too_many_codes', 'Too many codes requested. Please wait a few minutes and try again.');

    // Tidy up expired codes so the table stays small.
    for (const o of ctx.db.all('otps')) if (o.expiresAt < hourAgo) ctx.db.del('otps', o.id);

    const code = ctx.env.demo ? DEMO_CODE : ctx.env.random(6, '0123456789');
    const rec = ctx.db.put('otps', {
      id: ctx.id('otp'),
      email,
      codeHash: ctx.env.hash(`${email}:${code}`),
      audience,
      createdAt: ctx.now.toISOString(),
      expiresAt: new Date(ctx.now.getTime() + OTP_TTL_MIN * 60_000).toISOString(),
      attempts: 0,
      used: false,
    });
    if (!ctx.env.demo) await ctx.env.sendOtpEmail(email, code, settings(ctx).name);
    return { requestId: rec.id, channel: 'email', expiresInSeconds: OTP_TTL_MIN * 60 };
  });

  r.post('/auth/otp/verify', { public: true }, (ctx) => {
    const otp = ctx.db.get('otps', String(ctx.body.requestId ?? ''));
    const code = String(ctx.body.code ?? '').trim();
    if (!otp || otp.used || otp.expiresAt < ctx.now.toISOString()) throw new ApiError(422, 'code_expired', 'This code has expired. Please request a new one.');
    if (otp.attempts >= MAX_ATTEMPTS) throw new ApiError(429, 'too_many_attempts', 'Too many wrong codes. Please request a new one.');
    if (ctx.env.hash(`${otp.email}:${code}`) !== otp.codeHash) {
      ctx.db.put('otps', { ...otp, attempts: otp.attempts + 1 });
      throw new ApiError(422, 'invalid_code', ctx.env.demo ? `That code is not right. In demo mode use ${DEMO_CODE}.` : 'That code is not right. Please check the email and try again.');
    }
    ctx.db.put('otps', { ...otp, used: true });

    if (otp.audience === 'admin') {
      let staff = findStaffByEmail(ctx, otp.email);
      // Demo: any email signs in as the church owner.
      if (!staff && ctx.env.demo) staff = ctx.db.all('staff').find((s) => s.role === 'owner');
      if (!staff) throw new ApiError(404, 'not_staff', 'This email is not on the church office team.');
      const person = personForStaff(ctx, staff);
      ctx.audit('signed_in', 'staff', staff.id, `${staff.name} signed in to the church office`);
      return issueSession(ctx, person, ctx.db.get('staff', staff.id)!, 'admin');
    }

    let person = findPersonByEmail(ctx, otp.email);
    if (!person && ctx.env.demo) person = ctx.db.get('people', ctx.db.get('meta', 'demoMember')?.value ?? '');
    if (!person) {
      // A newcomer: add them as a visitor so they can use the app right away.
      const local = otp.email.split('@')[0].replace(/[._-]+/g, ' ').trim();
      const firstName = local ? local[0].toUpperCase() + local.slice(1) : 'Friend';
      person = ctx.db.put('people', newPerson(ctx, { firstName, lastName: '', email: otp.email, status: 'visitor', tags: ['Signed up in app'] }));
      void notify(ctx, 'visitor.new', { personIds: pastorIds(ctx), title: `New visitor: ${firstName}`, body: `${otp.email} just signed up in the app. Say hello and add them to a follow-up.`, link: `/admin/people/${person.id}` });
    }
    return issueSession(ctx, person, null, 'member');
  });

  r.post('/auth/refresh', { public: true }, (ctx) => {
    const [id, raw] = String(ctx.body.refreshToken ?? '').split('.');
    const rec = ctx.db.get('refreshTokens', id);
    if (!rec || rec.revoked || rec.expiresAt < ctx.now.toISOString() || rec.tokenHash !== ctx.env.hash(raw ?? '')) throw new ApiError(401, 'unauthorized', 'Please sign in again.');
    const person = ctx.db.get('people', rec.personId);
    const staff = rec.staffId ? ctx.db.get('staff', rec.staffId) : null;
    if (!person || (rec.scope === 'admin' && (!staff || staff.status !== 'active'))) throw new ApiError(401, 'unauthorized', 'Please sign in again.');
    // Rotate: the old refresh token stops working.
    ctx.db.put('refreshTokens', { ...rec, revoked: true });
    return issueSession(ctx, person, staff ?? null, rec.scope);
  });

  r.post('/auth/sign-out', { public: true }, (ctx) => {
    const [id] = String(ctx.body.refreshToken ?? '').split('.');
    const rec = ctx.db.get('refreshTokens', id);
    if (rec) ctx.db.put('refreshTokens', { ...rec, revoked: true });
    return undefined;
  });
}
