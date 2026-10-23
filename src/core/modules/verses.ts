// Kids' memory verse game: the verse the class was taught on Sunday becomes three rounds in the
// parent's app during the week (read it, fill the blanks, say it from memory), the teacher's tick in
// the register counts too, and the class has a leaderboard that resets every Sunday. Parents get a
// Monday push with the verse. Scoring is done here, never in the browser.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { Collections, MemberVerses, SsClass, SsLesson, SsVerseBoards, VerseAnswerResult, VerseBoard, VerseBoardRow, VerseGame, VerseGameView, VerseLevel, VersePuzzle } from '../types.js';
import { find, fullName } from '../util.js';
import { notify } from './notify.js';
import { addDays, classes, lastSunday, lessonFor } from './sunday-school.js';

export const LEVELS: VerseLevel[] = ['read', 'blanks', 'recite'];
export const POINTS = { read: 10, blanks: 20, recite: 30, inClass: 40 } as const;
const REF_RE = /\s*\(?((?:[1-3]\s?)?\p{Lu}[\p{L}.]+(?:\s\p{Lu}[\p{L}.]+)?\s\d+:\d+(?:[-–]\d+)?)\)?\.?\s*$/u;

/** "Be kind … Ephesians 4:32" → the words and the reference apart. */
export function splitVerse(memoryVerse: string): { verse: string; reference: string } {
  const text = memoryVerse.replace(/\s+/g, ' ').trim();
  const m = text.match(REF_RE);
  if (!m || m.index === undefined || m.index < 8) return { verse: text, reference: '' };
  return { verse: text.slice(0, m.index).trim(), reference: m[1].trim() };
}

const hash = (s: string) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619) >>> 0; return h; };
const norm = (w: string) => w.toLocaleLowerCase().replace(/[\p{P}\p{S}]/gu, '').trim();
const tokens = (text: string) => text.split(/\s+/).map(norm).filter(Boolean);

/** Every third long word goes missing (at most five), in a fixed order for the game so the chips do not jump. */
export function puzzleOf(verse: string, seed: string): VersePuzzle {
  const words = verse.split(/\s+/).filter(Boolean);
  const candidates = words.map((w, i) => (norm(w).length >= 4 ? i : -1)).filter((i) => i >= 0);
  const start = candidates.length ? hash(seed) % Math.min(3, candidates.length) : 0;
  const blanks = new Set(candidates.filter((_, k) => (k - start) % 3 === 0).slice(0, 5));
  if (!blanks.size && candidates.length) blanks.add(candidates[0]);
  const missing = [...blanks].map((i) => norm(words[i]));
  const distractors = candidates.filter((i) => !blanks.has(i)).map((i) => norm(words[i])).filter((w, k, arr) => !missing.includes(w) && arr.indexOf(w) === k).slice(0, 2);
  const options = [...missing, ...distractors];
  // Deterministic shuffle so a refresh keeps the same order.
  for (let i = options.length - 1; i > 0; i--) { const j = hash(`${seed}:${i}`) % (i + 1); [options[i], options[j]] = [options[j], options[i]]; }
  return { words: words.map((w, i) => (blanks.has(i) ? null : w)), options };
}

/** How much of the verse came back, in word order: longest common subsequence over normalised words. */
export function accuracyOf(verse: string, said: string): number {
  const a = tokens(verse), b = tokens(said);
  if (!a.length) return 0;
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return Math.round((dp[a.length][b.length] * 100) / a.length);
}

export const starsOf = (points: number) => (points >= 60 ? 3 : points >= 30 ? 2 : points >= 10 ? 1 : 0);

/** The verse a class is on this week: taught last Sunday (class lesson first, then the general one). */
export function currentLesson(ctx: Ctx, classId: string, week = lastSunday(ctx)): SsLesson | null {
  const l = lessonFor(ctx, classId, week);
  return l?.memoryVerse ? l : null;
}

function recitedInClass(ctx: Ctx, classId: string, week: string, personId: string) {
  return [week, addDays(week, 7)].some((d) => ctx.db.get('ssAttendance', `${classId}:${d}`)?.verse.includes(personId));
}

const blank = (ctx: Ctx, personId: string, c: SsClass, l: SsLesson, week: string): VerseGame => {
  const { verse, reference } = splitVerse(l.memoryVerse);
  return { id: `${personId}:${l.id}`, personId, classId: c.id, lessonId: l.id, week, verse, reference, done: { read: null, blanks: null, recite: null }, scores: { read: 0, blanks: 0, recite: 0 }, attempts: 0, bestAccuracy: null, updatedAt: ctx.now.toISOString() };
};
const gameOf = (ctx: Ctx, personId: string, c: SsClass, l: SsLesson, week: string) => ctx.db.get('verseGames', `${personId}:${l.id}`) ?? blank(ctx, personId, c, l, week);

function pointsOf(ctx: Ctx, g: VerseGame) {
  const inClass = recitedInClass(ctx, g.classId, g.week, g.personId);
  const points = g.scores.read + g.scores.blanks + g.scores.recite + (inClass ? POINTS.inClass : 0);
  return { inClass, points, stars: starsOf(points) };
}

function view(ctx: Ctx, g: VerseGame, title: string): VerseGameView {
  const { inClass, points, stars } = pointsOf(ctx, g);
  return { id: g.id, lessonId: g.lessonId, week: g.week, title, verse: g.verse, reference: g.reference, done: g.done, scores: g.scores, recitedInClass: inClass, points, stars, nextLevel: LEVELS.find((l) => !g.done[l]) ?? null, puzzle: puzzleOf(g.verse, g.id), bestAccuracy: g.bestAccuracy };
}

const shortName = (p: Collections['people']) => `${p.firstName} ${p.lastName.trim().charAt(0)}${p.lastName.trim() ? '.' : ''}`.trim();

/** The class's week: everyone enrolled, most points first, ties by who got there first. */
export function board(ctx: Ctx, c: SsClass, week: string, me: Set<string>, full = false): VerseBoard | null {
  const l = currentLesson(ctx, c.id, week);
  if (!l) return null;
  const { verse, reference } = splitVerse(l.memoryVerse);
  const rows: VerseBoardRow[] = c.studentIds
    .map((id) => ctx.db.get('people', id))
    .filter((p): p is Collections['people'] => !!p)
    .map((p) => {
      const g = gameOf(ctx, p.id, c, l, week);
      const { inClass, points, stars } = pointsOf(ctx, g);
      return { id: p.id, name: full ? fullName(p) : shortName(p), points, stars, levels: LEVELS.filter((x) => g.done[x]), recitedInClass: inClass, mine: me.has(p.id), _at: g.updatedAt } as VerseBoardRow & { _at: string };
    })
    .sort((a, b) => b.points - a.points || a._at.localeCompare(b._at) || a.name.localeCompare(b.name))
    .map(({ _at, ...r }) => r);
  return { classId: c.id, className: c.name, week, verse, reference, players: rows.filter((r) => r.points > 0).length, of: rows.length, rows };
}

/** The children in the signed-in person's household who are in a class. */
function myChildren(ctx: Ctx) {
  const me = find(ctx, 'people', ctx.me(), 'Profile');
  const household = me.householdName ? ctx.db.all('people').filter((p) => p.householdName === me.householdName) : [me];
  const cls = classes(ctx);
  return household.map((p) => ({ p, c: cls.find((c) => c.studentIds.includes(p.id)) })).filter((x): x is { p: Collections['people']; c: SsClass } => !!x.c);
}

export function memberVerses(ctx: Ctx): MemberVerses {
  const week = lastSunday(ctx);
  const kids = myChildren(ctx);
  const mine = new Set(kids.map((k) => k.p.id));
  const boards = [...new Map(kids.map((k) => [k.c.id, k.c])).values()].map((c) => board(ctx, c, week, mine)).filter((b): b is VerseBoard => !!b);
  const children = kids.map(({ p, c }) => {
    const l = currentLesson(ctx, c.id, week);
    const past = ctx.db.all('verseGames').filter((g) => g.personId === p.id);
    const b = boards.find((x) => x.classId === c.id);
    const rank = b ? b.rows.findIndex((r) => r.id === p.id) : -1;
    return {
      id: p.id, name: p.firstName, classId: c.id, className: c.name,
      game: l ? view(ctx, gameOf(ctx, p.id, c, l, week), l.title) : null,
      rank: b && rank >= 0 && b.rows[rank].points > 0 ? rank + 1 : null,
      totalStars: past.reduce((n, g) => n + pointsOf(ctx, g).stars, 0),
      weeksPlayed: past.filter((g) => g.scores.read + g.scores.blanks + g.scores.recite > 0).length,
    };
  });
  return { children, boards };
}

/** Monday morning: parents get the verse their child is learning this week. */
export async function verseReminders(ctx: Ctx, today: string) {
  if (new Date(`${today}T00:00:00Z`).getUTCDay() !== 1) return;
  const week = lastSunday(ctx);
  for (const c of classes(ctx)) {
    const l = currentLesson(ctx, c.id, week);
    if (!l || !c.studentIds.length) continue;
    const key = `verse:${c.id}:${week}`;
    if (ctx.db.get('meta', key)) continue;
    ctx.db.put('meta', { id: key, value: today });
    const { verse, reference } = splitVerse(l.memoryVerse);
    const byParent = new Map<string, string[]>();
    for (const id of c.studentIds) {
      const child = ctx.db.get('people', id);
      if (!child?.householdName) continue;
      for (const par of ctx.db.all('people').filter((p) => p.id !== id && p.householdName === child.householdName && !c.studentIds.includes(p.id) && p.status !== 'inactive')) {
        byParent.set(par.id, [...(byParent.get(par.id) ?? []), child.firstName]);
      }
    }
    for (const [parentId, names] of byParent) {
      await notify(ctx, 'verse.week', { personIds: [parentId], title: `${names.join(' and ')}'s memory verse this week`, body: `“${verse}” ${reference}. Three quick rounds in the app earn stars on the ${c.name} board.`.trim(), link: '/app/verses' });
    }
  }
}

export function registerVerses(r: Router) {
  r.get('/me/verses', {}, (ctx) => memberVerses(ctx));

  // One round at a time, in order: read, fill the blanks, say it from memory. Scored here.
  r.post('/me/verses/:childId/answer', {}, (ctx): VerseAnswerResult => {
    const kid = myChildren(ctx).find((k) => k.p.id === ctx.params[0]);
    if (!kid) throw new ApiError(404, 'not_found', 'That child is not in your family or not in a class.');
    const week = lastSunday(ctx);
    const l = currentLesson(ctx, kid.c.id, week);
    if (!l) throw new ApiError(409, 'no_verse', 'No memory verse this week.');
    const level = ctx.body?.level as VerseLevel;
    if (!LEVELS.includes(level)) throw new ApiError(422, 'validation', 'Which round?');
    const cur = gameOf(ctx, kid.p.id, kid.c, l, week);
    const g: VerseGame = { ...cur, done: { ...cur.done }, scores: { ...cur.scores } };
    const expected = LEVELS.find((x) => !g.done[x]);
    if (g.done[level]) throw new ApiError(409, 'done', 'That round is already done.');
    if (expected !== level) throw new ApiError(409, 'order', `Finish the "${expected}" round first.`);
    g.attempts += 1;
    g.updatedAt = ctx.now.toISOString();
    let ok = false, accuracy = 0, earned = 0, message = '';
    if (level === 'read') {
      ok = true; accuracy = 100; earned = POINTS.read; message = 'Read! Now try it with some words missing.';
    } else if (level === 'blanks') {
      const puzzle = puzzleOf(g.verse, g.id);
      const want = g.verse.split(/\s+/).filter(Boolean).filter((_, i) => puzzle.words[i] === null).map(norm);
      const got = (Array.isArray(ctx.body.answers) ? ctx.body.answers : []).map((a: unknown) => norm(String(a ?? '')));
      const right = want.filter((w, i) => got[i] === w).length;
      accuracy = Math.round((right * 100) / Math.max(1, want.length));
      ok = right === want.length;
      earned = ok ? POINTS.blanks : 0;
      message = ok ? 'All the words are back! Now say it from memory.' : `${right} of ${want.length} right. Try again.`;
    } else {
      accuracy = accuracyOf(g.verse, String(ctx.body.text ?? ''));
      g.bestAccuracy = Math.max(g.bestAccuracy ?? 0, accuracy);
      ok = accuracy >= 70;
      earned = accuracy >= 90 ? POINTS.recite : ok ? 20 : 0;
      message = accuracy >= 90 ? 'Word perfect!' : ok ? 'Nearly word perfect. Well done!' : accuracy >= 40 ? 'Getting there. Read it once more and try again.' : 'Not yet. Read it again and try once more.';
    }
    if (ok) { g.done[level] = ctx.now.toISOString(); g.scores[level] = earned; }
    ctx.db.put('verseGames', g);
    return { ok, accuracy, earned, message, game: view(ctx, g, l.title) };
  });

  // Teachers: every class's board for a week, and the term's star table.
  r.get('/admin/sunday-school/verses', { perm: 'checkin' }, (ctx): SsVerseBoards => {
    const weeks = [...new Set([lastSunday(ctx), ...ctx.db.all('verseGames').map((g) => g.week)])].sort().reverse().slice(0, 12);
    const week = typeof ctx.query.week === 'string' && weeks.includes(ctx.query.week) ? ctx.query.week : weeks[0];
    const boards = classes(ctx).map((c) => board(ctx, c, week, new Set(), true)).filter((b): b is VerseBoard => !!b);
    const totals = new Map<string, { stars: number; weeks: number }>();
    for (const g of ctx.db.all('verseGames')) {
      const t = totals.get(g.personId) ?? { stars: 0, weeks: 0 };
      const s = pointsOf(ctx, g).stars;
      totals.set(g.personId, { stars: t.stars + s, weeks: t.weeks + (s ? 1 : 0) });
    }
    const cls = classes(ctx);
    const stars = [...totals].map(([id, t]) => { const p = ctx.db.get('people', id); const c = cls.find((x) => x.studentIds.includes(id)); return p && t.stars ? { id, name: fullName(p), className: c?.name ?? '', stars: t.stars, weeks: t.weeks } : null; }).filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => b.stars - a.stars || a.name.localeCompare(b.name)).slice(0, 30);
    return { week, weeks, boards, stars };
  });
}
