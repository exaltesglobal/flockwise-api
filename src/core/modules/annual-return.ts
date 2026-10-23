// The denomination's annual return, auto-filled. Every Indian church body asks its local units for
// the same kind of statement once a year: how many families and members, the sacraments given,
// attendance, what came in and went out, who leads. The figures here come straight from the
// records (people, registers, check-ins, giving, accounts, Sunday school, teams, elections); the
// office checks them, overrides any line, types the few that only it knows (the diocesan quota,
// property), prints or exports the form, and marks it submitted, which freezes the figures.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { AnnualReturn, AnnualReturnView, Collections, ReturnHeader, ReturnLine, ReturnLineView, ReturnSection, ReturnTemplate } from '../types.js';
import { age, fiscalYearRange, settings } from '../util.js';

const PERM = ['settings', 'insights'] as ('settings' | 'insights')[];

// ----- the forms -----
const L = (key: string, label: string, kind: ReturnLine['kind'] = 'number', hint?: string): ReturnLine => ({ key, label, kind, source: 'auto', hint });
const M = (key: string, label: string, kind: ReturnLine['kind'] = 'number', hint?: string): ReturnLine => ({ key, label, kind, source: 'manual', hint });

const MEMBERSHIP = (communicantLabel = 'Communicant members'): ReturnSection => ({ id: 'membership', title: 'Membership', lines: [
  L('families', 'Families (households)'), L('communicants', communicantLabel, 'number', 'Adult members on the roll'), L('baptisedMembers', 'Baptised members (all ages)'), L('adults', 'Adults'), L('children', 'Children'),
  L('men', 'Men'), L('women', 'Women'), L('youth', 'Youth (13 to 30)'), L('newMembers', 'New members this year'), L('transfersOut', 'Members transferred out'), L('deaths', 'Deaths (burials recorded)'),
] });
const SACRAMENTS = (confirmation = true): ReturnSection => ({ id: 'sacraments', title: 'Sacraments and rites', lines: [
  L('baptismsInfant', 'Baptisms: infants and children'), L('baptismsAdult', 'Baptisms: adults'), ...(confirmation ? [L('confirmations', 'Confirmations')] : []), L('marriages', 'Marriages solemnised'), L('burials', 'Burials'), L('dedications', 'Child dedications', 'number', 'From the service plans'),
] });
const WORSHIP: ReturnSection = { id: 'worship', title: 'Worship and attendance', lines: [
  L('services', 'Sunday services held'), L('avgAttendance', 'Average Sunday attendance'), L('avgChildren', 'Average children at Sunday school / kids church'), L('highestAttendance', 'Highest attendance'), L('specialServices', 'Other services and events'),
] };
const EDUCATION: ReturnSection = { id: 'education', title: 'Sunday school and fellowships', lines: [
  L('ssClasses', 'Sunday school classes'), L('ssChildren', 'Sunday school children on roll'), L('ssTeachers', 'Sunday school teachers'), L('cells', 'House fellowships / prayer cells'), L('ministries', 'Fellowships and ministries (women, youth, choir…)'), L('volunteers', 'People serving on teams'),
] };
const FINANCE: ReturnSection = { id: 'finance', title: 'Income and expenditure', lines: [
  L('incomeTotal', 'Total income (gifts and offerings)', 'money'), L('tithes', 'Tithes', 'money'), L('offerings', 'Sunday offerings', 'money'), L('missions', 'Missions giving', 'money'), L('building', 'Building fund', 'money'), L('benevolence', 'Benevolence paid out', 'money'),
  L('expenseTotal', 'Total expenditure', 'money'), L('salaries', 'Salaries and allowances', 'money'), L('receipts80g', 'Gifts with 80G receipts', 'money'), L('fcra', 'Foreign contributions (FCRA)', 'money'),
] };
const LEADERSHIP: ReturnSection = { id: 'leadership', title: 'Leadership and staff', lines: [
  L('staff', 'Paid staff and office bearers with office access'), L('committee', 'Committee elected this year', 'text', 'From the last published election'), M('minister', 'Presbyter / pastor in charge', 'text'), M('assistants', 'Assistant pastors, evangelists, Bible women', 'text'),
] };
const PROPERTY: ReturnSection = { id: 'property', title: 'Property and assets', lines: [
  L('assets', 'Items on the asset register'), L('assetValue', 'Asset register value (cost)', 'money'), M('landBuildings', 'Land and buildings (description, survey no., extent)', 'text'), M('encumbrances', 'Loans, disputes or encumbrances', 'text'),
] };

const T: ReturnTemplate[] = [
  { id: 'csi', name: 'CSI pastorate annual return', body: 'Church of South India', unit: 'Pastorate', above: 'Diocese', sections: [
    MEMBERSHIP('Communicant members'), SACRAMENTS(true), WORSHIP, EDUCATION,
    { ...FINANCE, lines: [...FINANCE.lines, M('assessment', 'Diocesan assessment due', 'money'), M('assessmentPaid', 'Diocesan assessment paid', 'money'), M('harvest', 'Harvest festival collection', 'money')] },
    { ...LEADERSHIP, lines: [L('staff', 'Paid staff'), L('committee', 'Pastorate committee elected', 'text', 'From the last published election'), M('minister', 'Presbyter in charge', 'text'), M('secretary', 'Pastorate committee secretary', 'text'), M('treasurer', 'Pastorate committee treasurer', 'text')] },
    PROPERTY,
  ] },
  { id: 'cni', name: 'CNI pastorate annual return', body: 'Church of North India', unit: 'Pastorate', above: 'Diocese', sections: [
    MEMBERSHIP('Communicant members'), SACRAMENTS(true), WORSHIP, EDUCATION,
    { ...FINANCE, lines: [...FINANCE.lines, M('quota', 'Diocesan quota due', 'money'), M('quotaPaid', 'Diocesan quota paid', 'money')] },
    { ...LEADERSHIP, lines: [L('staff', 'Paid staff'), L('committee', 'Pastorate committee elected', 'text', 'From the last published election'), M('minister', 'Presbyter in charge', 'text'), M('secretary', 'Secretary', 'text'), M('treasurer', 'Treasurer', 'text')] },
    PROPERTY,
  ] },
  { id: 'ag', name: 'AG local assembly annual report', body: 'Assemblies of God', unit: 'Assembly', above: 'Section / District', sections: [
    { id: 'membership', title: 'Membership', lines: [L('families', 'Families'), L('communicants', 'Adult members'), L('adults', 'Adults attending'), L('children', 'Children'), L('youth', 'Youth (13 to 30)'), L('newMembers', 'New members this year'), M('conversions', 'Conversions / decisions for Christ'), M('spiritBaptisms', 'Baptised in the Holy Spirit')] },
    { id: 'sacraments', title: 'Ordinances', lines: [L('baptismsAdult', 'Water baptisms (believers)'), L('baptismsInfant', 'Water baptisms (under 13)'), L('dedications', 'Child dedications'), L('marriages', 'Marriages'), L('burials', 'Funerals')] },
    WORSHIP, EDUCATION,
    { ...FINANCE, lines: [...FINANCE.lines, M('districtDues', 'Section / district dues paid', 'money'), M('missionsNational', 'Missions giving: national', 'money'), M('missionsForeign', 'Missions giving: foreign', 'money')] },
    { ...LEADERSHIP, lines: [L('staff', 'Pastoral staff'), L('committee', 'Church board / deacons elected', 'text'), M('minister', 'Senior pastor', 'text'), M('assistants', 'Associate pastors and evangelists', 'text'), M('credentials', 'Credential holders', 'text')] },
    PROPERTY,
  ] },
  { id: 'methodist', name: 'Methodist charge annual statistics', body: 'Methodist Church in India', unit: 'Local church / charge', above: 'District', sections: [MEMBERSHIP('Full members'), SACRAMENTS(true), WORSHIP, EDUCATION, { ...FINANCE, lines: [...FINANCE.lines, M('apportionment', 'Conference apportionment paid', 'money')] }, LEADERSHIP, PROPERTY] },
  { id: 'baptist', name: 'Baptist church annual return', body: 'Baptist church (union or association)', unit: 'Local church', above: 'Association', sections: [MEMBERSHIP('Members (believers)'), SACRAMENTS(false), WORSHIP, EDUCATION, { ...FINANCE, lines: [...FINANCE.lines, M('associationDues', 'Association contribution', 'money')] }, LEADERSHIP, PROPERTY] },
  { id: 'pentecostal', name: 'Pentecostal church annual report', body: 'Pentecostal church (IPC, TPM and others)', unit: 'Local church', above: 'Centre / Region', sections: [
    { id: 'membership', title: 'Membership', lines: [L('families', 'Families'), L('communicants', 'Adult believers'), L('adults', 'Adults'), L('children', 'Children'), L('youth', 'Youth (13 to 30)'), L('newMembers', 'New members this year'), M('conversions', 'Conversions'), M('spiritBaptisms', 'Baptised in the Holy Spirit')] },
    { id: 'sacraments', title: 'Ordinances', lines: [L('baptismsAdult', 'Water baptisms'), L('dedications', 'Child dedications'), L('marriages', 'Marriages'), L('burials', 'Funerals')] },
    WORSHIP, EDUCATION, FINANCE, LEADERSHIP, PROPERTY,
  ] },
  { id: 'marthoma', name: 'Mar Thoma parish annual return', body: 'Mar Thoma Syrian Church', unit: 'Parish', above: 'Diocese', sections: [MEMBERSHIP('Members'), SACRAMENTS(true), WORSHIP, EDUCATION, { ...FINANCE, lines: [...FINANCE.lines, M('diocesanShare', 'Diocesan share paid', 'money')] }, { ...LEADERSHIP, lines: [L('staff', 'Paid staff'), L('committee', 'Parish committee elected', 'text'), M('minister', 'Vicar', 'text'), M('secretary', 'Secretary', 'text'), M('trustee', 'Trustee', 'text')] }, PROPERTY] },
  { id: 'lutheran', name: 'Lutheran congregation annual return', body: 'Lutheran church (UELCI member)', unit: 'Congregation', above: 'Synod / Circle', sections: [MEMBERSHIP('Communicant members'), SACRAMENTS(true), WORSHIP, EDUCATION, FINANCE, LEADERSHIP, PROPERTY] },
  { id: 'generic', name: 'Annual statistical return', body: 'Any church body', unit: 'Local church', above: 'Head office', sections: [MEMBERSHIP('Members'), SACRAMENTS(true), WORSHIP, EDUCATION, FINANCE, LEADERSHIP, PROPERTY] },
];
export const TEMPLATES = T;
const templateOf = (id: string) => T.find((t) => t.id === id) ?? null;

// ----- the figures -----
type Facts = Record<string, number | string | null>;
const giftDate = (d: Collections['donations']) => d.paidAt ?? d.createdAt;

/** Every auto line's figure for the period, from the records. Keys match the lines above. */
export function annualFacts(ctx: Ctx, year: number): Facts {
  const { from, to } = fiscalYearRange(ctx, String(year));
  const fromIso = from.toISOString(), toIso = to.toISOString();
  const within = (iso: string | null | undefined) => !!iso && iso >= fromIso && iso < toIso;
  const withinDate = (d: string) => `${d}T00:00:00.000Z` >= fromIso && `${d}T00:00:00.000Z` < toIso;
  const atEnd = new Date(Math.min(to.getTime() - 1, ctx.now.getTime()));

  const people = ctx.db.all('people').filter((p) => p.status !== 'inactive' && p.joinedAt < toIso);
  const child = (p: Collections['people']) => { const a = age(p.birthDate, atEnd); return a !== null && a < settings(ctx).childAgeLimit; };
  const households = new Set<string>();
  let loners = 0;
  for (const p of people) { if (p.householdName) households.add(p.householdName); else loners++; }
  const youth = people.filter((p) => { const a = age(p.birthDate, atEnd); return a !== null && a >= 13 && a <= 30; }).length;

  const regs = ctx.db.all('registers').filter((r) => r.status !== 'void' && withinDate(r.date));
  const baptised = new Set(ctx.db.all('registers').filter((r) => r.kind === 'baptism' && r.status !== 'void' && r.personId).map((r) => r.personId));
  const bap = regs.filter((r) => r.kind === 'baptism');
  const infant = bap.filter((r) => { const b = r.details.birthDate || ctx.db.get('people', r.personId ?? '')?.birthDate; const a = b ? age(b, new Date(`${r.date}T00:00:00Z`)) : null; return a !== null && a < 13; }).length;

  const services = ctx.db.all('events').filter((e) => e.kind === 'service' && within(e.startsAt) && e.endsAt <= ctx.now.toISOString());
  const counts = services.map((e) => { const ci = ctx.db.all('checkins').filter((c) => c.eventId === e.id); return { total: Math.max(e.attendance ?? 0, ci.length), children: ci.filter((c) => c.isChild).length }; });
  const withCount = counts.filter((c) => c.total > 0);
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : 0);
  const dedications = ctx.db.all('plans').filter((p) => services.some((e) => e.id === p.eventId)).reduce((s, p) => s + p.items.filter((i) => /dedicat/i.test(i.title)).length, 0);

  const classes = ctx.db.all('ssClasses');
  const groups = ctx.db.all('groups');
  const gifts = ctx.db.all('donations').filter((d) => d.status === 'succeeded' && within(giftDate(d)));
  const sum = (xs: { amount: number }[]) => xs.reduce((s, x) => s + x.amount, 0);
  const byFund = (re: RegExp) => sum(gifts.filter((d) => re.test(d.fundName)));
  const expenses = ctx.db.all('expenses').filter((e) => e.status === 'paid' && within(e.paidAt ?? `${e.date}T00:00:00.000Z`));
  const heads = new Map(ctx.db.all('accountHeads').map((h) => [h.id, h.name]));
  const aid = ctx.db.all('aidRequests').filter((a) => a.status === 'paid' && within(a.paidAt));
  const staff = ctx.db.all('staff').filter((s) => s.status === 'active');
  const election = ctx.db.all('elections').filter((e) => e.kind === 'election' && e.resultsPublished && e.closedAt && within(e.closedAt)).sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))[0];
  const elected = election ? election.candidates.filter((c) => { const votes = (election.paperVotes[c.id] ?? 0) + ctx.db.all('ballots').filter((b) => b.electionId === election.id && b.choices.includes(c.id)).length; return votes > 0; }).map((c) => c.name) : [];
  const assets = ctx.db.all('assets').filter((a) => a.status === 'active');

  return {
    families: households.size + loners,
    communicants: people.filter((p) => p.status === 'member' && !child(p)).length,
    baptisedMembers: people.filter((p) => !!p.baptismDate || baptised.has(p.id)).length,
    adults: people.filter((p) => !child(p)).length,
    children: people.filter(child).length,
    men: people.filter((p) => p.gender === 'male' && !child(p)).length,
    women: people.filter((p) => p.gender === 'female' && !child(p)).length,
    youth,
    newMembers: people.filter((p) => within(p.joinedAt) && p.status === 'member').length,
    transfersOut: regs.filter((r) => r.kind === 'transfer').length,
    deaths: regs.filter((r) => r.kind === 'burial').length,
    baptismsInfant: infant,
    baptismsAdult: bap.length - infant,
    confirmations: regs.filter((r) => r.kind === 'confirmation').length,
    marriages: regs.filter((r) => r.kind === 'marriage').length,
    burials: regs.filter((r) => r.kind === 'burial').length,
    dedications,
    services: services.length,
    avgAttendance: avg(withCount.map((c) => c.total)),
    avgChildren: avg(counts.filter((c) => c.children > 0).map((c) => c.children)),
    highestAttendance: Math.max(0, ...withCount.map((c) => c.total)),
    specialServices: ctx.db.all('events').filter((e) => e.kind !== 'service' && e.published && within(e.startsAt) && e.endsAt <= ctx.now.toISOString()).length,
    ssClasses: classes.length,
    ssChildren: new Set(classes.flatMap((c) => c.studentIds)).size,
    ssTeachers: new Set(classes.flatMap((c) => c.teacherIds)).size,
    cells: groups.filter((g) => g.type === 'cell').length,
    ministries: groups.filter((g) => g.type === 'ministry').length,
    volunteers: new Set(ctx.db.all('teams').flatMap((t) => t.members.map((m) => m.personId))).size,
    incomeTotal: sum(gifts),
    tithes: byFund(/tithe/i),
    offerings: byFund(/offering|general|sunday/i),
    missions: byFund(/mission/i),
    building: byFund(/building|construction/i),
    benevolence: aid.reduce((s, a) => s + (a.approved ?? a.amount), 0),
    expenseTotal: sum(expenses),
    salaries: sum(expenses.filter((e) => /salar|allowance|stipend|honorari/i.test(heads.get(e.headId) ?? ''))),
    receipts80g: sum(gifts.filter((d) => !!d.pan)),
    fcra: sum(gifts.filter((d) => d.fcra)),
    staff: staff.length,
    committee: elected.length ? `${election!.title}: ${elected.join(', ')}` : '',
    assets: assets.reduce((s, a) => s + (a.quantity || 1), 0),
    assetValue: assets.reduce((s, a) => s + (a.cost ?? 0) * (a.quantity || 1), 0),
  };
}

const blankHeader = (ctx: Ctx, t: ReturnTemplate): ReturnHeader => {
  const latest = ctx.db.all('annualReturns').filter((r) => r.templateId === t.id).sort((a, b) => b.year - a.year)[0];
  const minister = ctx.db.all('staff').find((s) => s.role === 'owner' && s.status === 'active');
  return latest?.header ?? { body: t.body, above: '', unit: settings(ctx).name, code: '', minister: minister?.name ?? '', preparedBy: ctx.staff?.name ?? '' };
};

function view(ctx: Ctx, t: ReturnTemplate, year: number): AnnualReturnView {
  const { from, to, label } = fiscalYearRange(ctx, String(year));
  const saved = ctx.db.get('annualReturns', `${t.id}:${year}`) ?? null;
  const facts = saved?.status === 'submitted' && saved.snapshot ? null : annualFacts(ctx, year);
  const s = settings(ctx);
  const header = saved?.header ?? blankHeader(ctx, t);
  const sections = t.sections.map((sec) => ({
    id: sec.id, title: sec.title,
    lines: sec.lines.map((l): ReturnLineView => {
      const auto = l.source === 'auto' ? (facts ? facts[l.key] ?? null : saved?.snapshot?.[l.key] ?? null) : null;
      const own = saved?.values[l.key];
      // The minister's name on the form is the one in the header unless the office types another.
      const fallback = l.source === 'manual' && l.key === 'minister' ? header.minister || null : auto;
      const value = saved?.status === 'submitted' && saved.snapshot ? saved.snapshot[l.key] ?? null : own !== undefined && own !== '' ? own : fallback;
      return { ...l, auto, value, overridden: own !== undefined && own !== '' && own !== auto };
    }),
  }));
  return {
    template: { id: t.id, name: t.name, body: t.body, unit: t.unit, above: t.above },
    year, label, from: from.toISOString().slice(0, 10), to: new Date(to.getTime() - 1).toISOString().slice(0, 10), currency: s.currency,
    church: { name: s.name, address: s.address, phone: s.phone, email: s.email, city: s.city },
    header,
    sections, return: saved,
    years: ctx.db.all('annualReturns').filter((r) => r.templateId === t.id).sort((a, b) => b.year - a.year).map((r) => ({ year: r.year, label: fiscalYearRange(ctx, String(r.year)).label, status: r.status })),
  };
}

function pickTemplate(ctx: Ctx, raw: unknown): ReturnTemplate {
  const id = String(raw ?? '') || ctx.db.get('meta', 'annualReturn:template')?.value || 'generic';
  const t = templateOf(id);
  if (!t) throw new ApiError(404, 'not_found', 'No such form. Pick one of the denominations listed.');
  return t;
}
const pickYear = (ctx: Ctx, raw: unknown) => { const y = Number(raw); return y >= 2000 && y <= 2100 ? y : fiscalYearRange(ctx).start; };

export function registerAnnualReturn(r: Router) {
  r.get('/admin/annual-return/templates', { perm: PERM }, () => T.map((t) => ({ id: t.id, name: t.name, body: t.body, unit: t.unit, above: t.above, lines: t.sections.reduce((s, x) => s + x.lines.length, 0) })));

  r.get('/admin/annual-return', { perm: PERM }, (ctx): AnnualReturnView => view(ctx, pickTemplate(ctx, ctx.query.template), pickYear(ctx, ctx.query.year)));

  // Save the office's own figures and the header. Lines left blank fall back to the data.
  r.put('/admin/annual-return', { perm: PERM }, (ctx): AnnualReturnView => {
    const t = pickTemplate(ctx, ctx.body.template);
    const year = pickYear(ctx, ctx.body.year);
    const cur = ctx.db.get('annualReturns', `${t.id}:${year}`);
    if (cur?.status === 'submitted') throw new ApiError(409, 'submitted', 'This return was submitted and its figures are frozen. Reopen it to change them.');
    const keys = new Set(t.sections.flatMap((s) => s.lines.map((l) => l.key)));
    const values: Record<string, number | string> = { ...(cur?.values ?? {}) };
    for (const [k, v] of Object.entries((ctx.body.values ?? {}) as Record<string, unknown>)) {
      if (!keys.has(k)) continue;
      if (v === null || v === '' || v === undefined) { delete values[k]; continue; }
      const line = t.sections.flatMap((s) => s.lines).find((l) => l.key === k)!;
      values[k] = line.kind === 'text' ? String(v).slice(0, 2000) : Number(v);
      if (line.kind !== 'text' && !Number.isFinite(values[k] as number)) throw new ApiError(422, 'invalid', `"${line.label}" must be a number.`, { [k]: line.label });
    }
    const h = (ctx.body.header ?? {}) as Partial<ReturnHeader>;
    const base = cur?.header ?? blankHeader(ctx, t);
    const header: ReturnHeader = { body: String(h.body ?? base.body).slice(0, 120), above: String(h.above ?? base.above).slice(0, 120), unit: String(h.unit ?? base.unit).slice(0, 120), code: String(h.code ?? base.code).slice(0, 60), minister: String(h.minister ?? base.minister).slice(0, 120), preparedBy: String(h.preparedBy ?? base.preparedBy).slice(0, 120) };
    const next: AnnualReturn = { id: `${t.id}:${year}`, templateId: t.id, year, header, values, notes: String(ctx.body.notes ?? cur?.notes ?? '').slice(0, 4000), status: 'draft', snapshot: null, submittedAt: null, submittedBy: '', updatedAt: ctx.now.toISOString() };
    ctx.db.put('annualReturns', next);
    ctx.db.put('meta', { id: 'annualReturn:template', value: t.id });
    return view(ctx, t, year);
  });

  // Freeze every figure as it stands and mark the return submitted.
  r.post('/admin/annual-return/submit', { perm: PERM }, (ctx): AnnualReturnView => {
    const t = pickTemplate(ctx, ctx.body.template);
    const year = pickYear(ctx, ctx.body.year);
    const v = view(ctx, t, year);
    const cur = ctx.db.get('annualReturns', `${t.id}:${year}`);
    const snapshot: Record<string, number | string | null> = {};
    for (const s of v.sections) for (const l of s.lines) snapshot[l.key] = l.value;
    const next: AnnualReturn = { id: `${t.id}:${year}`, templateId: t.id, year, header: v.header, values: cur?.values ?? {}, notes: cur?.notes ?? '', status: 'submitted', snapshot, submittedAt: ctx.now.toISOString(), submittedBy: ctx.staff?.name ?? '', updatedAt: ctx.now.toISOString() };
    ctx.db.put('annualReturns', next);
    ctx.audit('submitted', 'settings', next.id, `Submitted the ${t.name} for ${v.label}`);
    return view(ctx, t, year);
  });

  r.post('/admin/annual-return/reopen', { perm: PERM }, (ctx): AnnualReturnView => {
    const t = pickTemplate(ctx, ctx.body.template);
    const year = pickYear(ctx, ctx.body.year);
    const cur = ctx.db.get('annualReturns', `${t.id}:${year}`);
    if (!cur) throw new ApiError(404, 'not_found', 'Nothing saved for that year.');
    ctx.db.put('annualReturns', { ...cur, status: 'draft', snapshot: null, submittedAt: null, submittedBy: '', updatedAt: ctx.now.toISOString() });
    return view(ctx, t, year);
  });

  r.get('/admin/annual-return/export.csv', { perm: PERM }, (ctx) => {
    const v = view(ctx, pickTemplate(ctx, ctx.query.template), pickYear(ctx, ctx.query.year));
    const q = (x: unknown) => `"${String(x ?? '').replace(/"/g, '""')}"`;
    const money = (n: unknown) => (typeof n === 'number' ? (n / 100).toFixed(2) : '');
    const rows = [['Section', 'Line', 'Value', 'From the data', 'Source'].map(q).join(',')];
    for (const s of v.sections) for (const l of s.lines) rows.push([s.title, l.label, l.kind === 'money' ? money(l.value) : l.value ?? '', l.kind === 'money' ? money(l.auto) : l.auto ?? '', l.overridden ? 'office' : l.source === 'auto' ? 'data' : 'office'].map(q).join(','));
    return { csv: `${v.template.name} ${v.label}\n${v.church.name}\n\n${rows.join('\n')}\n` };
  });
}
