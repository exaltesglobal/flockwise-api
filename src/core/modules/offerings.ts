// Special offerings: harvest festival, building fund, thanksgiving and other campaigns. A campaign
// collects online and in-person gifts to one fund, numbered envelopes given to each family, in-kind
// offerings (produce, gold, livestock) and the harvest auction, with one progress bar for all of it.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { AuctionLot, Campaign, Collections, CampaignDetail, CampaignKind, CampaignProgress, CampaignView, InKindGift, MemberCampaign, OfferingEnvelope, PaymentMethod, PublicCampaign } from '../types.js';
import { age, dateOnly, find, fullName, giftDate, localDate, requireFields } from '../util.js';
import { recordGift } from './giving.js';
import { familyKey } from './zones.js';

const KINDS: CampaignKind[] = ['harvest', 'building', 'thanksgiving', 'mission', 'special'];
const METHODS: PaymentMethod[] = ['cash', 'cheque', 'bank_transfer', 'upi', 'card', 'netbanking'];
const paise = (v: unknown) => Math.max(0, Math.round(Number(v) || 0));

function inWindow(c: Campaign, iso: string) {
  const day = dateOnly(iso);
  return day >= c.startsOn && (!c.endsOn || day <= c.endsOn);
}

function progress(ctx: Ctx, c: Campaign): CampaignProgress {
  const gifts = ctx.db.all('donations').filter((d) => d.fundId === c.fundId && d.status === 'succeeded' && inWindow(c, giftDate(d)));
  const envelopeIds = new Set(ctx.db.all('envelopes').filter((e) => e.campaignId === c.id && e.donationId).map((e) => e.donationId));
  const lots = ctx.db.all('auctionLots').filter((l) => l.campaignId === c.id);
  const lotIds = new Set(lots.filter((l) => l.donationId).map((l) => l.donationId));
  const soldItems = new Set(lots.filter((l) => l.paid && l.inKindId).map((l) => l.inKindId));
  const sum = (xs: { amount: number }[]) => xs.reduce((s, d) => s + d.amount, 0);
  const envelopes = sum(gifts.filter((d) => envelopeIds.has(d.id)));
  const auction = sum(gifts.filter((d) => lotIds.has(d.id)));
  const total = sum(gifts);
  const inKind = ctx.db.all('inKind').filter((g) => g.campaignId === c.id && !soldItems.has(g.id)).reduce((s, g) => s + g.value, 0);
  const raised = total + inKind;
  const givers = new Set([...gifts.map((d) => d.donorId ?? `n:${d.donorName.toLowerCase()}`), ...ctx.db.all('inKind').filter((g) => g.campaignId === c.id).map((g) => g.donorId ?? `n:${g.donorName.toLowerCase()}`)]).size;
  return {
    raised,
    gifts: total - envelopes - auction,
    envelopes,
    auction,
    inKind,
    givers,
    goal: c.goal,
    percent: c.goal ? Math.round((raised * 100) / c.goal) : null,
    auctionUnpaid: lots.filter((l) => !l.paid).reduce((s, l) => s + l.amount, 0),
  };
}

function view(ctx: Ctx, c: Campaign): CampaignView {
  const env = ctx.db.all('envelopes').filter((e) => e.campaignId === c.id);
  return { ...c, fundName: ctx.db.get('funds', c.fundId)?.name ?? '', progress: progress(ctx, c), envelopesOut: env.length, envelopesBack: env.filter((e) => e.receivedAt).length };
}

function detail(ctx: Ctx, c: Campaign): CampaignDetail {
  const byGiver = new Map<string, { name: string; amount: number }>();
  for (const d of ctx.db.all('donations').filter((x) => x.fundId === c.fundId && x.status === 'succeeded' && inWindow(c, giftDate(x)))) {
    const k = d.donorId ?? `n:${d.donorName.toLowerCase()}`;
    const row = byGiver.get(k) ?? { name: d.donorName, amount: 0 };
    row.amount += d.amount;
    byGiver.set(k, row);
  }
  return {
    ...view(ctx, c),
    envelopes: ctx.db.all('envelopes').filter((e) => e.campaignId === c.id).sort((a, b) => a.number - b.number),
    inKind: ctx.db.all('inKind').filter((g) => g.campaignId === c.id).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)),
    lots: ctx.db.all('auctionLots').filter((l) => l.campaignId === c.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    topGivers: [...byGiver.values()].sort((a, b) => b.amount - a.amount).slice(0, 10),
  };
}

export function publicCampaign(ctx: Ctx, c: Campaign): PublicCampaign {
  const p = progress(ctx, c);
  return { id: c.id, name: c.name, kind: c.kind, description: c.description, fundId: c.fundId, goal: c.goal, raised: p.raised, percent: p.percent, givers: p.givers, endsOn: c.endsOn };
}

/** Active campaigns the church shows publicly. */
export function liveCampaigns(ctx: Ctx) {
  const today = localDate(ctx, ctx.now);
  return ctx.db.all('campaigns').filter((c) => c.status === 'active' && c.showPublic && c.startsOn <= today && (!c.endsOn || c.endsOn >= today));
}

const campaignOf = (ctx: Ctx) => find(ctx, 'campaigns', ctx.params[0], 'Campaign');
const editable = (c: Campaign) => {
  if (c.status === 'closed') throw new ApiError(409, 'closed', `“${c.name}” is closed. Reopen it to make changes.`);
  return c;
};

function fields(ctx: Ctx, b: Record<string, unknown>, prev?: Campaign) {
  const name = String(b.name ?? prev?.name ?? '').trim();
  if (!name) throw new ApiError(422, 'invalid', 'Give the campaign a name.', { name: 'Required' });
  const kind = (b.kind ?? prev?.kind ?? 'special') as CampaignKind;
  if (!KINDS.includes(kind)) throw new ApiError(422, 'invalid', 'Choose the kind of offering.', { kind: 'Invalid' });
  const startsOn = String(b.startsOn ?? prev?.startsOn ?? localDate(ctx, ctx.now)).slice(0, 10);
  const endsOn = b.endsOn === undefined ? (prev?.endsOn ?? null) : b.endsOn ? String(b.endsOn).slice(0, 10) : null;
  if (endsOn && endsOn < startsOn) throw new ApiError(422, 'invalid', 'The end date is before the start date.', { endsOn: 'Before start' });
  const goal = b.goal === undefined ? (prev?.goal ?? null) : b.goal ? paise(b.goal) : null;
  return {
    name,
    kind,
    description: String(b.description ?? prev?.description ?? '').trim().slice(0, 1000),
    goal,
    startsOn,
    endsOn,
    showPublic: b.showPublic === undefined ? (prev?.showPublic ?? true) : !!b.showPublic,
  };
}

function personName(ctx: Ctx, id: unknown, fallback: unknown) {
  const p = id ? ctx.db.get('people', String(id)) : undefined;
  const name = p ? fullName(p) : String(fallback ?? '').trim();
  if (!name) throw new ApiError(422, 'invalid', 'Choose a person or type a name.', { donorName: 'Required' });
  return { id: p?.id ?? null, name };
}

function method(v: unknown): PaymentMethod {
  const m = String(v ?? 'cash') as PaymentMethod;
  if (!METHODS.includes(m)) throw new ApiError(422, 'invalid', 'Choose how it was paid.', { method: 'Invalid' });
  return m;
}

export function registerOfferings(r: Router) {
  r.get('/admin/offerings', { perm: 'giving.view' }, (ctx) =>
    ctx.db.all('campaigns').sort((a, b) => (a.status === b.status ? b.startsOn.localeCompare(a.startsOn) : a.status === 'active' ? -1 : 1)).map((c) => view(ctx, c)),
  );

  r.post('/admin/offerings', { perm: 'giving.edit' }, (ctx) => {
    const f = fields(ctx, ctx.body);
    // Each campaign has its own fund unless the office picks an existing one (e.g. the building fund).
    let fundId = ctx.body.fundId ? find(ctx, 'funds', String(ctx.body.fundId), 'Fund').id : null;
    if (!fundId) fundId = ctx.db.put('funds', { id: ctx.id('fd'), name: f.name, description: f.description, taxDeductible: ctx.body.taxDeductible !== false, active: true, goal: f.goal }).id;
    const c = ctx.db.put('campaigns', { id: ctx.id('cp'), ...f, fundId, status: 'active', createdAt: ctx.now.toISOString(), createdBy: ctx.staff?.name ?? '' });
    ctx.audit('created', 'campaign', c.id, `Started the offering “${c.name}”`);
    return detail(ctx, c);
  });

  r.get('/admin/offerings/:id', { perm: 'giving.view' }, (ctx) => detail(ctx, campaignOf(ctx)));

  r.patch('/admin/offerings/:id', { perm: 'giving.edit' }, (ctx) => {
    const c = campaignOf(ctx);
    const status = ctx.body.status === 'closed' || ctx.body.status === 'active' ? (ctx.body.status as Campaign['status']) : c.status;
    const next = ctx.db.put('campaigns', { ...c, ...fields(ctx, ctx.body, c), status });
    if (next.goal !== c.goal) {
      const fund = ctx.db.get('funds', c.fundId);
      if (fund && fund.name === c.name) ctx.db.put('funds', { ...fund, goal: next.goal });
    }
    ctx.audit('updated', 'campaign', c.id, status !== c.status ? `${status === 'closed' ? 'Closed' : 'Reopened'} the offering “${c.name}”` : `Updated the offering “${c.name}”`);
    return detail(ctx, next);
  });

  r.del('/admin/offerings/:id', { perm: 'giving.edit' }, (ctx) => {
    const c = campaignOf(ctx);
    const used = ctx.db.all('envelopes').some((e) => e.campaignId === c.id && e.donationId) || ctx.db.all('auctionLots').some((l) => l.campaignId === c.id && l.paid);
    if (used) throw new ApiError(409, 'in_use', 'Money has been recorded against this campaign. Close it instead.');
    for (const k of ['envelopes', 'inKind', 'auctionLots'] as const) for (const x of ctx.db.all(k).filter((y) => y.campaignId === c.id)) ctx.db.del(k, x.id);
    ctx.db.del('campaigns', c.id);
    ctx.audit('deleted', 'campaign', c.id, `Deleted the offering “${c.name}”`);
    return { ok: true };
  });

  // ------------------------------------------------------------ envelopes

  // Gives one numbered envelope to each family that does not have one yet (or a number of blank ones).
  r.post('/admin/offerings/:id/envelopes', { perm: 'giving.edit' }, (ctx) => {
    const c = editable(campaignOf(ctx));
    const existing = ctx.db.all('envelopes').filter((e) => e.campaignId === c.id);
    let next = existing.reduce((m, e) => Math.max(m, e.number), 0) + 1;
    const promised = ctx.body.promised ? paise(ctx.body.promised) : null;
    const put = (personId: string | null, familyName: string) =>
      ctx.db.put('envelopes', { id: ctx.id('ev'), campaignId: c.id, number: next++, personId, familyName, promised, amount: null, method: null, receivedAt: null, donationId: null });
    let made = 0;
    if (ctx.body.blank) {
      const n = Math.min(500, Math.max(1, Math.round(Number(ctx.body.blank) || 0)));
      for (let i = 0; i < n; i++, made++) put(null, '');
    } else {
      const have = new Set(existing.map((e) => e.personId && ctx.db.get('people', e.personId)).filter((p) => !!p).map((p) => familyKey(p!)));
      const groups = new Map<string, Collections['people'][]>();
      for (const p of ctx.db.all('people').filter((x) => x.status !== 'inactive' && (!ctx.body.zoneId || x.zoneId === ctx.body.zoneId))) {
        const k = familyKey(p);
        if (!have.has(k)) groups.set(k, [...(groups.get(k) ?? []), p]);
      }
      const rows = [...groups.values()].map((members) => {
        const adults = members.filter((m) => (age(m.birthDate, ctx.now) ?? 30) >= 18);
        const head = (adults.length ? adults : members).sort((a, b) => (a.birthDate ?? '9999').localeCompare(b.birthDate ?? '9999'))[0];
        return { head, name: head.householdName || fullName(head) };
      });
      for (const row of rows.sort((a, b) => a.name.localeCompare(b.name))) {
        put(row.head.id, row.name);
        made++;
      }
    }
    if (made) ctx.audit('created', 'envelopes', c.id, `Gave out ${made} envelopes for “${c.name}”`);
    return { made, campaign: detail(ctx, c) };
  });

  r.patch('/admin/offerings/:id/envelopes/:envId', { perm: 'giving.edit' }, (ctx) => {
    const c = editable(campaignOf(ctx));
    const e = find(ctx, 'envelopes', ctx.params[1], 'Envelope');
    if (e.campaignId !== c.id) throw new ApiError(404, 'not_found', 'Envelope not found.');
    const p = ctx.body.personId ? find(ctx, 'people', String(ctx.body.personId), 'Person') : ctx.body.personId === null ? null : undefined;
    const next: OfferingEnvelope = {
      ...e,
      ...(p !== undefined ? { personId: p?.id ?? null, familyName: p ? p.householdName || fullName(p) : String(ctx.body.familyName ?? '') } : {}),
      ...(ctx.body.familyName !== undefined && p === undefined ? { familyName: String(ctx.body.familyName).trim() } : {}),
      ...(ctx.body.promised !== undefined ? { promised: ctx.body.promised ? paise(ctx.body.promised) : null } : {}),
    };
    return ctx.db.put('envelopes', next);
  });

  // The envelope comes back: record the gift in it.
  r.post('/admin/offerings/:id/envelopes/:envId/receive', { perm: 'giving.edit' }, (ctx) => {
    const c = editable(campaignOf(ctx));
    const e = find(ctx, 'envelopes', ctx.params[1], 'Envelope');
    if (e.campaignId !== c.id) throw new ApiError(404, 'not_found', 'Envelope not found.');
    if (e.donationId) throw new ApiError(409, 'already_received', `Envelope ${e.number} is already recorded.`);
    const amount = paise(ctx.body.amount);
    if (!amount) throw new ApiError(422, 'invalid', 'Enter the amount in the envelope.', { amount: 'Required' });
    const m = method(ctx.body.method);
    const name = e.familyName || String(ctx.body.donorName ?? '').trim() || `Envelope ${e.number}`;
    const d = recordGift(ctx, { donorId: e.personId, donorName: name, fundId: c.fundId, amount, method: m, receivedAt: ctx.body.receivedAt, pan: ctx.body.pan, batchId: ctx.body.batchId });
    return ctx.db.put('envelopes', { ...e, familyName: name, amount, method: m, receivedAt: d.paidAt ?? d.createdAt, donationId: d.id });
  });

  r.del('/admin/offerings/:id/envelopes/:envId', { perm: 'giving.edit' }, (ctx) => {
    const c = editable(campaignOf(ctx));
    const e = find(ctx, 'envelopes', ctx.params[1], 'Envelope');
    if (e.campaignId !== c.id) throw new ApiError(404, 'not_found', 'Envelope not found.');
    if (e.donationId) throw new ApiError(409, 'already_received', 'This envelope has a gift recorded. Refund the gift in Giving first.');
    ctx.db.del('envelopes', e.id);
    return { ok: true };
  });

  // ------------------------------------------------------------ in-kind offerings

  r.post('/admin/offerings/:id/in-kind', { perm: 'giving.edit' }, (ctx) => {
    const c = editable(campaignOf(ctx));
    requireFields(ctx.body, ['item']);
    const who = personName(ctx, ctx.body.donorId, ctx.body.donorName);
    const g: InKindGift = {
      id: ctx.id('ik'),
      campaignId: c.id,
      donorId: who.id,
      donorName: who.name,
      item: String(ctx.body.item).trim().slice(0, 200),
      quantity: String(ctx.body.quantity ?? '').trim().slice(0, 60),
      value: paise(ctx.body.value),
      forAuction: ctx.body.forAuction !== false,
      note: String(ctx.body.note ?? '').trim().slice(0, 300),
      receivedAt: ctx.body.receivedAt ? new Date(String(ctx.body.receivedAt)).toISOString() : ctx.now.toISOString(),
    };
    ctx.audit('recorded', 'in-kind gift', g.id, `${g.donorName} brought ${g.quantity ? `${g.quantity} ` : ''}${g.item} for “${c.name}”`);
    return ctx.db.put('inKind', g);
  });

  r.del('/admin/offerings/:id/in-kind/:itemId', { perm: 'giving.edit' }, (ctx) => {
    const c = editable(campaignOf(ctx));
    const g = find(ctx, 'inKind', ctx.params[1], 'Item');
    if (g.campaignId !== c.id) throw new ApiError(404, 'not_found', 'Item not found.');
    if (ctx.db.all('auctionLots').some((l) => l.inKindId === g.id)) throw new ApiError(409, 'in_use', 'This item is in the auction. Remove the lot first.');
    ctx.db.del('inKind', g.id);
    return { ok: true };
  });

  // ------------------------------------------------------------ auction

  r.post('/admin/offerings/:id/lots', { perm: 'giving.edit' }, (ctx) => {
    const c = editable(campaignOf(ctx));
    const item = ctx.body.inKindId ? find(ctx, 'inKind', String(ctx.body.inKindId), 'Item') : null;
    if (item && item.campaignId !== c.id) throw new ApiError(404, 'not_found', 'Item not found.');
    if (item && ctx.db.all('auctionLots').some((l) => l.inKindId === item.id)) throw new ApiError(409, 'sold', `${item.item} is already sold.`);
    const title = String(ctx.body.title ?? '').trim() || (item ? `${item.quantity ? `${item.quantity} ` : ''}${item.item}` : '');
    if (!title) throw new ApiError(422, 'invalid', 'Say what was auctioned.', { title: 'Required' });
    const amount = paise(ctx.body.amount);
    if (!amount) throw new ApiError(422, 'invalid', 'Enter the winning bid.', { amount: 'Required' });
    const who = personName(ctx, ctx.body.bidderId, ctx.body.bidderName);
    const lot: AuctionLot = { id: ctx.id('al'), campaignId: c.id, inKindId: item?.id ?? null, title, bidderId: who.id, bidderName: who.name, amount, paid: false, method: null, paidAt: null, donationId: null, createdAt: ctx.now.toISOString() };
    ctx.db.put('auctionLots', lot);
    if (ctx.body.paidNow) return payLot(ctx, c, lot, method(ctx.body.method));
    return lot;
  });

  r.post('/admin/offerings/:id/lots/:lotId/pay', { perm: 'giving.edit' }, (ctx) => {
    const c = editable(campaignOf(ctx));
    const lot = find(ctx, 'auctionLots', ctx.params[1], 'Lot');
    if (lot.campaignId !== c.id) throw new ApiError(404, 'not_found', 'Lot not found.');
    if (lot.paid) throw new ApiError(409, 'already_paid', 'This bid is already paid.');
    return payLot(ctx, c, lot, method(ctx.body.method));
  });

  r.del('/admin/offerings/:id/lots/:lotId', { perm: 'giving.edit' }, (ctx) => {
    const c = editable(campaignOf(ctx));
    const lot = find(ctx, 'auctionLots', ctx.params[1], 'Lot');
    if (lot.campaignId !== c.id) throw new ApiError(404, 'not_found', 'Lot not found.');
    if (lot.paid) throw new ApiError(409, 'already_paid', 'This bid is paid. Refund the gift in Giving first.');
    ctx.db.del('auctionLots', lot.id);
    return { ok: true };
  });

  // ------------------------------------------------------------ members

  r.get('/giving/campaigns', {}, (ctx) => {
    const me = ctx.me();
    return liveCampaigns(ctx).map((c): MemberCampaign => {
      const mine = ctx.db.get('people', me);
      const env = ctx.db.all('envelopes').find((e) => e.campaignId === c.id && (e.personId === me || (!!mine?.householdName && !!e.personId && ctx.db.get('people', e.personId)?.householdName === mine.householdName)));
      return { ...publicCampaign(ctx, c), envelope: env ? { number: env.number, promised: env.promised, amount: env.amount } : null };
    });
  });
}

function payLot(ctx: Ctx, c: Campaign, lot: AuctionLot, m: PaymentMethod) {
  const d = recordGift(ctx, { donorId: lot.bidderId, donorName: lot.bidderName, fundId: c.fundId, amount: lot.amount, method: m });
  ctx.audit('recorded', 'auction', lot.id, `${lot.bidderName} paid for ${lot.title} at the “${c.name}” auction`);
  return ctx.db.put('auctionLots', { ...lot, paid: true, method: m, paidAt: d.paidAt ?? d.createdAt, donationId: d.id });
}
