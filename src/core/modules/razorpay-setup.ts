// Assisted Razorpay setup: the church pays Flockwise a one-time fee, opens its Razorpay account
// through our partner link, uploads its papers here, and our team does the KYC.
import type { Db } from '../db.js';
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { ChurchOrgType, KycDoc, KycDocKind, RazorpaySetup, RazorpaySetupStatus, RazorpaySetupView } from '../types.js';
import { churchId, settings } from '../util.js';

/** ₹1,999 in paise. */
export const SETUP_FEE = 199_900;
export const SETUP_KIND = 'razorpay_setup';
export const MAX_DOC_BYTES = 3 * 1024 * 1024;
export const MAX_DOCS = 12;

export const ORG_TYPES: Record<ChurchOrgType, string> = {
  trust: 'Registered trust',
  society: 'Registered society',
  section8: 'Section 8 company',
  parent: 'Under a diocese or parent body',
};

export const DOC_KINDS: Record<KycDocKind, string> = {
  pan: 'PAN card of the trust, society or company',
  registration: 'Trust deed, society registration or incorporation certificate',
  bank_proof: 'Cancelled cheque or bank statement in the church’s name',
  signatory_id: 'Aadhaar or PAN of the person who signs for the church',
  authorisation: 'Letter from the parent body allowing the church to collect gifts',
  reg_12a_80g: '12A or 80G certificate',
  fcra: 'FCRA registration certificate',
  address_proof: 'Address proof of the church',
  other: 'Something else',
};

const STATUSES: RazorpaySetupStatus[] = ['pending_payment', 'paid', 'in_progress', 'done', 'refunded'];

export function requiredDocs(orgType: ChurchOrgType | null): KycDocKind[] {
  const base: KycDocKind[] = ['pan', 'registration', 'bank_proof', 'signatory_id'];
  return orgType === 'parent' ? [...base, 'authorisation'] : base;
}

export const getSetup = (db: Db) => (db.get('integrations', 'razorpaySetup') as RazorpaySetup | undefined) ?? null;

function missing(s: RazorpaySetup | null): KycDocKind[] {
  if (!s) return requiredDocs(null);
  const have = new Set(s.docs.map((d) => d.kind));
  return requiredDocs(s.orgType).filter((k) => !have.has(k));
}

export function setupView(ctx: Ctx): RazorpaySetupView {
  const setup = getSetup(ctx.db);
  return {
    price: SETUP_FEE,
    currency: 'INR',
    online: !!ctx.env.billing?.oneTime || ctx.env.demo,
    partnerUrl: ctx.env.razorpayPartnerUrl ?? '',
    setup,
    missing: missing(setup),
  };
}

/** Records the fee as paid (from the billing webhook or a check on return). Safe to call twice. */
export function markSetupPaid(ctx: Ctx, providerRef: string) {
  const s = getSetup(ctx.db);
  if (!s || s.status !== 'pending_payment' || s.paymentRef !== providerRef) return false;
  ctx.db.put('integrations', { ...s, status: 'paid', paidAt: ctx.now.toISOString() });
  ctx.audit('paid', 'payments', null, 'Paid for assisted Razorpay setup');
  return true;
}

/** PDF, JPG or PNG, by the file's first bytes. */
export function sniff(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'application/pdf';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  return null;
}

function decode(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^,]*,/, '');
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
  const bin = atob(clean);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Uploads are open after payment and until our team finishes. */
function openSetup(ctx: Ctx): RazorpaySetup {
  const s = getSetup(ctx.db);
  if (!s || !['paid', 'in_progress'].includes(s.status)) throw new ApiError(409, 'not_open', 'Document upload opens after the assisted setup payment.');
  return s;
}

/** Drops the stored document bytes (kept only while our team needs them). */
export function purgeFiles(db: Db, s: RazorpaySetup) {
  for (const d of s.docs) db.del('kycFiles', d.id);
}

export function registerRazorpaySetup(r: Router) {
  r.get('/admin/settings/payments/setup', { perm: 'settings' }, async (ctx) => {
    const s = getSetup(ctx.db);
    if (s?.status === 'pending_payment' && s.paymentRef && ctx.env.billing?.linkPaid) {
      try {
        if (await ctx.env.billing.linkPaid(s.paymentRef)) markSetupPaid(ctx, s.paymentRef);
      } catch {
        // Razorpay unreachable: the webhook will confirm it.
      }
    }
    return setupView(ctx);
  });

  r.post('/admin/settings/payments/setup', { perm: 'settings' }, async (ctx) => {
    const existing = getSetup(ctx.db);
    if (existing && existing.status !== 'pending_payment' && existing.status !== 'refunded') throw new ApiError(409, 'already_paid', 'You have already paid for assisted setup.');
    const church = settings(ctx);
    const base: RazorpaySetup = {
      id: 'razorpaySetup', status: 'pending_payment', amount: SETUP_FEE, paymentRef: null, paymentUrl: null,
      requestedBy: ctx.staff?.name ?? church.name, requestedByEmail: ctx.staff?.email ?? church.email ?? '', createdAt: ctx.now.toISOString(),
      paidAt: null, doneAt: null, orgType: existing?.orgType ?? null, contactPhone: existing?.contactPhone ?? church.phone ?? '', docs: [], docsSubmittedAt: null, teamNote: '',
    };
    if (ctx.env.demo && !ctx.env.billing?.oneTime) {
      ctx.db.put('integrations', { ...base, status: 'paid', paidAt: ctx.now.toISOString() });
      ctx.audit('paid', 'payments', null, 'Paid for assisted Razorpay setup');
      return { activated: true, view: setupView(ctx) };
    }
    if (!ctx.env.billing?.oneTime) throw new ApiError(503, 'billing_off', 'Online payment for assisted setup is not switched on yet. Write to hello@flockwise.church and we will set it up for you.');
    const out = await ctx.env.billing.oneTime({
      churchId: churchId(ctx), kind: SETUP_KIND, amount: SETUP_FEE, description: `Assisted Razorpay setup and KYC for ${church.name}`,
      email: base.requestedByEmail, name: base.requestedBy, returnUrl: `${ctx.env.webUrl}/admin/razorpay-setup`,
    });
    ctx.db.put('integrations', { ...base, paymentRef: out.providerRef, paymentUrl: out.url });
    ctx.audit('created', 'payments', null, 'Started paying for assisted Razorpay setup');
    return { checkoutUrl: out.url };
  });

  r.patch('/admin/settings/payments/setup', { perm: 'settings' }, (ctx) => {
    const s = openSetup(ctx);
    const next = { ...s };
    if (ctx.body.orgType !== undefined) {
      if (!(ctx.body.orgType in ORG_TYPES)) throw new ApiError(422, 'invalid', 'Pick how the church is registered.', { orgType: 'Pick one' });
      next.orgType = ctx.body.orgType as ChurchOrgType;
    }
    if (ctx.body.contactPhone !== undefined) next.contactPhone = String(ctx.body.contactPhone).trim().slice(0, 20);
    ctx.db.put('integrations', next);
    return setupView(ctx);
  });

  r.post('/admin/settings/payments/setup/docs', { perm: 'settings' }, (ctx) => {
    const s = openSetup(ctx);
    const kind = String(ctx.body.kind ?? '') as KycDocKind;
    if (!(kind in DOC_KINDS)) throw new ApiError(422, 'invalid', 'Pick what this document is.', { kind: 'Pick one' });
    if (s.docs.length >= MAX_DOCS) throw new ApiError(422, 'too_many', `You can upload up to ${MAX_DOCS} files. Remove one first.`);
    const data = String(ctx.body.data ?? '');
    if (!data) throw new ApiError(422, 'invalid', 'Choose a file first.');
    const bytes = decode(data);
    if (bytes.length > MAX_DOC_BYTES) throw new ApiError(422, 'too_big', 'Each file must be under 3 MB. Take a photo instead of a scan, or compress the PDF.');
    const mime = sniff(bytes);
    if (!mime) throw new ApiError(422, 'bad_type', 'Only PDF, JPG or PNG files, please.');
    const doc: KycDoc = { id: ctx.id('kyc'), kind, fileName: String(ctx.body.fileName ?? 'document').slice(0, 180), mime, size: bytes.length, uploadedAt: ctx.now.toISOString(), uploadedBy: ctx.staff?.name ?? '' };
    ctx.db.put('kycFiles', { id: doc.id, sealed: ctx.env.seal(data.replace(/^data:[^,]*,/, '')) });
    ctx.db.put('integrations', { ...s, docs: [...s.docs, doc] });
    ctx.audit('uploaded', 'payments', doc.id, `Uploaded a KYC document (${DOC_KINDS[kind]})`);
    return setupView(ctx);
  });

  r.del('/admin/settings/payments/setup/docs/:id', { perm: 'settings' }, (ctx) => {
    const s = openSetup(ctx);
    const id = ctx.params[0];
    if (!s.docs.some((d) => d.id === id)) throw new ApiError(404, 'not_found', 'Document not found.');
    ctx.db.del('kycFiles', id);
    ctx.db.put('integrations', { ...s, docs: s.docs.filter((d) => d.id !== id) });
    return setupView(ctx);
  });

  r.post('/admin/settings/payments/setup/submit', { perm: 'settings' }, (ctx) => {
    const s = openSetup(ctx);
    if (!s.orgType) throw new ApiError(422, 'invalid', 'Pick how the church is registered first.', { orgType: 'Pick one' });
    const need = missing(s);
    if (need.length) throw new ApiError(422, 'missing_docs', `Still needed: ${need.map((k) => DOC_KINDS[k]).join('; ')}.`);
    ctx.db.put('integrations', { ...s, docsSubmittedAt: ctx.now.toISOString() });
    ctx.audit('submitted', 'payments', null, 'Sent KYC documents to the Flockwise team');
    return setupView(ctx);
  });
}

// ----- for the Flockwise team panel -----

/** One church's setup for the team list, without file bytes. */
export function teamSetupRow(db: Db) {
  const s = getSetup(db);
  if (!s) return null;
  return { ...s, missing: missing(s), keysConnected: !!db.get('integrations', 'razorpay') };
}

/** The team updates progress. Done or refunded drops the stored documents. */
export function teamUpdateSetup(db: Db, body: Record<string, unknown>, nowIso: string) {
  const s = getSetup(db);
  if (!s) throw new ApiError(404, 'not_found', 'This church has not asked for assisted setup.');
  const next: RazorpaySetup = { ...s };
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status as RazorpaySetupStatus) || body.status === 'pending_payment') throw new ApiError(422, 'invalid', 'Unknown status.');
    if (s.status === 'pending_payment') throw new ApiError(409, 'not_paid', 'This church has not paid yet.');
    next.status = body.status as RazorpaySetupStatus;
    if (next.status === 'done' && !s.doneAt) next.doneAt = nowIso;
  }
  if (typeof body.teamNote === 'string') next.teamNote = body.teamNote.slice(0, 1000);
  const closed = (x: RazorpaySetupStatus) => x === 'done' || x === 'refunded';
  if (closed(next.status) && !closed(s.status)) {
    purgeFiles(db, s);
    next.docs = s.docs.map((d) => ({ ...d, fileName: `${d.fileName} (deleted)` }));
  }
  db.put('integrations', next);
  return next;
}

export function teamReadDoc(db: Db, docId: string, unseal: (s: string) => string) {
  const s = getSetup(db);
  const doc = s?.docs.find((d) => d.id === docId);
  const file = db.get('kycFiles', docId);
  if (!doc || !file) throw new ApiError(404, 'not_found', 'That document is no longer stored.');
  return { fileName: doc.fileName, mime: doc.mime, data: unseal(file.sealed) };
}
