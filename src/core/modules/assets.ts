// Asset register: what the church owns (chairs, sound gear, the generator, instruments, the
// van), where it is, who looks after it, what it cost, and when it is next due a service or the
// AMC runs out. The daily tick reminds the office a week before a service and a month before an
// AMC or warranty ends.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { Asset, AssetCategory, AssetCondition, AssetLogEntry, AssetsHub } from '../types.js';
import { permsOf } from '../perms.js';
import { find, fullName, localDate, money, normEmail, settings } from '../util.js';
import { notify } from './notify.js';

export const ASSET_CATEGORIES: AssetCategory[] = ['furniture', 'sound', 'av', 'instrument', 'electrical', 'vehicle', 'kitchen', 'building', 'it', 'other'];
const CONDITIONS: AssetCondition[] = ['good', 'needs_repair', 'retired'];
const LOG_KINDS: AssetLogEntry['kind'][] = ['service', 'repair', 'note', 'moved'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;
const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
const date = (v: unknown, field: string): string | null => { const s = clean(v, 10); if (!s) return null; if (!DATE_RE.test(s)) throw new ApiError(422, 'validation', `Use YYYY-MM-DD for ${field}.`); return s; };
const minorOrNull = (v: unknown) => { if (v === null || v === undefined || v === '') return null; const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < 0) throw new ApiError(422, 'validation', 'Amounts are in paise.'); return n; };
const addMonths = (d: string, months: number) => { const [y, m, day] = d.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + months, 1)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); t.setUTCDate(Math.min(day, last)); return t.toISOString().slice(0, 10); };
const daysUntil = (d: string, today: string) => Math.round((Date.parse(`${d}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY);

/** Next service: from the last service (or purchase) plus the interval. */
export function nextService(a: Pick<Asset, 'serviceEveryMonths' | 'lastServicedOn' | 'purchasedOn'>): string | null {
  if (!a.serviceEveryMonths) return null;
  const from = a.lastServicedOn ?? a.purchasedOn;
  return from ? addMonths(from, a.serviceEveryMonths) : null;
}

function nextTag(ctx: Ctx): string {
  const n = Number(ctx.db.get('meta', 'assets:tag')?.value ?? 0) + 1;
  ctx.db.put('meta', { id: 'assets:tag', value: String(n) });
  return `A-${String(n).padStart(4, '0')}`;
}

function view(a: Asset, today: string) {
  const next = nextService(a);
  return {
    ...a, nextServiceOn: next,
    serviceDueInDays: next ? daysUntil(next, today) : null,
    amcDueInDays: a.amc?.until ? daysUntil(a.amc.until, today) : null,
    warrantyDueInDays: a.warrantyUntil ? daysUntil(a.warrantyUntil, today) : null,
  };
}

export function hub(ctx: Ctx, q: Record<string, string | undefined>): AssetsHub {
  const today = localDate(ctx, ctx.now);
  const status = q.status === 'retired' ? 'retired' : q.status === 'all' ? 'all' : 'active';
  const text = clean(q.q, 80).toLowerCase();
  const all = ctx.db.all('assets').map((a) => view(a, today));
  const active = all.filter((a) => a.status === 'active');
  const rows = all
    .filter((a) => status === 'all' || a.status === status)
    .filter((a) => !q.category || a.category === q.category)
    .filter((a) => !text || [a.name, a.tag, a.location, a.custodianName, a.serial, a.vendor, a.amc?.vendor].some((s) => (s ?? '').toLowerCase().includes(text)))
    .sort((a, b) => a.tag.localeCompare(b.tag));
  return {
    assets: rows,
    summary: {
      count: active.reduce((s, a) => s + a.quantity, 0),
      value: active.reduce((s, a) => s + (a.cost ?? 0) * a.quantity, 0),
      serviceDue: active.filter((a) => a.serviceDueInDays !== null && a.serviceDueInDays <= 7).length,
      amcExpiring: active.filter((a) => (a.amcDueInDays !== null && a.amcDueInDays <= 30) || (a.warrantyDueInDays !== null && a.warrantyDueInDays <= 30)).length,
      needsRepair: active.filter((a) => a.condition === 'needs_repair').length,
    },
    categories: ASSET_CATEGORIES,
  };
}

/** People records of staff who can change the register: they get the reminders. */
function keeperIds(ctx: Ctx): string[] {
  const out = new Set<string>();
  for (const s of ctx.db.all('staff')) {
    if (s.status !== 'active') continue;
    const perms = permsOf(ctx.db, s);
    if (!perms.includes('settings') && !perms.includes('giving.edit')) continue;
    const p = (s.personId && ctx.db.get('people', s.personId)) || ctx.db.all('people').find((x) => normEmail(x.email) === normEmail(s.email));
    if (p) out.add(p.id);
  }
  return [...out];
}

/** Reminders a week before a service is due and a month before an AMC or warranty ends; one per due date. Called from the daily tick. */
export async function assetReminders(ctx: Ctx, today: string) {
  const church = settings(ctx).name;
  const due: string[] = [];
  for (const a of ctx.db.all('assets').filter((a) => a.status === 'active')) {
    const checks: [string, string | null, number][] = [['service', nextService(a), 7], ['amc', a.amc?.until ?? null, 30], ['warranty', a.warrantyUntil, 30]];
    for (const [what, on, window] of checks) {
      if (!on) continue;
      const days = daysUntil(on, today);
      if (days > window) continue;
      const key = `asset:${what}:${a.id}:${on}`;
      if (ctx.db.get('meta', key)) continue;
      ctx.db.put('meta', { id: key, value: today });
      const when = days < 0 ? `was due ${-days} day${days === -1 ? '' : 's'} ago` : days === 0 ? 'is due today' : `is due in ${days} day${days === 1 ? '' : 's'}`;
      due.push(what === 'service' ? `${a.name} (${a.tag}) service ${when}${a.amc?.vendor ? ` — AMC with ${a.amc.vendor}${a.amc.phone ? `, ${a.amc.phone}` : ''}` : ''}` : what === 'amc' ? `${a.name} (${a.tag}) AMC with ${a.amc?.vendor || 'the vendor'} ${when.replace('is due', 'ends').replace('was due', 'ended')}` : `${a.name} (${a.tag}) warranty ${when.replace('is due', 'ends').replace('was due', 'ended')}`);
    }
  }
  if (!due.length) return;
  await notify(ctx, 'asset.due', { personIds: keeperIds(ctx), title: `${church}: ${due.length} asset reminder${due.length === 1 ? '' : 's'}`, body: due.join('\n'), link: '/admin/assets' });
}

function cleanAsset(ctx: Ctx, body: Record<string, unknown>, cur: Asset | null): Omit<Asset, 'id' | 'tag' | 'createdAt' | 'createdBy' | 'log' | 'status'> {
  const name = clean(body.name ?? cur?.name, 120);
  if (!name) throw new ApiError(422, 'validation', 'Give the asset a name.', { name: 'Required' });
  const category = ASSET_CATEGORIES.includes(body.category as AssetCategory) ? (body.category as AssetCategory) : cur?.category ?? 'other';
  const quantity = body.quantity === undefined ? cur?.quantity ?? 1 : Math.max(1, Math.round(Number(body.quantity)) || 1);
  const custodianId = body.custodianId === undefined ? cur?.custodianId ?? null : body.custodianId ? find(ctx, 'people', String(body.custodianId), 'Person').id : null;
  const custodian = custodianId ? ctx.db.get('people', custodianId) : null;
  const amcIn = body.amc as Record<string, unknown> | null | undefined;
  const amc = amcIn === undefined ? cur?.amc ?? null : amcIn === null ? null : { vendor: clean(amcIn.vendor, 120), phone: clean(amcIn.phone, 40), until: date(amcIn.until, 'the AMC end date'), note: clean(amcIn.note, 300) };
  const pick = <T>(k: string, cv: T | undefined, f: (v: unknown) => T): T => (body[k] === undefined ? (cv as T) : f(body[k]));
  return {
    name, category, quantity,
    location: pick('location', cur?.location ?? '', (v) => clean(v, 120)),
    serial: pick('serial', cur?.serial ?? '', (v) => clean(v, 80)),
    vendor: pick('vendor', cur?.vendor ?? '', (v) => clean(v, 120)),
    purchasedOn: pick('purchasedOn', cur?.purchasedOn ?? null, (v) => date(v, 'the purchase date')),
    cost: pick('cost', cur?.cost ?? null, minorOrNull),
    warrantyUntil: pick('warrantyUntil', cur?.warrantyUntil ?? null, (v) => date(v, 'the warranty end')),
    amc,
    serviceEveryMonths: pick('serviceEveryMonths', cur?.serviceEveryMonths ?? null, (v) => (v === null || v === '' ? null : Math.max(1, Math.min(120, Math.round(Number(v)) || 0)) || null)),
    lastServicedOn: pick('lastServicedOn', cur?.lastServicedOn ?? null, (v) => date(v, 'the last service')),
    condition: CONDITIONS.includes(body.condition as AssetCondition) ? (body.condition as AssetCondition) : cur?.condition ?? 'good',
    custodianId, custodianName: custodian ? fullName(custodian) : custodianId ? cur?.custodianName ?? '' : '',
    notes: pick('notes', cur?.notes ?? '', (v) => clean(v, 2000)),
    photoUrl: pick('photoUrl', cur?.photoUrl ?? null, (v) => (/^https?:\/\//.test(String(v ?? '')) ? clean(v, 500) : null)),
  };
}

export function registerAssets(r: Router) {
  const EDIT = ['settings', 'giving.edit'] as ('settings' | 'giving.edit')[];
  r.get('/admin/assets', { staff: true }, (ctx) => hub(ctx, ctx.query));
  r.post('/admin/assets', { perm: EDIT }, (ctx) => {
    const by = ctx.staff?.name ?? 'office';
    const fields = cleanAsset(ctx, ctx.body, null); // validate before a tag number is used up
    const own = clean(ctx.body.tag, 20);
    if (own && ctx.db.all('assets').some((a) => a.tag === own)) throw new ApiError(409, 'duplicate', `Tag ${own} is already used.`);
    let tag = own;
    while (!tag || ctx.db.all('assets').some((a) => a.tag === tag)) tag = nextTag(ctx);
    const a: Asset = { id: ctx.id('as'), tag, status: 'active', createdAt: ctx.now.toISOString(), createdBy: by, log: [], ...fields };
    ctx.db.put('assets', a);
    ctx.audit('created', 'asset', a.id, `Added ${a.name} (${a.tag})${a.cost ? `, ${money(ctx, a.cost)}` : ''}`);
    return view(a, localDate(ctx, ctx.now));
  });
  r.patch('/admin/assets/:id', { perm: EDIT }, (ctx) => {
    const a = find(ctx, 'assets', ctx.params[0], 'Asset');
    let tag = a.tag;
    if (ctx.body.tag !== undefined) {
      tag = clean(ctx.body.tag, 20) || a.tag;
      if (tag !== a.tag && ctx.db.all('assets').some((x) => x.tag === tag)) throw new ApiError(409, 'duplicate', `Tag ${tag} is already used.`);
    }
    const next: Asset = { ...a, tag, ...cleanAsset(ctx, ctx.body, a) };
    if (ctx.body.status === 'active' && a.status === 'retired') { next.status = 'active'; if (next.condition === 'retired') next.condition = 'good'; }
    ctx.db.put('assets', next);
    ctx.audit('updated', 'asset', a.id, `Updated ${next.name} (${next.tag})`);
    return view(next, localDate(ctx, ctx.now));
  });
  r.post('/admin/assets/:id/log', { perm: EDIT }, (ctx) => {
    const a = find(ctx, 'assets', ctx.params[0], 'Asset');
    const kind = LOG_KINDS.includes(ctx.body.kind) ? (ctx.body.kind as AssetLogEntry['kind']) : 'note';
    const text = clean(ctx.body.text, 1000);
    const on = date(ctx.body.date, 'the date') ?? localDate(ctx, ctx.now);
    if (!text && kind === 'note') throw new ApiError(422, 'validation', 'Write the note.');
    const entry: AssetLogEntry = { at: ctx.now.toISOString(), on, by: ctx.staff?.name ?? 'office', kind, text, cost: minorOrNull(ctx.body.cost) };
    const next: Asset = { ...a, log: [entry, ...a.log].slice(0, 200) };
    if (kind === 'service' || kind === 'repair') { next.lastServicedOn = on; if (a.condition === 'needs_repair' && kind === 'repair') next.condition = 'good'; }
    if (kind === 'moved' && ctx.body.location !== undefined) next.location = clean(ctx.body.location, 120);
    ctx.db.put('assets', next);
    ctx.audit(kind === 'note' ? 'noted' : kind, 'asset', a.id, `${a.name} (${a.tag}): ${kind}${text ? ` — ${text}` : ''}${entry.cost ? ` (${money(ctx, entry.cost)})` : ''}`);
    return view(next, localDate(ctx, ctx.now));
  });
  r.del('/admin/assets/:id', { perm: EDIT }, (ctx) => {
    const a = find(ctx, 'assets', ctx.params[0], 'Asset');
    const reason = clean(ctx.body?.reason ?? ctx.query.reason, 300);
    const entry: AssetLogEntry = { at: ctx.now.toISOString(), on: localDate(ctx, ctx.now), by: ctx.staff?.name ?? 'office', kind: 'retired', text: reason, cost: null };
    ctx.db.put('assets', { ...a, status: 'retired', condition: 'retired', log: [entry, ...a.log] });
    ctx.audit('retired', 'asset', a.id, `Retired ${a.name} (${a.tag})${reason ? `: ${reason}` : ''}`);
    return { ok: true };
  });
  r.get('/admin/assets/export.csv', { staff: true }, (ctx) => {
    const rows = hub(ctx, { status: 'all' }).assets;
    const cell = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ['Tag', 'Name', 'Category', 'Qty', 'Location', 'Custodian', 'Serial', 'Vendor', 'Purchased', 'Cost', 'Warranty until', 'AMC vendor', 'AMC phone', 'AMC until', 'Service every (months)', 'Last serviced', 'Next service', 'Condition', 'Status', 'Notes'];
    const lines = rows.map((a) => [a.tag, a.name, a.category, a.quantity, a.location, a.custodianName, a.serial, a.vendor, a.purchasedOn, a.cost === null ? '' : a.cost / 100, a.warrantyUntil, a.amc?.vendor, a.amc?.phone, a.amc?.until, a.serviceEveryMonths, a.lastServicedOn, a.nextServiceOn, a.condition, a.status, a.notes].map(cell).join(','));
    return { __raw: true as const, contentType: 'text/csv; charset=utf-8', filename: 'assets.csv', body: [head.join(','), ...lines].join('\r\n') };
  });
}
