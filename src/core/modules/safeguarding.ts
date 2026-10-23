// Safeguarding for children's ministry: who must be cleared (members of chosen teams and Sunday
// school teachers), their police verification, child-protection training, signed declaration and
// references, when each runs out, and a warning (or a hard stop) on the rota for anyone not cleared.
import { ApiError } from '../errors.js';
import type { Ctx, Router } from '../engine.js';
import type { SafeguardCheck, SafeguardHub, SafeguardKind, SafeguardPersonView, SafeguardSettings, SafeguardStatus } from '../types.js';
import { find, fullName } from '../util.js';

const KINDS: SafeguardKind[] = ['police', 'training', 'declaration', 'reference'];
export const SAFEGUARD_LABEL: Record<SafeguardKind, string> = { police: 'Police verification', training: 'Child-protection training', declaration: 'Signed declaration', reference: 'Reference' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const META = 'safeguarding:settings';
const SOON_DAYS = 60;

export function safeguardSettings(ctx: Pick<Ctx, 'db'>): SafeguardSettings {
  const raw = ctx.db.get('meta', META)?.value;
  const base: SafeguardSettings = { teamIds: [], sundaySchool: true, required: ['police', 'training', 'declaration'], validMonths: { police: 36, training: 24, declaration: 12, reference: 0 }, blockRota: false };
  if (!raw) {
    // Out of the box: any team whose name says kids or children.
    const kids = ctx.db.all('teams').filter((t) => /kid|child|children|nursery|creche|sunday school|vbs|toddler/i.test(t.name)).map((t) => t.id);
    return { ...base, teamIds: kids };
  }
  const s = JSON.parse(raw) as Partial<SafeguardSettings>;
  return { ...base, ...s, validMonths: { ...base.validMonths, ...(s.validMonths ?? {}) } };
}

const addMonths = (iso: string, months: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
};
const expiryOf = (c: SafeguardCheck, s: SafeguardSettings) => c.expiresOn ?? (s.validMonths[c.kind] > 0 ? addMonths(c.issuedOn, s.validMonths[c.kind]) : null);

function stateOf(expiresOn: string | null, today: string): SafeguardStatus {
  if (!expiresOn) return 'cleared';
  if (expiresOn < today) return 'expired';
  const soon = new Date(Date.parse(`${today}T00:00:00Z`) + SOON_DAYS * 86_400_000).toISOString().slice(0, 10);
  return expiresOn <= soon ? 'expiring' : 'cleared';
}

/** People who must be cleared, with what they do. */
function inScope(ctx: Ctx, s: SafeguardSettings): Map<string, string[]> {
  const roles = new Map<string, string[]>();
  const add = (id: string, role: string) => { if (ctx.db.get('people', id)) roles.set(id, [...(roles.get(id) ?? []), role]); };
  for (const t of ctx.db.all('teams')) if (s.teamIds.includes(t.id)) for (const m of t.members) add(m.personId, t.name);
  if (s.sundaySchool) for (const c of ctx.db.all('ssClasses')) for (const id of c.teacherIds ?? []) add(id, `Sunday school · ${c.name}`);
  return roles;
}

export function personStatus(ctx: Ctx, personId: string, s = safeguardSettings(ctx)): { status: SafeguardStatus; items: SafeguardPersonView['items']; checks: SafeguardCheck[] } {
  const today = ctx.now.toISOString().slice(0, 10);
  const checks = [...(ctx.db.get('safeguarding', personId)?.checks ?? [])].sort((a, b) => b.issuedOn.localeCompare(a.issuedOn));
  const items = s.required.map((kind) => {
    const latest = checks.filter((c) => c.kind === kind).sort((a, b) => (expiryOf(b, s) ?? '9999').localeCompare(expiryOf(a, s) ?? '9999'))[0] ?? null;
    const expiresOn = latest ? expiryOf(latest, s) : null;
    return { kind, check: latest, expiresOn, state: latest ? stateOf(expiresOn, today) : ('missing' as SafeguardStatus) };
  });
  const rank: SafeguardStatus[] = ['missing', 'expired', 'expiring', 'cleared'];
  const status = items.length ? rank.find((r) => items.some((i) => i.state === r))! : 'cleared';
  return { status, items, checks };
}

/** For the rota: null when fine, else why this person should not be scheduled on this team. */
export function rotaClearance(ctx: Ctx, teamId: string, personId: string): { reason: string; block: boolean } | null {
  const s = safeguardSettings(ctx);
  if (!s.teamIds.includes(teamId)) return null;
  const st = personStatus(ctx, personId, s);
  if (st.status === 'cleared' || st.status === 'expiring') return null;
  const missing = st.items.filter((i) => i.state === 'missing' || i.state === 'expired').map((i) => `${SAFEGUARD_LABEL[i.kind].toLowerCase()} ${i.state === 'expired' ? 'expired' : 'missing'}`);
  return { reason: `Not cleared to work with children (${missing.join(', ')})`, block: s.blockRota };
}

function hub(ctx: Ctx): SafeguardHub {
  const s = safeguardSettings(ctx);
  const roles = inScope(ctx, s);
  const nowIso = ctx.now.toISOString();
  const soon = new Date(ctx.now.getTime() + 30 * 86_400_000).toISOString();
  const events = new Map(ctx.db.all('events').filter((e) => e.startsAt >= nowIso).map((e) => [e.id, e]));
  const teams = new Map(ctx.db.all('teams').map((t) => [t.id, t]));
  const people: SafeguardPersonView[] = [...roles].map(([personId, r]) => {
    const p = ctx.db.get('people', personId)!;
    const st = personStatus(ctx, personId, s);
    const scheduled = ctx.db
      .all('assignments')
      .filter((a) => a.personId === personId && a.status !== 'declined' && s.teamIds.includes(a.teamId) && events.has(a.eventId))
      .map((a) => { const e = events.get(a.eventId)!; return { eventId: e.id, title: e.title, startsAt: e.startsAt, teamName: teams.get(a.teamId)?.name ?? '' }; })
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    return { personId, name: fullName(p), phone: p.phone, roles: [...new Set(r)], status: st.status, items: st.items, checks: st.checks, scheduled };
  });
  const order: SafeguardStatus[] = ['missing', 'expired', 'expiring', 'cleared'];
  people.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.name.localeCompare(b.name));
  const counts = { cleared: 0, expiring: 0, expired: 0, missing: 0 } as Record<SafeguardStatus, number>;
  for (const p of people) counts[p.status]++;
  const atRisk = people.filter((p) => (p.status === 'missing' || p.status === 'expired') && p.scheduled.some((x) => x.startsAt <= soon)).length;
  return { settings: s, teams: ctx.db.all('teams').map((t) => ({ id: t.id, name: t.name })), people, counts, atRisk };
}

function personView(ctx: Ctx, personId: string): SafeguardPersonView {
  return hub(ctx).people.find((p) => p.personId === personId) ?? (() => {
    const p = find(ctx, 'people', personId, 'Person');
    const st = personStatus(ctx, personId);
    return { personId, name: fullName(p), phone: p.phone, roles: [], status: st.status, items: st.items, checks: st.checks, scheduled: [] };
  })();
}

export function registerSafeguarding(r: Router) {
  r.get('/admin/safeguarding', { perm: ['people.view', 'volunteers'] }, (ctx) => hub(ctx));

  r.patch('/admin/safeguarding/settings', { perm: 'people.edit' }, (ctx) => {
    const cur = safeguardSettings(ctx);
    const b = ctx.body as Partial<SafeguardSettings>;
    const next: SafeguardSettings = {
      teamIds: Array.isArray(b.teamIds) ? b.teamIds.filter((id) => ctx.db.get('teams', String(id))).map(String) : cur.teamIds,
      sundaySchool: b.sundaySchool !== undefined ? !!b.sundaySchool : cur.sundaySchool,
      required: Array.isArray(b.required) ? KINDS.filter((k) => b.required!.includes(k)) : cur.required,
      validMonths: { ...cur.validMonths },
      blockRota: b.blockRota !== undefined ? !!b.blockRota : cur.blockRota,
    };
    if (b.validMonths) for (const k of KINDS) if (b.validMonths[k] !== undefined) next.validMonths[k] = Math.max(0, Math.min(120, Math.round(Number(b.validMonths[k]) || 0)));
    ctx.db.put('meta', { id: META, value: JSON.stringify(next) });
    ctx.audit('updated', 'safeguarding', null, 'Updated safeguarding rules');
    return hub(ctx);
  });

  r.post('/admin/safeguarding/:personId/checks', { perm: 'people.edit' }, (ctx) => {
    const p = find(ctx, 'people', ctx.params[0], 'Person');
    const b = ctx.body as Partial<SafeguardCheck>;
    const kind = b.kind as SafeguardKind;
    if (!KINDS.includes(kind)) throw new ApiError(422, 'invalid', 'Choose what kind of check this is.', { kind: 'Required' });
    const issuedOn = String(b.issuedOn ?? '').slice(0, 10);
    if (!DATE_RE.test(issuedOn)) throw new ApiError(422, 'invalid', 'Enter the date it was issued or done.', { issuedOn: 'Use YYYY-MM-DD' });
    if (issuedOn > ctx.now.toISOString().slice(0, 10)) throw new ApiError(422, 'invalid', 'The date cannot be in the future.', { issuedOn: 'Not in the future' });
    const expiresOn = b.expiresOn ? String(b.expiresOn).slice(0, 10) : null;
    if (expiresOn && (!DATE_RE.test(expiresOn) || expiresOn <= issuedOn)) throw new ApiError(422, 'invalid', 'The expiry date must come after the issue date.', { expiresOn: 'After the issue date' });
    const check: SafeguardCheck = { id: ctx.id('sg'), kind, issuedOn, expiresOn, reference: String(b.reference ?? '').trim().slice(0, 80) || null, note: String(b.note ?? '').trim().slice(0, 300) || null, recordedBy: ctx.staff?.name ?? 'Office', recordedAt: ctx.now.toISOString() };
    const rec = ctx.db.get('safeguarding', p.id) ?? { id: p.id, checks: [] };
    ctx.db.put('safeguarding', { ...rec, checks: [...rec.checks, check] });
    ctx.audit('recorded', 'safeguarding', p.id, `${SAFEGUARD_LABEL[kind]} recorded for ${fullName(p)}`);
    return personView(ctx, p.id);
  });

  r.del('/admin/safeguarding/:personId/checks/:checkId', { perm: 'people.edit' }, (ctx) => {
    const p = find(ctx, 'people', ctx.params[0], 'Person');
    const rec = ctx.db.get('safeguarding', p.id);
    const c = rec?.checks.find((x) => x.id === ctx.params[1]);
    if (!rec || !c) throw new ApiError(404, 'not_found', 'That record is not there.');
    ctx.db.put('safeguarding', { ...rec, checks: rec.checks.filter((x) => x.id !== c.id) });
    ctx.audit('deleted', 'safeguarding', p.id, `Removed a ${SAFEGUARD_LABEL[c.kind].toLowerCase()} record for ${fullName(p)}`);
    return personView(ctx, p.id);
  });
}
