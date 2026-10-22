// The church's connections to other services: Zoom (meeting links on events), Google Cloud
// Storage (its own bucket for photos and videos, the media library) and Canva (open designs
// with the brand kit applied). Credentials are sealed by the host; the demo has stand-ins.
import type { Ctx, GoogleKey, HttpRequest, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { CanvaConfig, CanvaDesign, CanvaStatus, ConnectionsStatus, GcsConfig, GcsStatus, MediaFolder, MediaItem, MediaList, MediaUpload, ZoomConfig, ZoomStatus } from '../types.js';
import { MEDIA_FOLDERS } from '../types.js';
import { churchId, eventView, find, requireFields, settings } from '../util.js';

const ZOOM_TOKEN = 'https://zoom.us/oauth/token';
const ZOOM_API = 'https://api.zoom.us/v2';
const GCS_API = 'https://storage.googleapis.com/storage/v1';
const CANVA_API = 'https://api.canva.com/rest/v1';
export const CANVA_AUTH = 'https://www.canva.com/api/oauth/authorize';
const CANVA_SCOPES = 'asset:read asset:write design:content:read design:content:write design:meta:read profile:read';
const SIGNED_LINK_SECONDS = 7 * 86_400;

const zoomConfig = (ctx: Pick<Ctx, 'db'>) => ctx.db.get('integrations', 'zoom') as ZoomConfig | undefined;
const gcsConfig = (ctx: Pick<Ctx, 'db'>) => ctx.db.get('integrations', 'gcs') as GcsConfig | undefined;
const canvaConfig = (ctx: Pick<Ctx, 'db'>) => ctx.db.get('integrations', 'canva') as CanvaConfig | undefined;

const needHttp = (ctx: Ctx) => {
  if (!ctx.env.http) throw new ApiError(422, 'not_available', 'This server cannot reach other services yet.');
  return ctx.env.http;
};
const json = (r: { text: string }) => {
  try {
    return r.text ? JSON.parse(r.text) : null;
  } catch {
    return null;
  }
};
const b64 = (s: string) => (typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'utf8').toString('base64'));
const apiMessage = (data: unknown, fallback: string) => {
  const d = data as { message?: string; error?: string | { message?: string }; error_description?: string } | null;
  return d?.message ?? (typeof d?.error === 'object' ? d.error?.message : undefined) ?? d?.error_description ?? (typeof d?.error === 'string' ? d.error : undefined) ?? fallback;
};

// ---------- Zoom ----------

export function zoomStatus(ctx: Ctx): ZoomStatus {
  const c = zoomConfig(ctx);
  return { connected: !!c, accountId: c?.accountId ?? '', userEmail: c?.userEmail ?? '', userName: c?.userName ?? '', connectedAt: c?.connectedAt ?? null, lastError: c?.lastError ?? null, meetings: ctx.db.all('events').filter((e) => e.zoom).length };
}

async function zoomToken(ctx: Ctx, accountId: string, clientId: string, clientSecret: string) {
  const http = needHttp(ctx);
  const r = await http({ method: 'POST', url: `${ZOOM_TOKEN}?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`, headers: { Authorization: `Basic ${b64(`${clientId}:${clientSecret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
  const data = json(r);
  if (r.status >= 300 || !data?.access_token) throw new ApiError(422, 'zoom_refused', `Zoom did not accept these details: ${apiMessage(data, `answered ${r.status}`)}. Check the Account ID, Client ID and Client Secret of your Server-to-Server OAuth app.`);
  return String(data.access_token);
}

async function zoomCall(ctx: Ctx, c: ZoomConfig, req: { method: HttpRequest['method']; path: string; body?: unknown }) {
  const token = await zoomToken(ctx, c.accountId, c.clientId, ctx.env.unseal(c.clientSecretSealed));
  const r = await needHttp(ctx)({ method: req.method, url: `${ZOOM_API}${req.path}`, headers: { Authorization: `Bearer ${token}`, ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: req.body !== undefined ? JSON.stringify(req.body) : undefined });
  const data = json(r);
  ctx.db.put('integrations', { ...c, lastError: r.status < 300 || r.status === 404 ? null : apiMessage(data, `Zoom answered ${r.status}`) });
  return { status: r.status, data };
}

// ---------- Google Cloud Storage ----------

export function gcsStatus(ctx: Ctx): GcsStatus {
  const c = gcsConfig(ctx);
  const files = ctx.db.all('media').filter((m) => m.status === 'ready');
  return {
    available: !!ctx.env.google && !!ctx.env.http, connected: !!c, bucket: c?.bucket ?? '', projectId: c?.projectId ?? '', clientEmail: c?.clientEmail ?? '', publicRead: c?.publicRead ?? false,
    connectedAt: c?.connectedAt ?? null, lastError: c?.lastError ?? null, files: files.length, bytes: files.reduce((n, m) => n + m.size, 0),
  };
}

const keyOf = (ctx: Ctx, c: GcsConfig): GoogleKey => ({ clientEmail: c.clientEmail, privateKey: ctx.env.unseal(c.privateKeySealed), projectId: c.projectId });

/** Whether anyone on the internet may read the bucket's objects (allUsers has objectViewer). */
async function bucketIsPublic(ctx: Ctx, key: GoogleKey, bucket: string) {
  const token = await ctx.env.google!.accessToken(key, 'https://www.googleapis.com/auth/devstorage.read_write');
  const r = await needHttp(ctx)({ method: 'GET', url: `${GCS_API}/b/${encodeURIComponent(bucket)}/iam`, headers: { Authorization: `Bearer ${token}` } });
  if (r.status >= 300) return false;
  const bindings = (json(r)?.bindings ?? []) as { role: string; members: string[] }[];
  return bindings.some((b) => /objectViewer|objectAdmin|storage\.admin|legacyBucketReader|legacyObjectReader/.test(b.role) && b.members.includes('allUsers'));
}

const publicUrl = (bucket: string, object: string) => `https://storage.googleapis.com/${bucket}/${object.split('/').map(encodeURIComponent).join('/')}`;

/** Refreshes signed links on a private bucket; public buckets keep their plain links. */
async function mediaView(ctx: Ctx, c: GcsConfig | undefined, items: MediaItem[]): Promise<MediaItem[]> {
  if (!c || c.publicRead || !ctx.env.google) return items;
  const key = keyOf(ctx, c);
  return Promise.all(items.map(async (m) => (m.url.startsWith('data:') ? m : { ...m, url: await ctx.env.google!.signedUrl(key, { bucket: c.bucket, object: m.object, method: 'GET', expiresSeconds: SIGNED_LINK_SECONDS }) })));
}

const safeName = (name: string) => name.replace(/[^\w.\-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'file';

// ---------- Canva ----------

export function canvaStatus(ctx: Ctx): CanvaStatus {
  const c = canvaConfig(ctx);
  return { available: !!ctx.env.canvaApp && !!ctx.env.http, connected: !!c, userName: c?.userName ?? '', teamName: c?.teamName ?? '', connectedAt: c?.connectedAt ?? null, lastError: c?.lastError ?? null, designs: ctx.db.count('canvaDesigns') };
}

async function canvaTokens(ctx: Ctx, params: Record<string, string>) {
  const app = ctx.env.canvaApp!;
  const r = await needHttp(ctx)({ method: 'POST', url: `${CANVA_API}/oauth/token`, headers: { Authorization: `Basic ${b64(`${app.clientId}:${app.clientSecret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
  const data = json(r);
  if (r.status >= 300 || !data?.access_token) throw new ApiError(422, 'canva_refused', `Canva did not complete the connection: ${apiMessage(data, `answered ${r.status}`)}.`);
  return { access: String(data.access_token), refresh: String(data.refresh_token ?? ''), expiresIn: Number(data.expires_in) || 14_400 };
}

/** A valid access token, refreshed when it is about to expire. */
async function canvaAccess(ctx: Ctx): Promise<{ c: CanvaConfig; token: string }> {
  const c = canvaConfig(ctx);
  if (!c) throw new ApiError(404, 'not_connected', 'Canva is not connected. Connect it in Settings › Integrations.');
  if (!ctx.env.canvaApp) throw new ApiError(422, 'not_available', 'This server is not set up for Canva.');
  if (new Date(c.expiresAt).getTime() - ctx.now.getTime() > 120_000) return { c, token: ctx.env.unseal(c.accessTokenSealed) };
  const t = await canvaTokens(ctx, { grant_type: 'refresh_token', refresh_token: ctx.env.unseal(c.refreshTokenSealed) });
  const next: CanvaConfig = { ...c, accessTokenSealed: ctx.env.seal(t.access), refreshTokenSealed: ctx.env.seal(t.refresh || ctx.env.unseal(c.refreshTokenSealed)), expiresAt: new Date(ctx.now.getTime() + t.expiresIn * 1000).toISOString() };
  ctx.db.put('integrations', next);
  return { c: next, token: t.access };
}

async function canvaCall(ctx: Ctx, req: { method: HttpRequest['method']; path: string; body?: unknown; raw?: { bytes: Uint8Array; contentType: string; headers: Record<string, string> } }) {
  const { c, token } = await canvaAccess(ctx);
  const r = await needHttp(ctx)({
    method: req.method, url: `${CANVA_API}${req.path}`,
    headers: { Authorization: `Bearer ${token}`, ...(req.raw ? { 'Content-Type': 'application/octet-stream', ...req.raw.headers } : req.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: req.raw ? req.raw.bytes : req.body !== undefined ? JSON.stringify(req.body) : undefined,
  });
  const data = json(r);
  ctx.db.put('integrations', { ...canvaConfig(ctx)!, lastError: r.status < 300 ? null : apiMessage(data, `Canva answered ${r.status}`) });
  if (r.status >= 300) throw new ApiError(502, 'canva_error', `Canva: ${apiMessage(data, `answered ${r.status}`)}`);
  void c;
  return data;
}

/** Decodes a data URL into bytes without Node APIs. */
function dataUrlBytes(dataUrl: string): { bytes: Uint8Array; contentType: string } {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m || !m[2]) throw new ApiError(422, 'invalid', 'Send the picture as a base64 data URL.');
  const bin = typeof atob === 'function' ? atob(m[3]) : Buffer.from(m[3], 'base64').toString('binary');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, contentType: m[1] || 'application/octet-stream' };
}

const DESIGN_SIZES: Record<string, { width: number; height: number }> = { invitation: { width: 1080, height: 1350 }, social: { width: 1080, height: 1080 }, story: { width: 1080, height: 1920 }, poster: { width: 2480, height: 3508 }, bulletin: { width: 2480, height: 3508 }, slide: { width: 1920, height: 1080 } };

export function connectionsStatus(ctx: Ctx): Pick<ConnectionsStatus, 'zoom' | 'gcs' | 'canva'> {
  return { zoom: zoomStatus(ctx), gcs: gcsStatus(ctx), canva: canvaStatus(ctx) };
}

export function registerConnections(r: Router) {
  // ----- Zoom -----
  r.post('/admin/integrations/zoom', { perm: 'settings' }, async (ctx) => {
    requireFields(ctx.body, ['accountId', 'clientId', 'clientSecret']);
    const accountId = String(ctx.body.accountId).trim();
    const clientId = String(ctx.body.clientId).trim();
    const clientSecret = String(ctx.body.clientSecret).trim();
    const token = await zoomToken(ctx, accountId, clientId, clientSecret);
    const me = await needHttp(ctx)({ method: 'GET', url: `${ZOOM_API}/users/me`, headers: { Authorization: `Bearer ${token}` } });
    const user = json(me);
    if (me.status >= 300) throw new ApiError(422, 'zoom_refused', `Zoom accepted the app but refused to read the user (${apiMessage(user, `status ${me.status}`)}). Give the app the user:read:user:admin and meeting:write:meeting:admin scopes.`);
    const c: ZoomConfig = { id: 'zoom', accountId, clientId, clientSecretSealed: ctx.env.seal(clientSecret), userEmail: String(user?.email ?? ''), userName: `${user?.first_name ?? ''} ${user?.last_name ?? ''}`.trim() || String(user?.display_name ?? ''), connectedAt: ctx.now.toISOString(), connectedBy: ctx.staff?.name ?? '', lastError: null };
    ctx.db.put('integrations', c);
    ctx.audit('connected', 'integration', 'zoom', `Connected Zoom (${c.userEmail})`);
    return zoomStatus(ctx);
  });
  r.del('/admin/integrations/zoom', { perm: 'settings' }, (ctx) => {
    if (zoomConfig(ctx)) {
      ctx.db.del('integrations', 'zoom');
      ctx.audit('disconnected', 'integration', 'zoom', 'Disconnected Zoom');
    }
    return zoomStatus(ctx);
  });
  /** Creates a Zoom meeting for the event and puts its join link on it. */
  r.post('/admin/events/:id/zoom', { perm: 'events' }, async (ctx) => {
    const c = zoomConfig(ctx);
    if (!c) throw new ApiError(404, 'not_connected', 'Connect Zoom in Settings › Integrations first.');
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    if (ev.zoom) return eventView(ctx, ev);
    const minutes = Math.max(15, Math.round((new Date(ev.endsAt).getTime() - new Date(ev.startsAt).getTime()) / 60_000));
    const res = await zoomCall(ctx, c, {
      method: 'POST', path: '/users/me/meetings',
      body: { topic: ev.title.slice(0, 200), type: 2, start_time: ev.startsAt.replace(/\.\d{3}Z$/, 'Z'), duration: minutes, timezone: settings(ctx).timezone || 'Asia/Kolkata', agenda: ev.description.slice(0, 2000), settings: { join_before_host: true, waiting_room: false, mute_upon_entry: true, approval_type: 2 } },
    });
    if (res.status >= 300 || !res.data?.join_url) throw new ApiError(502, 'zoom_error', `Zoom could not create the meeting: ${apiMessage(res.data, `answered ${res.status}`)}`);
    const next = { ...ev, meetingUrl: String(res.data.join_url), zoom: { meetingId: String(res.data.id), joinUrl: String(res.data.join_url), startUrl: String(res.data.start_url ?? ''), passcode: String(res.data.password ?? '') } };
    ctx.db.put('events', next);
    ctx.audit('updated', 'event', ev.id, `Created a Zoom meeting for ${ev.title}`);
    return eventView(ctx, next);
  });
  r.del('/admin/events/:id/zoom', { perm: 'events' }, async (ctx) => {
    const ev = find(ctx, 'events', ctx.params[0], 'Event');
    const c = zoomConfig(ctx);
    if (ev.zoom && c) await zoomCall(ctx, c, { method: 'DELETE', path: `/meetings/${ev.zoom.meetingId}` }).catch(() => undefined);
    const next = { ...ev, zoom: null, meetingUrl: ev.zoom && ev.meetingUrl === ev.zoom.joinUrl ? null : ev.meetingUrl ?? null };
    ctx.db.put('events', next);
    return eventView(ctx, next);
  });

  // ----- Google Cloud Storage -----
  r.post('/admin/integrations/gcs', { perm: 'settings' }, async (ctx) => {
    if (!ctx.env.google) throw new ApiError(422, 'not_available', 'This server cannot sign Google requests yet.');
    requireFields(ctx.body, ['bucket', 'serviceAccount']);
    const bucket = String(ctx.body.bucket).trim().replace(/^gs:\/\//, '').replace(/\/.*$/, '');
    if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket)) throw new ApiError(422, 'invalid', 'Enter the bucket name, like gracechurch-media.', { bucket: 'Bucket name' });
    let sa: { client_email?: string; private_key?: string; project_id?: string };
    try {
      sa = typeof ctx.body.serviceAccount === 'string' ? JSON.parse(ctx.body.serviceAccount) : ctx.body.serviceAccount;
    } catch {
      throw new ApiError(422, 'invalid', 'Paste the whole service-account JSON key file.', { serviceAccount: 'Not valid JSON' });
    }
    if (!sa?.client_email || !sa.private_key?.includes('PRIVATE KEY')) throw new ApiError(422, 'invalid', 'This is not a service-account key. In Google Cloud, create a service account with the Storage Object Admin role and download its JSON key.', { serviceAccount: 'Needs client_email and private_key' });
    const key: GoogleKey = { clientEmail: sa.client_email, privateKey: sa.private_key, projectId: sa.project_id ?? '' };
    const token = await ctx.env.google.accessToken(key, 'https://www.googleapis.com/auth/devstorage.read_write').catch((e: Error) => {
      throw new ApiError(422, 'google_refused', `Google did not accept this key: ${e.message}`);
    });
    const r = await needHttp(ctx)({ method: 'GET', url: `${GCS_API}/b/${encodeURIComponent(bucket)}?fields=name,location`, headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 404) throw new ApiError(422, 'invalid', `There is no bucket called ${bucket} that this service account can see.`, { bucket: 'Not found' });
    if (r.status >= 300) throw new ApiError(422, 'google_refused', `Google refused: ${apiMessage(json(r), `status ${r.status}`)}. Give the service account the Storage Object Admin role on the bucket.`);
    const publicRead = await bucketIsPublic(ctx, key, bucket).catch(() => false);
    const c: GcsConfig = { id: 'gcs', bucket, projectId: key.projectId, clientEmail: key.clientEmail, privateKeySealed: ctx.env.seal(key.privateKey), publicRead, connectedAt: ctx.now.toISOString(), connectedBy: ctx.staff?.name ?? '', lastError: null };
    ctx.db.put('integrations', c);
    ctx.audit('connected', 'integration', 'gcs', `Connected Google Cloud Storage bucket ${bucket}`);
    return gcsStatus(ctx);
  });
  r.del('/admin/integrations/gcs', { perm: 'settings' }, (ctx) => {
    if (gcsConfig(ctx)) {
      ctx.db.del('integrations', 'gcs');
      ctx.audit('disconnected', 'integration', 'gcs', 'Disconnected Google Cloud Storage (files stay in the bucket)');
    }
    return gcsStatus(ctx);
  });

  // ----- media library -----
  r.get('/admin/media', { perm: 'comms' }, async (ctx): Promise<MediaList> => {
    const folder = ctx.query.folder as MediaFolder | undefined;
    const items = ctx.db.all('media').filter((m) => m.status === 'ready' && (!folder || m.folder === folder)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 500);
    return { data: await mediaView(ctx, gcsConfig(ctx), items), gcs: gcsStatus(ctx) };
  });
  /** Step 1 of an upload: a signed URL the browser PUTs the file to. */
  r.post('/admin/media/uploads', { perm: 'comms' }, async (ctx): Promise<MediaUpload> => {
    const c = gcsConfig(ctx);
    if (!c || !ctx.env.google) throw new ApiError(404, 'not_connected', 'Connect Google Cloud Storage in Settings › Integrations to upload photos and videos.');
    requireFields(ctx.body, ['name', 'contentType']);
    const name = String(ctx.body.name).slice(0, 120);
    const contentType = String(ctx.body.contentType).toLowerCase().slice(0, 100);
    if (!/^(image|video|audio|application\/pdf)/.test(contentType)) throw new ApiError(422, 'invalid', 'Upload pictures, videos, audio or PDFs.');
    const size = Math.max(0, Math.floor(Number(ctx.body.size) || 0));
    if (size > 2_000_000_000) throw new ApiError(422, 'too_large', 'Files up to 2 GB.');
    const folder = (MEDIA_FOLDERS.some((f) => f.id === ctx.body.folder) ? ctx.body.folder : 'general') as MediaFolder;
    const id = ctx.id('md');
    const object = `${churchId(ctx)}/${folder}/${ctx.now.toISOString().slice(0, 7)}/${id}-${safeName(name)}`;
    const item: MediaItem = { id, name, contentType, size, folder, object, url: publicUrl(c.bucket, object), status: 'pending', uploadedBy: ctx.staff?.name ?? '', createdAt: ctx.now.toISOString() };
    ctx.db.put('media', item);
    const uploadUrl = await ctx.env.google.signedUrl(keyOf(ctx, c), { bucket: c.bucket, object, method: 'PUT', contentType, expiresSeconds: 900 });
    return { item, uploadUrl, headers: { 'Content-Type': contentType } };
  });
  /** Step 2: the browser says the PUT finished. */
  r.post('/admin/media/:id/complete', { perm: 'comms' }, async (ctx) => {
    const m = find(ctx, 'media', ctx.params[0], 'File');
    const c = gcsConfig(ctx);
    // The demo keeps the picture itself, since there is no bucket to put it in.
    const url = ctx.env.demo && typeof ctx.body?.previewUrl === 'string' && ctx.body.previewUrl.startsWith('data:') ? String(ctx.body.previewUrl).slice(0, 600_000) : m.url;
    const next: MediaItem = { ...m, status: 'ready', url, size: Math.max(m.size, Math.floor(Number(ctx.body?.size) || 0)) };
    ctx.db.put('media', next);
    return (await mediaView(ctx, c, [next]))[0];
  });
  r.del('/admin/media/:id', { perm: 'comms' }, async (ctx) => {
    const m = find(ctx, 'media', ctx.params[0], 'File');
    const c = gcsConfig(ctx);
    if (c && ctx.env.google && m.status === 'ready' && !m.url.startsWith('data:')) {
      const token = await ctx.env.google.accessToken(keyOf(ctx, c), 'https://www.googleapis.com/auth/devstorage.read_write').catch(() => null);
      if (token) await needHttp(ctx)({ method: 'DELETE', url: `${GCS_API}/b/${encodeURIComponent(c.bucket)}/o/${encodeURIComponent(m.object)}`, headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined);
    }
    ctx.db.del('media', m.id);
    ctx.audit('deleted', 'media', m.id, `Deleted ${m.name} from the media library`);
    return undefined;
  });

  // ----- Canva -----
  /** Where to send the browser to connect the church's Canva. */
  r.get('/admin/integrations/canva/connect', { perm: 'settings' }, (ctx) => {
    const app = ctx.env.canvaApp;
    if (!app || !ctx.env.http) throw new ApiError(422, 'not_available', 'This server is not set up for Canva yet (CANVA_CLIENT_ID and CANVA_CLIENT_SECRET).');
    const { verifier, challenge } = app.pkce();
    const nonce = ctx.env.random(24, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    ctx.db.put('meta', { id: `canva:state:${nonce}`, value: JSON.stringify({ verifier, staffId: ctx.staff?.id ?? null, at: ctx.now.toISOString(), returnTo: String(ctx.body?.returnTo ?? ctx.query.returnTo ?? '') }) });
    const state = `${churchId(ctx)}.${nonce}`;
    const url = `${CANVA_AUTH}?${new URLSearchParams({ code_challenge: challenge, code_challenge_method: 's256', scope: CANVA_SCOPES, response_type: 'code', client_id: app.clientId, state, redirect_uri: app.redirectUrl }).toString()}`;
    // The demo has no Canva: the portal finishes the sign-in itself with this stand-in link.
    if (app.redirectUrl.startsWith('demo:')) return { url: `demo:canva?state=${encodeURIComponent(state)}`, state };
    return { url, state };
  });
  /** Canva sends the browser back to the host, which calls this with the code. */
  r.post('/integrations/canva/callback', { public: true }, async (ctx) => {
    const app = ctx.env.canvaApp;
    if (!app) throw new ApiError(422, 'not_available', 'Canva is not set up on this server.');
    const nonce = String(ctx.body?.state ?? '').split('.').pop() ?? '';
    const saved = ctx.db.get('meta', `canva:state:${nonce}`);
    if (!saved) throw new ApiError(400, 'bad_state', 'This Canva sign-in link has expired. Start again from Settings › Integrations.');
    ctx.db.del('meta', `canva:state:${nonce}`);
    const st = JSON.parse(saved.value) as { verifier: string; staffId: string | null; at: string; returnTo: string };
    if (ctx.now.getTime() - new Date(st.at).getTime() > 15 * 60_000) throw new ApiError(400, 'bad_state', 'This Canva sign-in link has expired. Start again from Settings › Integrations.');
    const t = await canvaTokens(ctx, { grant_type: 'authorization_code', code: String(ctx.body?.code ?? ''), code_verifier: st.verifier, redirect_uri: app.redirectUrl });
    const prof = await needHttp(ctx)({ method: 'GET', url: `${CANVA_API}/users/me/profile`, headers: { Authorization: `Bearer ${t.access}` } });
    const p = json(prof);
    const c: CanvaConfig = { id: 'canva', accessTokenSealed: ctx.env.seal(t.access), refreshTokenSealed: ctx.env.seal(t.refresh), expiresAt: new Date(ctx.now.getTime() + t.expiresIn * 1000).toISOString(), userName: String(p?.display_name ?? ''), teamName: String(p?.team_name ?? ''), connectedAt: ctx.now.toISOString(), connectedBy: ctx.db.get('staff', st.staffId ?? '')?.name ?? '', lastError: null };
    ctx.db.put('integrations', c);
    ctx.audit('connected', 'integration', 'canva', `Connected Canva (${c.userName})`);
    return { ok: true, returnTo: st.returnTo };
  });
  r.del('/admin/integrations/canva', { perm: 'settings' }, (ctx) => {
    if (canvaConfig(ctx)) {
      ctx.db.del('integrations', 'canva');
      ctx.audit('disconnected', 'integration', 'canva', 'Disconnected Canva');
    }
    return canvaStatus(ctx);
  });
  r.get('/admin/canva/designs', { perm: 'comms' }, (ctx) => ctx.db.all('canvaDesigns').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100));
  /**
   * Opens a design in the church's Canva: a blank one of the right size, or one started from a
   * picture (the invitation card drawn in Flockwise, the logo, a photo from the media library).
   */
  r.post('/admin/canva/designs', { perm: 'comms' }, async (ctx): Promise<CanvaDesign> => {
    const kind = DESIGN_SIZES[String(ctx.body?.kind ?? '')] ? String(ctx.body.kind) : 'social';
    const title = String(ctx.body?.title ?? `${settings(ctx).name} design`).trim().slice(0, 120) || 'Design';
    let assetId: string | null = null;
    const image = typeof ctx.body?.imageDataUrl === 'string' ? ctx.body.imageDataUrl : '';
    if (image) {
      if (image.length > 8_000_000) throw new ApiError(422, 'too_large', 'Pictures up to about 6 MB.');
      const { bytes, contentType } = dataUrlBytes(image);
      const meta = b64(JSON.stringify({ name_base64: b64(unescape(encodeURIComponent(title.slice(0, 50)))) }));
      const job = await canvaCall(ctx, { method: 'POST', path: '/asset-uploads', raw: { bytes, contentType, headers: { 'Asset-Upload-Metadata': meta } } });
      let j = job?.job;
      for (let i = 0; i < 20 && j && j.status === 'in_progress'; i++) {
        await new Promise((res) => setTimeout(res, ctx.env.demo ? 0 : 1000));
        j = (await canvaCall(ctx, { method: 'GET', path: `/asset-uploads/${j.id}` }))?.job;
      }
      if (!j || j.status !== 'success') throw new ApiError(502, 'canva_error', `Canva could not take the picture${j?.error?.message ? `: ${j.error.message}` : ''}.`);
      assetId = String(j.asset.id);
    }
    const size = DESIGN_SIZES[kind];
    const made = await canvaCall(ctx, { method: 'POST', path: '/designs', body: { design_type: { type: 'custom', width: size.width, height: size.height }, title, ...(assetId ? { asset_id: assetId } : {}) } });
    const d = made?.design;
    if (!d?.id) throw new ApiError(502, 'canva_error', 'Canva did not return a design.');
    const rec: CanvaDesign = { id: String(d.id), title: String(d.title ?? title), editUrl: String(d.urls?.edit_url ?? ''), viewUrl: String(d.urls?.view_url ?? ''), thumbnailUrl: d.thumbnail?.url ? String(d.thumbnail.url) : null, kind, createdAt: ctx.now.toISOString() };
    ctx.db.put('canvaDesigns', rec);
    ctx.audit('created', 'design', rec.id, `Opened "${rec.title}" in Canva`);
    return rec;
  });
}
