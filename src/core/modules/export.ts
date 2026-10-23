// Export everything: the church's data as CSV files plus one JSON file, so a church can leave
// (or keep a backup) as easily as it joined. Secrets, sign-in tokens and secret ballots stay out.
import type { Ctx, Router } from '../engine.js';
import { KINDS, type ExportBundle, type ExportFile, type ExportSummary, type Kind } from '../types.js';
import { church } from '../util.js';

/** Never exported: credentials, sessions, sealed keys, device tokens, secret ballots and the WhatsApp bot's scratch space. */
const PRIVATE: Kind[] = ['otps', 'refreshTokens', 'teamLogins', 'devices', 'apiKeys', 'integrations', 'kycFiles', 'meta', 'ballots', 'ballotStubs', 'botMessages', 'live', 'presentations', 'captions', 'streamViews', 'media', 'canvaDesigns', 'calendarFeeds', 'greetingLinks', 'settings', 'automations'];

/** The files most churches actually open, with names people recognise. */
const FRIENDLY: Partial<Record<Kind, string>> = {
  people: 'people', campuses: 'campuses', events: 'events', rsvps: 'rsvps', groups: 'groups', groupMembers: 'group-members', groupMeetings: 'group-meetings',
  funds: 'funds', donations: 'gifts', pledges: 'pledges', recurring: 'recurring-gifts', batches: 'counting-batches', expenses: 'expenses', accountHeads: 'account-heads',
  checkins: 'attendance', headcounts: 'headcounts', attendanceHistory: 'attendance-history', teams: 'teams', assignments: 'rota', blockouts: 'away-dates',
  songs: 'songs', plans: 'service-plans', sermons: 'sermons', care: 'care', prayer: 'prayer', visits: 'visits', zones: 'zones', registers: 'registers', assets: 'assets',
  staff: 'office-users', roles: 'roles', audit: 'audit-log', messages: 'messages', announcements: 'announcements', forms: 'forms', formResponses: 'form-responses',
  resources: 'rooms-and-resources', bookings: 'bookings', aidRequests: 'benevolence', rentals: 'hall-hire', elections: 'elections', consentLog: 'consent-log', dataRequests: 'data-requests',
};

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? (Array.isArray(v) && v.every((x) => typeof x !== 'object') ? v.join('; ') : JSON.stringify(v)) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Any list of records → CSV with the union of their keys, in first-seen order. */
export function toCsv(rows: Record<string, unknown>[], head?: string[]) {
  const keys = head ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [keys.map(cell).join(','), ...rows.map((r) => keys.map((k) => cell(r[k])).join(','))].join('\r\n');
}

const money = (minor: number | null | undefined) => (minor === null || minor === undefined ? '' : (minor / 100).toFixed(2));

/** The curated people, gifts and attendance sheets read like a register, not a database. */
function curated(ctx: Ctx): ExportFile[] {
  const campus = new Map(ctx.db.all('campuses').map((c) => [c.id, c.name]));
  const groupsOf = new Map<string, string[]>();
  const groupName = new Map(ctx.db.all('groups').map((g) => [g.id, g.name]));
  for (const m of ctx.db.all('groupMembers')) groupsOf.set(m.personId, [...(groupsOf.get(m.personId) ?? []), groupName.get(m.groupId) ?? m.groupId]);
  const people = ctx.db.all('people').map((p) => ({
    'ID': p.id, 'First name': p.firstName, 'Last name': p.lastName, 'Mobile': p.phone, 'Email': p.email, 'Status': p.status, 'Gender': p.gender, 'Date of birth': p.birthDate,
    'Household': p.householdName, 'Address': p.address, 'Campus': p.campusId ? campus.get(p.campusId) ?? '' : '', 'Groups': (groupsOf.get(p.id) ?? []).join('; '), 'Tags': p.tags.join('; '),
    'Language': p.language, 'Baptism date': p.baptismDate, 'Anniversary': p.anniversary, 'Joined': p.joinedAt.slice(0, 10), 'Last attended': p.lastAttendedAt?.slice(0, 10) ?? '',
    'Email consent': p.consent.email, 'SMS consent': p.consent.sms, 'WhatsApp consent': p.consent.whatsapp, 'In directory': p.consent.directory, 'Notes': p.notes, 'Old system ID': p.externalId ?? '',
  }));
  const gifts = ctx.db.all('donations').filter((d) => d.status === 'succeeded').map((d) => ({
    'ID': d.id, 'Date': (d.paidAt ?? d.createdAt).slice(0, 10), 'Donor': d.donorName, 'Donor ID': d.donorId, 'Fund': d.fundName, 'Amount': money(d.amount), 'Currency': d.currency, 'Method': d.method,
    'Receipt number': d.receiptNumber, 'PAN': d.pan, 'Foreign donor': d.fcra, 'Recurring': d.frequency === 'monthly', 'Provider': d.provider, 'Reference': d.providerRef ?? d.providerPaymentId ?? '', 'Event': d.eventId ? ctx.db.get('events', d.eventId)?.title ?? d.eventId : '',
  }));
  const events = new Map(ctx.db.all('events').map((e) => [e.id, e]));
  const attendance = ctx.db.all('checkins').map((c) => ({
    'Date': c.at.slice(0, 10), 'Time': c.at.slice(11, 16), 'Service': events.get(c.eventId)?.title ?? c.eventId, 'Person': c.personName, 'Person ID': c.personId, 'Household': c.householdName, 'Child': c.isChild, 'Room': c.roomName, 'Method': c.method, 'Checked out': c.checkedOutAt?.slice(11, 16) ?? '',
  }));
  return [
    { name: 'people.csv', rows: people.length, csv: toCsv(people) },
    { name: 'gifts.csv', rows: gifts.length, csv: toCsv(gifts) },
    { name: 'attendance.csv', rows: attendance.length, csv: toCsv(attendance) },
  ];
}

function exportable(): Kind[] {
  return KINDS.filter((k) => !PRIVATE.includes(k));
}

export function exportSummary(ctx: Ctx): ExportSummary {
  const counts: Record<string, number> = {};
  for (const k of exportable()) {
    const n = ctx.db.count(k);
    if (n) counts[FRIENDLY[k] ?? k] = n;
  }
  return { people: ctx.db.count('people'), gifts: ctx.db.all('donations').filter((d) => d.status === 'succeeded').length, attendance: ctx.db.count('checkins'), files: Object.keys(counts).length + 5, counts };
}

export function exportBundle(ctx: Ctx): ExportBundle {
  const files = curated(ctx);
  const raw: Partial<Record<Kind, unknown[]>> = {};
  for (const k of exportable()) {
    const rows = ctx.db.all(k) as unknown as Record<string, unknown>[];
    if (!rows.length) continue;
    raw[k] = rows;
    const name = FRIENDLY[k] ?? k;
    if (!['people', 'gifts', 'attendance'].includes(name)) files.push({ name: `tables/${name}.csv`, rows: rows.length, csv: toCsv(rows) });
    else files.push({ name: `tables/${name}-raw.csv`, rows: rows.length, csv: toCsv(rows) });
  }
  const c = church(ctx);
  const json = JSON.stringify({ exportedAt: ctx.now.toISOString(), exportedBy: ctx.staff?.name ?? '', church: { id: c.id, name: c.name, city: c.city }, format: 'flockwise-export-1', data: raw });
  files.push({ name: 'flockwise-data.json', rows: Object.values(raw).reduce((n, r) => n + r.length, 0), csv: json });
  ctx.audit('exported', 'church', c.id, `Exported all church data (${files.length} files) by ${ctx.staff?.name ?? 'the office'}`);
  return { generatedAt: ctx.now.toISOString(), church: c.name, readme: readme(ctx, files), files };
}

function readme(ctx: Ctx, files: ExportFile[]) {
  return [
    `${church(ctx).name}: export from Flockwise, ${ctx.now.toISOString().slice(0, 10)}.`,
    '',
    'people.csv, gifts.csv and attendance.csv are the sheets most people need, with names instead of ids.',
    'tables/*.csv hold every record as stored (one file per table; nested values are JSON). Amounts in tables/ are in paise.',
    'flockwise-data.json is the complete machine-readable copy for moving to another system or back into Flockwise.',
    'Not included: passwords, sign-in tokens, payment keys, secret ballots, uploaded files (download those from the media library).',
    '',
    ...files.map((f) => `${f.name}: ${f.rows} rows`),
  ].join('\n');
}

export function registerExportRoutes(r: Router) {
  r.get('/admin/export', { perm: 'settings' }, (ctx) => exportSummary(ctx));
  r.post('/admin/export', { perm: 'settings' }, (ctx) => exportBundle(ctx));
}

