// Bearer-token auth. Tokens are HS256 JWTs signed with JWT_SECRET. The OTP sign-in endpoints
// (docs/API.md, /auth/*) will issue them; until then use `npm run token` to mint one for testing.
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { MiddlewareHandler } from 'hono';

import { config } from './config.js';
import { ApiError } from './errors.js';

export type Claims = {
  sub: string; // member id
  church: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  staffRole?: 'owner' | 'admin' | 'pastor' | 'finance' | 'leader' | null;
  exp: number; // seconds since epoch
};

export type AuthEnv = { Variables: { user: Claims } };

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signToken(claims: Omit<Claims, 'exp'>, ttlSeconds = 3600) {
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const sig = b64(createHmac('sha256', config.jwtSecret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

export function verifyToken(token: string): Claims | null {
  const [header, body, sig] = token.split('.');
  if (!header || !body || !sig || !config.jwtSecret) return null;
  const expected = createHmac('sha256', config.jwtSecret).update(`${header}.${body}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as Claims;
    return claims.exp * 1000 > Date.now() ? claims : null;
  } catch {
    return null;
  }
}

const DEV_USER: Claims = { sub: 'p_priya', church: config.church.id, name: 'Priya Thomas', email: 'priya@example.com', phone: '+919876543210', staffRole: 'owner', exp: 0 };

export const requireMember: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const claims = token ? verifyToken(token) : config.devAuth ? DEV_USER : null;
  if (!claims) throw new ApiError(401, 'unauthorized', 'Please sign in again.');
  if (claims.church !== config.church.id) throw new ApiError(403, 'wrong_church', 'This account belongs to a different church.');
  c.set('user', claims);
  await next();
};

export function requireStaff(...roles: NonNullable<Claims['staffRole']>[]): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const role = c.get('user').staffRole;
    if (!role || (roles.length && !roles.includes(role) && role !== 'owner' && role !== 'admin')) throw new ApiError(403, 'forbidden', 'You do not have access to this.');
    await next();
  };
}
