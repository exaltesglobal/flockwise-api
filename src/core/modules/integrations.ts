// Connections to other apps: Chitthi for WhatsApp, and API keys for the public API and MCP.
import type { Ctx, DeliveryResult, Outgoing, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { ApiKeyRecord, ApiKeyView, Channel, ChannelStatus, ChitthiConfig, ChitthiStatus, ChitthiTemplate, PaymentsStatus, RazorpayConfig } from '../types.js';
import { churchId, settings } from '../util.js';

export const CHITTHI_SIGNUP = 'https://app.chitthi.live/signup?ref=flockwise';

const chitthi = (ctx: Ctx) => ctx.db.get('integrations', 'chitthi') as ChitthiConfig | undefined;
export const razorpayConfig = (ctx: Pick<Ctx, 'db'>) => ctx.db.get('integrations', 'razorpay') as RazorpayConfig | undefined;

function chitthiStatus(ctx: Ctx): ChitthiStatus {
  const c = chitthi(ctx);
  return {
    connected: !!c, workspace: c?.workspace ?? '', keyHint: c?.keyHint ?? '', template: c?.template ?? '', language: c?.language ?? 'en', params: c?.params ?? 1,
    connectedAt: c?.connectedAt ?? null, lastError: c?.lastError ?? null, lastSentAt: c?.lastSentAt ?? null, signupUrl: CHITTHI_SIGNUP,
  };
}

/** Channel status with WhatsApp marked as going through Chitthi when the church connected it. */
export function channelStatus(ctx: Ctx): ChannelStatus {
  const base = ctx.env.channels();
  const c = chitthi(ctx);
  return c ? { ...base, whatsapp: { configured: true, provider: `Chitthi (${c.workspace})` } } : base;
}

const errMessage = (data: unknown, status: number) => (data as { error?: { message?: string } } | null)?.error?.message ?? `Chitthi answered ${status}.`;

/** WhatsApp template values may not contain new lines or long runs of spaces. */
const flat = (s: string) => s.replace(/\s*\n\s*/g, ' · ').replace(/\s{4,}/g, '   ').trim().slice(0, 1000);

async function sendChitthi(ctx: Ctx, c: ChitthiConfig, key: string, m: Outgoing): Promise<DeliveryResult> {
  const first = m.name.split(' ')[0] || 'friend';
  const params = c.params <= 0 ? [] : c.params === 1 ? [flat(m.text)] : [first, flat(m.text), ...Array(Math.max(0, c.params - 2)).fill('-')];
  const body = c.template ? { to: m.to, template: c.template, language: c.language || 'en', params } : { to: m.to, text: m.text };
  const res = await ctx.env.chitthi(key, { method: 'POST', path: '/api/v1/messages', body });
  return res.status < 300 ? { ok: true } : { ok: false, error: errMessage(res.data, res.status) };
}

/** Sends a batch on a channel: WhatsApp through Chitthi when connected, otherwise the host's providers. */
export async function deliverAll(ctx: Ctx, channel: Channel, batch: Outgoing[]): Promise<DeliveryResult[]> {
  const c = channel === 'whatsapp' ? chitthi(ctx) : undefined;
  if (!c) return ctx.env.deliver(channel, batch);
  const key = ctx.env.unseal(c.apiKeySealed);
  const out: DeliveryResult[] = [];
  for (let i = 0; i < batch.length; i += 5) {
    out.push(...(await Promise.all(batch.slice(i, i + 5).map((m) => sendChitthi(ctx, c, key, m).catch((e: Error) => ({ ok: false, error: e.message }))))));
  }
  const failed = out.find((r) => !r.ok);
  const sent = out.some((r) => r.ok);
  ctx.db.put('integrations', { ...c, lastError: failed && !sent ? failed.error ?? 'Sending failed' : null, lastSentAt: sent ? ctx.env.now().toISOString() : c.lastSentAt });
  return out;
}

function keyView(ctx: Ctx, k: ApiKeyRecord): ApiKeyView {
  const { hash: _hash, ...rest } = k;
  return { ...rest, createdByName: ctx.db.get('staff', k.staffId)?.name ?? 'Former staff' };
}

const cleanTemplate = (body: Record<string, unknown>) => ({
  template: String(body.template ?? '').trim().slice(0, 120),
  language: String(body.language ?? 'en').trim().slice(0, 12) || 'en',
  params: Math.max(0, Math.min(10, Math.floor(Number(body.params ?? 1)) || 0)),
});

export function registerIntegrations(r: Router) {
  r.get('/admin/integrations', { perm: 'settings' }, (ctx) => ({ chitthi: chitthiStatus(ctx) }));

  r.post('/admin/integrations/chitthi', { perm: 'settings' }, async (ctx) => {
    const apiKey = String(ctx.body.apiKey ?? '').trim();
    if (!/^chk_(live|test)_[A-Za-z0-9_-]{8,}$/.test(apiKey)) throw new ApiError(400, 'invalid_key', 'Paste the API key from Chitthi › Settings › Developer. It starts with chk_live_.');
    const res = await ctx.env.chitthi(apiKey, { method: 'GET', path: '/api/integrations/hooks' }).catch(() => null);
    if (!res) throw new ApiError(502, 'chitthi_unreachable', 'Could not reach Chitthi. Try again in a minute.');
    if (res.status === 401) throw new ApiError(400, 'invalid_key', 'Chitthi did not accept this key. Make a new one in Chitthi › Settings › Developer.');
    if (res.status >= 300) throw new ApiError(502, 'chitthi_error', errMessage(res.data, res.status));
    const now = ctx.now.toISOString();
    const t = cleanTemplate(ctx.body);
    const c: ChitthiConfig = ctx.db.put('integrations', {
      id: 'chitthi', apiKeySealed: ctx.env.seal(apiKey), keyHint: `${apiKey.slice(0, 9)}…${apiKey.slice(-4)}`, workspace: String(res.data?.workspace ?? 'Chitthi'),
      ...t, connectedAt: now, connectedBy: ctx.staff!.name, lastError: null, lastSentAt: null,
    } satisfies ChitthiConfig) as ChitthiConfig;
    ctx.audit('connected', 'integration', 'chitthi', `Connected Chitthi workspace ${c.workspace} for WhatsApp`);
    return chitthiStatus(ctx);
  });

  r.patch('/admin/integrations/chitthi', { perm: 'settings' }, (ctx) => {
    const c = chitthi(ctx);
    if (!c) throw new ApiError(404, 'not_connected', 'Chitthi is not connected.');
    ctx.db.put('integrations', { ...c, ...cleanTemplate({ ...c, ...ctx.body }) });
    ctx.audit('updated', 'integration', 'chitthi', 'Changed the Chitthi WhatsApp template');
    return chitthiStatus(ctx);
  });

  r.del('/admin/integrations/chitthi', { perm: 'settings' }, (ctx) => {
    if (!chitthi(ctx)) return chitthiStatus(ctx);
    ctx.db.del('integrations', 'chitthi');
    ctx.audit('disconnected', 'integration', 'chitthi', 'Disconnected Chitthi');
    return chitthiStatus(ctx);
  });

  /** Approved templates in the church's Chitthi workspace (empty when Chitthi cannot list them yet). */
  r.get('/admin/integrations/chitthi/templates', { perm: 'settings' }, async (ctx): Promise<{ available: boolean; data: ChitthiTemplate[] }> => {
    const c = chitthi(ctx);
    if (!c) throw new ApiError(404, 'not_connected', 'Chitthi is not connected.');
    const res = await ctx.env.chitthi(ctx.env.unseal(c.apiKeySealed), { method: 'GET', path: '/api/v1/templates' }).catch(() => null);
    if (!res || res.status >= 300 || !Array.isArray(res.data?.data)) return { available: false, data: [] };
    return { available: true, data: (res.data.data as ChitthiTemplate[]).map((t) => ({ name: String(t.name), language: String(t.language), category: String(t.category ?? ''), body: String(t.body ?? ''), params: Number(t.params) || 0 })) };
  });

  r.post('/admin/integrations/chitthi/test', { perm: 'settings' }, async (ctx) => {
    if (!chitthi(ctx)) throw new ApiError(404, 'not_connected', 'Chitthi is not connected.');
    const phone = String(ctx.body.phone ?? ctx.staff?.phone ?? '').trim();
    if (phone.replace(/\D/g, '').length < 10) throw new ApiError(400, 'invalid_phone', 'Enter a WhatsApp number to send the test to.');
    const [res] = await deliverAll(ctx, 'whatsapp', [{ to: phone, name: ctx.staff!.name, subject: '', text: `Test from Flockwise: WhatsApp messages from ${settings(ctx).name} now go through Chitthi.` }]);
    if (!res.ok) throw new ApiError(502, 'send_failed', res.error ?? 'Chitthi could not send the message.');
    return { ok: true };
  });

  // ----- API keys -----
  r.get('/admin/api-keys', { perm: 'settings' }, (ctx) =>
    ctx.db.all('apiKeys').filter((k) => !k.revokedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((k) => keyView(ctx, k)));

  r.post('/admin/api-keys', { perm: 'settings' }, (ctx) => {
    const name = String(ctx.body.name ?? '').trim().slice(0, 60);
    if (!name) throw new ApiError(400, 'name_required', 'Give the key a name, e.g. "Zapier" or "Claude".');
    if (ctx.db.all('apiKeys').filter((k) => !k.revokedAt).length >= 20) throw new ApiError(400, 'too_many_keys', 'You have 20 keys. Revoke one you no longer use first.');
    const secret = `fw_live_${churchId(ctx)}.${ctx.env.random(32, 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789')}`;
    const k = ctx.db.put('apiKeys', {
      id: ctx.id('key'), name, prefix: secret.slice(0, 12), hash: ctx.env.hash(secret), staffId: ctx.staff!.id,
      access: ctx.body.access === 'full' ? 'full' : 'read', createdAt: ctx.now.toISOString(), lastUsedAt: null, revokedAt: null,
    });
    ctx.audit('created', 'api key', k.id, `Made ${k.access === 'full' ? 'a full-access' : 'a read-only'} API key "${name}"`);
    // The secret is shown once; only its hash is kept.
    return { key: keyView(ctx, k), secret };
  });

  r.del('/admin/api-keys/:id', { perm: 'settings' }, (ctx) => {
    const k = ctx.db.get('apiKeys', ctx.params[0]);
    if (!k || k.revokedAt) throw new ApiError(404, 'not_found', 'That key was not found.');
    ctx.db.put('apiKeys', { ...k, revokedAt: ctx.now.toISOString() });
    ctx.audit('revoked', 'api key', k.id, `Revoked API key "${k.name}"`);
    return undefined;
  });
}

// ----- the church's own Razorpay account for gifts -----
const KEY_RE = /^rzp_(live|test)_[A-Za-z0-9]{6,}$/;

export function paymentsStatus(ctx: Ctx): PaymentsStatus {
  const c = razorpayConfig(ctx);
  return { connected: !!c || !!ctx.env.serverPaymentKeys, keyId: c?.main.keyId ?? null, mode: c ? (c.main.keyId.startsWith('rzp_live_') ? 'live' : 'test') : null, fcraKeyId: c?.fcra?.keyId ?? null, webhookPath: `/v1/webhooks/razorpay/${churchId(ctx)}`, serverKeys: !!ctx.env.serverPaymentKeys && !c };
}

async function sealAccount(ctx: Ctx, raw: unknown, label: string) {
  const a = (raw ?? {}) as Record<string, unknown>;
  const keyId = String(a.keyId ?? '').trim();
  const keySecret = String(a.keySecret ?? '').trim();
  const webhookSecret = String(a.webhookSecret ?? '').trim();
  if (!KEY_RE.test(keyId)) throw new ApiError(422, 'invalid', `The ${label} Key ID starts with rzp_live_ or rzp_test_.`, { keyId: 'Paste the Key ID from Razorpay' });
  if (keySecret.length < 10) throw new ApiError(422, 'invalid', `Paste the ${label} Key Secret.`, { keySecret: 'Paste the Key Secret' });
  if (webhookSecret.length < 6) throw new ApiError(422, 'invalid', `Paste the ${label} webhook secret you set in Razorpay.`, { webhookSecret: 'Paste the webhook secret' });
  if (ctx.env.verifyRazorpay && !(await ctx.env.verifyRazorpay(keyId, keySecret))) throw new ApiError(422, 'razorpay_rejected', `Razorpay did not accept the ${label} keys. Check the Key ID and Secret, and that the account is activated.`);
  return { keyId, keySecretSealed: ctx.env.seal(keySecret), webhookSecretSealed: ctx.env.seal(webhookSecret) };
}

export function registerPayments(r: Router) {
  r.get('/admin/settings/payments', { perm: 'settings' }, (ctx) => paymentsStatus(ctx));
  r.post('/admin/settings/payments/razorpay', { perm: 'settings' }, async (ctx) => {
    const main = await sealAccount(ctx, ctx.body, 'Razorpay');
    const fcra = ctx.body.fcra?.keyId ? await sealAccount(ctx, ctx.body.fcra, 'FCRA account') : null;
    ctx.db.put('integrations', { id: 'razorpay', main, fcra, connectedAt: ctx.now.toISOString(), connectedBy: ctx.staff?.name ?? '' });
    const s = settings(ctx);
    ctx.db.put('settings', { ...s, paymentProvider: 'razorpay', payments: { provider: 'razorpay', connected: true, accountId: main.keyId } });
    ctx.audit('connected', 'payments', null, `Connected Razorpay (${main.keyId})${fcra ? ' with an FCRA account' : ''}`);
    return paymentsStatus(ctx);
  });
  r.del('/admin/settings/payments/razorpay', { perm: 'settings' }, (ctx) => {
    ctx.db.del('integrations', 'razorpay');
    const s = settings(ctx);
    ctx.db.put('settings', { ...s, payments: { ...s.payments, connected: !!ctx.env.serverPaymentKeys, accountId: null } });
    ctx.audit('disconnected', 'payments', null, 'Disconnected Razorpay');
    return paymentsStatus(ctx);
  });
}
