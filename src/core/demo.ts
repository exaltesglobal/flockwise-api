// Host hooks for demo mode: everything stays in memory, gifts succeed instantly and
// messages are only logged. Used by the web demo and by tests.
import type { Env } from './engine.js';
import type { Channel } from './types.js';

export function createDemoEnv(opts: { now?: () => Date; webUrl?: string } = {}): Env & { outbox: { channel: Channel; to: string; subject: string; text: string }[] } {
  let seq = 0;
  const outbox: { channel: Channel; to: string; subject: string; text: string }[] = [];
  const rand = () => {
    const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
    if (c?.getRandomValues) return c.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
    return Math.random();
  };
  return {
    demo: true,
    outbox,
    now: opts.now ?? (() => new Date()),
    newId: (prefix) => `${prefix}_${Date.now().toString(36)}${(++seq).toString(36)}${Math.floor(rand() * 1e6).toString(36)}`,
    random: (length, alphabet) => Array.from({ length }, () => alphabet[Math.floor(rand() * alphabet.length)]).join(''),
    // Demo only: no secrets are stored, so a plain marker is enough.
    hash: (v) => `demo:${v}`,
    signAccess: (claims) => ({ token: `demo.${btoa(JSON.stringify(claims))}`, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() }),
    sendOtpEmail: async () => undefined,
    deliver: async (channel, batch) => {
      for (const m of batch) outbox.push({ channel, to: m.to, subject: m.subject, text: m.text });
      return batch.map(() => ({ ok: true }));
    },
    channels: () => ({ email: { configured: false, provider: 'demo' }, sms: { configured: false, provider: 'demo' }, whatsapp: { configured: false, provider: 'demo' } }),
    checkout: async () => ({ checkoutUrl: '', providerRef: null, provider: 'demo', status: 'succeeded' }),
    webUrl: opts.webUrl ?? '',
    // A stand-in Chitthi: any well-formed key works except ones containing "bad".
    chitthi: async (apiKey, req) => {
      if (apiKey.includes('bad')) return { status: 401, data: { error: { message: 'Missing or invalid API key.' } } };
      if (req.path === '/api/integrations/hooks') return { status: 200, data: { workspace: 'Grace Church WhatsApp', hooks: [] } };
      if (req.path === '/api/v1/templates') return { status: 200, data: { data: [{ name: 'church_update', language: 'en', category: 'UTILITY', body: 'Hello from church: {{1}}', params: 1 }, { name: 'church_update_hi', language: 'hi', category: 'UTILITY', body: 'नमस्ते {{1}}, {{2}}', params: 2 }] } };
      if (req.path === '/api/v1/messages') {
        const b = req.body as { to: string; text?: string; template?: string; params?: string[] };
        outbox.push({ channel: 'whatsapp', to: b.to, subject: b.template ? `chitthi:${b.template}` : 'chitthi', text: b.text ?? (b.params ?? []).join(' | ') });
        return { status: 201, data: { id: 'msg_demo', wa_message_id: 'wamid.demo', conversation_id: 'cv_demo' } };
      }
      return { status: 404, data: { error: { message: 'Not found' } } };
    },
    seal: (v) => `demo:${v}`,
    unseal: (v) => v.replace(/^demo:/, ''),
  };
}

/** Reads the claims back out of a demo access token. */
export function readDemoToken(token: string | null | undefined) {
  if (!token?.startsWith('demo.')) return null;
  try {
    return JSON.parse(atob(token.slice(5)));
  } catch {
    return null;
  }
}
