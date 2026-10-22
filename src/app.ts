import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';

import { verifyAccess } from './auth.js';
import { config } from './config.js';
import type { createChurchEngine } from './core/index.js';
import { ApiError, onError } from './errors.js';
import { channelStatus } from './providers.js';
import { devRoutes } from './routes/dev.js';
import { givingRoutes } from './routes/giving.js';
import { webhookRoutes } from './routes/webhooks.js';
import type { Store } from './store/types.js';

type Engine = ReturnType<typeof createChurchEngine>;

// Simple per-IP limiter for sign-in codes (the engine also limits per email).
const hits = new Map<string, number[]>();
function limited(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 10_000) hits.clear();
  return list.length > max;
}

export function createApp(engine: Engine, store: Store) {
  const app = new Hono();
  app.use('*', secureHeaders());
  // The web app needs CORS; the mobile apps are native and don't.
  app.use('/v1/*', cors({ origin: [config.webUrl, ...config.extraOrigins], allowHeaders: ['Authorization', 'Content-Type', 'X-Client'], allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], maxAge: 86400 }));
  app.onError(onError);

  app.get('/', (c) => c.json({ name: 'Flockwise API', version: '1.0.0', docs: 'docs/API.md' }));
  app.get('/v1/health', (c) =>
    c.json({ ok: true, payments: config.razorpay.main ? 'razorpay' : 'test-checkout', fcra: !!config.razorpay.fcra, database: config.db ? 'mysql' : config.dataFile ? 'file' : 'memory', channels: channelStatus() }),
  );
  app.route('/v1', webhookRoutes(store));
  app.route('/v1', givingRoutes(store));
  if (!config.razorpay.main) app.route('/v1', devRoutes(store));

  // Everything else is the church engine (docs/API.md and docs/API-ADMIN.md).
  app.all('/v1/*', async (c) => {
    const path = c.req.path.slice(3);
    const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? c.req.header('x-real-ip') ?? '';
    if (path === '/auth/otp/request' && limited(`otp:${ip}`, 20, 3600_000)) throw new ApiError(429, 'too_many_codes', 'Too many sign-in attempts from this network. Please try again later.');
    if (path.startsWith('/public/') && c.req.method !== 'GET' && limited(`public:${ip}`, 30, 3600_000)) throw new ApiError(429, 'too_many_requests', 'Too many submissions from this network. Please try again later.');
    if (path === '/auth/otp/verify' && limited(`verify:${ip}`, 40, 3600_000)) throw new ApiError(429, 'too_many_attempts', 'Too many attempts. Please try again later.');
    const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    // Integrations call with a church API key; people call with a short-lived access token.
    const apiKey = bearer?.startsWith('fw_live_') ? bearer : null;
    if (apiKey && limited(`key:${apiKey.slice(0, 16)}`, 600, 60_000)) throw new ApiError(429, 'rate_limited', 'Too many requests for this API key. Slow down to 600 a minute.');
    const auth = apiKey ? null : verifyAccess(bearer);
    let body: unknown = undefined;
    if (c.req.method !== 'GET' && c.req.method !== 'DELETE') {
      const text = await c.req.text();
      if (text.length > 5_000_000) throw new ApiError(413, 'too_large', 'That request is too large.');
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new ApiError(400, 'bad_json', 'The request was not valid JSON.');
      }
    }
    const result = await engine.handle({ method: c.req.method, path, query: c.req.query(), body, auth, apiKey, ip });
    if (result === undefined) return c.body(null, 204);
    return c.json(result as object, c.req.method === 'POST' && /\/(intents|ticket)$/.test(path) ? 201 : 200);
  });

  // MCP server for AI assistants (Streamable HTTP; stateless, JSON replies). docs/MCP.md
  app.use('/mcp', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type', 'Mcp-Protocol-Version', 'Mcp-Session-Id'], allowMethods: ['POST', 'GET', 'DELETE'] }));
  app.get('/mcp', (c) => c.json({ error: { code: 'method_not_allowed', message: 'POST JSON-RPC messages to this URL.' } }, 405));
  app.delete('/mcp', (c) => c.body(null, 405));
  // The key can also be part of the URL, for assistants that only take a connector URL.
  const mcpPost = async (c: Context, key: string | null) => {
    if (key && limited(`key:${key.slice(0, 16)}`, 600, 60_000)) throw new ApiError(429, 'rate_limited', 'Too many requests for this API key.');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
    }
    const out = await engine.mcp(body, key);
    return out === null ? c.body(null, 202) : c.json(out as object);
  };
  app.post('/mcp', (c) => mcpPost(c, c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? null));
  app.use('/mcp/:key', cors({ origin: '*', allowHeaders: ['Content-Type', 'Mcp-Protocol-Version', 'Mcp-Session-Id'], allowMethods: ['POST', 'GET', 'DELETE'] }));
  app.post('/mcp/:key', (c) => mcpPost(c, c.req.param('key')));
  app.get('/mcp/:key', (c) => c.json({ error: { code: 'method_not_allowed', message: 'POST JSON-RPC messages to this URL.' } }, 405));

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404));
  return app;
}
