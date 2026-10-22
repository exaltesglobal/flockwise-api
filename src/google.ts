// Google service-account signing for a church's own Cloud Storage bucket: access tokens
// (a signed JWT swapped at Google's token endpoint) and V4 signed URLs, so the browser
// uploads straight to the bucket and private buckets still show their pictures.
import { createHash, createSign } from 'node:crypto';

import type { GoogleKey } from './core/engine.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const HOST = 'storage.googleapis.com';

const b64url = (v: Buffer | string) => Buffer.from(v).toString('base64url');
const sha256hex = (v: string) => createHash('sha256').update(v).digest('hex');
const rsaSign = (privateKey: string, data: string, encoding: 'hex' | 'base64url') => {
  const s = createSign('RSA-SHA256');
  s.update(data);
  return s.sign(privateKey, encoding === 'hex' ? 'hex' : 'base64url');
};

type Cached = { token: string; expiresAt: number };
const tokens = new Map<string, Cached>();

/** An OAuth access token for the service account (cached until a minute before it expires). */
export async function googleAccessToken(key: GoogleKey, scope: string): Promise<string> {
  const cacheKey = `${key.clientEmail}:${scope}:${sha256hex(key.privateKey).slice(0, 12)}`;
  const hit = tokens.get(cacheKey);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: key.clientEmail, scope, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const assertion = `${header}.${claims}.${rsaSign(key.privateKey, `${header}.${claims}`, 'base64url')}`;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number; error_description?: string; error?: string } | null;
  if (!res.ok || !data?.access_token) throw new Error(data?.error_description ?? data?.error ?? `Google token request failed (${res.status})`);
  tokens.set(cacheKey, { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 });
  return data.access_token;
}

// RFC 3986 path segments: encodeURIComponent plus the few characters it leaves alone.
const encodeSegment = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encodeQuery = (s: string) => encodeSegment(s);

/** A V4 signed URL for one object: PUT to upload (content type fixed), GET to read. */
export async function googleSignedUrl(key: GoogleKey, input: { bucket: string; object: string; method: 'PUT' | 'GET'; contentType?: string; expiresSeconds: number }, at = new Date()): Promise<string> {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // YYYYMMDDTHHMMSSZ
  const date = stamp.slice(0, 8);
  const scope = `${date}/auto/storage/goog4_request`;
  const path = `/${encodeSegment(input.bucket)}/${input.object.split('/').map(encodeSegment).join('/')}`;
  const headers: Record<string, string> = { host: HOST, ...(input.method === 'PUT' && input.contentType ? { 'content-type': input.contentType } : {}) };
  const headerNames = Object.keys(headers).sort();
  const signedHeaders = headerNames.join(';');
  const canonicalHeaders = headerNames.map((h) => `${h}:${headers[h].trim()}\n`).join('');
  const query: Record<string, string> = {
    'X-Goog-Algorithm': 'GOOG4-RSA-SHA256',
    'X-Goog-Credential': `${key.clientEmail}/${scope}`,
    'X-Goog-Date': stamp,
    'X-Goog-Expires': String(Math.min(Math.max(1, Math.floor(input.expiresSeconds)), 7 * 86_400)),
    'X-Goog-SignedHeaders': signedHeaders,
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeQuery(k)}=${encodeQuery(query[k])}`)
    .join('&');
  const canonicalRequest = [input.method, path, canonicalQuery, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['GOOG4-RSA-SHA256', stamp, scope, sha256hex(canonicalRequest)].join('\n');
  const signature = rsaSign(key.privateKey, stringToSign, 'hex');
  return `https://${HOST}${path}?${canonicalQuery}&X-Goog-Signature=${signature}`;
}

export const googleHooks = { accessToken: googleAccessToken, signedUrl: (key: GoogleKey, input: Parameters<typeof googleSignedUrl>[1]) => googleSignedUrl(key, input) };
