// Skills & helping hands. Members say what they can do (electrician, doctor, tabla, Telugu typing,
// driving) and whether they are happy to help the church, so the office can find a volunteer in a
// minute. A church board carries job openings, needs ("maths tutor for my son") and offers, with
// contact by phone; posts close themselves after 30 days and the office can hide any post.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { BoardKind, BoardPost, BoardPostView, MySkills, SkillPerson, SkillProfile, SkillsHub } from '../types.js';
import { find, fullName, localDate } from '../util.js';

const DAY = 86_400_000;
const POST_DAYS = 30;
const KINDS: BoardKind[] = ['job', 'need', 'offer'];
export const SKILL_SUGGESTIONS = [
  'Electrician', 'Plumber', 'Carpenter', 'Painter', 'Mason', 'Driver', 'Cook', 'Tailor', 'Doctor', 'Nurse', 'Pharmacist', 'Counsellor',
  'Lawyer', 'Accountant', 'Chartered accountant', 'Teacher', 'Maths tutor', 'English tutor', 'Computer and IT', 'Photography', 'Video editing',
  'Graphic design', 'Sound and mixing', 'Keyboard', 'Guitar', 'Drums', 'Tabla', 'Violin', 'Singing', 'Translation', 'Telugu typing', 'Hindi typing',
  'Event decoration', 'First aid', 'Social media', 'Website', 'Hospitality', 'Children\'s ministry',
];
const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** Tidy a skill: trim, collapse spaces, first letter upper case, and match a suggestion's spelling. */
function tidy(raw: unknown): string {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!s) return '';
  return SKILL_SUGGESTIONS.find((x) => x.toLowerCase() === s.toLowerCase()) ?? s[0].toUpperCase() + s.slice(1);
}
function readSkills(v: unknown): string[] {
  const list = Array.isArray(v) ? v : String(v ?? '').split(',');
  const out: string[] = [];
  for (const x of list) { const t = tidy(x); if (t && !out.some((y) => y.toLowerCase() === t.toLowerCase())) out.push(t); }
  return out.slice(0, 20);
}

function personRow(ctx: Ctx, p: SkillProfile): SkillPerson | null {
  const person = ctx.db.get('people', p.id);
  if (!person || person.status === 'inactive') return null;
  return { personId: p.id, name: fullName(person), phone: person.phone ?? null, skills: p.skills, note: p.note, serve: p.serve, share: p.share, updatedAt: p.updatedAt };
}

function postView(ctx: Ctx, b: BoardPost): BoardPostView {
  const p = ctx.db.get('people', b.personId);
  return { ...b, name: p ? fullName(p) : 'Removed person', phone: p?.phone ?? null, expired: b.expiresOn < localDate(ctx, ctx.now) };
}

function hub(ctx: Ctx): SkillsHub {
  const people = ctx.db.all('skillProfiles').map((p) => personRow(ctx, p)).filter((x): x is SkillPerson => !!x && x.skills.length > 0).sort((a, b) => a.name.localeCompare(b.name));
  const tally = new Map<string, number>();
  for (const p of people) for (const s of p.skills) tally.set(s, (tally.get(s) ?? 0) + 1);
  const posts = ctx.db.all('boardPosts').map((b) => postView(ctx, b)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200);
  return {
    people,
    skills: [...tally].map(([skill, count]) => ({ skill, count })).sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill)),
    posts,
    counts: { people: people.length, willingToServe: people.filter((p) => p.serve).length, openPosts: posts.filter((p) => p.status === 'open' && !p.expired).length },
  };
}

function mine(ctx: Ctx): MySkills {
  const me = ctx.me();
  const p = ctx.db.get('skillProfiles', me);
  return {
    mine: p ? { skills: p.skills, note: p.note, serve: p.serve, share: p.share } : null,
    directory: ctx.db.all('skillProfiles').filter((x) => x.share && x.skills.length && x.id !== me).map((x) => personRow(ctx, x)).filter((x): x is SkillPerson => !!x)
      .sort((a, b) => a.name.localeCompare(b.name)).map(({ personId, name, phone, skills, note }) => ({ personId, name, phone, skills, note })),
    posts: ctx.db.all('boardPosts').map((b) => postView(ctx, b))
      .filter((b) => (b.status === 'open' && !b.expired) || (b.personId === me && b.status !== 'hidden'))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100)
      .map((b) => ({ ...b, mine: b.personId === me })),
    suggestions: SKILL_SUGGESTIONS,
  };
}

function saveProfile(ctx: Ctx, id: string, b: Record<string, unknown>): SkillProfile {
  const prev = ctx.db.get('skillProfiles', id);
  return ctx.db.put('skillProfiles', {
    id,
    skills: b.skills !== undefined ? readSkills(b.skills) : (prev?.skills ?? []),
    note: b.note !== undefined ? clean(b.note, 300) : (prev?.note ?? ''),
    serve: b.serve !== undefined ? !!b.serve : (prev?.serve ?? true),
    share: b.share !== undefined ? !!b.share : (prev?.share ?? false),
    updatedAt: ctx.now.toISOString(),
  });
}

export function registerSkills(r: Router) {
  r.get('/admin/skills', { perm: ['people.view', 'volunteers'] }, (ctx) => hub(ctx));

  // The office records skills for someone who told them in person.
  r.patch('/admin/skills/:personId', { perm: 'people.edit' }, (ctx) => {
    find(ctx, 'people', ctx.params[0], 'Person');
    saveProfile(ctx, ctx.params[0], ctx.body as Record<string, unknown>);
    return hub(ctx);
  });

  r.post('/admin/board/:id/:action', { perm: 'people.edit' }, (ctx) => {
    const b = find(ctx, 'boardPosts', ctx.params[0], 'Post');
    const action = ctx.params[1];
    if (action === 'hide') { ctx.db.put('boardPosts', { ...b, status: 'hidden' }); ctx.audit('updated', 'board', b.id, `Hid board post "${b.title}"`); }
    else if (action === 'show') ctx.db.put('boardPosts', { ...b, status: 'open' });
    else throw new ApiError(404, 'not_found', 'Unknown action.');
    return hub(ctx);
  });

  r.get('/me/skills', {}, (ctx) => mine(ctx));
  r.put('/me/skills', {}, (ctx) => { saveProfile(ctx, ctx.me(), ctx.body as Record<string, unknown>); return mine(ctx); });

  r.post('/me/board', {}, (ctx) => {
    const b = ctx.body as Record<string, unknown>;
    const me = ctx.me();
    const title = clean(b.title, 100);
    if (!title) throw new ApiError(422, 'invalid', 'Give the post a short title.', { title: 'Required' });
    const today = localDate(ctx, ctx.now);
    if (ctx.db.all('boardPosts').filter((x) => x.personId === me && x.status === 'open' && x.expiresOn >= today).length >= 3) throw new ApiError(409, 'limit', 'You can have 3 open posts at a time. Close one first.');
    ctx.db.put('boardPosts', {
      id: ctx.id('bp'), personId: me, kind: KINDS.includes(b.kind as BoardKind) ? (b.kind as BoardKind) : 'need',
      title, body: clean(b.body, 1000), place: clean(b.place, 80), status: 'open', createdAt: ctx.now.toISOString(), expiresOn: addDays(today, POST_DAYS),
    });
    return mine(ctx);
  });

  r.post('/me/board/:id/close', {}, (ctx) => {
    const b = find(ctx, 'boardPosts', ctx.params[0], 'Post');
    if (b.personId !== ctx.me()) throw new ApiError(403, 'forbidden', 'Only the person who posted can close it.');
    if (b.status === 'open') ctx.db.put('boardPosts', { ...b, status: 'closed' });
    return mine(ctx);
  });
}
