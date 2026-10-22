// The team mobile app: volunteers only, no members or guests. The church office creates each
// login and the person gets a temporary password by email; at sign-in they pick the team they
// are on, and the app then shows only that person's own assignments.
import { ApiError } from '../errors.js';
import type { Ctx, Router } from '../engine.js';
import type { Collections, Permission, Session, TeamLoginView } from '../types.js';
import { find, normEmail, requireFields, settings } from '../util.js';
import { issueSession } from './auth.js';

const MAX_FAILURES = 5;
const LOCK_MIN = 15;
const RESET_TTL_MIN = 15;
const MIN_PASSWORD = 8;
const TEMP_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Login = Collections['teamLogins'];

const invalid = () => new ApiError(401, 'invalid_credentials', 'That email or password is not right.');

function teamsOf(ctx: Ctx, personId: string) {
  return ctx.db.all('teams').filter((t) => t.members.some((m) => m.personId === personId)).sort((x, y) => x.name.localeCompare(y.name));
}

function loginByEmail(ctx: Ctx, email: string) {
  return ctx.db.all('teamLogins').find((l) => l.email === email);
}

function view(ctx: Ctx, l: Login): TeamLoginView {
  const p = ctx.db.get('people', l.personId);
  return {
    personId: l.personId,
    name: p ? `${p.firstName} ${p.lastName}`.trim() : 'Removed person',
    email: l.email,
    teams: teamsOf(ctx, l.personId).map((t) => ({ id: t.id, name: t.name })),
    mustChangePassword: l.mustChangePassword,
    disabled: l.disabled,
    createdAt: l.createdAt,
    lastSignInAt: l.lastSignInAt,
  };
}

function checkPassword(pw: unknown) {
  const s = String(pw ?? '');
  if (s.length < MIN_PASSWORD) throw new ApiError(422, 'weak_password', `Use at least ${MIN_PASSWORD} characters.`, { newPassword: `At least ${MIN_PASSWORD} characters` });
  return s;
}

/** Signs the person into one of their teams; the team is checked, the token scope stays 'member'. */
function signInToTeam(ctx: Ctx, l: Login, teamId: string): Session & { team: { id: string; name: string }; mustChangePassword: boolean } {
  const person = ctx.db.get('people', l.personId);
  if (!person) throw invalid();
  const team = teamsOf(ctx, person.id).find((t) => t.id === teamId);
  if (!team) throw new ApiError(403, 'not_on_team', 'You are not on that team. Ask the church office to add you.');
  ctx.db.put('teamLogins', { ...l, failedAt: [], lastSignInAt: ctx.now.toISOString() });
  return { ...issueSession(ctx, person, null, 'member'), team: { id: team.id, name: team.name }, mustChangePassword: l.mustChangePassword };
}

async function emailTempPassword(ctx: Ctx, l: Login, password: string, first: boolean) {
  const p = ctx.db.get('people', l.personId)!;
  const name = settings(ctx).name;
  await ctx.env.deliver('email', [{
    to: l.email,
    name: `${p.firstName} ${p.lastName}`.trim(),
    subject: first ? `Your ${name} team app login` : `Your new ${name} team app password`,
    text: `Hi ${p.firstName},\n\n${first ? `You can now sign in to the ${name} team app.` : `The church office reset your ${name} team app password.`}\n\nEmail: ${l.email}\nTemporary password: ${password}\n\nSign in, pick your team, and you will be asked to choose your own password.\n\n${name}`,
  }]);
}

export function registerTeamAuth(r: Router) {
  // ----- the app -----
  r.get('/team/teams', { public: true }, (ctx) => ctx.db.all('teams').sort((x, y) => x.name.localeCompare(y.name)).map((t) => ({ id: t.id, name: t.name, color: t.color })));

  r.post('/auth/team/sign-in', { public: true }, (ctx) => {
    requireFields(ctx.body, ['email', 'password', 'teamId']);
    const email = normEmail(String(ctx.body.email));
    const l = loginByEmail(ctx, email);
    // Same answer for an unknown email and a wrong password, so emails cannot be guessed.
    if (!l) throw invalid();
    if (l.disabled) throw new ApiError(403, 'login_disabled', 'This login was switched off. Ask the church office.');
    const since = ctx.now.getTime() - LOCK_MIN * 60_000;
    const recent = l.failedAt.filter((t) => new Date(t).getTime() > since);
    if (recent.length >= MAX_FAILURES) throw new ApiError(429, 'too_many_attempts', `Too many wrong passwords. Try again in ${LOCK_MIN} minutes.`);
    if (!ctx.env.verifyPassword(String(ctx.body.password), l.passwordHash)) {
      ctx.db.put('teamLogins', { ...l, failedAt: [...recent, ctx.now.toISOString()] });
      throw invalid();
    }
    return signInToTeam(ctx, l, String(ctx.body.teamId));
  });

  r.post('/auth/team/password', {}, (ctx) => {
    requireFields(ctx.body, ['currentPassword', 'newPassword']);
    const l = ctx.db.get('teamLogins', ctx.me());
    if (!l || l.disabled) throw new ApiError(403, 'no_team_login', 'This account has no team app login.');
    if (!ctx.env.verifyPassword(String(ctx.body.currentPassword), l.passwordHash)) throw new ApiError(422, 'wrong_password', 'Your current password is not right.', { currentPassword: 'Not right' });
    const pw = checkPassword(ctx.body.newPassword);
    ctx.db.put('teamLogins', { ...l, passwordHash: ctx.env.hashPassword(pw), mustChangePassword: false, failedAt: [] });
    return undefined;
  });

  r.post('/auth/team/forgot', { public: true }, async (ctx) => {
    const email = normEmail(String(ctx.body?.email ?? ''));
    const l = EMAIL_RE.test(email) ? loginByEmail(ctx, email) : undefined;
    // Always "sent", so the reply does not say whether the email has a login.
    if (!l || l.disabled) return { sent: true };
    const code = ctx.env.demo ? '123456' : ctx.env.random(6, '0123456789');
    ctx.db.put('teamLogins', { ...l, resetCodeHash: ctx.env.hash(`${l.id}:${code}`), resetExpiresAt: new Date(ctx.now.getTime() + RESET_TTL_MIN * 60_000).toISOString(), resetAttempts: 0 });
    const p = ctx.db.get('people', l.personId);
    await ctx.env.deliver('email', [{ to: l.email, name: p ? `${p.firstName} ${p.lastName}`.trim() : '', subject: `${settings(ctx).name} team app: reset code ${code}`, text: `Your reset code is ${code}. It works for ${RESET_TTL_MIN} minutes.\n\nIf you did not ask for this, you can ignore this email.` }]);
    return { sent: true };
  });

  r.post('/auth/team/reset', { public: true }, (ctx) => {
    requireFields(ctx.body, ['email', 'code', 'newPassword', 'teamId']);
    const l = loginByEmail(ctx, normEmail(String(ctx.body.email)));
    if (!l || l.disabled || !l.resetCodeHash || !l.resetExpiresAt || l.resetExpiresAt < ctx.now.toISOString()) throw new ApiError(422, 'invalid_code', 'That code is not right or has expired. Ask for a new one.');
    if (l.resetAttempts >= MAX_FAILURES) throw new ApiError(429, 'too_many_attempts', 'Too many wrong codes. Ask for a new one.');
    if (ctx.env.hash(`${l.id}:${String(ctx.body.code).trim()}`) !== l.resetCodeHash) {
      ctx.db.put('teamLogins', { ...l, resetAttempts: l.resetAttempts + 1 });
      throw new ApiError(422, 'invalid_code', 'That code is not right. Please check the email and try again.');
    }
    const pw = checkPassword(ctx.body.newPassword);
    const next: Login = { ...l, passwordHash: ctx.env.hashPassword(pw), mustChangePassword: false, failedAt: [], resetCodeHash: null, resetExpiresAt: null, resetAttempts: 0 };
    ctx.db.put('teamLogins', next);
    return signInToTeam(ctx, next, String(ctx.body.teamId));
  });

  // ----- the office -----
  const perm: { perm: Permission[] } = { perm: ['volunteers', 'staff'] };
  r.get('/admin/team-logins', perm, (ctx) => ctx.db.all('teamLogins').map((l) => view(ctx, l)).sort((x, y) => x.name.localeCompare(y.name)));

  r.post('/admin/team-logins', perm, async (ctx) => {
    requireFields(ctx.body, ['personId']);
    const p = find(ctx, 'people', String(ctx.body.personId), 'Person');
    const email = normEmail(p.email);
    if (!EMAIL_RE.test(email)) throw new ApiError(422, 'email_required', `${p.firstName} has no email address. Add one to their record first.`, { personId: 'Needs an email' });
    if (!teamsOf(ctx, p.id).length) throw new ApiError(422, 'not_on_team', `${p.firstName} is not on any team yet. Add them to a team first.`, { personId: 'Not on a team' });
    if (ctx.db.all('teamLogins').some((l) => l.email === email && l.personId !== p.id)) throw new ApiError(409, 'email_taken', 'Another person already uses this email for the team app.');
    const existing = ctx.db.get('teamLogins', p.id);
    if (existing && !existing.disabled) throw new ApiError(409, 'already_exists', `${p.firstName} already has a login. Reset the password instead.`);
    const password = ctx.env.random(12, TEMP_ALPHABET);
    const l: Login = { id: p.id, personId: p.id, email, passwordHash: ctx.env.hashPassword(password), mustChangePassword: true, disabled: false, createdAt: ctx.now.toISOString(), lastSignInAt: null, failedAt: [], resetCodeHash: null, resetExpiresAt: null, resetAttempts: 0 };
    ctx.db.put('teamLogins', l);
    await emailTempPassword(ctx, l, password, true);
    ctx.audit('created', 'teamLogin', p.id, `Sent team app login to ${p.firstName} ${p.lastName}`);
    return view(ctx, l);
  });

  r.post('/admin/team-logins/:personId/reset', perm, async (ctx) => {
    const l = find(ctx, 'teamLogins', ctx.params[0], 'Login');
    const p = find(ctx, 'people', l.personId, 'Person');
    const password = ctx.env.random(12, TEMP_ALPHABET);
    const next: Login = { ...l, email: normEmail(p.email) || l.email, passwordHash: ctx.env.hashPassword(password), mustChangePassword: true, disabled: false, failedAt: [], resetCodeHash: null, resetExpiresAt: null, resetAttempts: 0 };
    ctx.db.put('teamLogins', next);
    await emailTempPassword(ctx, next, password, false);
    ctx.audit('updated', 'teamLogin', l.id, `Reset the team app password for ${p.firstName} ${p.lastName}`);
    return view(ctx, next);
  });

  r.del('/admin/team-logins/:personId', perm, (ctx) => {
    const l = find(ctx, 'teamLogins', ctx.params[0], 'Login');
    ctx.db.put('teamLogins', { ...l, disabled: true });
    // Their phone sessions stop at the next refresh.
    for (const t of ctx.db.all('refreshTokens')) if (t.personId === l.personId && t.scope === 'member') ctx.db.put('refreshTokens', { ...t, revoked: true });
    ctx.audit('deleted', 'teamLogin', l.id, 'Switched off a team app login');
    return undefined;
  });
}
