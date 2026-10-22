// The WhatsApp assistant: people message the church's WhatsApp number (run on Chitthi) and get
// service times, this week's events, a giving link or the latest sermon, can send a prayer request,
// say they are new, or ask to talk to someone. Chitthi forwards each message here by webhook.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import { atLeast, effectivePlan, getSubscription } from '../plans.js';
import type { BotIntent, BotMessage, ChitthiConfig, WaBotConfig, WaBotStatus } from '../types.js';
import { bySoonest, churchId, DAY, fullName, newPerson, normPhone, settings, upcoming } from '../util.js';
import { publicPageOf } from './ministry.js';
import { logConsent } from './privacy.js';

const KEEP = 500;
const STATE_TTL = 30 * 60_000;

export const botConfig = (ctx: Pick<Ctx, 'db'>) => ctx.db.get('integrations', 'waBot') as WaBotConfig | undefined;
const chitthi = (ctx: Ctx) => ctx.db.get('integrations', 'chitthi') as ChitthiConfig | undefined;

const defaultWelcome = (ctx: Ctx) => `Welcome to ${settings(ctx).name}! 🙏`;

/** What a message asks for. Numbers match the menu; a few words in English and Hindi work too. */
export function intentOf(text: string): BotIntent {
  const t = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return 'menu';
  if (/^(stop|unsubscribe|band karo)$/.test(t)) return 'stop';
  if (/^(start|subscribe)$/.test(t)) return 'start';
  if (/^(hi|hello|hey|menu|help|namaste|namaskar|praise the lord|ptl|0)$/.test(t)) return 'menu';
  if (/^1$|service|timing|time|samay|worship|mass/.test(t)) return 'services';
  if (/^2$|event|programme|program|this week/.test(t)) return 'events';
  if (/^3$|pray|prarthana|prayer/.test(t)) return 'prayer_ask';
  if (/^4$|give|offering|tithe|donat|daan|upi/.test(t)) return 'give';
  if (/^5$|sermon|message|preach|video/.test(t)) return 'sermon';
  if (/^6$|new here|i m new|im new|first time|visitor|naya/.test(t)) return 'new';
  if (/^7$|talk|call me|pastor|office|someone/.test(t)) return 'talk';
  return 'unknown';
}

function when(ctx: Ctx, isoAt: string) {
  try {
    return new Intl.DateTimeFormat('en-IN', { timeZone: settings(ctx).timezone || 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(isoAt));
  } catch {
    return isoAt.slice(0, 16).replace('T', ' ');
  }
}

function menu(welcome: string) {
  return [
    welcome,
    '',
    'Reply with a number:',
    '1️⃣ Service times',
    '2️⃣ Events this week',
    '3️⃣ Send a prayer request',
    '4️⃣ Give online',
    '5️⃣ Latest sermon',
    '6️⃣ I’m new here',
    '7️⃣ Talk to someone from the church',
  ].join('\n');
}

function state(ctx: Ctx, phone: string): string | null {
  const m = ctx.db.get('meta', `bot:${phone}`);
  if (!m) return null;
  const [what, at] = String(m.value).split('|');
  return ctx.now.getTime() - Number(at) < STATE_TTL ? what : null;
}
const setState = (ctx: Ctx, phone: string, what: string | null) =>
  what ? ctx.db.put('meta', { id: `bot:${phone}`, value: `${what}|${ctx.now.getTime()}` }) : ctx.db.del('meta', `bot:${phone}`);

function careCase(ctx: Ctx, personId: string | null, personName: string, title: string, note: string) {
  ctx.db.put('care', {
    id: ctx.id('cc'), personId, personName, type: 'follow_up', title, status: 'open', priority: 'normal', assignedTo: null, assignedName: null,
    dueAt: new Date(ctx.now.getTime() + DAY).toISOString(), createdAt: ctx.now.toISOString(), closedAt: null,
    notes: note ? [{ id: ctx.id('cn'), at: ctx.now.toISOString(), by: 'WhatsApp assistant', text: note }] : [], source: 'manual', confidential: false,
  });
}

/** Works out the reply to one incoming message and records what it did. Pure apart from the database. */
export function answer(ctx: Ctx, msg: { phone: string; name: string; text: string }, dry = false): { intent: BotIntent; reply: string; personId: string | null } {
  const cfg = botConfig(ctx);
  const s = settings(ctx);
  const phone = normPhone(msg.phone);
  let person = ctx.db.all('people').find((p) => phone.length === 10 && normPhone(p.phone) === phone) ?? null;
  const name = person ? person.firstName : msg.name.split(/\s+/)[0] || 'friend';
  const web = ctx.env.webUrl;
  const waiting = state(ctx, phone);
  let intent: BotIntent = intentOf(msg.text);

  // A prayer request is the message after "3", unless they typed a menu word instead.
  if (waiting === 'prayer' && !['menu', 'stop'].includes(intent) && msg.text.trim().length > 3) intent = 'prayer';
  if (intent !== 'prayer_ask' && !dry) setState(ctx, phone, null);

  switch (intent) {
    case 'menu':
      return { intent, personId: person?.id ?? null, reply: menu(cfg?.welcome || defaultWelcome(ctx)) };
    case 'services': {
      const times = publicPageOf(ctx).serviceTimes.trim();
      const next = ctx.db.all('events').filter((e) => e.published && upcoming(ctx, e) && e.kind === 'service').sort(bySoonest).slice(0, 3);
      const lines = [times ? `🕊️ Our services:\n${times}` : next.length ? '🕊️ Next services:' : 'Please call the church office for service times.'];
      if (!times) for (const e of next) lines.push(`• ${when(ctx, e.startsAt)} · ${e.title}${e.location ? ` (${e.location})` : ''}`);
      if (s.address) lines.push('', `📍 ${s.address}`);
      return { intent, personId: person?.id ?? null, reply: lines.join('\n') };
    }
    case 'events': {
      const soon = ctx.db.all('events').filter((e) => e.published && upcoming(ctx, e) && new Date(e.startsAt).getTime() < ctx.now.getTime() + 8 * DAY).sort(bySoonest).slice(0, 6);
      if (!soon.length) return { intent, personId: person?.id ?? null, reply: `Nothing else is planned for the next week. See everything coming up: ${web}/app/events` };
      return { intent, personId: person?.id ?? null, reply: ['📅 This week:', ...soon.map((e) => `• ${when(ctx, e.startsAt)} · ${e.title}${e.location ? ` (${e.location})` : ''}`), '', `RSVP and more: ${web}/app/events`].join('\n') };
    }
    case 'prayer_ask':
      if (!dry) setState(ctx, phone, 'prayer');
      return { intent, personId: person?.id ?? null, reply: `🙏 ${name}, please type your prayer request in one message. Only our pastors will see it.` };
    case 'prayer': {
      if (dry) return { intent, personId: person?.id ?? null, reply: `Thank you, ${name}. Our pastors will pray for you. 🙏` };
      ctx.db.put('prayer', { id: ctx.id('pr'), personId: person?.id ?? null, name: person ? fullName(person) : msg.name || msg.phone, text: msg.text.trim().slice(0, 1000), visibility: 'pastors', status: 'open', prayedBy: [], createdAt: ctx.now.toISOString(), answeredNote: null });
      ctx.audit('created', 'prayer', null, `Prayer request from ${person ? fullName(person) : msg.name || msg.phone} on WhatsApp`);
      return { intent, personId: person?.id ?? null, reply: `Thank you, ${name}. Our pastors will pray for you. 🙏\n\n“Cast all your anxiety on him because he cares for you.” 1 Peter 5:7` };
    }
    case 'give':
      return { intent, personId: person?.id ?? null, reply: `Thank you for giving! 💛\nGive by UPI, card or netbanking here: ${web}/app/give\n\nYou can also set up a monthly gift with UPI AutoPay, and download your 80G receipts from the same page.` };
    case 'sermon': {
      const sermon = ctx.db.all('sermons').filter((x) => x.published).sort((x, y) => y.date.localeCompare(x.date))[0];
      if (!sermon) return { intent, personId: person?.id ?? null, reply: 'Sermons will appear here soon.' };
      const link = sermon.videoUrl || sermon.audioUrl || `${web}/app/sermons`;
      return { intent, personId: person?.id ?? null, reply: `🎙️ ${sermon.title}\n${[sermon.speaker, sermon.scripture].filter(Boolean).join(' · ')}\n${link}` };
    }
    case 'new': {
      if (dry) return { intent, personId: person?.id ?? null, reply: `We’re so glad you found us, ${name}! 🎉\nSomeone from ${s.name} will message you soon.` };
      if (!person) {
        const [first, ...rest] = (msg.name || 'Guest').trim().split(/\s+/);
        person = ctx.db.put('people', { ...newPerson(ctx, { firstName: first || 'Guest', lastName: rest.join(' '), phone: msg.phone, status: 'visitor' }), tags: ['WhatsApp'] });
        ctx.audit('created', 'person', person.id, `Added ${fullName(person)} from WhatsApp`);
      }
      careCase(ctx, person.id, fullName(person), 'Welcome a newcomer from WhatsApp', `${fullName(person)} said they are new (${msg.phone}).`);
      return { intent, personId: person.id, reply: `We’re so glad you found us, ${name}! 🎉\nSomeone from ${s.name} will message you soon. Reply 1 for service times${s.address ? ` · 📍 ${s.address}` : ''}.` };
    }
    case 'talk':
      if (!dry) careCase(ctx, person?.id ?? null, person ? fullName(person) : msg.name || msg.phone, 'Wants to talk (WhatsApp)', `Phone ${msg.phone}. Message: ${msg.text.trim().slice(0, 300)}`);
      return { intent, personId: person?.id ?? null, reply: `Thank you, ${name}. Someone from the church will message you soon.${s.phone ? ` If it’s urgent, call ${s.phone}.` : ''}` };
    case 'stop':
      if (person && !dry) logConsent(ctx, person.id, person.consent, ctx.db.put('people', { ...person, consent: { ...person.consent, whatsapp: false } }).consent, 'whatsapp');
      return { intent, personId: person?.id ?? null, reply: 'You won’t get WhatsApp updates from us any more. Reply START to turn them back on.' };
    case 'start':
      if (person && !dry) logConsent(ctx, person.id, person.consent, ctx.db.put('people', { ...person, consent: { ...person.consent, whatsapp: true } }).consent, 'whatsapp');
      return { intent, personId: person?.id ?? null, reply: 'Welcome back! You’ll get WhatsApp updates from us again. Reply MENU any time.' };
    default:
      return { intent: 'unknown', personId: person?.id ?? null, reply: `Sorry, I didn’t understand that.\n\n${menu('').trim()}` };
  }
}

/** Handles one message Chitthi forwarded (already verified by the host) and sends the reply. Never throws. */
export async function handleBotMessage(ctx: Ctx, msg: { phone: string; name: string; text: string; type?: string }) {
  const cfg = botConfig(ctx);
  const c = chitthi(ctx);
  if (!cfg?.enabled || !c) return null;
  if (!atLeast(effectivePlan(getSubscription(ctx.db), ctx.now), 'grow')) return null;
  if (msg.type && msg.type !== 'text' && msg.type !== 'button' && msg.type !== 'interactive') msg = { ...msg, text: 'menu' };
  const out = answer(ctx, msg);
  let sent = false;
  let error: string | null = null;
  try {
    const res = await ctx.env.chitthi(ctx.env.unseal(c.apiKeySealed), { method: 'POST', path: '/api/v1/messages', body: { to: msg.phone, text: out.reply } });
    sent = res.status < 300;
    if (!sent) error = (res.data as { error?: { message?: string } } | null)?.error?.message ?? `Chitthi answered ${res.status}`;
  } catch (e) {
    error = e instanceof Error ? e.message : 'Could not reach Chitthi';
  }
  const log: BotMessage = { id: ctx.id('bm'), at: ctx.now.toISOString(), phone: msg.phone, name: msg.name, personId: out.personId, text: msg.text.slice(0, 500), intent: out.intent, reply: out.reply, sent };
  ctx.db.put('botMessages', log);
  const all = ctx.db.all('botMessages');
  if (all.length > KEEP) for (const old of all.sort((a, b) => a.at.localeCompare(b.at)).slice(0, all.length - KEEP)) ctx.db.del('botMessages', old.id);
  ctx.db.put('integrations', { ...cfg, lastMessageAt: log.at, lastError: error });
  return log;
}

function status(ctx: Ctx): WaBotStatus {
  const cfg = botConfig(ctx);
  const since = new Date(ctx.now.getTime() - 30 * DAY).toISOString();
  const recent = ctx.db.all('botMessages').filter((m) => m.at >= since).sort((a, b) => b.at.localeCompare(a.at));
  return {
    chitthiConnected: !!chitthi(ctx),
    enabled: !!cfg?.enabled,
    welcome: cfg?.welcome || defaultWelcome(ctx),
    connectedAt: cfg?.connectedAt ?? null,
    lastMessageAt: cfg?.lastMessageAt ?? null,
    lastError: cfg?.lastError ?? null,
    last30: {
      messages: recent.length,
      people: new Set(recent.map((m) => normPhone(m.phone))).size,
      prayers: recent.filter((m) => m.intent === 'prayer').length,
      newcomers: recent.filter((m) => m.intent === 'new').length,
      talk: recent.filter((m) => m.intent === 'talk').length,
    },
    recent: recent.slice(0, 50),
  };
}

const chitthiError = (data: unknown, code: number) => (data as { error?: { message?: string } } | null)?.error?.message ?? `Chitthi answered ${code}.`;

export function registerWhatsAppBot(r: Router) {
  r.get('/admin/integrations/whatsapp-bot', { perm: 'settings' }, (ctx) => status(ctx));

  r.post('/admin/integrations/whatsapp-bot', { perm: 'settings' }, async (ctx) => {
    const c = chitthi(ctx);
    if (!c) throw new ApiError(409, 'not_connected', 'Connect Chitthi first. The assistant answers on your Chitthi WhatsApp number.');
    const prev = botConfig(ctx);
    const welcome = String(ctx.body.welcome ?? prev?.welcome ?? '').trim().slice(0, 300) || defaultWelcome(ctx);
    let hookId = prev?.hookId ?? null;
    let secretSealed = prev?.secretSealed ?? null;
    if (!hookId && !ctx.env.demo) {
      if (!ctx.env.webhookBase) throw new ApiError(503, 'no_webhook_url', 'This server has no public address for webhooks (API_PUBLIC_URL).');
      const res = await ctx.env.chitthi(ctx.env.unseal(c.apiKeySealed), { method: 'POST', path: '/api/integrations/hooks', body: { target_url: `${ctx.env.webhookBase}/chitthi/${churchId(ctx)}`, event: 'message.received' } }).catch(() => null);
      if (!res) throw new ApiError(502, 'chitthi_unreachable', 'Could not reach Chitthi. Try again in a minute.');
      if (res.status === 402) throw new ApiError(402, 'chitthi_plan', 'The WhatsApp assistant needs webhooks, which come with Chitthi’s Growth plan. Upgrade in Chitthi › Billing, then try again.');
      if (res.status >= 300) throw new ApiError(502, 'chitthi_error', chitthiError(res.data, res.status));
      hookId = String(res.data?.id ?? '');
      secretSealed = ctx.env.seal(String(res.data?.secret ?? ''));
    }
    ctx.db.put('integrations', { id: 'waBot', enabled: true, hookId, secretSealed, welcome, connectedAt: prev?.connectedAt ?? ctx.now.toISOString(), connectedBy: ctx.staff?.name ?? '', lastMessageAt: prev?.lastMessageAt ?? null, lastError: null } satisfies WaBotConfig);
    ctx.audit('connected', 'integration', 'waBot', prev?.enabled ? 'Updated the WhatsApp assistant' : 'Turned on the WhatsApp assistant');
    return status(ctx);
  });

  r.del('/admin/integrations/whatsapp-bot', { perm: 'settings' }, async (ctx) => {
    const cfg = botConfig(ctx);
    const c = chitthi(ctx);
    if (cfg?.hookId && c) await ctx.env.chitthi(ctx.env.unseal(c.apiKeySealed), { method: 'DELETE', path: `/api/integrations/hooks/${encodeURIComponent(cfg.hookId)}` }).catch(() => null);
    if (cfg) ctx.db.put('integrations', { ...cfg, enabled: false, hookId: null, secretSealed: null });
    ctx.audit('disconnected', 'integration', 'waBot', 'Turned off the WhatsApp assistant');
    return status(ctx);
  });

  // Office staff can try the assistant without WhatsApp (nothing is sent).
  r.post('/admin/integrations/whatsapp-bot/try', { perm: 'settings' }, (ctx) => {
    const text = String(ctx.body.text ?? '').slice(0, 500);
    const out = answer(ctx, { phone: String(ctx.body.phone ?? '+910000000000'), name: ctx.staff?.name ?? 'Test', text }, true);
    return { intent: out.intent, reply: out.reply };
  });
}
