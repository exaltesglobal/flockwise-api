// Weekly SMS digest in local script: once a week, members who do not have the app (no phone
// registered for push) get one text in their own language with the Sunday service time, this
// week's events, the verse from the bulletin and the office number. Plain SMS reaches a feature
// phone; the church can send it on WhatsApp instead. Every line is written in the six scripts
// here, so nothing needs the AI and nothing leaves the church's own words untranslated.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { Collections, LanguageCode, SmsDigestPreview, SmsDigestSettings, SmsDigestStatus } from '../types.js';
import { DAY, fullName, localDate, localHour, settings } from '../util.js';
import { automations } from './comms.js';
import { channelStatus, deliverAll } from './integrations.js';
import { publicPageOf } from './ministry.js';

type Strings = { week: string; service: string; events: string; verse: string; prayer: string; bless: string; nothing: string };
const T: Record<LanguageCode, Strings> = {
  en: { week: 'This week at {church}', service: 'Sunday service', events: 'This week', verse: 'Verse', prayer: 'Prayer requests: call {phone}', bless: 'God bless you!', nothing: 'No other events this week.' },
  hi: { week: '{church} में इस सप्ताह', service: 'रविवार आराधना', events: 'इस सप्ताह', verse: 'वचन', prayer: 'प्रार्थना के लिए कॉल करें: {phone}', bless: 'परमेश्वर आपको आशीष दे!', nothing: 'इस सप्ताह और कोई कार्यक्रम नहीं।' },
  ta: { week: '{church} - இந்த வாரம்', service: 'ஞாயிறு ஆராதனை', events: 'இந்த வாரம்', verse: 'வசனம்', prayer: 'ஜெப வேண்டுதலுக்கு அழைக்கவும்: {phone}', bless: 'கர்த்தர் உங்களை ஆசீர்வதிப்பாராக!', nothing: 'இந்த வாரம் வேறு நிகழ்ச்சிகள் இல்லை.' },
  te: { week: '{church} లో ఈ వారం', service: 'ఆదివారం ఆరాధన', events: 'ఈ వారం', verse: 'వచనం', prayer: 'ప్రార్థన కోసం కాల్ చేయండి: {phone}', bless: 'దేవుడు మిమ్మల్ని దీవించును గాక!', nothing: 'ఈ వారం ఇతర కార్యక్రమాలు లేవు.' },
  ml: { week: '{church} - ഈ ആഴ്ച', service: 'ഞായറാഴ്ച ആരാധന', events: 'ഈ ആഴ്ച', verse: 'വചനം', prayer: 'പ്രാർത്ഥനാ അപേക്ഷയ്ക്ക് വിളിക്കുക: {phone}', bless: 'ദൈവം നിങ്ങളെ അനുഗ്രഹിക്കട്ടെ!', nothing: 'ഈ ആഴ്ച മറ്റ് പരിപാടികളില്ല.' },
  kn: { week: '{church} ನಲ್ಲಿ ಈ ವಾರ', service: 'ಭಾನುವಾರ ಆರಾಧನೆ', events: 'ಈ ವಾರ', verse: 'ವಚನ', prayer: 'ಪ್ರಾರ್ಥನೆಗಾಗಿ ಕರೆ ಮಾಡಿ: {phone}', bless: 'ದೇವರು ನಿಮ್ಮನ್ನು ಆಶೀರ್ವದಿಸಲಿ!', nothing: 'ಈ ವಾರ ಬೇರೆ ಕಾರ್ಯಕ್ರಮಗಳಿಲ್ಲ.' },
};
const LOCALE: Record<LanguageCode, string> = { en: 'en-IN', hi: 'hi-IN', ta: 'ta-IN', te: 'te-IN', ml: 'ml-IN', kn: 'kn-IN' };
const GSM = /^[A-Za-z0-9 @£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà\n\r^{}\\[~\]|€]*$/;

export const digestSettings = (ctx: Ctx): SmsDigestSettings => automations(ctx).smsDigest ?? { enabled: false, day: 6, hour: 17, audience: 'no_app', channel: 'sms', note: '' };

/** SMS segments: 160/153 for plain Latin text, 70/67 once any other script is in it. */
export function segmentsOf(text: string) {
  const n = [...text].length;
  const plain = GSM.test(text);
  const single = plain ? 160 : 70, multi = plain ? 153 : 67;
  return { chars: n, segments: n <= single ? 1 : Math.ceil(n / multi) };
}

/** Who gets it: people with a phone who allowed the channel; by default only those without the app on a phone. */
export function digestRecipients(ctx: Ctx, s = digestSettings(ctx)) {
  const withApp = new Set(ctx.db.all('devices').filter((d) => d.app === 'member').map((d) => d.personId));
  return ctx.db.all('people').filter((p) => p.status !== 'inactive' && p.phone && p.consent[s.channel] && (s.audience === 'everyone' || !withApp.has(p.id)));
}

const fill = (t: string, vars: Record<string, string>) => t.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

/** The text for one person, in their language. */
export function digestText(ctx: Ctx, p: Pick<Collections['people'], 'language' | 'campusId'> | null, lang?: LanguageCode): string {
  const s = settings(ctx);
  const l: LanguageCode = lang ?? p?.language ?? s.languages?.[0] ?? 'en';
  const t = T[l] ?? T.en;
  const tz = s.timezone || 'Asia/Kolkata';
  const fmt = (iso: string) => { try { return new Intl.DateTimeFormat(LOCALE[l], { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)); } catch { return new Date(iso).toISOString().slice(5, 16); } };
  const campus = p?.campusId ? ctx.db.get('campuses', p.campusId) : null;
  const times = campus?.serviceTimes || publicPageOf(ctx).serviceTimes.split('\n').filter(Boolean).join('; ');
  const week = ctx.now.getTime() + 7 * DAY;
  const events = ctx.db.all('events').filter((e) => e.published && e.kind !== 'service' && Date.parse(e.startsAt) > ctx.now.getTime() && Date.parse(e.startsAt) < week).sort((a, b) => a.startsAt.localeCompare(b.startsAt)).slice(0, 4);
  const bulletin = ctx.db.all('bulletins').filter((b) => b.status === 'published' && b.verse && Math.abs(Date.parse(b.date) - ctx.now.getTime()) < 8 * DAY).sort((a, b) => b.date.localeCompare(a.date))[0];
  const d = digestSettings(ctx);
  const lines = [fill(t.week, { church: s.name })];
  if (times) lines.push(`${t.service}: ${times}`);
  lines.push(events.length ? `${t.events}: ${events.map((e) => `${fmt(e.startsAt)} ${e.title}`).join('; ')}` : t.nothing);
  if (bulletin?.verse) lines.push(`${t.verse}: ${bulletin.verse.replace(/\s+/g, ' ').trim().slice(0, 140)}`);
  if (d.note) lines.push(d.note);
  if (s.phone) lines.push(fill(t.prayer, { phone: s.phone }));
  lines.push(t.bless);
  return lines.join('\n');
}

const preview = (ctx: Ctx, p: Collections['people'] | null, lang?: LanguageCode): SmsDigestPreview => { const text = digestText(ctx, p, lang); return { personId: p?.id ?? null, name: p ? fullName(p) : 'Sample', language: lang ?? p?.language ?? 'en', text, ...segmentsOf(text) }; };

/** Sends the digest to everyone due, in their own language; one message record for the office's history. */
export async function sendSmsDigest(ctx: Ctx, by = 'Flockwise') {
  const s = digestSettings(ctx);
  const people = digestRecipients(ctx, s);
  const batch = people.map((p) => ({ to: p.phone!, name: fullName(p), subject: `${settings(ctx).name}: this week`, text: digestText(ctx, p) }));
  const results = batch.length ? await deliverAll(ctx, s.channel, batch) : [];
  const sent = results.filter((r) => r.ok).length;
  const failed = results.length - sent;
  const msg = ctx.db.put('messages', {
    id: ctx.id('ms'), channel: s.channel, audience: { type: 'people', ids: people.map((p) => p.id) }, audienceLabel: `Weekly digest · ${people.length} without the app`, subject: 'Weekly digest', body: digestText(ctx, null, 'en'),
    status: 'sent', scheduledAt: null, sentAt: ctx.now.toISOString(), createdAt: ctx.now.toISOString(), createdBy: by, stats: { recipients: people.length, sent, failed, skipped: 0 }, simulated: false, source: 'automation',
  });
  ctx.db.put('meta', { id: 'smsdigest:last', value: ctx.now.toISOString() });
  ctx.audit('sent', 'message', msg.id, `Weekly ${s.channel.toUpperCase()} digest to ${people.length} people in their own script`);
  return { messageId: msg.id, recipients: people.length, sent, failed };
}

/** The daily tick: on the chosen weekday once the hour has come, once per week. */
export async function smsDigestDue(ctx: Ctx, today: string) {
  const s = digestSettings(ctx);
  if (!s.enabled) return;
  const tz = settings(ctx).timezone || 'Asia/Kolkata';
  const weekday = new Date(new Date(ctx.now).toLocaleString('en-US', { timeZone: tz })).getDay();
  if (weekday !== s.day || localHour(ctx, ctx.now) < s.hour) return;
  const key = `smsdigest:${today}`;
  if (ctx.db.get('meta', key)) return;
  ctx.db.put('meta', { id: key, value: today });
  await sendSmsDigest(ctx);
}

function nextAt(ctx: Ctx, s: SmsDigestSettings): string | null {
  if (!s.enabled) return null;
  for (let i = 0; i < 8; i++) {
    const d = new Date(ctx.now.getTime() + i * DAY);
    const tz = settings(ctx).timezone || 'Asia/Kolkata';
    const local = new Date(d.toLocaleString('en-US', { timeZone: tz }));
    if (local.getDay() !== s.day) continue;
    if (i === 0 && localHour(ctx, ctx.now) >= s.hour) continue;
    return `${localDate(ctx, d)}T${String(s.hour).padStart(2, '0')}:00`;
  }
  return null;
}

export function registerSmsDigest(r: Router) {
  r.get('/admin/messages/sms-digest', { perm: 'comms' }, async (ctx): Promise<SmsDigestStatus> => {
    const s = digestSettings(ctx);
    const people = digestRecipients(ctx, s);
    const byLanguage: Record<string, number> = {};
    for (const p of people) byLanguage[p.language ?? 'en'] = (byLanguage[p.language ?? 'en'] ?? 0) + 1;
    const sample = people.find((p) => p.language && p.language !== 'en') ?? people[0] ?? null;
    return { settings: s, recipients: people.length, byLanguage, sample: preview(ctx, sample), lastSentAt: ctx.db.get('meta', 'smsdigest:last')?.value ?? null, nextAt: nextAt(ctx, s), channelReady: ctx.env.demo || !!channelStatus(ctx)[s.channel]?.configured };
  });
  r.get('/admin/messages/sms-digest/preview', { perm: 'comms' }, (ctx): SmsDigestPreview => {
    const lang = ctx.query.language as LanguageCode | undefined;
    if (lang && !T[lang]) throw new ApiError(422, 'validation', 'Unknown language.');
    const p = ctx.query.personId ? ctx.db.get('people', ctx.query.personId) ?? null : null;
    return preview(ctx, p, lang);
  });
  r.post('/admin/messages/sms-digest/send', { perm: 'comms' }, (ctx) => sendSmsDigest(ctx, ctx.staff?.name ?? 'office'));
}
