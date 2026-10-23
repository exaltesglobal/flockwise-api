// Reading bank statement exports (SBI, HDFC, ICICI, Axis, Kotak, Canara, Union, IOB and most
// others) into plain lines. Runs in the browser before upload and in tests; no money leaves the
// office until the treasurer presses Add.

export type BankTarget = 'date' | 'narration' | 'ref' | 'debit' | 'credit' | 'amount' | 'drcr' | 'balance' | '';
export type BankLineInput = {
  /** YYYY-MM-DD */
  date: string;
  narration: string;
  ref: string | null;
  /** Minor units; credits positive, debits negative. */
  amount: number;
  balance: number | null;
};
export type NarrationKind = 'razorpay' | 'upi' | 'cheque' | 'cash' | 'neft' | 'charges' | 'interest' | 'other';

export const BANK_TARGETS: { id: BankTarget; label: string; synonyms: string[] }[] = [
  { id: 'date', label: 'Date', synonyms: ['txn date', 'transaction date', 'tran date', 'transaction dt', 'date', 'posted date', 'value date', 'value dt'] },
  { id: 'narration', label: 'Narration', synonyms: ['narration', 'description', 'transaction remarks', 'particulars', 'remarks', 'details', 'transaction details', 'transaction description'] },
  { id: 'ref', label: 'Reference / cheque no.', synonyms: ['ref no./cheque no.', 'chq./ref.no.', 'chq/ref no', 'chq / ref number', 'cheque no', 'cheque number', 'chq no', 'chqno', 'ref no', 'ref number', 'reference no', 'reference', 'utr', 'instrument no', 'transaction id', 'tran id'] },
  { id: 'debit', label: 'Debit (withdrawal)', synonyms: ['debit', 'withdrawal amt.', 'withdrawal amount', 'withdrawal', 'withdrawals', 'dr', 'debit amount', 'dr amount', 'paid out', 'money out'] },
  { id: 'credit', label: 'Credit (deposit)', synonyms: ['credit', 'deposit amt.', 'deposit amount', 'deposit', 'deposits', 'cr', 'credit amount', 'cr amount', 'paid in', 'money in'] },
  { id: 'amount', label: 'Amount (one column)', synonyms: ['amount', 'transaction amount', 'txn amount', 'amount (inr)'] },
  { id: 'drcr', label: 'Dr / Cr', synonyms: ['dr/cr', 'dr / cr', 'type', 'txn type', 'transaction type', 'cr/dr', 'debit/credit'] },
  { id: 'balance', label: 'Balance', synonyms: ['balance', 'closing balance', 'running balance', 'bal', 'available balance', 'balance (inr)'] },
];

const norm = (s: string) => s.toLowerCase().replace(/\(inr\s*\)/g, '').replace(/[^a-z0-9./ ]+/g, ' ').replace(/\s+/g, ' ').trim();

export function guessBankColumns(headers: string[]): BankTarget[] {
  const out: BankTarget[] = headers.map(() => '');
  const names = headers.map(norm);
  // Each target takes the heading that names it best: exact synonyms in order of preference
  // ("Transaction Date" before "Value Date"), then headings that contain one.
  for (const t of BANK_TARGETS) {
    let hit = -1;
    for (const pass of ['exact', 'contains'] as const) {
      for (const syn of t.synonyms) {
        hit = names.findIndex((n, i) => !out[i] && n && (pass === 'exact' ? n === syn : syn.length > 2 && n.includes(syn)));
        if (hit >= 0) break;
      }
      if (hit >= 0) break;
    }
    if (hit >= 0) out[hit] = t.id;
  }
  const taken = new Set(out);
  // A lone "amount" with "dr"/"cr" lists is fine; "debit"+"credit" make "amount" redundant.
  if (taken.has('debit') && taken.has('credit')) out.forEach((t, i) => { if (t === 'amount') out[i] = ''; });
  return out;
}

/** Bank exports often start with account details; the heading row is the first one that names a date and money. */
export function findHeaderRow(table: string[][]): number {
  for (let i = 0; i < Math.min(table.length, 40); i++) {
    const g = guessBankColumns(table[i] ?? []);
    if (g.includes('date') && (g.includes('debit') || g.includes('credit') || g.includes('amount'))) return i;
  }
  return 0;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/** Bank dates: 01/04/2026, 01-04-26, 01-Apr-2026, 01 Apr 2026, 2026-04-01, 01/04/2026 10:31:00. */
export function parseBankDate(v: string): string | undefined {
  const s = v.trim();
  if (!s) return undefined;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/ -]([A-Za-z]{3,4})[/ -](\d{2,4})/);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (!mo) return undefined;
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${y}-${String(mo).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) {
    let day = Number(m[1]);
    let month = Number(m[2]);
    if (month > 12 && day <= 12) [day, month] = [month, day];
    if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return undefined;
}

/** "12,500.00", "₹ 12,500", "12500.00 Cr", "-1,200", "(1,200)" → paise, or null when blank. */
export function parseBankAmount(v: string): number | null {
  const s = v.replace(/[₹,\s]/g, '').replace(/^\((.*)\)$/, '-$1').replace(/(cr|dr)\.?$/i, '');
  if (!s || s === '-' || s === '--') return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function narrationKind(n: string): NarrationKind {
  const s = n.toLowerCase();
  if (/razorpay|rzp|razorpa/.test(s)) return 'razorpay';
  if (/\b(bank )?charges?\b|sms chg|sms alert|chrg|gst|annual fee|folio|cheque book|debit card fee|min bal|amb chg/.test(s)) return 'charges';
  if (/\bint(erest)?\b.*(cr|paid|credit)|interest credit|int\.? ?pd|credit interest|sb int/.test(s)) return 'interest';
  if (/\bupi\b|@|upi\//.test(s)) return 'upi';
  if (/\bchq\b|cheque|clg|clearing|\bcts\b|inward/.test(s)) return 'cheque';
  if (/cash dep|cdm|cash deposit|by cash|csh dep|\bcash\b/.test(s)) return 'cash';
  if (/neft|rtgs|imps|ft-|fund transfer|tpt|transfer/.test(s)) return 'neft';
  return 'other';
}

/** The 12-digit UPI reference or the UTR in a narration, when one is there. */
export function narrationRef(n: string): string | null {
  const neft = n.match(/\b(N\d{9,}[A-Z0-9]*)\b/i);
  if (neft) return neft[1].toUpperCase();
  const upi = n.match(/(?<!\d)(\d{12})(?!\d)/);
  if (upi) return upi[1];
  // A UTR like HDFCR52026101234567, but not an IFSC (four letters, a zero, six characters).
  for (const m of n.matchAll(/\b([A-Z]{4}[A-Z0-9]{1,3}\d{6,12})\b/g)) if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(m[1])) return m[1];
  return null;
}

/** An Indian mobile written in a narration (UPI narrations often carry the payer's number). */
export function narrationPhone(n: string): string | null {
  const m = n.replace(/\s/g, '').match(/(?<!\d)(?:\+?91)?([6-9]\d{9})(?!\d)/);
  return m ? m[1] : null;
}

/** The payer's UPI id, when the narration has one. */
export function narrationVpa(n: string): string | null {
  const m = n.match(/([a-z0-9._-]{3,}@[a-z]{2,})/i);
  return m ? m[1].toLowerCase() : null;
}

export function rowsToBankLines(mapping: BankTarget[], rows: string[][]): { lines: BankLineInput[]; problems: string[] } {
  const col = (t: BankTarget) => mapping.indexOf(t);
  const lines: BankLineInput[] = [];
  const problems: string[] = [];
  const iDate = col('date'), iNarr = col('narration'), iRef = col('ref'), iDr = col('debit'), iCr = col('credit'), iAmt = col('amount'), iDrCr = col('drcr'), iBal = col('balance');
  rows.forEach((r, idx) => {
    const cell = (i: number) => (i >= 0 ? String(r[i] ?? '').trim() : '');
    if (r.every((c) => !String(c ?? '').trim())) return;
    const date = parseBankDate(cell(iDate));
    if (!date) {
      // Totals and footer rows have no date; only complain when a real line lost its date.
      const footer = r.some((c) => /^(total|totals|grand total|closing balance|opening balance|balance b\/f|balance c\/f)/i.test(String(c ?? '').trim()));
      if (!footer && (parseBankAmount(cell(iDr)) || parseBankAmount(cell(iCr)) || parseBankAmount(cell(iAmt)))) problems.push(`Row ${idx + 2}: no date`);
      return;
    }
    let amount: number | null = null;
    if (iDr >= 0 || iCr >= 0) {
      const dr = parseBankAmount(cell(iDr));
      const cr = parseBankAmount(cell(iCr));
      amount = cr && cr !== 0 ? Math.abs(cr) : dr && dr !== 0 ? -Math.abs(dr) : null;
    } else if (iAmt >= 0) {
      const a = parseBankAmount(cell(iAmt));
      if (a !== null) {
        const t = cell(iDrCr).toLowerCase();
        const raw = cell(iAmt).toLowerCase();
        const debit = /^(dr|d|debit|withdrawal)/.test(t) || /dr\.?$/.test(raw) || a < 0;
        amount = debit ? -Math.abs(a) : Math.abs(a);
      }
    }
    if (amount === null || amount === 0) { problems.push(`Row ${idx + 2}: no amount`); return; }
    const narration = (cell(iNarr) || cell(iRef) || 'No narration').replace(/\s+/g, ' ').slice(0, 300);
    lines.push({ date, narration, ref: cell(iRef).slice(0, 60) || null, amount, balance: parseBankAmount(cell(iBal)) });
  });
  return { lines, problems };
}

/** Names the bank from the heading row and the first narrations, for the statement's label. */
export function detectBank(headers: string[], sample: string[]): string {
  const h = headers.map(norm).join('|');
  const s = sample.join(' ').toUpperCase();
  if (h.includes('txn date') && h.includes('ref no./cheque no.')) return 'SBI';
  if (h.includes('chq./ref.no.') || h.includes('withdrawal amt.')) return 'HDFC Bank';
  if (h.includes('transaction remarks') || h.includes('withdrawal amount')) return 'ICICI Bank';
  if (h.includes('tran date') || h.includes('particulars')) return 'Axis Bank';
  for (const [k, name] of [['SBI', 'SBI'], ['HDFC', 'HDFC Bank'], ['ICICI', 'ICICI Bank'], ['AXIS', 'Axis Bank'], ['KOTAK', 'Kotak'], ['CANARA', 'Canara Bank'], ['UNION', 'Union Bank'], ['IOB', 'Indian Overseas Bank'], ['BOB', 'Bank of Baroda'], ['PNB', 'PNB'], ['INDUSIND', 'IndusInd'], ['YES', 'Yes Bank'], ['FEDERAL', 'Federal Bank'], ['SIB', 'South Indian Bank'], ['KARUR', 'KVB']] as const) if (s.includes(k)) return name;
  return 'Bank';
}
