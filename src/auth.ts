// Access tokens are HS256 JWTs signed with JWT_SECRET and valid for an hour. Refresh
// tokens are random, stored hashed by the engine, and rotated on every refresh.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

import { config } from './config.js';
import type { AuthClaims } from './core/index.js';

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const ACCESS_TTL = 3600;

type Jwt = AuthClaims & { church: string; exp: number };

export function signAccess(claims: AuthClaims) {
  const exp = Math.floor(Date.now() / 1000) + ACCESS_TTL;
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ ...claims, church: config.church.id, exp } satisfies Jwt));
  const sig = b64(createHmac('sha256', config.jwtSecret).update(`${header}.${body}`).digest());
  return { token: `${header}.${body}.${sig}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export function verifyAccess(token: string | undefined): AuthClaims | null {
  if (!token) return null;
  const [header, body, sig] = token.split('.');
  if (!header || !body || !sig) return null;
  const expected = createHmac('sha256', config.jwtSecret).update(`${header}.${body}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString()) as Jwt;
    if (c.exp * 1000 <= Date.now() || c.church !== config.church.id) return null;
    return { sub: c.sub, staffId: c.staffId ?? null, scope: c.scope === 'admin' ? 'admin' : 'member' };
  } catch {
    return null;
  }
}

/** Keyed hash for OTP codes and refresh tokens, so a database leak does not reveal them. */
export const hashSecret = (value: string) => createHash('sha256').update(`${config.jwtSecret}:${value}`).digest('hex');

export function randomString(length: number, alphabet: string) {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

// Sealing for stored partner credentials (AES-256-GCM, key derived from JWT_SECRET).
const sealKey = () => createHash('sha256').update(`${config.jwtSecret}:seal`).digest();
export function seal(value: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', sealKey(), iv);
  const enc = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  return `v1.${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64url')}`;
}
export function unseal(sealed: string) {
  const raw = Buffer.from(sealed.replace(/^v1\./, ''), 'base64url');
  const d = createDecipheriv('aes-256-gcm', sealKey(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
