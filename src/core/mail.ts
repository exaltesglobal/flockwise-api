// The church's own mailbox. When the office connects one (Gmail, Google Workspace, Outlook,
// Hostinger mail or any SMTP server), every email Flockwise sends for that church, sign-in
// codes included, leaves from that address instead of the server's shared one.
import type { Db } from './db.js';
import type { Env, Outgoing, SmtpAccount } from './engine.js';
import type { EmailAccountConfig } from './types.js';

export const emailAccount = (db: Db) => db.get('integrations', 'email') as EmailAccountConfig | undefined;

export function unsealAccount(env: Env, c: EmailAccountConfig): SmtpAccount {
  return { host: c.host, port: c.port, user: c.user, pass: env.unseal(c.passSealed), from: c.from, fromName: c.fromName };
}

/** Env with email routed through the church mailbox when one is connected and the host can do SMTP. */
export function withChurchMail(db: Db, env: Env): Env {
  const send = async (batch: Outgoing[]) => {
    const c = emailAccount(db);
    if (!c || !env.smtp) return env.deliver('email', batch);
    const out = await env.smtp(unsealAccount(env, c), batch).catch((e: Error) => batch.map(() => ({ ok: false, error: e.message })));
    const failed = out.find((r) => !r.ok);
    const sent = out.some((r) => r.ok);
    db.put('integrations', { ...c, lastError: failed && !sent ? failed.error ?? 'Sending failed' : null, lastSentAt: sent ? env.now().toISOString() : c.lastSentAt });
    return out;
  };
  return {
    ...env,
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
  };
}
