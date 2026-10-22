// Church registers: baptism, confirmation, marriage and burial entries with printable
// certificates, and membership transfer letters. Entries are numbered per register and year,
// are never deleted (only voided with a reason), and every correction leaves a marginal note.
import { ApiError } from '../errors.js';
import type { Ctx, Router } from '../engine.js';
import type { Certificate, Collections, RegisterEntry, RegisterField, RegisterKind, RegisterSummary } from '../types.js';
import { find, fullName, localDate, page, settings } from '../util.js';

export const REGISTER_KINDS: RegisterKind[] = ['baptism', 'confirmation', 'marriage', 'burial', 'transfer'];

export const REGISTER_LABELS: Record<RegisterKind, { name: string; certificate: string; prefix: string; person: string; date: string }> = {
  baptism: { name: 'Baptism register', certificate: 'Certificate of Baptism', prefix: 'BAP', person: 'Name of the baptised', date: 'Date of baptism' },
  confirmation: { name: 'Confirmation register', certificate: 'Certificate of Confirmation', prefix: 'CNF', person: 'Name of the confirmed', date: 'Date of confirmation' },
  marriage: { name: 'Marriage register', certificate: 'Certificate of Marriage', prefix: 'MAR', person: 'Name of the bridegroom', date: 'Date of marriage' },
  burial: { name: 'Burial register', certificate: 'Certificate of Burial', prefix: 'BUR', person: 'Name of the deceased', date: 'Date of burial' },
  transfer: { name: 'Transfer letters', certificate: 'Letter of Transfer', prefix: 'TRF', person: 'Name of the member', date: 'Date of letter' },
};

const STATUS = ['Bachelor', 'Spinster', 'Widower', 'Widow', 'Divorced'];

/** The extra columns of each register, in the order they are printed. */
export const REGISTER_FIELDS: Record<RegisterKind, RegisterField[]> = {
  baptism: [
    { key: 'birthDate', label: 'Date of birth', type: 'date', required: true },
    { key: 'birthPlace', label: 'Place of birth', type: 'text' },
    { key: 'gender', label: 'Gender', type: 'select', options: ['Male', 'Female'] },
    { key: 'fatherName', label: "Father's name", type: 'text' },
    { key: 'motherName', label: "Mother's name", type: 'text' },
    { key: 'address', label: 'Address', type: 'textarea' },
    { key: 'godparents', label: 'Godparents / sponsors', type: 'text' },
  ],
  confirmation: [
    { key: 'birthDate', label: 'Date of birth', type: 'date' },
    { key: 'baptismDate', label: 'Date of baptism', type: 'date' },
    { key: 'baptismPlace', label: 'Place of baptism', type: 'text' },
    { key: 'fatherName', label: "Father's name", type: 'text' },
    { key: 'motherName', label: "Mother's name", type: 'text' },
    { key: 'sponsor', label: 'Sponsor', type: 'text' },
  ],
  marriage: [
    { key: 'groomAge', label: 'Age', type: 'number', group: 'Bridegroom' },
    { key: 'groomStatus', label: 'Condition', type: 'select', options: STATUS, group: 'Bridegroom' },
    { key: 'groomFather', label: "Father's name", type: 'text', group: 'Bridegroom' },
    { key: 'groomAddress', label: 'Address', type: 'textarea', group: 'Bridegroom' },
    { key: 'brideName', label: 'Name of the bride', type: 'text', required: true, group: 'Bride' },
    { key: 'brideAge', label: 'Age', type: 'number', group: 'Bride' },
    { key: 'brideStatus', label: 'Condition', type: 'select', options: STATUS, group: 'Bride' },
    { key: 'brideFather', label: "Father's name", type: 'text', group: 'Bride' },
    { key: 'brideAddress', label: 'Address', type: 'textarea', group: 'Bride' },
    { key: 'bannsDates', label: 'Banns published on', type: 'text' },
    { key: 'witness1', label: 'First witness', type: 'text', required: true },
    { key: 'witness2', label: 'Second witness', type: 'text', required: true },
  ],
  burial: [
    { key: 'deathDate', label: 'Date of death', type: 'date', required: true },
    { key: 'age', label: 'Age', type: 'number' },
    { key: 'relation', label: 'Father / husband / wife', type: 'text' },
    { key: 'address', label: 'Address', type: 'textarea' },
    { key: 'causeOfDeath', label: 'Cause of death', type: 'text' },
    { key: 'cemetery', label: 'Cemetery', type: 'text' },
    { key: 'graveNumber', label: 'Grave number', type: 'text' },
  ],
  transfer: [
    { key: 'toChurch', label: 'Transferred to (church)', type: 'text', required: true },
    { key: 'toAddress', label: 'Address of that church', type: 'textarea' },
    { key: 'memberSince', label: 'Member since', type: 'date' },
    { key: 'family', label: 'Family members included', type: 'textarea' },
    { key: 'reason', label: 'Reason for transfer', type: 'text' },
  ],
};

const clean = (v: unknown, max = 500) => String(v ?? '').trim().slice(0, max);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validate(kind: RegisterKind, e: Pick<RegisterEntry, 'date' | 'name' | 'details'>) {
  const errors: Record<string, string> = {};
  if (!DATE_RE.test(e.date)) errors.date = 'Enter the date';
  if (!e.name) errors.name = 'Enter the name';
  for (const f of REGISTER_FIELDS[kind]) {
    const v = e.details[f.key];
    if (f.required && !v) errors[f.key] = 'Required';
    else if (v && f.type === 'date' && !DATE_RE.test(v)) errors[f.key] = 'Enter a date';
    else if (v && f.type === 'select' && f.options && !f.options.includes(v)) errors[f.key] = 'Choose an option';
  }
  if (Object.keys(errors).length) throw new ApiError(422, 'invalid', 'Please fill in the required fields.', errors);
}

function cleanDetails(kind: RegisterKind, raw: unknown, base: Record<string, string> = {}) {
  const out = { ...base };
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  for (const f of REGISTER_FIELDS[kind]) if (src[f.key] !== undefined) out[f.key] = clean(src[f.key], f.type === 'textarea' ? 1000 : 300);
  return out;
}

function nextNumber(ctx: Ctx, kind: RegisterKind, date: string) {
  const year = date.slice(0, 4);
  const key = `register:${kind}:${year}`;
  const n = Number(ctx.db.get('meta', key)?.value ?? 0) + 1;
  ctx.db.put('meta', { id: key, value: String(n) });
  return `${REGISTER_LABELS[kind].prefix}/${year}/${String(n).padStart(4, '0')}`;
}

const byNewest = (a: RegisterEntry, b: RegisterEntry) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number);

/** The person's own record follows the register where it is still empty. */
function updatePeople(ctx: Ctx, e: RegisterEntry) {
  const person = e.personId ? ctx.db.get('people', e.personId) : undefined;
  if (e.kind === 'baptism' && person && !person.baptismDate) ctx.db.put('people', { ...person, baptismDate: e.date });
  if (e.kind === 'marriage') {
    for (const id of [e.personId, e.spouseId]) {
      const p = id ? ctx.db.get('people', id) : undefined;
      if (p && !p.anniversary) ctx.db.put('people', { ...p, anniversary: e.date });
    }
  }
  if (e.kind === 'burial' && person && person.status !== 'inactive') {
    ctx.db.put('people', { ...person, status: 'inactive', tags: [...new Set([...person.tags, 'Deceased'])] });
  }
}

function summary(ctx: Ctx): RegisterSummary[] {
  const year = localDate(ctx, ctx.now).slice(0, 4);
  const live = ctx.db.all('registers').filter((e) => e.status === 'recorded');
  return REGISTER_KINDS.map((kind) => {
    const mine = live.filter((e) => e.kind === kind).sort(byNewest);
    return { kind, total: mine.length, thisYear: mine.filter((e) => e.date.startsWith(year)).length, last: mine[0]?.date ?? null };
  });
}

const fmtDate = (d: string | undefined) => {
  if (!d || !DATE_RE.test(d)) return d ?? '';
  return new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};

export function certificate(ctx: Ctx, e: RegisterEntry, copy: number): Certificate {
  const s = settings(ctx);
  const L = REGISTER_LABELS[e.kind];
  const rows: { label: string; value: string }[] = [{ label: 'Register entry', value: e.number }, { label: L.person, value: e.name }];
  for (const f of REGISTER_FIELDS[e.kind]) {
    const v = e.details[f.key];
    if (!v) continue;
    rows.push({ label: f.group && f.key !== 'brideName' ? `${f.label} (${f.group.toLowerCase()})` : f.label, value: f.type === 'date' ? fmtDate(v) : v });
  }
  rows.push({ label: L.date, value: fmtDate(e.date) }, { label: 'Place', value: e.place }, { label: e.kind === 'transfer' ? 'Signed by' : 'Officiating minister', value: e.officiant });
  if (e.remarks) rows.push({ label: 'Remarks', value: e.remarks });
  let letter: string | null = null;
  if (e.kind === 'transfer') {
    const d = e.details;
    letter = [
      `To the Pastor and Church Council,\n${d.toChurch}${d.toAddress ? `\n${d.toAddress}` : ''}`,
      `Dear brothers and sisters in Christ,`,
      `This is to certify that the membership of ${e.name} at ${s.name}${d.memberSince ? `, held since ${fmtDate(d.memberSince)},` : ''} is in good standing.${d.family ? ` Family members included with this letter: ${d.family}.` : ''}`,
      `At ${d.reason ? `their request (${d.reason.toLowerCase()})` : 'their request'}, we commend ${e.name} to your fellowship and pastoral care. Kindly receive them into your membership and let us know when they have been received.`,
      `With grace and peace,`,
    ].join('\n\n');
  }
  return {
    entry: e,
    title: L.certificate,
    church: { name: s.name, address: s.address, city: s.city, phone: s.phone, email: s.email, logoUrl: s.logoUrl ?? null },
    rows,
    letter,
    issuedAt: localDate(ctx, ctx.now),
    copy,
  };
}

const FIELDS_EDITABLE = ['date', 'place', 'officiant', 'name', 'remarks'] as const;

export function registerRegisters(r: Router) {
  r.get('/admin/registers/summary', { perm: 'people.view' }, (ctx) => ({ kinds: summary(ctx), fields: REGISTER_FIELDS, labels: REGISTER_LABELS }));

  r.get('/admin/registers', { perm: 'people.view' }, (ctx) => {
    const kind = ctx.query.kind as RegisterKind | undefined;
    const q = clean(ctx.query.q).toLowerCase();
    const year = clean(ctx.query.year);
    const list = ctx.db
      .all('registers')
      .filter((e) => !kind || e.kind === kind)
      .filter((e) => !year || e.date.startsWith(year))
      .filter((e) => ctx.query.status === 'void' ? e.status === 'void' : ctx.query.status === 'all' || e.status === 'recorded')
      .filter((e) => !q || [e.name, e.number, e.officiant, ...Object.values(e.details)].some((v) => v.toLowerCase().includes(q)))
      .sort(byNewest);
    return page(list, ctx.query.cursor, 100);
  });

  r.get('/admin/registers/:id', { perm: 'people.view' }, (ctx) => find(ctx, 'registers', ctx.params[0], 'Register entry'));

  r.get('/admin/people/:id/registers', { perm: 'people.view' }, (ctx) =>
    ctx.db.all('registers').filter((e) => e.personId === ctx.params[0] || e.spouseId === ctx.params[0]).sort(byNewest),
  );

  r.post('/admin/registers', { perm: 'people.edit' }, (ctx) => {
    const kind = ctx.body.kind as RegisterKind;
    if (!REGISTER_KINDS.includes(kind)) throw new ApiError(422, 'invalid', 'Choose a register.');
    const person = ctx.body.personId ? find(ctx, 'people', String(ctx.body.personId), 'Person') : null;
    const spouse = kind === 'marriage' && ctx.body.spouseId ? find(ctx, 'people', String(ctx.body.spouseId), 'Person') : null;
    const details = cleanDetails(kind, ctx.body.details);
    if (kind === 'marriage' && spouse && !details.brideName) details.brideName = fullName(spouse);
    const s = settings(ctx);
    const draft = {
      date: clean(ctx.body.date, 10),
      name: clean(ctx.body.name, 200) || (person ? fullName(person) : ''),
      details,
    };
    validate(kind, draft);
    const now = ctx.now.toISOString();
    const e = ctx.db.put('registers', {
      id: ctx.id('rg'),
      kind,
      number: nextNumber(ctx, kind, draft.date),
      ...draft,
      place: clean(ctx.body.place, 200) || [s.name, s.city].filter(Boolean).join(', '),
      officiant: clean(ctx.body.officiant, 200),
      personId: person?.id ?? null,
      spouseId: spouse?.id ?? null,
      remarks: clean(ctx.body.remarks, 1000) || null,
      status: 'recorded',
      voidReason: null,
      notes: [],
      certificatesIssued: 0,
      createdAt: now,
      createdBy: ctx.staff?.name ?? 'Church office',
      updatedAt: now,
    });
    updatePeople(ctx, e);
    if (kind === 'transfer' && person && ctx.body.markInactive) ctx.db.put('people', { ...ctx.db.get('people', person.id)!, status: 'inactive', tags: [...new Set([...person.tags, 'Transferred'])] });
    ctx.audit('created', 'register', e.id, `Recorded ${e.number}: ${e.name} (${REGISTER_LABELS[kind].name.toLowerCase()})`);
    return e;
  });

  // Corrections keep the original visible: each changed value is written as a marginal note.
  r.patch('/admin/registers/:id', { perm: 'people.edit' }, (ctx) => {
    const e = find(ctx, 'registers', ctx.params[0], 'Register entry');
    if (e.status === 'void') throw new ApiError(409, 'void', 'This entry is void and cannot be changed.');
    const next: Collections['registers'] = { ...e, details: cleanDetails(e.kind, ctx.body.details, e.details) };
    for (const k of FIELDS_EDITABLE) if (ctx.body[k] !== undefined) (next as Record<string, unknown>)[k] = k === 'remarks' ? clean(ctx.body[k], 1000) || null : clean(ctx.body[k], k === 'date' ? 10 : 200);
    for (const k of ['personId', 'spouseId'] as const) {
      if (ctx.body[k] === undefined) continue;
      next[k] = ctx.body[k] ? find(ctx, 'people', String(ctx.body[k]), 'Person').id : null;
    }
    validate(e.kind, next);
    const labels: Record<string, string> = { date: REGISTER_LABELS[e.kind].date, place: 'Place', officiant: 'Officiant', name: REGISTER_LABELS[e.kind].person, remarks: 'Remarks' };
    for (const f of REGISTER_FIELDS[e.kind]) labels[f.key] = f.group ? `${f.label} (${f.group.toLowerCase()})` : f.label;
    const changes: string[] = [];
    for (const k of FIELDS_EDITABLE) if ((e[k] ?? '') !== (next[k] ?? '')) changes.push(`${labels[k]}: "${e[k] ?? ''}" → "${next[k] ?? ''}"`);
    for (const f of REGISTER_FIELDS[e.kind]) if ((e.details[f.key] ?? '') !== (next.details[f.key] ?? '')) changes.push(`${labels[f.key]}: "${e.details[f.key] ?? ''}" → "${next.details[f.key] ?? ''}"`);
    if (!changes.length && next.personId === e.personId && next.spouseId === e.spouseId) return e;
    const reason = clean(ctx.body.reason, 300);
    const by = ctx.staff?.name ?? 'Church office';
    if (changes.length) next.notes = [...e.notes, { at: ctx.now.toISOString(), by, text: `Corrected ${changes.join('; ')}${reason ? `. Reason: ${reason}` : ''}` }];
    next.updatedAt = ctx.now.toISOString();
    ctx.db.put('registers', next);
    updatePeople(ctx, next);
    ctx.audit('updated', 'register', e.id, `Corrected ${e.number}${changes.length ? `: ${changes.length} change${changes.length === 1 ? '' : 's'}` : ''}`);
    return next;
  });

  r.post('/admin/registers/:id/notes', { perm: 'people.edit' }, (ctx) => {
    const e = find(ctx, 'registers', ctx.params[0], 'Register entry');
    const text = clean(ctx.body.text, 1000);
    if (!text) throw new ApiError(422, 'invalid', 'Write the note.', { text: 'Required' });
    const next = ctx.db.put('registers', { ...e, notes: [...e.notes, { at: ctx.now.toISOString(), by: ctx.staff?.name ?? 'Church office', text }], updatedAt: ctx.now.toISOString() });
    ctx.audit('updated', 'register', e.id, `Added a note to ${e.number}`);
    return next;
  });

  // Entries are never deleted: a mistaken entry is voided and keeps its number.
  r.post('/admin/registers/:id/void', { perm: 'people.edit' }, (ctx) => {
    const e = find(ctx, 'registers', ctx.params[0], 'Register entry');
    if (!['owner', 'admin', 'pastor'].includes(ctx.role ?? '')) throw new ApiError(403, 'forbidden', 'Only a pastor or admin can void a register entry.');
    const reason = clean(ctx.body.reason, 300);
    if (!reason) throw new ApiError(422, 'invalid', 'Give the reason for voiding this entry.', { reason: 'Required' });
    if (e.status === 'void') return e;
    const next = ctx.db.put('registers', { ...e, status: 'void', voidReason: reason, notes: [...e.notes, { at: ctx.now.toISOString(), by: ctx.staff?.name ?? 'Church office', text: `Voided: ${reason}` }], updatedAt: ctx.now.toISOString() });
    ctx.audit('deleted', 'register', e.id, `Voided ${e.number}: ${reason}`);
    return next;
  });

  // Issuing a certificate counts the copy, so duplicates are numbered.
  r.post('/admin/registers/:id/certificate', { perm: 'people.view' }, (ctx) => {
    const e = find(ctx, 'registers', ctx.params[0], 'Register entry');
    if (e.status === 'void') throw new ApiError(409, 'void', 'A void entry has no certificate.');
    const next = ctx.db.put('registers', { ...e, certificatesIssued: e.certificatesIssued + 1 });
    ctx.audit('created', 'register', e.id, `Issued ${REGISTER_LABELS[e.kind].certificate.toLowerCase()} for ${e.number} (copy ${next.certificatesIssued})`);
    return certificate(ctx, next, next.certificatesIssued);
  });
}
