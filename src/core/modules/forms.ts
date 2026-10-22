// Forms and registrations: custom questions, ticket types, discount codes, capacity with a
// waitlist, and paid registrations through the church's own payment account. Forms can be
// for members (signed in) or public (anyone with the link, matched to a person by email).
import { ApiError } from '../errors.js';
import type { Ctx, Router } from '../engine.js';
import type { Collections, Form, FormAnswer, FormField, FormInput, FormResponse, FormSubmitResult, FormView, PublicForm, TicketType } from '../types.js';
import { find, fullName, matchOrCreatePerson, money, normEmail, pick, requireFields, settings } from '../util.js';
import { addMember, ensureEventFund } from './church.js';
import { onDonationSucceeded } from './giving.js';
import { startWorkflow } from './workflows.js';

const FIELD_TYPES = ['text', 'textarea', 'select', 'multiselect', 'checkbox', 'date', 'number', 'email', 'phone'];
/** An unpaid registration holds its place for this long. */
const HOLD_MS = 30 * 60_000;

const placesOf = (r: Pick<FormResponse, 'tickets'>) => (r.tickets.length ? r.tickets.reduce((s, t) => s + t.qty, 0) : 1);

function holdsPlace(ctx: Ctx, r: FormResponse) {
  if (r.status === 'confirmed') return true;
  return r.status === 'pending_payment' && ctx.now.getTime() - new Date(r.createdAt).getTime() < HOLD_MS;
}

const responsesOf = (ctx: Ctx, formId: string) => ctx.db.all('formResponses').filter((r) => r.formId === formId);

function usedPlaces(ctx: Ctx, form: Form, ticketTypeId?: string) {
  return responsesOf(ctx, form.id)
    .filter((r) => holdsPlace(ctx, r))
    .reduce((s, r) => s + (ticketTypeId ? r.tickets.filter((t) => t.ticketTypeId === ticketTypeId).reduce((a, t) => a + t.qty, 0) : placesOf(r)), 0);
}

function closedReason(ctx: Ctx, f: Form): string | null {
  if (f.status === 'draft') return 'This form is not open yet.';
  if (f.status === 'closed') return 'Registration has closed.';
  if (f.opensAt && new Date(f.opensAt) > ctx.now) return `Registration opens on ${f.opensAt.slice(0, 10)}.`;
  if (f.closesAt && new Date(f.closesAt) <= ctx.now) return 'Registration has closed.';
  return null;
}

export function formView(ctx: Ctx, f: Form): FormView {
  const rs = responsesOf(ctx, f.id);
  return {
    ...f,
    places: usedPlaces(ctx, f),
    confirmed: rs.filter((r) => r.status === 'confirmed').length,
    waitlisted: rs.filter((r) => r.status === 'waitlisted').length,
    pending: rs.filter((r) => r.status === 'pending_payment').length,
    revenue: rs.filter((r) => r.status === 'confirmed').reduce((s, r) => s + r.amount, 0),
    eventTitle: ctx.db.get('events', f.eventId)?.title ?? null,
  };
}

export function publicForm(ctx: Ctx, f: Form): PublicForm {
  const ev = ctx.db.get('events', f.eventId);
  const reason = closedReason(ctx, f);
  const spotsLeft = f.capacity ? Math.max(0, f.capacity - usedPlaces(ctx, f)) : null;
  return {
    id: f.id,
    title: f.title,
    description: f.description,
    fields: f.fields,
    ticketTypes: f.ticketTypes.map((t) => ({ ...t, remaining: t.capacity ? Math.max(0, t.capacity - usedPlaces(ctx, f, t.id)) : null })),
    event: ev ? { id: ev.id, title: ev.title, startsAt: ev.startsAt, location: ev.location } : null,
    isOpen: !reason,
    closedReason: reason,
    spotsLeft,
    waitlist: f.waitlist,
    hasDiscounts: f.discountCodes.length > 0,
    currency: settings(ctx).currency,
    churchName: settings(ctx).name,
    isPublic: f.isPublic,
  };
}

/** The open registration form for an event, if there is one. */
export function formForEvent(ctx: Ctx, eventId: string) {
  return ctx.db.all('forms').find((f) => f.eventId === eventId && f.status === 'open') ?? null;
}

// ----- validation -----

function cleanFields(raw: unknown): FormField[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 60).map((x: Record<string, unknown>, i) => ({
    id: String(x.id || `q${i + 1}`).slice(0, 40),
    label: String(x.label ?? '').trim().slice(0, 200) || `Question ${i + 1}`,
    type: (FIELD_TYPES.includes(String(x.type)) ? x.type : 'text') as FormField['type'],
    required: !!x.required,
    options: Array.isArray(x.options) ? x.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 50) : [],
    helpText: String(x.helpText ?? '').slice(0, 300),
  }));
}

function cleanTickets(ctx: Ctx, raw: unknown, existing: TicketType[] = []): TicketType[] {
  if (!Array.isArray(raw)) return existing;
  return raw.slice(0, 20).map((x: Record<string, unknown>) => ({
    id: String(x.id || ctx.id('tt')),
    name: String(x.name ?? '').trim().slice(0, 80) || 'Ticket',
    price: Math.max(0, Math.round(Number(x.price) || 0)),
    capacity: x.capacity ? Math.max(1, Math.round(Number(x.capacity))) : null,
  }));
}

function cleanForm(ctx: Ctx, body: Record<string, unknown>, existing?: Form): Partial<FormInput> {
  const input = pick<FormInput>(body, ['title', 'description', 'eventId', 'capacity', 'waitlist', 'opensAt', 'closesAt', 'status', 'isPublic', 'addTag', 'addToGroupId', 'workflowId', 'confirmationMessage']);
  if (body.fields !== undefined) input.fields = cleanFields(body.fields);
  if (body.ticketTypes !== undefined) input.ticketTypes = cleanTickets(ctx, body.ticketTypes, existing?.ticketTypes);
  if (body.discountCodes !== undefined && Array.isArray(body.discountCodes)) {
    const used = new Map((existing?.discountCodes ?? []).map((d) => [d.code, d.used]));
    input.discountCodes = body.discountCodes.slice(0, 50).map((d: Record<string, unknown>) => {
      const code = String(d.code ?? '').trim().toUpperCase().replace(/\s+/g, '').slice(0, 30);
      return {
        code,
        percentOff: d.percentOff ? Math.min(100, Math.max(1, Math.round(Number(d.percentOff)))) : null,
        amountOff: !d.percentOff && d.amountOff ? Math.max(1, Math.round(Number(d.amountOff))) : null,
        maxUses: d.maxUses ? Math.max(1, Math.round(Number(d.maxUses))) : null,
        used: used.get(code) ?? 0,
      };
    }).filter((d) => d.code);
  }
  if (input.status && !['draft', 'open', 'closed'].includes(input.status)) throw new ApiError(422, 'invalid', 'Unknown form status.');
  if (input.eventId) find(ctx, 'events', input.eventId, 'Event');
  if (input.addToGroupId) find(ctx, 'groups', input.addToGroupId, 'Group');
  if (input.workflowId) find(ctx, 'workflows', input.workflowId, 'Workflow');
  for (const k of ['opensAt', 'closesAt'] as const) if (input[k]) input[k] = new Date(String(input[k])).toISOString();
  if (input.capacity !== undefined) input.capacity = input.capacity ? Math.max(1, Math.round(Number(input.capacity))) : null;
  if (input.addTag !== undefined) input.addTag = String(input.addTag ?? '').trim() || null;
  return input;
}

function cleanAnswers(form: Form, raw: Record<string, unknown>) {
  const answers: Record<string, FormAnswer> = {};
  const errors: Record<string, string> = {};
  for (const f of form.fields) {
    let v = raw?.[f.id] as FormAnswer | undefined;
    if (f.type === 'checkbox') v = !!v;
    else if (f.type === 'multiselect') v = Array.isArray(v) ? v.map(String).filter((o) => f.options.includes(o)) : [];
    else if (f.type === 'number') v = v === '' || v === null || v === undefined ? null : Number(v);
    else v = v === undefined || v === null ? '' : String(v).trim().slice(0, 4000);
    const empty = v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0);
    if (f.required && empty) errors[f.id] = 'Required';
    else if (!empty && f.type === 'select' && f.options.length && !f.options.includes(String(v))) errors[f.id] = 'Choose one of the options';
    else if (!empty && f.type === 'number' && !Number.isFinite(v as number)) errors[f.id] = 'Enter a number';
    else if (!empty && f.type === 'email' && !/^\S+@\S+\.\S+$/.test(String(v))) errors[f.id] = 'Enter a valid email';
    else if (!empty && f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) errors[f.id] = 'Enter a date';
    answers[f.id] = v;
  }
  if (Object.keys(errors).length) throw new ApiError(422, 'invalid', 'Please check the highlighted answers.', errors);
  return answers;
}

// ----- submitting -----

function applyDiscount(form: Form, code: string | undefined, amount: number) {
  if (!code) return { amount, code: null };
  const c = form.discountCodes.find((d) => d.code === code.trim().toUpperCase());
  if (!c) throw new ApiError(422, 'invalid', 'That discount code is not valid.', { discountCode: 'Not valid' });
  if (c.maxUses && c.used >= c.maxUses) throw new ApiError(422, 'invalid', 'That discount code has been used up.', { discountCode: 'Used up' });
  const off = c.percentOff ? Math.round((amount * c.percentOff) / 100) : (c.amountOff ?? 0);
  return { amount: Math.max(0, amount - off), code: c.code };
}

export async function submitForm(ctx: Ctx, form: Form, signedInId: string | null, body: Record<string, unknown>): Promise<FormSubmitResult> {
  const reason = closedReason(ctx, form);
  if (reason) throw new ApiError(409, 'closed', reason);
  const me = signedInId ? find(ctx, 'people', signedInId, 'Profile') : null;
  if (!me) {
    requireFields(body, ['name', 'email']);
    if (!/^\S+@\S+\.\S+$/.test(String(body.email))) throw new ApiError(422, 'invalid', 'Enter a valid email.', { email: 'Enter a valid email' });
  }
  const answers = cleanAnswers(form, (body.answers ?? {}) as Record<string, unknown>);

  // Tickets: at least one when the form sells them.
  let tickets: FormResponse['tickets'] = [];
  if (form.ticketTypes.length) {
    const raw = Array.isArray(body.tickets) ? body.tickets : [];
    tickets = raw
      .map((t: Record<string, unknown>) => ({ ticketTypeId: String(t.ticketTypeId), qty: Math.min(20, Math.max(0, Math.round(Number(t.qty) || 0))) }))
      .filter((t) => t.qty > 0 && form.ticketTypes.some((tt) => tt.id === t.ticketTypeId));
    if (!tickets.length) throw new ApiError(422, 'invalid', 'Choose at least one ticket.', { tickets: 'Required' });
  }

  // Capacity, overall and per ticket type. Over capacity goes to the waitlist when allowed.
  const want = placesOf({ tickets });
  let full = !!form.capacity && usedPlaces(ctx, form) + want > form.capacity;
  for (const t of tickets) {
    const tt = form.ticketTypes.find((x) => x.id === t.ticketTypeId)!;
    if (tt.capacity && usedPlaces(ctx, form, tt.id) + t.qty > tt.capacity) full = true;
  }
  if (full && !form.waitlist) throw new ApiError(409, 'full', 'Sorry, there are not enough places left.');

  const gross = tickets.reduce((s, t) => s + form.ticketTypes.find((x) => x.id === t.ticketTypeId)!.price * t.qty, 0);
  const priced = applyDiscount(form, body.discountCode ? String(body.discountCode) : undefined, gross);
  const person = me ?? matchOrCreatePerson(ctx, { name: String(body.name), email: String(body.email), phone: body.phone ? String(body.phone) : null });

  const response = ctx.db.put('formResponses', {
    id: ctx.id('fr'),
    formId: form.id,
    personId: person.id,
    name: me ? fullName(me) : String(body.name).trim().slice(0, 120),
    email: me ? me.email : normEmail(String(body.email)),
    phone: me ? me.phone : body.phone ? String(body.phone).trim().slice(0, 20) : null,
    answers,
    tickets,
    amount: priced.amount,
    discountCode: priced.code,
    status: full ? 'waitlisted' : priced.amount > 0 ? 'pending_payment' : 'confirmed',
    donationId: null,
    createdAt: ctx.now.toISOString(),
  });

  if (response.status === 'waitlisted') return { response, checkoutUrl: null, message: "You're on the waitlist. We'll let you know if a place opens up." };
  if (response.status === 'confirmed') {
    onConfirmed(ctx, response);
    return { response: ctx.db.get('formResponses', response.id)!, checkoutUrl: null, message: form.confirmationMessage || "You're registered. See you there!" };
  }
  const checkoutUrl = await startPayment(ctx, form, response);
  const latest = ctx.db.get('formResponses', response.id)!;
  return { response: latest, checkoutUrl: latest.status === 'confirmed' ? null : checkoutUrl, message: latest.status === 'confirmed' ? form.confirmationMessage || "You're registered. See you there!" : 'Complete your payment to confirm your place.' };
}

async function startPayment(ctx: Ctx, form: Form, r: FormResponse) {
  const fund = ensureEventFund(ctx);
  const s = settings(ctx);
  const d: Collections['donations'] = {
    id: ctx.id('dn'),
    donorId: r.personId,
    donorName: r.name,
    donorEmail: r.email,
    donorPhone: r.phone,
    fundId: fund.id,
    fundName: `Registration: ${form.title}`,
    amount: r.amount,
    currency: s.currency,
    frequency: 'once',
    status: 'pending',
    method: null,
    pan: null,
    donorCitizenship: 'IN',
    fcra: false,
    provider: 'demo',
    providerRef: null,
    providerPaymentId: null,
    createdAt: ctx.now.toISOString(),
    paidAt: null,
    eventId: form.eventId,
    receiptNumber: null,
    formResponseId: r.id,
  };
  const co = await ctx.env.checkout(d, { description: `${form.title} · ${s.name}`, fundTaxDeductible: false });
  ctx.db.put('formResponses', { ...r, donationId: d.id });
  const saved = ctx.db.put('donations', { ...d, providerRef: co.providerRef, provider: co.provider, status: co.status ?? 'pending', paidAt: co.status === 'succeeded' ? ctx.now.toISOString() : null, method: co.status === 'succeeded' ? 'upi' : null });
  if (saved.status === 'succeeded') onDonationSucceeded(ctx, saved);
  return co.checkoutUrl;
}

/** Runs once when a registration becomes confirmed: tags, group, RSVP, workflow, discount use, email. */
function onConfirmed(ctx: Ctx, r: FormResponse) {
  const form = ctx.db.get('forms', r.formId);
  if (!form) return;
  if (r.discountCode) ctx.db.put('forms', { ...form, discountCodes: form.discountCodes.map((d) => (d.code === r.discountCode ? { ...d, used: d.used + 1 } : d)) });
  const person = ctx.db.get('people', r.personId);
  if (!person) return;
  if (form.addTag && !person.tags.includes(form.addTag)) ctx.db.put('people', { ...person, tags: [...person.tags, form.addTag] });
  if (form.addToGroupId && ctx.db.get('groups', form.addToGroupId)) addMember(ctx, form.addToGroupId, person.id);
  if (form.eventId && !ctx.db.all('rsvps').some((x) => x.eventId === form.eventId && x.personId === person.id))
    ctx.db.put('rsvps', { id: ctx.id('rv'), eventId: form.eventId, personId: person.id, at: ctx.now.toISOString() });
  if (form.workflowId) startWorkflow(ctx, form.workflowId, person.id, 'Registered via a form');
  for (const w of ctx.db.all('workflows')) if (w.active && w.trigger === 'form' && w.triggerId === form.id && w.id !== form.workflowId) startWorkflow(ctx, w.id, person.id, 'Registered via a form');
  if (r.email) {
    const s = settings(ctx);
    const lines = [`Hi ${r.name.split(' ')[0]},`, '', form.confirmationMessage || `You're registered for ${form.title}.`];
    if (r.tickets.length) lines.push('', ...r.tickets.map((t) => `${t.qty} × ${form.ticketTypes.find((x) => x.id === t.ticketTypeId)?.name ?? 'Ticket'}`));
    if (r.amount) lines.push(`Paid: ${money(ctx, r.amount)}`);
    lines.push('', s.name);
    void ctx.env.deliver('email', [{ to: r.email, name: r.name, subject: `Registered: ${form.title}`, text: lines.join('\n') }]).catch(() => undefined);
  }
}

/** Called from onDonationSucceeded when a registration payment arrives. */
export function onFormPaid(ctx: Ctx, d: Collections['donations']) {
  const r = d.formResponseId ? ctx.db.get('formResponses', d.formResponseId) : undefined;
  if (!r || r.status === 'confirmed') return;
  const next = ctx.db.put('formResponses', { ...r, status: 'confirmed', donationId: d.id });
  onConfirmed(ctx, next);
}

/** When a place frees up on a free form, the longest-waiting person gets it. */
function promoteWaitlist(ctx: Ctx, form: Form) {
  const waiting = responsesOf(ctx, form.id).filter((r) => r.status === 'waitlisted' && r.amount === 0).sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  for (const r of waiting) {
    if (form.capacity && usedPlaces(ctx, form) + placesOf(r) > form.capacity) break;
    const next = ctx.db.put('formResponses', { ...r, status: 'confirmed' });
    onConfirmed(ctx, next);
  }
}

function cancel(ctx: Ctx, r: FormResponse) {
  const next = ctx.db.put('formResponses', { ...r, status: 'cancelled' });
  const form = ctx.db.get('forms', r.formId);
  if (form?.eventId && r.personId) {
    const others = responsesOf(ctx, form.id).some((x) => x.id !== r.id && x.personId === r.personId && x.status === 'confirmed');
    const rv = ctx.db.all('rsvps').find((x) => x.eventId === form.eventId && x.personId === r.personId);
    if (rv && !others) ctx.db.del('rsvps', rv.id);
  }
  if (form) promoteWaitlist(ctx, form);
  return next;
}

export function registerForms(r: Router) {
  // ----- member -----
  r.get('/forms', {}, (ctx) => {
    const me = ctx.me();
    const mine = ctx.db.all('formResponses').filter((x) => x.personId === me && x.status !== 'cancelled');
    return ctx.db
      .all('forms')
      .filter((f) => f.status === 'open' && !closedReason(ctx, f))
      .sort((x, y) => (x.closesAt ?? '9').localeCompare(y.closesAt ?? '9'))
      .map((f) => ({ ...publicForm(ctx, f), myStatus: mine.find((x) => x.formId === f.id)?.status ?? null }));
  });
  r.get('/forms/:id', {}, (ctx) => {
    const me = ctx.me();
    const f = find(ctx, 'forms', ctx.params[0], 'Form');
    if (f.status === 'draft') throw new ApiError(404, 'not_found', 'Form not found.');
    return { ...publicForm(ctx, f), myResponses: responsesOf(ctx, f.id).filter((x) => x.personId === me && x.status !== 'cancelled') };
  });
  r.post('/forms/:id/responses', {}, (ctx) => submitForm(ctx, find(ctx, 'forms', ctx.params[0], 'Form'), ctx.me(), ctx.body));
  r.del('/forms/:id/responses/:rid', {}, (ctx) => {
    const resp = find(ctx, 'formResponses', ctx.params[1], 'Registration');
    if (resp.personId !== ctx.me() || resp.formId !== ctx.params[0]) throw new ApiError(404, 'not_found', 'Registration not found.');
    if (resp.status === 'confirmed' && resp.amount > 0) throw new ApiError(409, 'paid', 'This registration is paid. Contact the church office to cancel and get a refund.');
    cancel(ctx, resp);
    return undefined;
  });

  // ----- public (no sign-in) -----
  const publicOnly = (ctx: Ctx) => {
    const f = find(ctx, 'forms', ctx.params[0], 'Form');
    if (!f.isPublic || f.status === 'draft') throw new ApiError(404, 'not_found', 'Form not found.');
    return f;
  };
  r.get('/public/forms/:id', { public: true }, (ctx) => publicForm(ctx, publicOnly(ctx)));
  r.post('/public/forms/:id/responses', { public: true }, async (ctx) => {
    const result = await submitForm(ctx, publicOnly(ctx), null, ctx.body);
    // Public callers see only their own submission, without internal ids.
    const { personId: _p, donationId: _d, ...response } = result.response;
    return { ...result, response };
  });

  // ----- admin -----
  r.get('/admin/forms', { perm: ['events', 'people.edit'] }, (ctx) =>
    ctx.db.all('forms').sort((x, y) => y.createdAt.localeCompare(x.createdAt)).map((f) => formView(ctx, f)),
  );
  r.post('/admin/forms', { perm: 'events' }, (ctx) => {
    requireFields(ctx.body, ['title']);
    const input = cleanForm(ctx, ctx.body);
    const f = ctx.db.put('forms', {
      title: '',
      description: '',
      eventId: null,
      fields: [],
      ticketTypes: [],
      capacity: null,
      waitlist: true,
      discountCodes: [],
      opensAt: null,
      closesAt: null,
      status: 'draft',
      isPublic: true,
      addTag: null,
      addToGroupId: null,
      workflowId: null,
      confirmationMessage: '',
      ...input,
      id: ctx.id('fm'),
      createdAt: ctx.now.toISOString(),
    });
    ctx.audit('created', 'form', f.id, `Created form “${f.title}”`);
    return formView(ctx, f);
  });
  r.get('/admin/forms/:id', { perm: ['events', 'people.edit'] }, (ctx) => formView(ctx, find(ctx, 'forms', ctx.params[0], 'Form')));
  r.patch('/admin/forms/:id', { perm: 'events' }, (ctx) => {
    const f = find(ctx, 'forms', ctx.params[0], 'Form');
    const next = ctx.db.put('forms', { ...f, ...cleanForm(ctx, ctx.body, f) });
    if (next.capacity !== f.capacity) promoteWaitlist(ctx, next);
    ctx.audit('updated', 'form', f.id, `Updated form “${next.title}”`);
    return formView(ctx, next);
  });
  r.post('/admin/forms/:id/duplicate', { perm: 'events' }, (ctx) => {
    const f = find(ctx, 'forms', ctx.params[0], 'Form');
    const copy = ctx.db.put('forms', { ...f, id: ctx.id('fm'), title: `${f.title} (copy)`, status: 'draft', discountCodes: f.discountCodes.map((d) => ({ ...d, used: 0 })), createdAt: ctx.now.toISOString() });
    return formView(ctx, copy);
  });
  r.del('/admin/forms/:id', { perm: 'events' }, (ctx) => {
    const f = find(ctx, 'forms', ctx.params[0], 'Form');
    const rs = responsesOf(ctx, f.id);
    if (rs.some((x) => x.status === 'confirmed' && x.amount > 0)) throw new ApiError(409, 'has_payments', 'This form has paid registrations. Close it instead of deleting it.');
    for (const x of rs) ctx.db.del('formResponses', x.id);
    ctx.db.del('forms', f.id);
    ctx.audit('deleted', 'form', f.id, `Deleted form “${f.title}”`);
    return undefined;
  });
  r.get('/admin/forms/:id/responses', { perm: ['events', 'people.edit'] }, (ctx) => {
    const f = find(ctx, 'forms', ctx.params[0], 'Form');
    const status = ctx.query.status;
    return responsesOf(ctx, f.id)
      .filter((x) => !status || x.status === status)
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt));
  });
  r.patch('/admin/forms/:id/responses/:rid', { perm: 'events' }, (ctx) => {
    const resp = find(ctx, 'formResponses', ctx.params[1], 'Registration');
    const form = find(ctx, 'forms', resp.formId, 'Form');
    if (ctx.body.status === 'cancelled') {
      const next = cancel(ctx, resp);
      ctx.audit('cancelled', 'form', form.id, `Cancelled ${resp.name}'s registration for “${form.title}”${resp.amount && resp.status === 'confirmed' ? ' (refund separately in Giving)' : ''}`);
      return next;
    }
    if (ctx.body.status === 'confirmed') {
      // Office override, e.g. paid in cash at the desk.
      if (resp.status === 'confirmed') return resp;
      const next = ctx.db.put('formResponses', { ...resp, status: 'confirmed' });
      onConfirmed(ctx, next);
      ctx.audit('confirmed', 'form', form.id, `Confirmed ${resp.name}'s registration for “${form.title}”`);
      return ctx.db.get('formResponses', resp.id);
    }
    if (ctx.body.answers) return ctx.db.put('formResponses', { ...resp, answers: { ...resp.answers, ...cleanAnswers({ ...form, fields: form.fields.map((x) => ({ ...x, required: false })) }, ctx.body.answers) } });
    throw new ApiError(422, 'invalid', 'Nothing to change.');
  });
  r.post('/admin/forms/:id/responses/:rid/promote', { perm: 'events' }, async (ctx) => {
    const resp = find(ctx, 'formResponses', ctx.params[1], 'Registration');
    const form = find(ctx, 'forms', resp.formId, 'Form');
    if (resp.status !== 'waitlisted') throw new ApiError(409, 'not_waitlisted', 'This person is not on the waitlist.');
    if (resp.amount === 0) {
      const next = ctx.db.put('formResponses', { ...resp, status: 'confirmed' });
      onConfirmed(ctx, next);
      return { response: ctx.db.get('formResponses', resp.id), checkoutUrl: null };
    }
    const pending = ctx.db.put('formResponses', { ...resp, status: 'pending_payment', createdAt: ctx.now.toISOString() });
    const checkoutUrl = await startPayment(ctx, form, pending);
    const latest = ctx.db.get('formResponses', resp.id)!;
    if (latest.status !== 'confirmed' && latest.email)
      void ctx.env.deliver('email', [{ to: latest.email, name: latest.name, subject: `A place opened up: ${form.title}`, text: `Hi ${latest.name.split(' ')[0]},\n\nA place has opened up for ${form.title}. Pay here within 30 minutes to confirm it:\n${checkoutUrl}\n\n${settings(ctx).name}` }]).catch(() => undefined);
    return { response: latest, checkoutUrl };
  });
}
