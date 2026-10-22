// The church's own mailbox. When the office connects one (Gmail, Google Workspace, Outlook,
// Hostinger mail or any SMTP server), every email Flockwise sends for that church, sign-in
// codes included, leaves from that address instead of the server's shared one.
import type { Db } from './db.js';
import type { Env, Outgoing, SmtpAccount } from './engine.js';
import type { ChurchSettings, EmailAccountConfig } from './types.js';

export const emailAccount = (db: Db) => db.get('integrations', 'email') as EmailAccountConfig | undefined;

export function unsealAccount(env: Env, c: EmailAccountConfig): SmtpAccount {
  return { host: c.host, port: c.port, user: c.user, pass: env.unseal(c.passSealed), from: c.from, fromName: c.fromName };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
const DEFAULT_PRIMARY = '#1f6b5c';

/** Plain text as simple HTML paragraphs, with links clickable. */
function paragraphs(text: string) {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((para) => `<p style="margin:0 0 14px;line-height:1.55">${esc(para).replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" style="color:inherit">${u}</a>`).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** The church's letterhead around a plain-text email: logo beside the name in the brand colour, address underneath. */
export function brandedHtml(s: Pick<ChurchSettings, 'name' | 'logoUrl' | 'brand' | 'address' | 'city' | 'website'>, m: Pick<Outgoing, 'text'>): string {
  const primary = s.brand?.primary ?? DEFAULT_PRIMARY;
  const serif = s.brand?.font === 'classic' || s.brand?.font === 'elegant';
  const font = serif ? "Georgia, 'Times New Roman', serif" : "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
  const logo = s.logoUrl ? `<img src="${esc(s.logoUrl)}" alt="" width="44" height="44" style="display:block;width:44px;height:44px;object-fit:contain;border-radius:8px;background:#fff">` : '';
  const foot = [s.address, s.city].filter(Boolean).join(', ');
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f4;font-family:${font};color:#1b2320">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f5f4"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:${esc(primary)};padding:16px 22px"><table role="presentation" cellspacing="0" cellpadding="0"><tr>${logo ? `<td style="padding-right:12px">${logo}</td>` : ''}<td style="color:#fff;font-size:19px;font-weight:700;letter-spacing:.01em">${esc(s.name)}</td></tr></table></td></tr>
<tr><td style="padding:24px 22px 10px;font-size:16px">${paragraphs(m.text)}</td></tr>
<tr><td style="padding:12px 22px 20px;border-top:1px solid #e6eae8;font-size:12px;color:#6b7572">${esc(s.name)}${foot ? ` · ${esc(foot)}` : ''}${s.website ? ` · <a href="${esc(s.website)}" style="color:#6b7572">${esc(s.website.replace(/^https?:\/\//, ''))}</a>` : ''}</td></tr>
</table></td></tr></table></body></html>`;
}

/** Env with email routed through the church mailbox when one is connected and the host can do SMTP. */
export function withChurchMail(db: Db, env: Env): Env {
  const send = async (raw: Outgoing[]) => {
    const s = db.get('settings', 'church');
    // Every email goes out on the church's letterhead; callers only write the text.
    const batch = s ? raw.map((m) => (m.html ? m : { ...m, html: brandedHtml(s, m) })) : raw;
    const c = emailAccount(db);
    if (!c || !env.smtp) return env.deliver('email', batch);
    const out = await env.smtp(unsealAccount(env, c), batch).catch((e: Error) => batch.map(() => ({ ok: false, error: e.message })));
    const failed = out.find((r) => !r.ok);
    const sent = out.some((r) => r.ok);
    db.put('integrations', { ...c, lastError: failed && !sent ? failed.error ?? 'Sending failed' : null, lastSentAt: sent ? env.now().toISOString() : c.lastSentAt });
    return out;
  };
  // Hosts may build the env on a prototype (the web demo does), so override on top of it rather than copying.
  return Object.assign(Object.create(env) as Env, {
    deliver: (channel, batch) => (channel === 'email' ? send(batch) : env.deliver(channel, batch)),
    sendOtpEmail: async (to, code, churchName) => {
      const c = emailAccount(db);
      if (!c || !env.smtp) return env.sendOtpEmail(to, code, churchName);
      const [r] = await send([{ to, name: '', subject: `${code} is your ${churchName} sign-in code`, text: `Your sign-in code is ${code}\n\nIt expires in 10 minutes. If you did not ask for this, you can ignore this email.\n\n${churchName}` }]);
      if (!r?.ok) throw new Error(r?.error ?? 'Email failed');
    },
    channels: () => {
      const base = env.channels();
      const c = emailAccount(db);
      return c && env.smtp ? { ...base, email: { configured: true, provider: c.from } } : base;
    },
  } satisfies Partial<Env>);
}
