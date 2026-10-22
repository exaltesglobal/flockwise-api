import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';

import { config } from './config.js';
import { onError } from './errors.js';
import { devAuthRoutes } from './routes/dev-auth.js';
import { devRoutes } from './routes/dev.js';
import { givingRoutes } from './routes/giving.js';
import { webhookRoutes } from './routes/webhooks.js';
import type { Store } from './store/types.js';

export function createApp(store: Store) {
  const app = new Hono();
  app.use('*', secureHeaders());
  // Only the web app needs CORS; the mobile apps are native.
  app.use('/v1/*', cors({ origin: [config.webUrl], allowHeaders: ['Authorization', 'Content-Type', 'X-Client'], allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], maxAge: 86400 }));
  app.onError(onError);

  app.get('/', (c) => c.json({ name: 'Flockwise API', version: '0.1.0', docs: 'docs/API.md' }));
  app.get('/v1/health', (c) =>
    c.json({ ok: true, payments: config.razorpay.main ? 'razorpay' : 'test-checkout', fcra: !!config.razorpay.fcra, database: config.db ? 'mysql' : 'memory' }),
  );
  app.route('/v1', webhookRoutes(store));
  app.route('/v1', givingRoutes(store));
  if (!config.razorpay.main) app.route('/v1', devRoutes(store));
  if (config.devAuth) app.route('/v1', devAuthRoutes());

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'This endpoint is not built yet.' } }, 404));
  return app;
}
