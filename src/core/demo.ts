// Host hooks for demo mode: everything stays in memory, gifts succeed instantly and
// messages are only logged. Used by the web demo and by tests.
import type { AiBlock, AiRequest, AiResponse, Env, HttpRequest, HttpResponse } from './engine.js';
import type { Channel } from './types.js';

export type DemoOutboxItem = { channel: Channel | 'push'; to: string; subject: string; text: string };

export function createDemoEnv(opts: { now?: () => Date; webUrl?: string; apiUrl?: string } = {}): Env & { outbox: DemoOutboxItem[] } {
  let seq = 0;
  const outbox: DemoOutboxItem[] = [];
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
    hashPassword: (pw) => `demo-pw:${pw}`,
    verifyPassword: (pw, stored) => stored === `demo-pw:${pw}`,
    signAccess: (claims) => ({ token: `demo.${btoa(JSON.stringify(claims))}`, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() }),
    sendOtpEmail: async () => undefined,
    deliver: async (channel, batch) => {
      for (const m of batch) outbox.push({ channel, to: m.to, subject: m.subject, text: m.text });
      return batch.map(() => ({ ok: true }));
    },
    channels: () => ({ email: { configured: false, provider: 'demo' }, sms: { configured: false, provider: 'demo' }, whatsapp: { configured: false, provider: 'demo' } }),
    checkout: async () => ({ checkoutUrl: '', providerRef: null, provider: 'demo', status: 'succeeded' }),
    webUrl: opts.webUrl ?? '',
    apiUrl: opts.apiUrl,
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
    ai: demoAi,
    seal: (v) => `demo:${v}`,
    unseal: (v) => v.replace(/^demo:/, ''),
    // The demo "sends" through the church mailbox by noting the From address; a host containing "bad" fails.
    smtp: async (account, batch) => {
      if (account.host.includes('bad')) return batch.map(() => ({ ok: false, error: 'Could not sign in to the mailbox. Check the address and password.' }));
      for (const m of batch) outbox.push({ channel: 'email', to: m.to, subject: `${m.subject} (from ${account.from})`, text: m.text });
      return batch.map(() => ({ ok: true }));
    },
    push: async (batch) => {
      for (const m of batch) outbox.push({ channel: 'push', to: m.token, subject: m.title, text: m.body });
      return batch.map(() => ({ ok: true }));
    },
    http: async (req) => demoHttp(req),
    google: {
      accessToken: async (key) => (key.privateKey.includes('bad') ? Promise.reject(new Error('invalid_grant: the key was rejected')) : 'demo-google-token'),
      signedUrl: async (_key, input) => `demo:${input.method}:${input.bucket}/${input.object}`,
    },
    canvaApp: { clientId: 'demo-canva', clientSecret: 'demo', redirectUrl: 'demo://canva/callback', pkce: () => ({ verifier: 'demo-verifier', challenge: 'demo-challenge' }) },
  };
}

const reply = (status: number, data: unknown): HttpResponse => ({ status, headers: {}, text: JSON.stringify(data) });

/** Stand-ins for Zoom, Google Cloud Storage and Canva: anything containing "bad" fails, the rest succeeds. */
function demoHttp(req: HttpRequest): HttpResponse {
  const u = req.url;
  const auth = req.headers?.Authorization ?? '';
  if (u.startsWith('https://zoom.us/oauth/token')) return /bad/.test(u + auth) ? reply(400, { reason: 'Invalid client_id or client_secret' }) : reply(200, { access_token: 'demo-zoom-token', expires_in: 3600 });
  if (u.startsWith('https://api.zoom.us/v2/users/me/meetings')) {
    const b = JSON.parse(typeof req.body === 'string' ? req.body : '{}') as { topic?: string };
    const id = 8000000000 + Math.floor(Math.random() * 999_999_999);
    return reply(201, { id, topic: b.topic, join_url: `https://zoom.us/j/${id}?pwd=demo`, start_url: `https://zoom.us/s/${id}?zak=demo`, password: '123456' });
  }
  if (u.startsWith('https://api.zoom.us/v2/users/me')) return reply(200, { email: 'office@gracechurch.in', first_name: 'Grace', last_name: 'Church' });
  if (u.startsWith('https://api.zoom.us/v2/meetings/')) return reply(204, null);
  if (u.startsWith('https://storage.googleapis.com/storage/v1/b/')) {
    if (/bad/.test(u)) return reply(404, { error: { message: 'Not Found' } });
    if (u.includes('/iam')) return reply(200, { bindings: u.includes('public') ? [{ role: 'roles/storage.objectViewer', members: ['allUsers'] }] : [] });
    if (req.method === 'DELETE') return reply(204, null);
    return reply(200, { name: u.split('/b/')[1].split(/[?/]/)[0], location: 'ASIA-SOUTH1' });
  }
  if (u.startsWith('https://api.canva.com/rest/v1/oauth/token')) return reply(200, { access_token: 'demo-canva-access', refresh_token: 'demo-canva-refresh', expires_in: 14_400 });
  if (u.startsWith('https://api.canva.com/rest/v1/users/me/profile')) return reply(200, { display_name: 'Grace Church Media', team_name: 'Grace Community Church' });
  if (u.startsWith('https://api.canva.com/rest/v1/asset-uploads')) return reply(200, { job: { id: 'job_demo', status: 'success', asset: { id: 'asset_demo', name: 'Flockwise picture' } } });
  if (u.startsWith('https://api.canva.com/rest/v1/exports')) return reply(200, { job: { id: 'export_demo', status: 'success', urls: ['https://export-download.canva.com/demo/design.png'] } });
  if (u.startsWith('https://export-download.canva.com/')) return { status: 200, headers: { 'content-type': 'image/png' }, text: '', bytes: new Uint8Array([137, 80, 78, 71]) };
  if (u.startsWith('https://storage.googleapis.com/upload/')) return reply(200, { name: 'uploaded' });
  if (u.startsWith('https://api.canva.com/rest/v1/designs/') && req.method === 'GET') {
    const id = u.split('/designs/')[1].split(/[?/]/)[0];
    return reply(200, { design: { id, title: 'Harvest festival poster', urls: { edit_url: `https://www.canva.com/design/${id}/edit`, view_url: `https://www.canva.com/design/${id}/view` }, thumbnail: { url: `https://document-export.canva.com/${id}/thumbnail.png` } } });
  }
  if (u.startsWith('https://api.canva.com/rest/v1/designs')) {
    const b = JSON.parse(typeof req.body === 'string' ? req.body : '{}') as { title?: string };
    const id = `DAF${Math.random().toString(36).slice(2, 10)}`;
    return reply(200, { design: { id, title: b.title ?? 'Design', urls: { edit_url: `https://www.canva.com/design/${id}/edit`, view_url: `https://www.canva.com/design/${id}/view` }, thumbnail: null } });
  }
  return reply(404, { message: 'Not found (demo)' });
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

/**
 * A scripted stand-in for Claude, so the demo and tests can show every AI screen without a key.
 * It looks things up with the real tools, then sums up what came back.
 */
async function demoAi(req: AiRequest): Promise<AiResponse> {
  const last = req.messages[req.messages.length - 1];
  const text = (t: string): AiResponse => ({ content: [{ type: 'text', text: t }], stopReason: 'end_turn' });
  const ask = typeof last.content === 'string' ? last.content : '';
  if (req.tools?.length) {
    if (typeof last.content === 'string') {
      const briefing = /briefing/i.test(ask);
      const calls: AiBlock[] = briefing
        ? [{ type: 'tool_use', id: 'tu_1', name: 'church_overview', input: {} }, { type: 'tool_use', id: 'tu_2', name: 'upcoming_celebrations', input: { days: 7 } }]
        : /birthday|anniversar/i.test(ask) ? [{ type: 'tool_use', id: 'tu_1', name: 'upcoming_celebrations', input: { days: 14 } }]
          : /event|service|sunday/i.test(ask) ? [{ type: 'tool_use', id: 'tu_1', name: 'list_events', input: {} }]
            : [{ type: 'tool_use', id: 'tu_1', name: 'search_people', input: { query: ask.split(/\s+/).filter((w) => /^[A-Z]/.test(w)).pop() ?? '' } }];
      return { content: [{ type: 'text', text: 'Let me check.' }, ...calls], stopReason: 'tool_use' };
    }
    const results = last.content.filter((b): b is Extract<AiBlock, { type: 'tool_result' }> => b.type === 'tool_result');
    const names = results.map((r) => { try { return [...r.content.matchAll(/"(?:name|title|firstName)":"([^"]+)"/g)].slice(0, 4).map((m) => m[1]); } catch { return []; } }).flat();
    return text(`Here is what I found in your church data (demo answer):\n\n${names.length ? names.map((n) => `- ${n}`).join('\n') : '- Nothing matched.'}\n\nConnect an AI key on the server for full answers.`);
  }
  const props = (req.schema?.properties ?? {}) as Record<string, unknown>;
  const photos = typeof last.content === 'string' ? 0 : last.content.filter((b) => b.type === 'image').length;
  if (photos) {
    // A scanned songbook page: one Telugu chorus with chords and one English hymn, as a real scan would come back.
    return text(JSON.stringify({ songs: [
      { title: 'Yesu Nee Naamam', author: '', key: 'G', language: 'te', lyrics: 'Chorus\nయేసు నీ నామం మధురం\nయేసు నీ ప్రేమ అమరం\n\nVerse 1\nనా పాపములన్నీ క్షమించితివి\nనా బాధలన్నీ తొలగించితివి', chordChart: 'Chorus\n[G]యేసు నీ [C]నామం మధు[G]రం\n[G]యేసు నీ [D]ప్రేమ అమ[G]రం\n\nVerse 1\n[C]నా పాపము[G]లన్నీ క్షమించి[D]తివి\n[C]నా బాధ[G]లన్నీ తొలగించి[D]తివి', warnings: ['The last line of verse 2 is cut off at the fold of the page.'] },
      { title: 'Rock of Ages', author: 'Augustus Toplady', key: '', language: 'en', lyrics: 'Verse 1\nRock of Ages, cleft for me,\nLet me hide myself in Thee;\nLet the water and the blood,\nFrom Thy wounded side which flowed,\nBe of sin the double cure;\nSave from wrath and make me pure.', chordChart: '', warnings: [] },
    ].slice(0, photos === 1 ? 2 : 2) }));
  }
  if (/clean sermon notes/.test(ask)) {
    const body = ask.slice(ask.indexOf('Notes:') + 6, ask.lastIndexOf('\n\nWrite ')).trim();
    const sentences = body.replace(/\b(um+|uh+|you know|like)\b,?\s*/gi, '').split(/(?<=[.!?])\s+/).filter(Boolean);
    return text(`## Main point\n${sentences.slice(0, 2).join(' ')}\n\n## Going deeper\n${sentences.slice(2).join(' ') || 'The preacher’s remaining notes, tidied (demo).'}\n\n_Tidied in demo mode. Connect an AI key on the server for the real thing._`);
  }
  if ('headline' in props && 'slides' in props && 'caption' in props) {
    // A Sunday recap: the facts are in the message, so the stand-in writes the five slides from them.
    let f: any = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    try { f = JSON.parse(ask.slice(ask.indexOf('Facts (JSON):') + 14, ask.indexOf('\n\nWrite:'))); } catch { /* keep the empty facts */ }
    const church = /staff of ([^,]+),/.exec(req.system ?? '')?.[1] ?? 'our church';
    const songs: string[] = Array.isArray(f.songs) ? f.songs.slice(0, 3) : [];
    const first: string[] = Array.isArray(f.firstTimers) ? f.firstTimers : [];
    const next = f.nextEvents?.[0];
    const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { weekday: 'long', timeZone: 'Asia/Kolkata' });
    const family = [first.length ? `We welcomed ${first.slice(0, 3).join(', ')}${first.length > 3 ? ` and ${first.length - 3} more` : ''} for the first time.` : '', f.celebrations?.length ? `${f.celebrations.length} birthdays and anniversaries this week.` : '', f.prayers?.prayed ? `${f.prayers.prayed} prayers prayed for ${f.prayers.requests} requests.` : ''].filter(Boolean).join(' ');
    return text(JSON.stringify({
      headline: f.sermon?.title ? `A Sunday of ${/hope/i.test(f.sermon.title) ? 'hope' : 'grace'} at ${church}` : `Sunday at ${church}`,
      caption: [`✨ Sunday in 60 seconds`, f.attendance ? `${f.attendance} of us worshipped together.` : 'We worshipped together.', f.sermon ? `${f.sermon.speaker || 'Our pastor'} preached "${f.sermon.title}" from ${f.sermon.scripture}.` : '', first.length ? `A warm welcome to ${first.slice(0, 2).join(' and ')} 🙏` : '', next ? `Next: ${next.title}, ${day(next.startsAt)}.` : '', `— ${church}`].filter(Boolean).join('\n'),
      slides: [
        { title: 'This Sunday', text: `${f.attendance ? `${f.attendance} of us` : 'We'} gathered at ${church}${f.children ? `, ${f.children} of them children` : ''}.`, stat: f.attendance ? String(f.attendance) : null },
        { title: 'The Word', text: f.sermon ? `${f.sermon.oneLiner || f.sermon.title} (${f.sermon.speaker})` : 'We opened the Word together.', stat: f.sermon?.scripture || null },
        { title: 'We sang', text: songs.length ? songs.join(' · ') : 'Songs of praise and thanks.', stat: songs.length ? `${f.songs.length} songs` : null },
        { title: 'Our family', text: family || 'Grateful for every family who came.', stat: first.length ? `${first.length} new` : f.prayers?.prayed ? `${f.prayers.prayed} prayers` : null },
        { title: 'Coming up', text: next ? `${next.title} on ${day(next.startsAt)}${next.location ? ` at ${next.location}` : ''}. See you Sunday!` : 'See you Sunday!', stat: next ? day(next.startsAt) : 'Sunday' },
      ],
    }));
  }
  if ('prayerPoints' in props && 'actions' in props) {
    // A spoken visit write-up: sentences become the diary line, "pray" lines the prayer points, promises the actions.
    const body = ask.slice(ask.indexOf('Transcript (speech-to-text, may have errors):') + 46, ask.lastIndexOf('\n\nReturn:')).trim();
    const sentences = body.replace(/\b(um+|uh+|you know|like|so yeah)\b,?\s*/gi, '').split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
    const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1).replace(/[.!?]*$/, '.');
    const isAction = (x: string) => /\b(will|need to|needs to|should|must|follow up|call|visit again|send|arrange|ask|remind|bring)\b/i.test(x);
    const isPrayer = (x: string) => /\bpray/i.test(x);
    const actions = sentences.filter(isAction).slice(0, 5).map((x) => ({ text: cap(x.replace(/^(i|we|i'll|we'll|i will|we will)\s+/i, '').replace(/^(will|need to|needs to|should|must)\s+/i, '')), due: /next week|this week|tomorrow|sunday|monday|friday/i.test(x) ? new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10) : null }));
    const prayer = sentences.filter(isPrayer).slice(0, 4).map((x) => cap(x.replace(/.*\bpray(ed|ing)?\s+(for|that|about)\s+/i, '')));
    const purpose = /hospital|surgery|ward|operation/i.test(body) ? 'hospital' : /funeral|passed away|died|bereave/i.test(body) ? 'bereavement' : /new (house|home|flat)|blessing/i.test(body) ? 'house_blessing' : /new family|first visit|just moved/i.test(body) ? 'new_family' : 'home';
    const concerns = [/job|salary|loan|debt|fees|money/i.test(body) ? 'Money: ' + (sentences.find((x) => /job|salary|loan|debt|fees|money/i.test(x)) ?? '').slice(0, 60) : '', /surgery|hospital|ill|sick|cancer|diabet|bp\b|pain/i.test(body) ? 'Health' : '', /marriage|husband|wife|divorce|fight/i.test(body) ? 'Marriage and family' : ''].filter(Boolean);
    return text(JSON.stringify({ summary: sentences.filter((x) => !isAction(x)).slice(0, 5).map(cap).join(' '), prayerPoints: prayer, actions, purpose, concerns, confidential: /surgery|cancer|divorce|loan|debt|abuse|hiv|depress/i.test(body) }));
  }
  if ('songs' in props) {
    const ids = [...ask.matchAll(/^(\S+) \| ([^|]+)\|/gm)].slice(0, Number(/Number of songs: (\d+)/.exec(ask)?.[1] ?? 4));
    return text(JSON.stringify({ songs: ids.map((m, i) => ({ songId: m[1], reason: i === 0 ? 'A strong call to worship.' : 'Fits the theme and flows from the song before.' })), note: 'Starts upbeat and settles into reflective worship (demo suggestion).' }));
  }
  if ('subject' in props) {
    const brief = ask.replace(/^Improve this draft\. Brief: /, '').split('\n')[0];
    return text(JSON.stringify({ subject: brief.slice(0, 60), text: `Dear {{firstName}},\n\n${brief}\n\nWe look forward to seeing you.\n\nWith love,\nThe church office` }));
  }
  if (/^Translate/m.test(req.system)) return text(`[${/into (\w+)/.exec(req.system)?.[1] ?? 'translation'}] ${ask}`);
  return text(`## Demo output\n\n${ask.split('\n').slice(0, 3).join('\n')}\n\n- Point one\n- Point two\n- Point three\n\nConnect an AI key on the server for real results.`);
}
