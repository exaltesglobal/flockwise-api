// The request router shared by the API server and the web demo. Adapters turn an HTTP
// request into `handle({ method, path, query, body, auth })` and send back the result.
import type { Db } from './db.js';
import { ApiError } from './errors.js';
import { PERMISSIONS } from './perms.js';
import type { Channel, ChannelStatus, Collections, DonationRecord, Kind, Permission, StaffRole } from './types.js';

export type Outgoing = { to: string; name: string; subject: string; text: string };
export type DeliveryResult = { ok: boolean; error?: string };

/** Everything the engine needs from its host. */
export type Env = {
  /** Demo mode: fixed sign-in code, gifts succeed instantly, nothing leaves the browser. */
  demo: boolean;
  now(): Date;
  newId(prefix: string): string;
  /** Random string from `alphabet` (cryptographically random on the server). */
  random(length: number, alphabet: string): string;
  hash(value: string): string;
  /** Short-lived access token for the session. */
  signAccess(claims: AuthClaims): { token: string; expiresAt: string };
  sendOtpEmail(to: string, code: string, churchName: string): Promise<void>;
  deliver(channel: Channel, batch: Outgoing[]): Promise<DeliveryResult[]>;
  channels(): ChannelStatus;
  /** Starts a hosted checkout for a pending donation row and returns where to send the donor. */
  checkout(donation: DonationRecord, opts: { description: string; fundTaxDeductible: boolean }): Promise<{ checkoutUrl: string; providerRef: string | null; provider: DonationRecord['provider']; status?: DonationRecord['status'] }>;
  /** Where the member portal lives, for links in messages. */
  webUrl: string;
};

/** What a signed access token says. The engine re-reads the staff role from the database on each request. */
export type AuthClaims = { sub: string; staffId: string | null; scope: 'admin' | 'member' };

export type Request = {
  method: string;
  path: string; // without /v1
  query?: Record<string, string | undefined>;
  body?: unknown;
  auth: AuthClaims | null;
  ip?: string;
};

export type Ctx = {
  db: Db;
  env: Env;
  params: string[];
  query: Record<string, string | undefined>;
  // Request bodies are validated field by field in each handler.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  auth: AuthClaims | null;
  ip: string;
  now: Date;
  /** The signed-in person's id. Throws 401 when signed out. */
  me(): string;
  staff: Collections['staff'] | null;
  role: StaffRole | null;
  can(p: Permission): boolean;
  require(p: Permission): void;
  id(prefix: string): string;
  audit(action: string, entity: string, entityId: string | null, summary: string): void;
};

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;
type RouteOpts = { public?: boolean; perm?: Permission | Permission[]; staff?: boolean };
type Route = { method: string; re: RegExp; opts: RouteOpts; handler: Handler };

export class Router {
  routes: Route[] = [];
  on(method: string, pattern: string, opts: RouteOpts, handler: Handler) {
    this.routes.push({ method, re: new RegExp(`^${pattern.replace(/:\w+/g, '([^/]+)')}$`), opts, handler });
  }
  get = (p: string, o: RouteOpts, h: Handler) => this.on('GET', p, o, h);
  post = (p: string, o: RouteOpts, h: Handler) => this.on('POST', p, o, h);
  put = (p: string, o: RouteOpts, h: Handler) => this.on('PUT', p, o, h);
  patch = (p: string, o: RouteOpts, h: Handler) => this.on('PATCH', p, o, h);
  del = (p: string, o: RouteOpts, h: Handler) => this.on('DELETE', p, o, h);
}

export function makeCtx(db: Db, env: Env, req: Pick<Request, 'auth' | 'body' | 'query' | 'ip'>, params: string[] = []): Ctx {
  const auth = req.auth;
  const staffRec = auth?.scope === 'admin' && auth.staffId ? db.get('staff', auth.staffId) : undefined;
  const staff = staffRec && staffRec.status === 'active' ? staffRec : null;
  const role = staff?.role ?? null;
  const perms = new Set(role ? PERMISSIONS[role] : []);
  const now = env.now();
  const ctx: Ctx = {
    db,
    env,
    params,
    query: req.query ?? {},
    body: req.body ?? {},
    auth,
    ip: req.ip ?? '',
    now,
    staff,
    role,
    me() {
      if (!auth || !db.get('people', auth.sub)) throw new ApiError(401, 'unauthorized', 'Please sign in again.');
      return auth.sub;
    },
    can: (p) => perms.has(p),
    require(p) {
      if (!perms.has(p)) throw new ApiError(403, 'forbidden', 'Your role does not have access to this. Ask the church owner or an admin.');
    },
    id: (prefix) => env.newId(prefix),
    audit(action, entity, entityId, summary) {
      const actor = staff ?? (auth ? db.get('people', auth.sub) : undefined);
      const actorName = staff ? staff.name : actor && 'firstName' in actor ? `${actor.firstName} ${actor.lastName}` : 'System';
      db.put('audit', { id: env.newId('au'), at: now.toISOString(), actorId: staff?.id ?? auth?.sub ?? null, actorName, action, entity, entityId, summary });
    },
  };
  return ctx;
}

export function createEngine(db: Db, env: Env, modules: ((r: Router) => void)[]) {
  const router = new Router();
  for (const m of modules) m(router);

  async function handle(req: Request): Promise<unknown> {
    const method = req.method.toUpperCase();
    const path = req.path.replace(/\/+$/, '') || '/';
    for (const route of router.routes) {
      if (route.method !== method) continue;
      const match = route.re.exec(path);
      if (!match) continue;
      const ctx = makeCtx(db, env, req, match.slice(1).map(decodeURIComponent));
      if (!route.opts.public) {
        ctx.me();
        if (path.startsWith('/admin/') || route.opts.staff || route.opts.perm) {
          if (!ctx.staff) throw new ApiError(403, 'forbidden', 'This is for church staff. Sign in to the church office.');
          const need = route.opts.perm ? ([] as Permission[]).concat(route.opts.perm) : [];
          if (need.length && !need.some((p) => ctx.can(p))) ctx.require(need[0]);
          if (ctx.staff.lastActiveAt?.slice(0, 10) !== ctx.now.toISOString().slice(0, 10)) db.put('staff', { ...ctx.staff, lastActiveAt: ctx.now.toISOString() });
        }
      }
      return route.handler(ctx);
    }
    throw new ApiError(404, 'not_found', `No endpoint for ${method} ${path}.`);
  }

  return { handle, router, db, env };
}

export type Engine = ReturnType<typeof createEngine>;
export type { Kind };
