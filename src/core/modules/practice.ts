// Choir practice: who came to each rehearsal and what was sung, and part recordings (soprano,
// alto, tenor, bass, melody or the whole song) on each song so singers can learn their line at
// home. The parts show in the musicians' view and in the member app; the evening before a
// rehearsal everyone in the team gets a nudge with the songs.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { MyPractice, Practice, PracticeMember, PracticeSong, PracticeView, PracticesHub, Rehearsal, Song, SongPart, SongPartName, Team } from '../types.js';
import { find, fullName, localDate, settings, upcoming } from '../util.js';
import { notify } from './notify.js';

export const SONG_PARTS: SongPartName[] = ['soprano', 'alto', 'tenor', 'bass', 'melody', 'harmony', 'instrumental', 'full'];
export const PART_LABEL: Record<SongPartName, string> = { soprano: 'Soprano', alto: 'Alto', tenor: 'Tenor', bass: 'Bass', melody: 'Melody', harmony: 'Harmony', instrumental: 'Instrumental', full: 'Whole song' };
const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
const SINGING = /worship|choir|music|band|sing|praise|vocal/i;

const practiceSong = (s: Song): PracticeSong => ({ id: s.id, title: s.title, author: s.author, key: s.defaultKey, parts: s.parts ?? [] });
const songsOf = (ctx: Ctx, ids: string[]) => ids.map((id) => ctx.db.get('songs', id)).filter((s): s is Song => !!s).map(practiceSong);
const planSongIds = (ctx: Ctx, eventId: string | null) => (eventId ? (ctx.db.get('plans', eventId)?.items ?? []).filter((i) => i.kind === 'song' && i.songId).map((i) => i.songId as string) : []);
const roster = (t: Team) => t.members.map((m) => m.personId);

/** The next planned rehearsal: the soonest upcoming service plan with a rehearsal time, and its songs. */
export function nextRehearsal(ctx: Ctx): Rehearsal | null {
  const cands = ctx.db.all('plans').filter((p) => p.rehearsalAt && Date.parse(p.rehearsalAt) > ctx.now.getTime() - 3 * 3_600_000)
    .map((p) => ({ p, ev: ctx.db.get('events', p.eventId) })).filter((x) => x.ev && upcoming(ctx, x.ev)).sort((a, b) => a.p.rehearsalAt!.localeCompare(b.p.rehearsalAt!));
  const x = cands[0];
  return x ? { eventId: x.p.eventId, eventTitle: x.ev!.title, at: x.p.rehearsalAt!, notes: x.p.rehearsalNotes ?? '', songs: songsOf(ctx, planSongIds(ctx, x.p.eventId)) } : null;
}

function view(ctx: Ctx, x: Practice): PracticeView {
  const t = ctx.db.get('teams', x.teamId);
  return { ...x, teamName: t?.name ?? 'Team', eventTitle: x.eventId ? ctx.db.get('events', x.eventId)?.title ?? null : null, songs: songsOf(ctx, x.songIds), present: x.presentIds.length, roster: t ? roster(t).length : 0 };
}

/** Attendance per member over the practices given (newest first). */
function membersOf(ctx: Ctx, t: Team, practices: Practice[]): PracticeMember[] {
  return t.members.map((m) => {
    const p = ctx.db.get('people', m.personId);
    const mine = practices.filter((x) => Date.parse(x.at) >= Date.parse(p?.joinedAt ?? '1970-01-01') || x.presentIds.includes(m.personId));
    let missedInARow = 0;
    for (const x of mine) { if (x.presentIds.includes(m.personId)) break; missedInARow++; }
    const last = mine.find((x) => x.presentIds.includes(m.personId));
    return { personId: m.personId, name: p ? fullName(p) : 'Removed', positions: m.positionIds.map((id) => t.positions.find((q) => q.id === id)?.name ?? '').filter(Boolean), present: mine.filter((x) => x.presentIds.includes(m.personId)).length, total: mine.length, missedInARow, lastAt: last?.at ?? null };
  }).sort((a, b) => b.missedInARow - a.missedInARow || a.name.localeCompare(b.name));
}

function cleanPractice(ctx: Ctx, t: Team, body: Record<string, unknown>, cur?: Practice): Omit<Practice, 'id' | 'teamId' | 'recordedBy' | 'createdAt' | 'updatedAt'> {
  const at = body.at === undefined ? cur?.at : new Date(String(body.at)).toISOString();
  if (!at || at === 'Invalid Date') throw new ApiError(422, 'validation', 'When was the practice?', { at: 'Required' });
  const eventId = body.eventId === undefined ? cur?.eventId ?? null : body.eventId ? find(ctx, 'events', String(body.eventId), 'Event').id : null;
  const ids = new Set(roster(t));
  const presentIds = body.presentIds === undefined ? cur?.presentIds ?? [] : (Array.isArray(body.presentIds) ? body.presentIds.map(String).filter((id) => ids.has(id)) : []);
  const songIds = body.songIds === undefined ? cur?.songIds ?? planSongIds(ctx, eventId) : (Array.isArray(body.songIds) ? body.songIds.map(String).filter((id) => ctx.db.get('songs', id)) : []);
  return { at, minutes: body.minutes === undefined ? cur?.minutes ?? 90 : Math.max(0, Math.min(600, Math.round(Number(body.minutes)) || 0)), eventId, songIds: [...new Set(songIds)].slice(0, 30), presentIds: [...new Set(presentIds)], notes: body.notes === undefined ? cur?.notes ?? '' : clean(body.notes, 2000) };
}

/** Teams that rehearse: any team with someone rostered for the service, else teams with a singing name. */
function rehearsingTeams(ctx: Ctx, eventId: string): Team[] {
  const teams = ctx.db.all('teams');
  const withPractice = teams.filter((t) => ctx.db.all('practices').some((x) => x.eventId === eventId && x.teamId === t.id));
  if (withPractice.length) return withPractice;
  const named = teams.filter((t) => SINGING.test(t.name));
  return named.length ? named : teams.filter((t) => ctx.db.all('assignments').some((a) => a.eventId === eventId && a.teamId === t.id));
}

/** The evening before a rehearsal: the time, the songs and a nudge to listen to the parts. */
export async function practiceReminders(ctx: Ctx, today: string) {
  const tomorrow = localDate(ctx, new Date(ctx.now.getTime() + 86_400_000));
  for (const p of ctx.db.all('plans')) {
    if (!p.rehearsalAt) continue;
    const day = localDate(ctx, new Date(p.rehearsalAt));
    if (day !== tomorrow && day !== today) continue;
    const key = `practice:${p.eventId}:${day}`;
    if (ctx.db.get('meta', key)) continue;
    const ev = ctx.db.get('events', p.eventId);
    if (!ev) continue;
    ctx.db.put('meta', { id: key, value: today });
    const teams = rehearsingTeams(ctx, p.eventId);
    const personIds = [...new Set(teams.flatMap(roster))];
    if (!personIds.length) continue;
    const tz = settings(ctx).timezone || 'Asia/Kolkata';
    const when = new Intl.DateTimeFormat('en-IN', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(p.rehearsalAt));
    const songs = songsOf(ctx, planSongIds(ctx, p.eventId));
    const list = songs.slice(0, 6).map((s) => `${s.title}${s.key ? ` (${s.key})` : ''}${s.parts.length ? ' ♪' : ''}`).join(', ');
    await notify(ctx, 'practice.reminder', { personIds, title: `Practice ${day === today ? 'today' : 'tomorrow'}, ${when}`, body: `Rehearsal for ${ev.title}${songs.length ? `: ${list}` : ''}.${songs.some((s) => s.parts.length) ? ' Songs marked ♪ have part recordings in the app; listen to your line before you come.' : ''}${p.rehearsalNotes ? `\n${p.rehearsalNotes}` : ''}`, link: '/app/practice' });
  }
}

export function registerPractice(r: Router) {
  const PERM = ['services', 'volunteers'] as ('services' | 'volunteers')[];
  const pickTeam = (ctx: Ctx, teamId: string | undefined) => {
    const teams = ctx.db.all('teams').sort((a, b) => a.name.localeCompare(b.name));
    return (teamId && teams.find((t) => t.id === teamId)) || teams.find((t) => SINGING.test(t.name)) || teams[0] || null;
  };

  // ----- office -----
  r.get('/admin/practices', { perm: PERM }, (ctx): PracticesHub => {
    const t = pickTeam(ctx, ctx.query.teamId);
    const practices = ctx.db.all('practices').filter((x) => !t || x.teamId === t.id).sort((a, b) => b.at.localeCompare(a.at));
    return {
      teams: ctx.db.all('teams').sort((a, b) => a.name.localeCompare(b.name)).map((x) => ({ id: x.id, name: x.name, color: x.color, roster: roster(x).length })),
      teamId: t?.id ?? null,
      practices: practices.slice(0, 60).map((x) => view(ctx, x)),
      members: t ? membersOf(ctx, t, practices.slice(0, 12)) : [],
      nextRehearsal: nextRehearsal(ctx),
      parts: SONG_PARTS,
      songsWithParts: ctx.db.all('songs').filter((s) => s.parts?.length).sort((a, b) => a.title.localeCompare(b.title)).map(practiceSong),
    };
  });
  r.post('/admin/practices', { perm: PERM }, (ctx) => {
    const t = find(ctx, 'teams', String(ctx.body.teamId ?? ''), 'Team');
    const x = ctx.db.put('practices', { id: ctx.id('pr'), teamId: t.id, ...cleanPractice(ctx, t, ctx.body), recordedBy: ctx.staff?.name ?? 'office', createdAt: ctx.now.toISOString(), updatedAt: ctx.now.toISOString() });
    ctx.audit('created', 'practice', x.id, `${t.name} practice on ${x.at.slice(0, 10)}: ${x.presentIds.length} of ${roster(t).length} came`);
    return view(ctx, x);
  });
  r.patch('/admin/practices/:id', { perm: PERM }, (ctx) => {
    const x = find(ctx, 'practices', ctx.params[0], 'Practice');
    const t = find(ctx, 'teams', x.teamId, 'Team');
    const next = ctx.db.put('practices', { ...x, ...cleanPractice(ctx, t, ctx.body, x), updatedAt: ctx.now.toISOString() });
    return view(ctx, next);
  });
  r.del('/admin/practices/:id', { perm: PERM }, (ctx) => {
    const x = find(ctx, 'practices', ctx.params[0], 'Practice');
    ctx.db.del('practices', x.id);
    ctx.audit('deleted', 'practice', x.id, `Removed a practice record`);
    return { ok: true as const };
  });
  r.get('/admin/practices/attendance.csv', { perm: PERM }, (ctx) => {
    const t = pickTeam(ctx, ctx.query.teamId);
    if (!t) throw new ApiError(404, 'not_found', 'No team.');
    const practices = ctx.db.all('practices').filter((x) => x.teamId === t.id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 26);
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Name', 'Parts', 'Present', 'Of', ...practices.map((x) => x.at.slice(0, 10))];
    const rows = membersOf(ctx, t, practices).map((m) => [m.name, m.positions.join(' / '), m.present, m.total, ...practices.map((x) => (x.presentIds.includes(m.personId) ? 'Y' : ''))]);
    return { __raw: true as const, contentType: 'text/csv; charset=utf-8', filename: `${t.name.replace(/\W+/g, '-')}-practice-attendance.csv`, body: [head, ...rows].map((r) => r.map(esc).join(',')).join('\n') };
  });

  // Part recordings on a song.
  r.post('/admin/songs/:id/parts', { perm: PERM }, (ctx) => {
    const s = find(ctx, 'songs', ctx.params[0], 'Song');
    const part = String(ctx.body.part ?? '') as SongPartName;
    if (!SONG_PARTS.includes(part)) throw new ApiError(422, 'validation', 'Which part is this?', { part: 'Required' });
    let url = clean(ctx.body.url, 600);
    const mediaId = ctx.body.mediaId ? find(ctx, 'media', String(ctx.body.mediaId), 'File').id : null;
    if (mediaId) url = ctx.db.get('media', mediaId)!.url;
    if (!/^https?:\/\//.test(url) && !url.startsWith('data:audio/')) throw new ApiError(422, 'validation', 'Paste a link to the recording (Drive, YouTube, WhatsApp export) or pick a file from the media library.', { url: 'A link' });
    const np: SongPart = { id: ctx.id('sp'), part, name: clean(ctx.body.name, 80) || PART_LABEL[part], url, mediaId, addedBy: ctx.staff?.name ?? 'office', addedAt: ctx.now.toISOString() };
    const parts = [...(s.parts ?? []).filter((p) => !(p.part === part && ctx.body.replace)), np].slice(-16);
    const next = ctx.db.put('songs', { ...s, parts });
    ctx.audit('updated', 'song', s.id, `Added a ${PART_LABEL[part].toLowerCase()} recording to ${s.title}`);
    return practiceSong(next);
  });
  r.del('/admin/songs/:id/parts/:partId', { perm: PERM }, (ctx) => {
    const s = find(ctx, 'songs', ctx.params[0], 'Song');
    const next = ctx.db.put('songs', { ...s, parts: (s.parts ?? []).filter((p) => p.id !== ctx.params[1]) });
    return practiceSong(next);
  });

  // ----- members and the Team app -----
  r.get('/me/practice', {}, (ctx): MyPractice => {
    const me = ctx.me();
    const teamId = ctx.query.teamId || null;
    const teams = ctx.db.all('teams').filter((t) => t.members.some((m) => m.personId === me) && (!teamId || t.id === teamId)).sort((a, b) => a.name.localeCompare(b.name));
    const ids = new Set(teams.map((t) => t.id));
    const practices = ctx.db.all('practices').filter((x) => ids.has(x.teamId)).sort((a, b) => b.at.localeCompare(a.at));
    const next = nextRehearsal(ctx);
    const nextIds = new Set((next?.songs ?? []).map((s) => s.id));
    const withParts = ctx.db.all('songs').filter((s) => s.parts?.length && !nextIds.has(s.id)).sort((a, b) => a.title.localeCompare(b.title)).map(practiceSong);
    const mine = practices.slice(0, 12);
    const last = mine.find((x) => x.presentIds.includes(me));
    return {
      teams: teams.map((t) => ({ id: t.id, name: t.name, myParts: (t.members.find((m) => m.personId === me)?.positionIds ?? []).map((id) => t.positions.find((p) => p.id === id)?.name ?? '').filter(Boolean), isLeader: t.leaderId === me, roster: t.members.map((m) => ctx.db.get('people', m.personId)).filter((p): p is NonNullable<typeof p> => !!p).map((p) => ({ personId: p.id, name: fullName(p) })).sort((a, b) => a.name.localeCompare(b.name)) })),
      nextRehearsal: next,
      songs: [...(next?.songs ?? []).filter((s) => s.parts.length), ...withParts],
      attendance: { present: mine.filter((x) => x.presentIds.includes(me)).length, total: mine.length, lastAt: last?.at ?? null },
      recent: practices.slice(0, 8).map((x) => ({ id: x.id, at: x.at, teamName: ctx.db.get('teams', x.teamId)?.name ?? 'Team', wasPresent: x.presentIds.includes(me), songs: songsOf(ctx, x.songIds).map((s) => s.title), presentIds: x.presentIds })),
      parts: SONG_PARTS,
    };
  });
  // A team leader records attendance from the Team app.
  const leaderTeam = (ctx: Ctx, teamId: string) => {
    const t = find(ctx, 'teams', teamId, 'Team');
    if (t.leaderId !== ctx.me()) throw new ApiError(403, 'forbidden', 'Only the team leader can mark practice attendance.');
    return t;
  };
  r.post('/me/practice', {}, (ctx) => {
    const t = leaderTeam(ctx, String(ctx.body.teamId ?? ''));
    const p = ctx.db.get('people', ctx.me());
    const x = ctx.db.put('practices', { id: ctx.id('pr'), teamId: t.id, ...cleanPractice(ctx, t, ctx.body), recordedBy: p ? fullName(p) : 'Team leader', createdAt: ctx.now.toISOString(), updatedAt: ctx.now.toISOString() });
    ctx.audit('created', 'practice', x.id, `${t.name} practice on ${x.at.slice(0, 10)}: ${x.presentIds.length} of ${roster(t).length} came`);
    return view(ctx, x);
  });
  r.patch('/me/practice/:id', {}, (ctx) => {
    const x = find(ctx, 'practices', ctx.params[0], 'Practice');
    const t = leaderTeam(ctx, x.teamId);
    return view(ctx, ctx.db.put('practices', { ...x, ...cleanPractice(ctx, t, ctx.body, x), updatedAt: ctx.now.toISOString() }));
  });
}
