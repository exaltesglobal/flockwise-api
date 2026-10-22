// Message delivery. Email: SMTP (e.g. Hostinger mail) or Resend. SMS: MSG91 (India, DLT
// template) or Twilio. WhatsApp: Meta's WhatsApp Cloud API. Anything not configured is
// logged instead of sent, and the message is marked "simulated" in the admin.
import nodemailer from 'nodemailer';

import { config, emailConfigured } from './config.js';
import type { DeliveryResult, Outgoing, PushMessage, PushResult, SmtpAccount } from './core/index.js';
import type { Channel, ChannelStatus } from './core/types.js';

let transport: nodemailer.Transporter | null = null;
function smtp() {
  const s = config.email.smtp!;
  transport ??= nodemailer.createTransport({ host: s.host, port: s.port, secure: s.port === 465, auth: { user: s.user, pass: s.pass } });
  return transport;
}

async function sendEmail(m: Outgoing): Promise<DeliveryResult> {
  if (config.email.smtp) {
    await smtp().sendMail({ from: config.email.from, to: m.to, subject: m.subject, text: m.text });
    return { ok: true };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.email.resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.email.from, to: [m.to], subject: m.subject, text: m.text }),
    signal: AbortSignal.timeout(15_000),
  });
  return res.ok ? { ok: true } : { ok: false, error: `Resend ${res.status}` };
}

/** Indian mobile numbers to 91XXXXXXXXXX; others keep their country code. */
const e164 = (phone: string) => {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 10 ? `91${digits}` : digits;
};

async function sendSms(m: Outgoing): Promise<DeliveryResult> {
  if (config.sms.provider === 'msg91') {
    // MSG91 Flow API: the DLT-approved template must have a ##message## variable.
    const res = await fetch('https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: { authkey: config.sms.msg91.authKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ template_id: config.sms.msg91.templateId, short_url: '0', recipients: [{ mobiles: e164(m.to), message: m.text.slice(0, 600) }] }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok ? { ok: true } : { ok: false, error: `MSG91 ${res.status}` };
  }
  const t = config.sms.twilio;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${t.sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${t.sid}:${t.token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: `+${e164(m.to)}`, From: t.from, Body: m.text }),
    signal: AbortSignal.timeout(15_000),
  });
  return res.ok ? { ok: true } : { ok: false, error: `Twilio ${res.status}` };
}

async function sendWhatsapp(m: Outgoing): Promise<DeliveryResult> {
  const w = config.whatsapp;
  // Business-initiated WhatsApp messages need an approved template; free text only works
  // within 24 hours of the member writing to you.
  const payload = w.template
    ? { messaging_product: 'whatsapp', to: e164(m.to), type: 'template', template: { name: w.template, language: { code: w.templateLang }, components: [{ type: 'body', parameters: [{ type: 'text', text: m.text.replace(/\s*\n\s*/g, ' ').slice(0, 1000) }] }] } }
    : { messaging_product: 'whatsapp', to: e164(m.to), type: 'text', text: { body: m.text } };
  const res = await fetch(`https://graph.facebook.com/v21.0/${w.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${w.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  return res.ok ? { ok: true } : { ok: false, error: `WhatsApp ${res.status}` };
}

export function channelStatus(): ChannelStatus {
  const smsOk = config.sms.provider === 'msg91' ? !!(config.sms.msg91.authKey && config.sms.msg91.templateId) : config.sms.provider === 'twilio' ? !!(config.sms.twilio.sid && config.sms.twilio.token && config.sms.twilio.from) : false;
  return {
    email: { configured: emailConfigured(), provider: config.email.smtp ? 'SMTP' : config.email.resendKey ? 'Resend' : 'not set up' },
    sms: { configured: smsOk, provider: smsOk ? (config.sms.provider === 'msg91' ? 'MSG91' : 'Twilio') : 'not set up' },
    whatsapp: { configured: !!(config.whatsapp.token && config.whatsapp.phoneNumberId), provider: config.whatsapp.token ? 'WhatsApp Cloud API' : 'not set up' },
  };
}

export async function deliver(channel: Channel, batch: Outgoing[]): Promise<DeliveryResult[]> {
  if (!channelStatus()[channel].configured) {
    for (const m of batch) console.log(`[${channel} not configured] to ${m.to}: ${m.subject || m.text.slice(0, 60)}`);
    return batch.map(() => ({ ok: true }));
  }
  const send = channel === 'email' ? sendEmail : channel === 'sms' ? sendSms : sendWhatsapp;
  const out: DeliveryResult[] = [];
  // A few at a time keeps within provider rate limits.
  for (let i = 0; i < batch.length; i += 5) {
    const results = await Promise.all(batch.slice(i, i + 5).map((m) => send(m).catch((e: Error) => ({ ok: false, error: e.message }))));
    out.push(...results);
  }
  return out;
}

export async function sendOtpEmail(to: string, code: string, churchName: string) {
  const subject = `${code} is your ${churchName} sign-in code`;
  const text = `Your sign-in code is ${code}\n\nIt expires in 10 minutes. If you did not ask for this, you can ignore this email.\n\n${churchName} · Flockwise`;
  if (!emailConfigured()) {
    if (config.production) throw new Error('Email is not configured');
    console.log(`[email not configured] sign-in code for ${to}: ${code}`);
    return;
  }
  const r = await sendEmail({ to, name: '', subject, text });
  if (!r.ok) throw new Error(r.error ?? 'Email failed');
}

// ----- a church's own mailbox -----
const mailboxes = new Map<string, nodemailer.Transporter>();
/** Sends through the church's SMTP account (Gmail app password, Workspace, Outlook, Hostinger…). */
export async function sendViaMailbox(a: SmtpAccount, batch: Outgoing[]): Promise<DeliveryResult[]> {
  const key = `${a.host}:${a.port}:${a.user}:${a.pass}`;
  let t = mailboxes.get(key);
  if (!t) {
    if (mailboxes.size > 200) mailboxes.clear();
    t = nodemailer.createTransport({ host: a.host, port: a.port, secure: a.port === 465, auth: { user: a.user, pass: a.pass }, connectionTimeout: 15_000, socketTimeout: 20_000 });
    mailboxes.set(key, t);
  }
  const from = a.fromName ? { name: a.fromName, address: a.from } : a.from;
  const out: DeliveryResult[] = [];
  for (const m of batch) {
    try {
      await t.sendMail({ from, to: m.to, subject: m.subject, text: m.text });
      out.push({ ok: true });
    } catch (e) {
      out.push({ ok: false, error: (e as Error).message.slice(0, 200) });
    }
  }
  return out;
}

// ----- push to the member and team apps (Expo) -----
const EXPO_PUSH = 'https://exp.host/--/api/v2/push/send';
export async function expoPush(batch: PushMessage[]): Promise<PushResult[]> {
  const out: PushResult[] = [];
  for (let i = 0; i < batch.length; i += 100) {
    const chunk = batch.slice(i, i + 100);
    try {
      const res = await fetch(EXPO_PUSH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}) },
        body: JSON.stringify(chunk.map((m) => ({ to: m.token, title: m.title, body: m.body, data: m.data ?? {}, sound: 'default', channelId: 'default' }))),
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json().catch(() => null)) as { data?: { status: string; message?: string; details?: { error?: string } }[] } | null;
      const tickets = json?.data ?? [];
      chunk.forEach((_, j) => {
        const t = tickets[j];
        if (!t) out.push({ ok: false, error: `Expo ${res.status}` });
        else if (t.status === 'ok') out.push({ ok: true });
        else out.push({ ok: false, error: t.message ?? t.details?.error ?? 'push failed', gone: t.details?.error === 'DeviceNotRegistered' });
      });
    } catch (e) {
      chunk.forEach(() => out.push({ ok: false, error: (e as Error).message }));
    }
  }
  return out;
}
