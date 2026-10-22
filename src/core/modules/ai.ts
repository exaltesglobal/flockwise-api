// AI helpers for the church office, powered by Claude: a writer for messages and announcements,
// translation into Indian languages, an assistant that answers questions from church data, a
// weekly briefing, sermon helpers and a worship set suggester. Switched off unless the host has
// an AI provider; each church has a monthly allowance.
import type { AiBlock, AiMessage, AiRequest, Ctx, Request, Router } from '../engine.js';
import type { Db } from '../db.js';
import { ApiError } from '../errors.js';
import { limitsFor, aiExtra } from '../plans.js';
import { TOOLS, trim } from '../mcp.js';
import type { AiAnswer, AiDraft, AiPurpose, AiSermonKind, AiSetlist, AiStatus } from '../types.js';
import { settings } from '../util.js';

const LANGS: Record<string, string> = { en: 'English', hi: 'Hindi', te: 'Telugu', ta: 'Tamil', ml: 'Malayalam', kn: 'Kannada', mr: 'Marathi', bn: 'Bengali', gu: 'Gujarati', pa: 'Punjabi', or: 'Odia', as: 'Assamese', ur: 'Urdu', kok: 'Konkani', mni: 'Manipuri', lus: 'Mizo', kha: 'Khasi', ne: 'Nepali' };

// The assistant calls the same endpoints as the office, as the signed-in staff member. The engine
// hands over its request handler once it is built.
// One server hosts many churches, so each church's handler is kept with its database.
const handles = new WeakMap<Db, (req: Request) => Promise<unknown>>();
export const bindAiHandle = (db: Db, h: (req: Request) => Promise<unknown>) => void handles.set(db, h);

const month = (ctx: Ctx) => ctx.now.toISOString().slice(0, 7);

function status(ctx: Ctx): AiStatus {
  const m = month(ctx);
  const used = Number(ctx.db.get('meta', `ai:${m}`)?.value ?? 0);
  return { enabled: !!ctx.env.ai, used, limit: (settings(ctx).aiMonthlyLimit ?? limitsFor(ctx.db, ctx.now).aiCredits) + aiExtra(ctx.db, m), month: m };
}

function churchContext(ctx: Ctx) {
  const s = settings(ctx);
  const langs = (s.languages ?? ['en']).map((l) => LANGS[l] ?? l).join(', ');
  return `You help the staff of ${s.name}, a church in ${s.city || 'India'}${s.country && s.country !== 'IN' ? ` (${s.country})` : ''}. Its languages are ${langs}. Today is ${ctx.now.toISOString().slice(0, 10)}. Write warmly and plainly, the way a caring Indian church office writes: respectful, never salesy, no emoji unless asked. Use Indian English spellings and Indian number formats (lakh, crore, ₹).`;
}

/** One model call, counted against the church's monthly allowance. */
async function run(ctx: Ctx, req: AiRequest) {
  if (!ctx.env.ai) throw new ApiError(503, 'ai_off', 'AI features are not switched on for this server yet.');
  const st = status(ctx);
  if (st.used >= st.limit) throw new ApiError(429, 'ai_limit', `You have used all ${st.limit} AI requests for this month. They reset on the 1st.`);
  ctx.db.put('meta', { id: `ai:${st.month}`, value: String(st.used + 1) });
  const res = await ctx.env.ai(req).catch((e: Error) => {
    throw new ApiError(502, 'ai_failed', e.message || 'The AI service did not answer. Try again in a minute.');
  });
  if (res.stopReason === 'refusal') throw new ApiError(422, 'ai_declined', 'The assistant could not help with that request.');
  return res;
}

const textOf = (blocks: AiBlock[]) => blocks.filter((b): b is Extract<AiBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n').trim();

function json<T>(blocks: AiBlock[]): T {
  const t = textOf(blocks);
  try {
    return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)) as T;
  } catch {
    throw new ApiError(502, 'ai_bad_reply', 'The assistant replied in a way Flockwise could not read. Try again.');
  }
}

const str = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

const DRAFT_SCHEMA = { type: 'object', properties: { subject: { type: 'string' }, text: { type: 'string' } }, required: ['subject', 'text'], additionalProperties: false };

const PURPOSE: Record<AiPurpose, string> = {
  message: 'a message to church members',
  announcement: 'an announcement for the member app and the Sunday slides',
  greeting: 'a personal greeting (birthday, anniversary or welcome)',
  social: 'a social media post (Instagram, Facebook, WhatsApp status)',
  prayer: 'a short prayer the pastor can read or send',
};
const CHANNEL_RULES: Record<string, string> = {
  email: 'It is an email: give a clear subject and a body of a few short paragraphs.',
  sms: 'It is an SMS: keep the text under 300 characters, no subject (leave subject empty).',
  whatsapp: 'It is a WhatsApp message: friendly, short paragraphs, under 700 characters, *bold* sparingly, no subject (leave subject empty).',
};

/** Read-only office tools the assistant may use; it never changes data. */
const ASK_TOOLS = TOOLS.filter((t) => !t.write);

export async function askAssistant(ctx: Ctx, question: string, history: AiMessage[], extraSystem = ''): Promise<AiAnswer> {
  const handle = handles.get(ctx.db);
  if (!handle) throw new ApiError(503, 'ai_off', 'The assistant is not ready.');
  const tools = ASK_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: { type: 'object', properties: t.props ?? {}, ...(t.required ? { required: t.required } : {}) } }));
  const system = `${churchContext(ctx)}\n\nYou are the Flockwise assistant inside the church office. Answer questions using the tools, which read the church's live data with the permissions of ${ctx.staff?.name ?? 'this staff member'}. Look things up rather than guessing; if a tool says access is not allowed, say so plainly. Be brief: lead with the answer, then a few bullet points at most. Use names, dates and numbers from the data. Keep anything marked confidential to what was asked. You cannot change data or send messages; point the user to the right page instead.${extraSystem ? `\n\n${extraSystem}` : ''}`;
  const messages: AiMessage[] = [...history.slice(-10), { role: 'user', content: question }];
  const used: string[] = [];
  for (let turn = 0; turn < 8; turn++) {
    const res = await run(ctx, { system, messages, tools, maxTokens: 4000, effort: 'medium' });
    messages.push({ role: 'assistant', content: res.content });
    if (res.stopReason === 'pause_turn') continue;
    const calls = res.content.filter((b): b is Extract<AiBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    if (res.stopReason !== 'tool_use' || !calls.length) return { answer: textOf(res.content) || 'I could not find an answer to that.', toolsUsed: used };
    const results: AiBlock[] = [];
    for (const c of calls) {
      const tool = ASK_TOOLS.find((t) => t.name === c.name);
      used.push(c.name);
      if (!tool) { results.push({ type: 'tool_result', tool_use_id: c.id, content: 'Unknown tool.', is_error: true }); continue; }
      try {
        const r = tool.call(c.input ?? {});
        const out = await handle({ method: r.method, path: r.path, query: r.query, body: r.body, auth: ctx.auth });
        results.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(trim(out)).slice(0, 60_000) });
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: c.id, content: e instanceof ApiError ? e.message : 'That lookup failed.', is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return { answer: 'That needed too many lookups. Try asking a narrower question.', toolsUsed: used };
}

export function registerAi(r: Router) {
  r.get('/admin/ai/status', { staff: true }, (ctx) => status(ctx));

  r.post('/admin/ai/write', { perm: ['comms', 'care', 'people.view'] }, async (ctx): Promise<AiDraft> => {
    const brief = str(ctx.body.brief, 2000);
    if (!brief) throw new ApiError(400, 'brief_required', 'Say what the message is about.');
    const purpose: AiPurpose = (Object.keys(PURPOSE) as AiPurpose[]).includes(ctx.body.purpose) ? ctx.body.purpose : 'message';
    const channel = String(ctx.body.channel ?? '');
    const lang = LANGS[String(ctx.body.language ?? 'en')] ?? 'English';
    const draft = str(ctx.body.draft, 4000);
    const res = await run(ctx, {
      system: `${churchContext(ctx)}\n\nYou draft ${PURPOSE[purpose]}. ${CHANNEL_RULES[channel] ?? ''} Write in ${lang}${lang !== 'English' ? ' using its own script' : ''}. Where the message goes to many people, you may use the placeholder {{firstName}} for the person's first name. Do not invent dates, times, places or amounts that the brief does not give; leave a clear [bracketed] gap instead. Reply with JSON: {"subject": "...", "text": "..."}.`,
      messages: [{ role: 'user', content: draft ? `Improve this draft. Brief: ${brief}\n\nDraft:\n${draft}` : brief }],
      schema: DRAFT_SCHEMA,
      maxTokens: 2000,
      effort: 'low',
    });
    const out = json<AiDraft>(res.content);
    return { subject: str(out.subject, 200), text: str(out.text, 6000) };
  });

  r.post('/admin/ai/translate', { perm: ['comms', 'services', 'people.view'] }, async (ctx) => {
    const text = str(ctx.body.text, 6000);
    const to = LANGS[String(ctx.body.to ?? '')];
    if (!text || !to) throw new ApiError(400, 'bad_request', 'Give the text and a language to translate into.');
    const res = await run(ctx, {
      system: `${churchContext(ctx)}\n\nTranslate church messages into ${to}, in its own script, the way a native-speaking Christian in India would say it. Keep names, Bible references, placeholders like {{firstName}}, links, numbers and line breaks exactly. Use the Bible book names and church words that ${to}-speaking churches use. Reply with only the translation.`,
      messages: [{ role: 'user', content: text }],
      maxTokens: 4000,
      effort: 'low',
    });
    return { text: textOf(res.content) };
  });

  r.post('/admin/ai/ask', { staff: true }, async (ctx) => {
    const question = str(ctx.body.question, 2000);
    if (!question) throw new ApiError(400, 'question_required', 'Ask a question.');
    const history: AiMessage[] = (Array.isArray(ctx.body.history) ? ctx.body.history : [])
      .filter((m: { role?: string; text?: string }) => (m.role === 'user' || m.role === 'assistant') && m.text)
      .map((m: { role: 'user' | 'assistant'; text: string }) => ({ role: m.role, content: str(m.text, 4000) }));
    return askAssistant(ctx, question, history);
  });

  r.post('/admin/ai/briefing', { staff: true }, async (ctx) =>
    askAssistant(ctx, 'Give me my weekly briefing.', [], 'For the weekly briefing: check the overview, upcoming celebrations, events this week, care cases and volunteer gaps you can see. Write at most 12 short bullets in sections: This week, People to reach, Needs attention. End with one encouraging line.'));

  r.post('/admin/ai/sermon', { perm: ['services', 'comms'] }, async (ctx) => {
    const kind: AiSermonKind = (['outline', 'discussion', 'social', 'kids', 'summary'] as const).includes(ctx.body.kind) ? ctx.body.kind : 'discussion';
    const title = str(ctx.body.title, 200);
    const passage = str(ctx.body.passage, 200);
    const notes = str(ctx.body.notes, 12_000);
    if (!title && !passage && !notes) throw new ApiError(400, 'bad_request', 'Give a title, passage or notes.');
    const lang = LANGS[String(ctx.body.language ?? 'en')] ?? 'English';
    const asks: Record<AiSermonKind, string> = {
      outline: 'a clear preaching outline: big idea, three or four points with supporting verses, illustrations suited to Indian listeners, and an application. Mark it as a starting point for the pastor’s own study.',
      discussion: 'small-group discussion questions for the week: an icebreaker, five or six questions moving from observation to application, and a closing prayer prompt.',
      social: 'three short social media posts and one WhatsApp status line inviting people to listen, each with a key quote.',
      kids: 'a children’s ministry version for ages 6 to 11: the main idea in one sentence, a simple story retelling, two activities and a memory verse.',
      summary: 'a 150-word summary for the church newsletter and website.',
    };
    const res = await run(ctx, {
      system: `${churchContext(ctx)}\n\nYou support pastors with sermon follow-up material, staying faithful to the passage and to mainstream Christian teaching. Never invent quotes from the sermon; use only what the notes say. Write in ${lang}. Use Markdown headings and lists.`,
      messages: [{ role: 'user', content: `Sermon title: ${title || '(none)'}\nPassage: ${passage || '(none)'}\nNotes:\n${notes || '(none)'}\n\nWrite ${asks[kind]}` }],
      maxTokens: 4000,
      effort: kind === 'outline' ? 'medium' : 'low',
    });
    return { text: textOf(res.content) };
  });

  r.post('/admin/ai/setlist', { perm: 'services' }, async (ctx): Promise<AiSetlist> => {
    const theme = str(ctx.body.theme, 500);
    const count = Math.max(2, Math.min(8, Number(ctx.body.count ?? 4) || 4));
    const songs = ctx.db.all('songs');
    if (!songs.length) throw new ApiError(400, 'no_songs', 'Add songs to the library first.');
    const lastUsed = new Map<string, string>();
    for (const p of ctx.db.all('plans')) {
      const ev = ctx.db.get('events', p.eventId);
      if (!ev || ev.startsAt > ctx.now.toISOString()) continue;
      for (const i of p.items) if (i.songId && (lastUsed.get(i.songId) ?? '') < ev.startsAt) lastUsed.set(i.songId, ev.startsAt);
    }
    const library = songs.map((s) => `${s.id} | ${s.title} | key ${s.defaultKey || '?'} | ${s.bpm ? `${s.bpm} bpm` : 'tempo ?'} | tags: ${s.tags.join(', ') || '-'} | last used ${lastUsed.get(s.id)?.slice(0, 10) ?? 'never'} | starts: ${s.lyrics.split('\n').find((l) => l.trim() && !/^\[|:$|^(verse|chorus|bridge)/i.test(l.trim()))?.slice(0, 60) ?? ''}`).join('\n');
    const res = await run(ctx, {
      system: `${churchContext(ctx)}\n\nYou help worship leaders plan a set from the church's own song library. Choose only songs from the library, by id. Build a flow (for example call to worship, praise, then reflective worship and response), keep keys and tempos workable next to each other, prefer songs that fit the theme, and avoid songs used in the last two weeks unless they fit far better. Reply with JSON: {"songs": [{"songId": "...", "reason": "..."}], "note": "one or two sentences on the flow"}.`,
      messages: [{ role: 'user', content: `Theme or sermon: ${theme || 'a normal Sunday service'}\nNumber of songs: ${count}\n\nLibrary (id | title | key | tempo | tags | last used | first line):\n${library}` }],
      schema: { type: 'object', properties: { songs: { type: 'array', items: { type: 'object', properties: { songId: { type: 'string' }, reason: { type: 'string' } }, required: ['songId', 'reason'], additionalProperties: false } }, note: { type: 'string' } }, required: ['songs', 'note'], additionalProperties: false },
      maxTokens: 2000,
      effort: 'low',
    });
    const out = json<{ songs: { songId: string; reason: string }[]; note: string }>(res.content);
    const byId = new Map(songs.map((s) => [s.id, s]));
    return {
      songs: (out.songs ?? []).filter((x) => byId.has(x.songId)).slice(0, count).map((x) => ({ songId: x.songId, title: byId.get(x.songId)!.title, reason: str(x.reason, 300) })),
      note: str(out.note, 600),
    };
  });
}
