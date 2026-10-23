// Column matching and clean-up for member and gift imports from Excel, Google Sheets, Elvanto and
// Planning Center exports. Pure functions shared by the church office (browser) and the engine, so a
// file is read and checked in the browser and the server receives tidy rows.
import type { ImportSource, PaymentMethod, PersonStatus } from './types.js';

export type ImportKind = 'people' | 'gifts';

export type PeopleTarget =
  | 'firstName' | 'lastName' | 'fullName' | 'phone' | 'email' | 'status' | 'inactive' | 'gender' | 'birthDate' | 'anniversary' | 'baptismDate'
  | 'householdName' | 'householdKey' | 'householdRole' | 'child' | 'address' | 'addressPart' | 'tags' | 'groups' | 'campus' | 'language'
  | 'notes' | 'allergies' | 'medicalNotes' | 'externalId' | '';

export type GiftTarget = 'date' | 'amount' | 'fund' | 'method' | 'donorName' | 'donorFirst' | 'donorLast' | 'donorEmail' | 'donorPhone' | 'reference' | 'externalId' | 'notes' | '';

export type TargetInfo<T extends string> = { value: T; label: string; synonyms: string[]; hint?: string };

/** Headings from Flockwise's template, common Indian spreadsheets, Planning Center People exports and Elvanto People exports. */
export const PEOPLE_TARGETS: TargetInfo<PeopleTarget>[] = [
  { value: 'firstName', label: 'First name', synonyms: ['first name', 'firstname', 'given name', 'first', 'preferred name', 'nickname'] },
  { value: 'lastName', label: 'Last name', synonyms: ['last name', 'lastname', 'surname', 'family name', 'last'] },
  { value: 'fullName', label: 'Full name (split)', synonyms: ['name', 'full name', 'member name', 'naam', 'person', 'person name'] },
  { value: 'phone', label: 'Mobile', synonyms: ['mobile', 'phone', 'mobile number', 'mobile phone number', 'mobile phone', 'contact', 'contact number', 'whatsapp', 'cell', 'phone number', 'home phone number', 'home phone'] },
  { value: 'email', label: 'Email', synonyms: ['email', 'e-mail', 'email address', 'home email', 'primary email', 'work email'] },
  { value: 'status', label: 'Status', synonyms: ['membership', 'member status', 'membership type', 'member type', 'category', 'status', 'type'] },
  { value: 'inactive', label: 'Inactive flag (Yes/No)', synonyms: ['archived', 'deceased', 'inactive', 'inactive reason', 'inactive date', 'left', 'status'], hint: 'Yes, Archived, Inactive, Moved or Deceased marks the person inactive.' },
  { value: 'gender', label: 'Gender', synonyms: ['gender', 'sex'] },
  { value: 'birthDate', label: 'Birth date', synonyms: ['birthdate', 'birth date', 'date of birth', 'dob', 'birthday', 'born'] },
  { value: 'anniversary', label: 'Wedding anniversary', synonyms: ['anniversary', 'wedding anniversary', 'marriage date', 'wedding date'] },
  { value: 'baptismDate', label: 'Baptism date', synonyms: ['baptism', 'baptism date', 'baptised', 'baptized', 'date of baptism', 'baptised on'] },
  { value: 'householdName', label: 'Household name', synonyms: ['household', 'household name', 'family', 'family name', 'house name'] },
  { value: 'householdKey', label: 'Household / family ID', synonyms: ['household id', 'family id', 'family no', 'family number', 'household number', 'house no'], hint: 'Rows sharing the same value become one household.' },
  { value: 'householdRole', label: 'Household role', synonyms: ['family relationship', 'relationship', 'household role', 'household primary contact', 'household parent/guardian', 'relation', 'head of family'] },
  { value: 'child', label: 'Child (Yes/No)', synonyms: ['child', 'is child', 'minor'] },
  { value: 'address', label: 'Address', synonyms: ['address', 'home address', 'full address', 'residential address'] },
  { value: 'addressPart', label: 'Address (part)', synonyms: ['street', 'address 1', 'address 2', 'address line 1', 'address line 2', 'home address street line 1', 'home address street line 2', 'area', 'locality', 'city', 'home address city', 'state', 'home address state', 'postcode', 'pincode', 'pin code', 'zip', 'zip code', 'home address zip code', 'suburb', 'town', 'district'], hint: 'Several parts are joined into one address.' },
  { value: 'tags', label: 'Tags', synonyms: ['tags', 'ministry', 'ministries', 'labels', 'demographics', 'keywords'] },
  { value: 'groups', label: 'Groups (comma separated)', synonyms: ['groups', 'group', 'cell group', 'small group', 'departments', 'department', 'teams', 'service teams', 'prayer cell', 'cell'] },
  { value: 'campus', label: 'Campus', synonyms: ['campus', 'primary campus', 'location', 'locations', 'site', 'branch', 'congregation'] },
  { value: 'language', label: 'Language', synonyms: ['language', 'preferred language', 'mother tongue'] },
  { value: 'notes', label: 'Notes', synonyms: ['notes', 'note', 'comments', 'remarks', 'marital status', 'occupation', 'profession', 'grade', 'school name'] },
  { value: 'allergies', label: 'Allergies', synonyms: ['allergies', 'allergy'] },
  { value: 'medicalNotes', label: 'Medical notes', synonyms: ['medical notes', 'medical', 'medical conditions'] },
  { value: 'externalId', label: 'ID from the old system', synonyms: ['id', 'person id', 'member id', 'individual id', 'remote id', 'people id', 'elvanto id', 'unique id', 'reg no', 'registration number'], hint: 'Used to match the same person on a second import.' },
];

/** Headings from Planning Center Giving donation exports, Elvanto financial exports and treasurer spreadsheets. */
export const GIFT_TARGETS: TargetInfo<GiftTarget>[] = [
  { value: 'date', label: 'Date', synonyms: ['date', 'received at', 'received', 'donation date', 'transaction date', 'date received', 'created at', 'paid at', 'gift date'] },
  { value: 'amount', label: 'Amount', synonyms: ['amount', 'total', 'gift amount', 'donation amount', 'amount given', 'value', 'rs', 'inr', 'amount (inr)', 'amount inr'] },
  { value: 'fund', label: 'Fund', synonyms: ['fund', 'fund name', 'category', 'designation', 'purpose', 'account', 'giving category', 'offering type', 'head'] },
  { value: 'method', label: 'Payment method', synonyms: ['payment method', 'method', 'mode', 'payment mode', 'payment type', 'payment source', 'type', 'source', 'how'] },
  { value: 'donorName', label: 'Donor name', synonyms: ['donor', 'donor name', 'name', 'person', 'member', 'given by', 'contributor', 'person name', 'full name'] },
  { value: 'donorFirst', label: 'Donor first name', synonyms: ['first name', 'firstname', 'donor first name', 'first'] },
  { value: 'donorLast', label: 'Donor last name', synonyms: ['last name', 'lastname', 'donor last name', 'surname', 'last'] },
  { value: 'donorEmail', label: 'Donor email', synonyms: ['email', 'donor email', 'e-mail', 'email address', 'home email'] },
  { value: 'donorPhone', label: 'Donor mobile', synonyms: ['mobile', 'phone', 'donor phone', 'mobile number', 'contact', 'phone number', 'whatsapp'] },
  { value: 'reference', label: 'Receipt / reference number', synonyms: ['receipt', 'receipt number', 'receipt no', 'reference', 'check number', 'cheque number', 'cheque no', 'utr', 'transaction reference', 'payment reference', 'reference number', 'ref'] },
  { value: 'externalId', label: 'ID from the old system', synonyms: ['id', 'donation id', 'transaction id', 'gift id', 'payment id', 'contribution id'], hint: 'Stops the same gift being imported twice.' },
  { value: 'notes', label: 'Notes', synonyms: ['notes', 'note', 'comments', 'memo', 'description', 'remarks', 'payment status', 'status'] },
];

export const IMPORT_SOURCES: { value: ImportSource; label: string; people: string; gifts: string }[] = [
  { value: 'excel', label: 'Excel', people: 'Any .xlsx sheet with one person per row and column headings in the first row.', gifts: 'One gift per row: date, name, amount, fund and how it was given. Headings in the first row.' },
  { value: 'csv', label: 'CSV / Google Sheets', people: 'In Google Sheets choose File → Download → Comma-separated values (.csv).', gifts: 'In Google Sheets choose File → Download → Comma-separated values (.csv).' },
  { value: 'elvanto', label: 'Elvanto', people: 'In Elvanto go to People → Export, tick every field including Family ID, Family Relationship, Departments and Locations, and upload the file here.', gifts: 'In Elvanto go to Financial → Transactions → Export (CSV) for the years you want, and upload the file here.' },
  { value: 'planning_center', label: 'Planning Center', people: 'In Planning Center People open a list (or all people) → Export → CSV. Keep the Household, Campus, Child and Membership columns.', gifts: 'In Planning Center Giving go to Donations → Export → CSV for the date range you want, and upload the file here.' },
];

const norm = (h: string) => h.trim().toLowerCase().replace(/[_*#:()]/g, ' ').replace(/\s+/g, ' ').trim();

/** Fields a sheet can sensibly hold more than once. */
const REPEATABLE = new Set(['addressPart', 'inactive', 'notes', 'tags', 'groups', '']);
/** Too generic to match inside a longer heading ("Nickname", "Household Name"). */
const EXACT_ONLY = new Set(['name', 'first', 'last', 'cell', 'type', 'id', 'ref', 'rs', 'inr', 'head', 'how']);

/** Every target a heading could mean, best first: the synonym's position (exact match) or 100 + position (heading contains the synonym). */
function candidates<T extends string>(targets: TargetInfo<T>[], header: string): { target: T; score: number }[] {
  const h = norm(header);
  if (!h) return [];
  const out: { target: T; score: number }[] = [];
  for (const t of targets) {
    let best = -1;
    t.synonyms.forEach((syn, i) => {
      const score = syn === h ? i : syn.length > 3 && !EXACT_ONLY.has(syn) && h.includes(syn) ? 100 + i : -1;
      if (score >= 0 && (best < 0 || score < best)) best = score;
    });
    if (best >= 0) out.push({ target: t.value, score: best });
  }
  return out.sort((a, b) => a.score - b.score);
}

/**
 * One guess per heading. A field that only makes sense once (first name, mobile, email…) goes to
 * the heading that names it best, so Elvanto's "Mobile" beats its "Phone", Planning Center's
 * "Membership" (Member/Visitor) beats its "Status" (active/inactive) and "Home Email" beats
 * "Work Email"; a loser takes its next meaning ("Status" becomes the inactive flag) or is left
 * unmatched for the office to decide.
 */
export function guessColumns(kind: ImportKind, headers: string[]): (PeopleTarget | GiftTarget)[] {
  const targets = (kind === 'people' ? PEOPLE_TARGETS : GIFT_TARGETS) as TargetInfo<string>[];
  const ranked = headers.map((h) => candidates(targets, h));
  const winner = new Map<string, number>();
  ranked.forEach((cs, i) => {
    const c = cs[0];
    if (!c || REPEATABLE.has(c.target)) return;
    const have = winner.get(c.target);
    if (have === undefined || ranked[have]![0]!.score > c.score) winner.set(c.target, i);
  });
  const out = ranked.map((cs, i) => {
    for (const c of cs) {
      if (REPEATABLE.has(c.target)) return c.target;
      if (!winner.has(c.target)) {
        winner.set(c.target, i);
        return c.target;
      }
      if (winner.get(c.target) === i) return c.target;
    }
    return '';
  });
  // "Full name" is pointless once first or last name is matched.
  if (out.includes('firstName') || out.includes('lastName')) return out.map((t) => (t === 'fullName' ? '' : t)) as (PeopleTarget | GiftTarget)[];
  return out as (PeopleTarget | GiftTarget)[];
}

/** A sheet with an amount and a fund or date column is a list of gifts, not people. */
export function detectKind(headers: string[]): ImportKind {
  const hs = headers.map(norm);
  const has = (t: GiftTarget) => hs.some((h) => GIFT_TARGETS.find((x) => x.value === t)!.synonyms.includes(h));
  return has('amount') && (has('fund') || has('date')) ? 'gifts' : 'people';
}

export function normaliseStatus(v: string): PersonStatus | undefined {
  const s = v.trim().toLowerCase();
  if (!s) return undefined;
  if (/inactive|left|moved|deceased|archiv|former|expired/.test(s)) return 'inactive';
  if (/visit|guest|first|new|contact|prospect|seeker/.test(s)) return 'visitor';
  if (/regular|attender|attendee|adherent|friend/.test(s)) return 'regular';
  return 'member';
}

const yes = (v: string) => /^(y|yes|true|t|1|child|primary|head)/i.test(v.trim());

/** Dates: ISO first; then day/month/year (India, Elvanto) or month/day/year (Planning Center), swapping when the first number cannot be a month. */
export function normaliseDate(v: string, source: ImportSource = 'csv'): string | undefined {
  const s = v.trim();
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) {
    let a = Number(m[1]);
    let b = Number(m[2]);
    const usFirst = source === 'planning_center';
    let [day, month] = usFirst ? [b, a] : [a, b];
    if (month > 12 && day <= 12) [day, month] = [month, day];
    if (month > 12 || day > 31) return undefined;
    const yr = m[3].length === 2 ? Number(m[3]) + (Number(m[3]) > 30 ? 1900 : 2000) : Number(m[3]);
    return `${yr}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

export function normalisePhone(v: string): string | undefined {
  const first = v.split(/[;,/]/)[0] ?? '';
  const digits = first.replace(/\D/g, '');
  if (!digits) return undefined;
  if (digits.length === 10) return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`; // bare Indian mobile
  if (digits.length === 11 && digits.startsWith('0')) return `+91 ${digits.slice(1, 6)} ${digits.slice(6)}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  if (digits.length < 8) return undefined;
  return first.trim().startsWith('+') ? first.trim() : `+${digits}`;
}

export function normaliseMethod(v: string): PaymentMethod {
  const s = v.trim().toLowerCase();
  if (/upi|gpay|google pay|phonepe|paytm|bhim/.test(s)) return 'upi';
  if (/cheque|check|dd|draft/.test(s)) return 'cheque';
  if (/card|visa|master|rupay|credit|debit|stripe|razorpay|online/.test(s)) return 'card';
  if (/net ?banking/.test(s)) return 'netbanking';
  if (/wallet/.test(s)) return 'wallet';
  if (/ach|bank|transfer|neft|imps|rtgs|eft|direct|wire|standing/.test(s)) return 'bank_transfer';
  return 'cash';
}

/** "₹1,23,456.50", "1234.5", "(200)" → paise. */
export function normaliseAmount(v: string): number | undefined {
  const s = v.replace(/[^\d.-]/g, '');
  if (!s) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(Math.abs(n) * 100);
}

export type ImportPersonRow = {
  firstName: string;
  lastName: string;
  phone?: string;
  email?: string;
  status?: PersonStatus;
  gender?: 'male' | 'female' | null;
  birthDate?: string;
  anniversary?: string;
  baptismDate?: string;
  householdName?: string;
  /** Rows with the same key become one household; the name comes from the primary contact or the surname. */
  householdKey?: string;
  householdRole?: 'primary' | 'adult' | 'child';
  address?: string;
  tags?: string[];
  /** Group names, created when missing. */
  groups?: string[];
  campus?: string;
  language?: string;
  notes?: string;
  allergies?: string;
  medicalNotes?: string;
  externalId?: string;
};

const splitList = (raw: string) => raw.split(/[,;|]/).map((t) => t.trim()).filter(Boolean);

function roleOf(raw: string): 'primary' | 'adult' | 'child' | undefined {
  const s = raw.trim().toLowerCase();
  if (!s || s === 'no' || s === 'false' || s === '0') return undefined;
  if (/child|son|daughter|kid|dependent/.test(s)) return 'child';
  if (/primary|head|true|yes|husband|father|^1$/.test(s)) return 'primary';
  return 'adult';
}

export function rowsToPeople(source: ImportSource, mapping: (PeopleTarget | '')[], rows: string[][]): ImportPersonRow[] {
  const out: ImportPersonRow[] = [];
  for (const row of rows) {
    const p: Partial<ImportPersonRow> = {};
    const addressParts: string[] = [];
    const notes: string[] = [];
    let inactive = false;
    mapping.forEach((target, i) => {
      const raw = String(row[i] ?? '').trim();
      if (!target || !raw) return;
      switch (target) {
        case 'fullName': {
          const parts = raw.split(/\s+/);
          p.firstName ??= parts[0];
          p.lastName ??= parts.slice(1).join(' ');
          break;
        }
        case 'firstName': p.firstName = raw; break;
        case 'lastName': p.lastName = raw; break;
        case 'phone': p.phone ??= normalisePhone(raw); break;
        case 'email': p.email ??= raw.split(/[;,]/)[0]?.trim().toLowerCase(); break;
        case 'status': p.status = normaliseStatus(raw); break;
        case 'inactive': if (yes(raw) || /^(inactive|archived|moved|deceased|left|new church)|\d{4}/i.test(raw.trim())) inactive = true; break;
        case 'gender': p.gender = /^f/i.test(raw) ? 'female' : /^m/i.test(raw) ? 'male' : null; break;
        case 'birthDate': p.birthDate = normaliseDate(raw, source); break;
        case 'anniversary': p.anniversary = normaliseDate(raw, source); break;
        case 'baptismDate': p.baptismDate = normaliseDate(raw, source); break;
        case 'householdName': p.householdName = raw; break;
        case 'householdKey': p.householdKey = raw; break;
        case 'householdRole': p.householdRole = roleOf(raw) ?? p.householdRole; break;
        case 'child': if (yes(raw)) p.householdRole = 'child'; break;
        case 'address': p.address = raw; break;
        case 'addressPart': addressParts.push(raw); break;
        case 'tags': p.tags = [...(p.tags ?? []), ...splitList(raw)]; break;
        case 'groups': p.groups = [...(p.groups ?? []), ...splitList(raw)]; break;
        case 'campus': p.campus = splitList(raw)[0]; break;
        case 'language': p.language = raw; break;
        case 'notes': notes.push(raw); break;
        case 'allergies': p.allergies = raw; break;
        case 'medicalNotes': p.medicalNotes = raw; break;
        case 'externalId': p.externalId = raw; break;
      }
    });
    if (addressParts.length && !p.address) p.address = addressParts.join(', ');
    if (notes.length) p.notes = notes.join('\n');
    if (inactive) p.status = 'inactive';
    if (!p.firstName && !p.lastName && !p.phone && !p.email) continue; // blank line
    out.push({ ...p, firstName: p.firstName ?? '', lastName: p.lastName ?? '' });
  }
  return out;
}

export type ImportGiftRow = {
  date: string;
  /** Minor units (paise). */
  amount: number;
  fundName: string;
  method: PaymentMethod;
  donorName: string;
  donorEmail?: string;
  donorPhone?: string;
  reference?: string;
  externalId?: string;
  notes?: string;
};

export function rowsToGifts(source: ImportSource, mapping: (GiftTarget | '')[], rows: string[][]): { gifts: ImportGiftRow[]; problems: { row: number; message: string }[] } {
  const gifts: ImportGiftRow[] = [];
  const problems: { row: number; message: string }[] = [];
  rows.forEach((row, r) => {
    const g: Partial<ImportGiftRow> = {};
    let first = '';
    let last = '';
    let blank = true;
    mapping.forEach((target, i) => {
      const raw = String(row[i] ?? '').trim();
      if (!target || !raw) return;
      blank = false;
      switch (target) {
        case 'date': g.date = normaliseDate(raw, source); break;
        case 'amount': g.amount = normaliseAmount(raw); break;
        case 'fund': g.fundName = raw; break;
        case 'method': g.method = normaliseMethod(raw); break;
        case 'donorName': g.donorName = raw; break;
        case 'donorFirst': first = raw; break;
        case 'donorLast': last = raw; break;
        case 'donorEmail': g.donorEmail = raw.split(/[;,]/)[0]?.trim().toLowerCase(); break;
        case 'donorPhone': g.donorPhone = normalisePhone(raw); break;
        case 'reference': g.reference = raw; break;
        case 'externalId': g.externalId = raw; break;
        case 'notes': g.notes = raw; break;
      }
    });
    if (blank) return;
    if (!g.donorName && (first || last)) g.donorName = `${first} ${last}`.trim();
    if (!g.amount) return problems.push({ row: r + 1, message: 'No amount' });
    if (!g.date) return problems.push({ row: r + 1, message: 'No date, or a date that could not be read' });
    gifts.push({ date: g.date, amount: g.amount, fundName: g.fundName || 'Tithes & Offerings', method: g.method ?? 'cash', donorName: g.donorName || 'Anonymous', donorEmail: g.donorEmail, donorPhone: g.donorPhone, reference: g.reference, externalId: g.externalId, notes: g.notes });
  });
  return { gifts, problems };
}
