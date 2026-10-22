// The request router shared by the API server and the web demo. Adapters turn an HTTP
// request into `handle({ method, path, query, body, auth })` and send back the result.
import type { Db } from './db.js';
import { ApiError } from './errors.js';
import { withChurchMail } from './mail.js';
import { permsOf, scopeOf, type Scope } from './perms.js';
import { atLeast, checkPlan, effectivePlan, getSubscription, type BillingInterval, type PlanId } from './plans.js';
import type { CatalogSong, Channel, ChannelStatus, ChurchNetworkHost, Collections, DonationRecord, Kind, Permission, StaffRole } from './types.js';

export type BillingCheckout = { churchId: string; churchName: string; plan: PlanId; interval: BillingInterval; currency: 'INR' | 'USD'; amount: number; email: string; name: string };
/** `html` is the branded version of `text`; providers send both when it is there. */
export type Outgoing = { to: string; name: string; subject: string; text: string; html?: string };
export type DeliveryResult = { ok: boolean; error?: string };
/** A church's own mailbox, unsealed, for the host to send through. */
export type SmtpAccount = { host: string; port: number; user: string; pass: string; from: string; fromName: string };
export type PushMessage = { token: string; title: string; body: string; data?: Record<string, string> };
/** `gone` means the phone uninstalled the app; the engine forgets that token. */
export type PushResult = { ok: boolean; error?: string; gone?: boolean };

/** A provider-neutral slice of the Claude Messages API, so the engine can run in the browser demo too. */
export type AiBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  /** A provider block the engine does not read (e.g. thinking) that must go back unchanged in the next turn. */
  | { type: 'opaque'; value: unknown };
export type AiMessage = { role: 'user' | 'assistant'; content: string | AiBlock[] };
export type AiRequest = {
  system: string;
  messages: AiMessage[];
  tools?: { name: string; description: string; input_schema: Record<string, unknown> }[];
  /** JSON schema the reply must follow (structured output). */
  schema?: Record<string, unknown>;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
};
export type AiResponse = { content: AiBlock[]; stopReason: string };

/** Everything the engine needs from its host. */
export type Env = {
  /** Demo mode: fixed sign-in code, gifts succeed instantly, nothing leaves the browser. */
  demo: boolean;
  now(): Date;
  newId(prefix: string): string;
  /** Random string from `alphabet` (cryptographically random on the server). */
  random(length: number, alphabet: string): string;
  hash(value: string): string;
  /** Slow, salted password hash (scrypt on the server) for team app logins. */
  hashPassword(password: string): string;
  verifyPassword(password: string, stored: string): boolean;
  /** Short-lived access token for the session. */
  signAccess(claims: AuthClaims): { token: string; expiresAt: string };
  sendOtpEmail(to: string, code: string, churchName: string): Promise<void>;
  deliver(channel: Channel, batch: Outgoing[]): Promise<DeliveryResult[]>;
  channels(): ChannelStatus;
  /** Starts a hosted checkout for a pending donation row and returns where to send the donor. */
  checkout(donation: DonationRecord, opts: { description: string; fundTaxDeductible: boolean; totalCount?: number; pledgeId?: string }): Promise<{ checkoutUrl: string; providerRef: string | null; provider: DonationRecord['provider']; status?: DonationRecord['status'] }>;
  /** Where the member portal lives, for links in messages. */
  webUrl: string;
  /** Calls the Chitthi API (WhatsApp) with a church's key. */
  chitthi(apiKey: string, req: { method: 'GET' | 'POST' | 'DELETE'; path: string; body?: unknown }): Promise<{ status: number; data: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Claude, when the server has an API key. Absent means AI features are switched off. */
  ai?: (req: AiRequest) => Promise<AiResponse>;
  /**
   * Flockwise's own subscription billing (the church pays Flockwise). Absent in the demo, where
   * a plan change takes effect at once.
   */
  billing?: {
    checkout(input: BillingCheckout): Promise<{ url: string; providerRef: string | null }>;
    cancel(providerRef: string): Promise<void>;
    /** A one-time payment to Flockwise (assisted Razorpay setup). */
    oneTime?(input: { churchId: string; kind: string; amount: number; description: string; email: string; name: string; returnUrl: string }): Promise<{ url: string; providerRef: string }>;
    /** Asks Razorpay whether a one-time payment link was paid, in case the webhook is late. */
    linkPaid?(providerRef: string): Promise<boolean>;
  };
  /** Pauses, resumes or cancels a giver's Razorpay subscription on the church's account. Absent in the demo, where it applies at once. */
  subscriptions?: {
    pause(ref: string, fcra: boolean): Promise<void>;
    resume(ref: string, fcra: boolean): Promise<void>;
    cancel(ref: string, fcra: boolean): Promise<void>;
  };
  /** Checks a church's Razorpay keys with Razorpay. Absent in the demo. */
  verifyRazorpay?: (keyId: string, keySecret: string) => Promise<boolean>;
  /** True when the host has its own Razorpay keys for this church (the server's original church). */
  serverPaymentKeys?: boolean;
  /** Church networks and dioceses this church belongs to, kept by the host (many-church servers). */
  network?: ChurchNetworkHost;
  /** Public base URL for incoming webhooks (…/v1/webhooks). Absent in the demo. */
  webhookBase?: string;
  /** Our Razorpay partner sign-up link for assisted setup. */
  razorpayPartnerUrl?: string;
  /** Encrypts a stored credential (e.g. a partner API key) and reads it back. */
  seal(value: string): string;
  unseal(sealed: string): string;
  /** Sends email through a church's own mailbox. Absent when the host cannot do SMTP. */
  smtp?: (account: SmtpAccount, batch: Outgoing[]) => Promise<DeliveryResult[]>;
  /** Push notifications to the member and team apps (Expo). Absent when the host has no push. */
  push?: (batch: PushMessage[]) => Promise<PushResult[]>;
  /** Plain HTTPS for the church's connections (Zoom, Google Cloud Storage, Canva). The demo answers with stand-ins. */
  http?: (req: HttpRequest) => Promise<HttpResponse>;
  /** Google service-account signing (access tokens and V4 signed URLs). Absent when the host cannot sign. */
  google?: {
    accessToken(key: GoogleKey, scope: string): Promise<string>;
    signedUrl(key: GoogleKey, input: { bucket: string; object: string; method: 'PUT' | 'GET'; contentType?: string; expiresSeconds: number }): Promise<string>;
  };
  /**
   * Licensed lyrics services (SongSelect, a publisher, an Indian label) Flockwise has an agreement
   * with. Each answers the lyrics-feed contract in docs/SONG-CATALOG.md over `http`. Empty or absent
   * means copyrighted songs are added with credits only.
   */
  lyricsFeeds?: LyricsFeed[];
  /** Songs and public-domain words the Flockwise team added to the shared song database (/platform/songs). */
  songCatalog?: { stored(): CatalogSong[] };
  /** Flockwise's Canva app, so churches can connect their Canva. Absent when CANVA_CLIENT_ID is not set. */
  canvaApp?: { clientId: string; clientSecret: string; redirectUrl: string; pkce(): { verifier: string; challenge: string } };
};

/** One licensed lyrics service. `key` is sent as a bearer token. */
export type LyricsFeed = { id: string; name: string; url: string; key: string; covers: 'all' | 'ccli' };

export type HttpRequest = { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string; headers?: Record<string, string>; body?: string | Uint8Array; timeoutMs?: number };
export type HttpResponse = { status: number; headers: Record<string, string>; text: string };
export type GoogleKey = { clientEmail: string; privateKey: string; projectId: string };

/** What a signed access token says. The engine re-reads the staff role from the database on each request. */
export type AuthClaims = { sub: string; staffId: string | null; scope: 'admin' | 'member'; keyId?: string; readOnly?: boolean };

export type Request = {
  method: string;
  path: string; // without /v1
  query?: Record<string, string | undefined>;
  body?: unknown;
  auth: AuthClaims | null;
  /** A public API key (fw_live_...), when the caller is an integration rather than a signed-in person. */
  apiKey?: string | null;
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
  /** Set when the login is limited to some zones, groups or teams; null sees the whole church. */
  scope: Scope | null;
  /** May this login see this person? Always true for unscoped logins. */
  inScope(personId: string | null | undefined): boolean;
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
  const perms = new Set(staff ? permsOf(db, staff) : []);
  const scope = staff ? scopeOf(db, staff) : null;
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
    scope,
    inScope: (personId) => !scope || (!!personId && scope.people.has(personId)),
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

export function createEngine(db: Db, hostEnv: Env, modules: ((r: Router) => void)[]) {
  // Email leaves from the church's own mailbox once the office connects one.
  const env = withChurchMail(db, hostEnv);
  const router = new Router();
  for (const m of modules) m(router);

  /** Turns an API key into the claims of the staff member who made it. */
  function keyAuth(token: string): AuthClaims {
    const bad = () => new ApiError(401, 'invalid_api_key', 'This API key is not valid or has been revoked.');
    const hash = env.hash(token);
    const key = db.all('apiKeys').find((k) => k.hash === hash && !k.revokedAt);
    if (!key) throw bad();
    const staff = db.get('staff', key.staffId);
    // Office staff may have no member profile linked; their sign-in profile is found by email.
    const personId = staff?.personId ?? db.all('people').find((p) => p.email?.toLowerCase() === staff?.email.toLowerCase())?.id;
    if (!staff || staff.status !== 'active' || !personId) throw bad();
    const today = env.now().toISOString();
    if (key.lastUsedAt?.slice(0, 10) !== today.slice(0, 10)) db.put('apiKeys', { ...key, lastUsedAt: today });
    return { sub: personId, staffId: staff.id, scope: 'admin', keyId: key.id, readOnly: key.access === 'read' };
  }

  async function handle(req: Request): Promise<unknown> {
    const method = req.method.toUpperCase();
    const path = req.path.replace(/\/+$/, '') || '/';
    if (!req.auth && req.apiKey) {
      req = { ...req, auth: keyAuth(req.apiKey) };
      // Keys reach church data only; they cannot make more keys, change connections or change staff roles.
      if (!path.startsWith('/admin/') || /^\/admin\/(api-keys|integrations)/.test(path) || (path.startsWith('/admin/staff') && method !== 'GET')) throw new ApiError(403, 'forbidden', 'API keys cannot use this endpoint.');
      if (!atLeast(effectivePlan(getSubscription(db), env.now()), 'cathedral')) throw new ApiError(402, 'plan_required', 'API access is part of the Cathedral plan.', { plan: 'cathedral' });
      if (req.auth!.readOnly && method !== 'GET') throw new ApiError(403, 'read_only_key', 'This API key can only read. Make a full-access key to change data.');
    }
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
          checkPlan(db, ctx.now, path, method, req.body);
          if (ctx.staff.lastActiveAt?.slice(0, 10) !== ctx.now.toISOString().slice(0, 10)) db.put('staff', { ...ctx.staff, lastActiveAt: ctx.now.toISOString() });
        }
      }
      return route.handler(ctx);
    }
    throw new ApiError(404, 'not_found', `No endpoint for ${method} ${path}.`);
  }

  return { handle, router, db, env, verifyKey: keyAuth };
}

export type Engine = ReturnType<typeof createEngine>;
export type { Kind };
