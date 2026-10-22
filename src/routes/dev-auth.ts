// Stand-in for OTP sign-in while DEV_AUTH=true, so the web and mobile apps can be tested
// against this API before SMS/WhatsApp OTP is built. Any identifier works; the code is 123456.
// Never enabled in production (see assertConfig).
import { Hono } from 'hono';

import { signToken } from '../auth.js';
import { config } from '../config.js';
import { ApiError } from '../errors.js';

export function devAuthRoutes() {
  const app = new Hono();
  const church = { id: config.church.id, name: config.church.name, city: '', country: config.church.country, currency: config.church.currency, logoUrl: null, paymentProvider: 'razorpay' };

  function session(identifier: string, staff: boolean) {
    const email = identifier.includes('@') ? identifier : 'priya@example.com';
    const claims = { sub: staff ? 'st_dev' : 'p_priya', church: config.church.id, name: staff ? 'Church Admin' : 'Priya Thomas', email, phone: identifier.includes('@') ? null : identifier, staffRole: staff ? ('owner' as const) : null };
    const [firstName, ...rest] = claims.name.split(' ');
    return {
      accessToken: signToken(claims, 3600),
      refreshToken: signToken(claims, 30 * 86400),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      member: { id: claims.sub, firstName, lastName: rest.join(' '), email, phone: claims.phone, language: 'en', householdName: null, photoUrl: null },
      church,
      staff: staff ? { role: 'owner' } : null,
    };
  }

  app.post('/auth/otp/request', async (c) => {
    const { identifier, audience } = await c.req.json<{ identifier?: string; audience?: string }>();
    if (!identifier?.trim()) throw new ApiError(422, 'invalid', 'Enter your phone number or email.', { identifier: 'Required' });
    const requestId = Buffer.from(JSON.stringify({ identifier, staff: audience === 'admin' })).toString('base64url');
    return c.json({ requestId, channel: identifier.includes('@') ? 'email' : 'whatsapp', expiresInSeconds: 300 });
  });
  app.post('/auth/otp/verify', async (c) => {
    const { requestId, code } = await c.req.json<{ requestId: string; code: string }>();
    if (code !== '123456') throw new ApiError(422, 'invalid_code', 'That code is not right. In test mode use 123456.');
    const { identifier, staff } = JSON.parse(Buffer.from(requestId, 'base64url').toString());
    return c.json(session(identifier, staff));
  });
  app.post('/auth/refresh', (c) => c.json({ error: { code: 'expired', message: 'Please sign in again.' } }, 401));
  app.post('/auth/sign-out', (c) => c.body(null, 204));
  return app;
}
