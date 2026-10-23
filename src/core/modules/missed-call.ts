// The missed-call line for feature phones. Many members have no smartphone and no data; what
// they do have is a phone that can give a missed call for free. The church takes a virtual number
// from its telephony provider (Exotel, Knowlarity, MyOperator, Ozonetel, Twilio…) and points the
// provider's missed-call webhook here. A call from a registered phone during a service marks the
// caller (and, if the office wants, the adults of the household) present; at any other time, or
// on the prayer number, it asks for prayer and a pastor calls back. Callers get a text back in
// their own language. Numbers the records do not know are kept for the office to link.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { LanguageCode, MissedCall, MissedCallAction, MissedCallHub, MissedCallLine, MissedCallSettings } from '../types.js';
import { churchId, DAY, fullName, isChild, normPhone, settings } from '../util.js';
import { checkIn } from './checkin.js';
import { automations } from './comms.js';
import { channelStatus, deliverAll } from './integrations.js';
import { notify, pastorIds } from './notify.js';

const PERM = ['checkin', 'care', 'settings'] as ('checkin' | 'care' | 'settings')[];
const BEFORE_MS = 3 * 60 * 60 * 1000; // same window as the door QR
const AFTER_MS = 60 * 60 * 1000;
const DUPLICATE_MS = 2 * 60 * 1000; // providers often post a missed call twice
const KEY_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

const DEFAULTS: MissedCallSettings = { enabled: false, key: '', attendanceNumber: '', prayerNumber: '', household: true, reply: true, channel: 'sms', provider: '' };
export const missedCallSettings = (ctx: Ctx): MissedCallSettings => ({ ...DEFAULTS, ...(automations(ctx).missedCall ?? {}) });

/** The service a call right now belongs to: from three hours before until an hour after, the nearest one. */
export function serviceNow(ctx: Ctx) {
  const t = ctx.now.getTime();
  return ctx.db.all('events')
    .filter((e) => e.kind === 'service' && t >= new Date(e.startsAt).getTime() - BEFORE_MS && t <= new Date(e.endsAt).getTime() + AFTER_MS)
    .sort((a, b) => Math.abs(new Date(a.startsAt).getTime() - t) - Math.abs(new Date(b.startsAt).getTime() - t))[0] ?? null;
}

// ----- what the caller hears back -----
type ReplyKind = Exclude<MissedCallAction, 'duplicate' | 'off'>;
const REPLIES: Record<LanguageCode, Record<ReplyKind, string>> = {
  en: {
    checked_in: 'Welcome, {name}! You are marked present at {service}. {others}– {church}',
    already: 'You are already marked present today, {name}. God bless you. – {church}',
    no_service: 'No service is on right now, {name}. Give a missed call on Sunday from three hours before the service to mark attendance. – {church}',
    closed: 'Attendance is not open for {service} yet. Please try again a little later. – {church}',
    prayer: 'Thank you, {name}. A pastor will call you back to pray with you. – {church}',
    unknown: 'We do not have this number in our records yet. Please tell the church office your name so we can add it. – {church}',
  },
  hi: {
    checked_in: 'स्वागत है, {name}! {service} में आपकी उपस्थिति दर्ज हो गई। {others}– {church}',
    already: '{name}, आज आपकी उपस्थिति पहले से दर्ज है। परमेश्वर आपको आशीष दे। – {church}',
    no_service: '{name}, अभी कोई आराधना नहीं चल रही। उपस्थिति के लिए रविवार को आराधना से तीन घंटे पहले से मिस्ड कॉल दें। – {church}',
    closed: '{service} के लिए उपस्थिति अभी खुली नहीं है। थोड़ी देर बाद फिर कोशिश करें। – {church}',
    prayer: 'धन्यवाद, {name}। एक पास्टर आपको प्रार्थना के लिए वापस कॉल करेंगे। – {church}',
    unknown: 'यह नंबर अभी हमारे रिकॉर्ड में नहीं है। कृपया चर्च कार्यालय को अपना नाम बताएँ। – {church}',
  },
  ta: {
    checked_in: 'வருக, {name}! {service} வருகை பதிவானது. {others}– {church}',
    already: '{name}, இன்று உங்கள் வருகை ஏற்கனவே பதிவானது. ஆண்டவர் ஆசீர்வதிப்பாராக. – {church}',
    no_service: '{name}, இப்போது ஆராதனை இல்லை. வருகை பதிவுக்கு ஞாயிறு ஆராதனைக்கு மூன்று மணி நேரம் முன்பிருந்து மிஸ்டு கால் கொடுங்கள். – {church}',
    closed: '{service} வருகை பதிவு இன்னும் திறக்கப்படவில்லை. சிறிது நேரம் கழித்து முயற்சிக்கவும். – {church}',
    prayer: 'நன்றி, {name}. ஒரு போதகர் உங்களுக்காக ஜெபிக்க திரும்ப அழைப்பார். – {church}',
    unknown: 'இந்த எண் எங்கள் பதிவேட்டில் இல்லை. உங்கள் பெயரை சபை அலுவலகத்திற்கு தெரிவிக்கவும். – {church}',
  },
  te: {
    checked_in: 'స్వాగతం, {name}! {service}లో మీ హాజరు నమోదైంది. {others}– {church}',
    already: '{name}, ఈ రోజు మీ హాజరు ఇప్పటికే నమోదైంది. దేవుడు మిమ్మల్ని దీవించును గాక. – {church}',
    no_service: '{name}, ఇప్పుడు ఆరాధన లేదు. హాజరు కోసం ఆదివారం ఆరాధనకు మూడు గంటల ముందు నుండి మిస్డ్ కాల్ ఇవ్వండి. – {church}',
    closed: '{service} హాజరు ఇంకా తెరవలేదు. కొంచెం సేపటి తర్వాత మళ్ళీ ప్రయత్నించండి. – {church}',
    prayer: 'ధన్యవాదాలు, {name}. ఒక పాస్టర్ మీతో ప్రార్థించడానికి తిరిగి కాల్ చేస్తారు. – {church}',
    unknown: 'ఈ నంబర్ మా రికార్డుల్లో లేదు. దయచేసి మీ పేరు చర్చి కార్యాలయానికి తెలియజేయండి. – {church}',
  },
  ml: {
    checked_in: 'സ്വാഗതം, {name}! {service}-ൽ ഹാജർ രേഖപ്പെടുത്തി. {others}– {church}',
    already: '{name}, ഇന്ന് നിങ്ങളുടെ ഹാജർ ഇതിനകം രേഖപ്പെടുത്തിയിട്ടുണ്ട്. ദൈവം അനുഗ്രഹിക്കട്ടെ. – {church}',
    no_service: '{name}, ഇപ്പോൾ ആരാധനയില്ല. ഹാജരിന് ഞായറാഴ്ച ആരാധനയ്ക്ക് മൂന്ന് മണിക്കൂർ മുമ്പ് മുതൽ മിസ്ഡ് കോൾ നൽകുക. – {church}',
    closed: '{service}-ന്റെ ഹാജർ ഇതുവരെ തുറന്നിട്ടില്ല. അൽപ്പസമയം കഴിഞ്ഞ് വീണ്ടും ശ്രമിക്കുക. – {church}',
    prayer: 'നന്ദി, {name}. ഒരു പാസ്റ്റർ നിങ്ങളോടൊപ്പം പ്രാർത്ഥിക്കാൻ തിരികെ വിളിക്കും. – {church}',
    unknown: 'ഈ നമ്പർ ഞങ്ങളുടെ രേഖകളിൽ ഇല്ല. ദയവായി നിങ്ങളുടെ പേര് സഭാ ഓഫീസിൽ അറിയിക്കുക. – {church}',
  },
  kn: {
    checked_in: 'ಸ್ವಾಗತ, {name}! {service}ನಲ್ಲಿ ನಿಮ್ಮ ಹಾಜರಾತಿ ದಾಖಲಾಗಿದೆ. {others}– {church}',
    already: '{name}, ಇಂದು ನಿಮ್ಮ ಹಾಜರಾತಿ ಈಗಾಗಲೇ ದಾಖಲಾಗಿದೆ. ದೇವರು ಆಶೀರ್ವದಿಸಲಿ. – {church}',
    no_service: '{name}, ಈಗ ಆರಾಧನೆ ಇಲ್ಲ. ಹಾಜರಾತಿಗಾಗಿ ಭಾನುವಾರ ಆರಾಧನೆಗೆ ಮೂರು ಗಂಟೆ ಮೊದಲಿನಿಂದ ಮಿಸ್ಡ್ ಕಾಲ್ ಕೊಡಿ. – {church}',
    closed: '{service} ಹಾಜರಾತಿ ಇನ್ನೂ ತೆರೆದಿಲ್ಲ. ಸ್ವಲ್ಪ ಸಮಯದ ನಂತರ ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ. – {church}',
    prayer: 'ಧನ್ಯವಾದಗಳು, {name}. ಒಬ್ಬ ಪಾಸ್ಟರ್ ನಿಮ್ಮೊಂದಿಗೆ ಪ್ರಾರ್ಥಿಸಲು ಮರಳಿ ಕರೆ ಮಾಡುತ್ತಾರೆ. – {church}',
    unknown: 'ಈ ಸಂಖ್ಯೆ ನಮ್ಮ ದಾಖಲೆಗಳಲ್ಲಿ ಇಲ್ಲ. ದಯವಿಟ್ಟು ನಿಮ್ಮ ಹೆಸರನ್ನು ಚರ್ಚ್ ಕಚೇರಿಗೆ ತಿಳಿಸಿ. – {church}',
  },
};
const OTHERS: Record<LanguageCode, string> = { en: 'With {n} more from your home. ', hi: 'आपके घर के {n} और लोग भी। ', ta: 'உங்கள் வீட்டிலிருந்து மேலும் {n} பேர். ', te: 'మీ ఇంటి నుండి మరో {n} మంది. ', ml: 'നിങ്ങളുടെ വീട്ടിൽ നിന്ന് {n} പേർ കൂടി. ', kn: 'ನಿಮ್ಮ ಮನೆಯಿಂದ ಇನ್ನೂ {n} ಜನ. ' };

export function replyText(ctx: Ctx, kind: ReplyKind, lang: LanguageCode | null | undefined, vars: { name?: string | null; service?: string | null; others?: number }) {
  const l: LanguageCode = lang && REPLIES[lang] ? lang : (settings(ctx).languages?.[0] ?? 'en');
  const t = REPLIES[l][kind];
  return t
    .replace('{name}', (vars.name ?? '').split(' ')[0] || (l === 'en' ? 'friend' : ''))
    .replace('{service}', vars.service ?? '')
    .replace('{others}', vars.others ? OTHERS[l].replace('{n}', String(vars.others)) : '')
    .replace('{church}', settings(ctx).name)
    .replace(/\s+,/g, ',').replace(/\s{2,}/g, ' ').trim();
}

/** The provider's own field names for who called and which number they called. */
export function callFields(raw: Record<string, unknown>) {
  const pick = (...keys: string[]) => { for (const k of keys) { const v = raw[k]; if (typeof v === 'string' && v.trim()) return v.trim(); if (typeof v === 'number') return String(v); } return ''; };
  return {
    from: pick('CallFrom', 'From', 'from', 'caller_id', 'callerid', 'caller_number', 'caller', 'phone', 'mobile', 'customer_number'),
    to: pick('CallTo', 'To', 'to', 'DialWhomNumber', 'dispnumber', 'called_number', 'virtual_number', 'number', 'did'),
  };
}

function decideLine(s: MissedCallSettings, to: string, serviceOn: boolean): MissedCallLine {
  const t = normPhone(to);
  const a = normPhone(s.attendanceNumber);
  const p = normPhone(s.prayerNumber);
  if (t && p && t === p && a !== p) return 'prayer';
  if (t && a && t === a && a !== p) return 'attendance';
  return serviceOn ? 'attendance' : 'prayer';
}

/** One missed call, from the provider or the office's "try it". Never throws for the caller's sake: every outcome is a log row. */
export async function handleMissedCall(ctx: Ctx, input: { from: string; to?: string; test?: boolean }): Promise<MissedCall> {
  const s = missedCallSettings(ctx);
  const from = normPhone(input.from);
  if (from.length < 10) throw new ApiError(422, 'invalid', 'The caller’s number is missing.', { from: 'Enter the number that called' });
  const now = ctx.now.toISOString();
  const to = normPhone(input.to ?? '') || input.to || '';
  const row = (partial: Partial<MissedCall>): MissedCall => ctx.db.put('missedCalls', { id: ctx.id('mc'), at: now, from, to, line: 'attendance', personId: null, personName: null, action: 'off', eventId: null, eventTitle: null, others: 0, reply: null, replied: false, test: !!input.test, ...partial });
  if (!s.enabled && !input.test) return row({ action: 'off' });

  const recent = ctx.db.all('missedCalls').filter((c) => c.from === from && c.to === to && !c.test && c.action !== 'duplicate' && ctx.now.getTime() - new Date(c.at).getTime() < DUPLICATE_MS);
  if (recent.length && !input.test) return row({ action: 'duplicate', line: recent[0]!.line, personId: recent[0]!.personId, personName: recent[0]!.personName });

  const ev = serviceNow(ctx);
  const line = decideLine(s, input.to ?? '', !!ev);
  const people = ctx.db.all('people').filter((p) => p.status !== 'inactive' && normPhone(p.phone) === from);
  const me = people.find((p) => !isChild(ctx, p)) ?? people[0] ?? null;
  let action: MissedCallAction;
  let others = 0;
  if (!me) {
    action = 'unknown';
  } else if (line === 'prayer') {
    action = 'prayer';
    const pr = ctx.db.put('prayer', { id: ctx.id('pr'), personId: me.id, name: fullName(me), text: `Gave a missed call on the prayer line. Please call back on ${me.phone}.`, visibility: 'pastors', status: 'open', prayedBy: [], createdAt: now, answeredNote: null, source: 'phone', contact: me.phone });
    await notify(ctx, 'prayer.new', { personIds: pastorIds(ctx), title: `${fullName(me)} asked for prayer by missed call`, body: `Call back on ${me.phone}.`, link: '/admin/care?tab=prayer' }).catch(() => undefined);
    ctx.audit('created', 'prayer', pr.id, `Prayer line: missed call from ${fullName(me)}`);
  } else if (!ev) {
    action = 'no_service';
  } else {
    const ids = [me.id, ...(s.household && me.householdName ? ctx.db.all('people').filter((p) => p.id !== me.id && p.householdName === me.householdName && p.status !== 'inactive' && !isChild(ctx, p)).map((p) => p.id) : [])];
    try {
      const r = checkIn(ctx, ev, ids, 'phone');
      const mine = r.checkins.some((c) => c.personId === me.id);
      others = r.checkins.filter((c) => c.personId !== me.id).length;
      action = mine || others ? 'checked_in' : 'already';
      if (!mine && !others) action = 'already';
    } catch (e) {
      action = e instanceof ApiError && e.code === 'checkin_closed' ? 'closed' : 'already';
    }
  }
  const reply = action === 'unknown' ? replyText(ctx, 'unknown', null, {}) : replyText(ctx, action, me?.language, { name: me ? fullName(me) : null, service: ev?.title ?? null, others });
  let replied = false;
  if (s.reply && !input.test) {
    const res = await deliverAll(ctx, s.channel, [{ to: me?.phone ?? input.from, name: me ? fullName(me) : input.from, subject: settings(ctx).name, text: reply }]).catch(() => []);
    replied = !!res[0]?.ok;
  }
  return row({ line, personId: me?.id ?? null, personName: me ? fullName(me) : null, action, eventId: ev && line === 'attendance' ? ev.id : null, eventTitle: ev && line === 'attendance' ? ev.title : null, others, reply, replied });
}

function hub(ctx: Ctx): MissedCallHub {
  const s = missedCallSettings(ctx);
  const all = ctx.db.all('missedCalls').sort((a, b) => b.at.localeCompare(a.at));
  const real = all.filter((c) => !c.test && c.action !== 'duplicate');
  const lastService = ctx.db.all('events').filter((e) => e.kind === 'service' && new Date(e.startsAt).getTime() <= ctx.now.getTime() + BEFORE_MS).sort((a, b) => b.startsAt.localeCompare(a.startsAt))[0];
  const ofLast = lastService ? real.filter((c) => c.eventId === lastService.id) : [];
  const month = ctx.now.getTime() - 30 * DAY;
  const ev = serviceNow(ctx);
  return {
    settings: s,
    webhookUrl: s.key && (ctx.env.webhookBase || ctx.env.demo) ? `${ctx.env.webhookBase ?? 'https://api.flockwise.church/v1/webhooks'}/missed-call/${churchId(ctx)}/${s.key}` : null,
    channelReady: ctx.env.demo || !!channelStatus(ctx)[s.channel]?.configured,
    serviceNow: ev ? { id: ev.id, title: ev.title, startsAt: ev.startsAt } : null,
    stats: { lastSunday: ofLast.length, checkedIn: real.filter((c) => c.action === 'checked_in').reduce((n, c) => n + 1 + c.others, 0), prayer: real.filter((c) => c.action === 'prayer').length, unknown: real.filter((c) => c.action === 'unknown' && !c.personId).length, total: real.length },
    recent: all.slice(0, 50),
    unknown: all.filter((c) => c.action === 'unknown' && !c.personId && new Date(c.at).getTime() >= month).slice(0, 30),
  };
}

export function registerMissedCall(r: Router) {
  r.get('/admin/missed-call', { perm: PERM }, (ctx): MissedCallHub => hub(ctx));

  r.put('/admin/missed-call', { perm: 'settings' }, (ctx): MissedCallHub => {
    const cur = missedCallSettings(ctx);
    const b = ctx.body as Partial<MissedCallSettings> & { newKey?: boolean };
    const phone = (v: unknown, fallback: string) => (typeof v === 'string' ? v.replace(/[^\d+\s-]/g, '').trim().slice(0, 20) : fallback);
    const next: MissedCallSettings = {
      enabled: typeof b.enabled === 'boolean' ? b.enabled : cur.enabled,
      key: cur.key && !b.newKey ? cur.key : ctx.env.random(20, KEY_ALPHABET),
      attendanceNumber: phone(b.attendanceNumber, cur.attendanceNumber),
      prayerNumber: phone(b.prayerNumber, cur.prayerNumber),
      household: typeof b.household === 'boolean' ? b.household : cur.household,
      reply: typeof b.reply === 'boolean' ? b.reply : cur.reply,
      channel: b.channel === 'whatsapp' ? 'whatsapp' : b.channel === 'sms' ? 'sms' : cur.channel,
      provider: typeof b.provider === 'string' ? b.provider.trim().slice(0, 40) : cur.provider,
    };
    if (next.enabled && !next.attendanceNumber && !next.prayerNumber) throw new ApiError(422, 'invalid', 'Enter the number members will call.', { attendanceNumber: 'Enter the missed-call number' });
    ctx.db.put('automations', { ...automations(ctx), missedCall: next });
    ctx.audit('updated', 'automations', null, `Missed-call line ${next.enabled ? 'on' : 'off'}`);
    return hub(ctx);
  });

  // The office tries a number as if the provider had sent it. Nothing is texted back; the reply is shown.
  r.post('/admin/missed-call/try', { perm: PERM }, (ctx) => handleMissedCall(ctx, { from: String(ctx.body.from ?? ''), to: typeof ctx.body.to === 'string' ? ctx.body.to : undefined, test: true }));

  // An unknown caller turns out to be someone: save the number on their record and, if the service is still on, mark them present.
  r.post('/admin/missed-call/:id/link', { perm: ['people.edit', 'checkin'] }, async (ctx): Promise<MissedCall> => {
    const call = ctx.db.get('missedCalls', ctx.params[0]!);
    if (!call) throw new ApiError(404, 'not_found', 'That call is no longer in the list.');
    const p = ctx.db.get('people', String(ctx.body.personId ?? ''));
    if (!p) throw new ApiError(422, 'invalid', 'Pick the person who called.', { personId: 'Required' });
    if (!p.phone) ctx.db.put('people', { ...p, phone: `+91 ${call.from.slice(0, 5)} ${call.from.slice(5)}` });
    let action = call.action;
    let others = 0;
    const ev = call.eventId ? ctx.db.get('events', call.eventId) : call.line === 'attendance' ? serviceNow(ctx) : null;
    if (call.line === 'attendance' && ev) {
      try { const r = checkIn(ctx, ev, [p.id], 'phone'); action = r.checkins.length ? 'checked_in' : 'already'; others = 0; } catch { action = 'already'; }
    }
    for (const other of ctx.db.all('missedCalls').filter((c) => c.from === call.from && !c.personId)) ctx.db.put('missedCalls', { ...other, personId: p.id, personName: fullName(p) });
    ctx.audit('updated', 'person', p.id, `Linked missed call from ${call.from} to ${fullName(p)}`);
    return ctx.db.put('missedCalls', { ...call, personId: p.id, personName: fullName(p), action, others, eventId: ev?.id ?? call.eventId, eventTitle: ev?.title ?? call.eventTitle });
  });

  // The provider's webhook, GET or POST, with the secret in the path. Any field names the common providers use.
  const hook = async (ctx: Ctx) => {
    const s = missedCallSettings(ctx);
    if (!s.key || ctx.params[0] !== s.key) throw new ApiError(404, 'not_found', 'Unknown line.');
    const raw = { ...(ctx.query as Record<string, unknown>), ...((ctx.body && typeof ctx.body === 'object' ? ctx.body : {}) as Record<string, unknown>) };
    const { from, to } = callFields(raw);
    if (!from) return { ok: true as const, ignored: true as const };
    const c = await handleMissedCall(ctx, { from, to });
    return { ok: true as const, action: c.action, reply: c.reply };
  };
  r.post('/public/missed-call/:key', { public: true }, hook);
  r.get('/public/missed-call/:key', { public: true }, hook);
}
