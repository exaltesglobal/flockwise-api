// People power tools: custom fields on profiles, smart lists that update themselves from
// rules, and follow-up workflows (step-by-step boards for new visitors, baptism classes...).
import { ApiError } from '../errors.js';
import type { Ctx, Router } from '../engine.js';
import type { Collections, CustomField, ListRule, SmartList, SmartListView, Workflow, WorkflowCard, WorkflowCardView, WorkflowStep, WorkflowView } from '../types.js';
import { age, DAY, find, fullName, giftDate, page, personView, pick, requireFields } from '../util.js';

// ----- custom fields -----

const FIELD_TYPES = ['text', 'number', 'date', 'select', 'checkbox'];

/** Keeps only known custom fields, coerced to their type. */
export function cleanCustom(ctx: Ctx, raw: unknown): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!raw || typeof raw !== 'object') return out;
  const fields = new Map(ctx.db.all('customFields').map((f) => [f.id, f]));
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const f = fields.get(k);
    if (!f) continue;
    if (v === null || v === '' || v === undefined) out[k] = null;
    else if (f.type === 'number') out[k] = Number.isFinite(Number(v)) ? Number(v) : null;
    else if (f.type === 'checkbox') out[k] = !!v;
    else if (f.type === 'select') out[k] = f.options.includes(String(v)) ? String(v) : null;
    else out[k] = String(v).slice(0, 1000);
  }
  return out;
}

// ----- smart lists -----

function within(iso: string | null | undefined, days: number, now: Date) {
  return !!iso && now.getTime() - new Date(iso).getTime() <= days * DAY;
}

function compare(op: ListRule['op'], actual: number | null, target: number) {
  if (actual === null) return op === 'empty';
  if (op === 'gt') return actual > target;
  if (op === 'lt') return actual < target;
  if (op === 'is') return actual === target;
  if (op === 'is_not') return actual !== target;
  return op === 'not_empty';
}

function ruleMatcher(ctx: Ctx, rule: ListRule): (p: Collections['people']) => boolean {
  const v = String(rule.value ?? '').trim();
  const n = Number(v) || 0;
  const neg = rule.op === 'is_not' || rule.op === 'not_within';
  const set = (ids: Iterable<string>) => {
    const s = new Set(ids);
    return (p: Collections['people']) => s.has(p.id) !== neg;
  };
  switch (rule.field) {
    case 'status':
      return (p) => (p.status === v) !== neg;
    case 'gender':
      return (p) => (p.gender === v) !== neg;
    case 'campus':
      return (p) => (p.campusId === v) !== neg;
    case 'tag':
      return (p) => (rule.op === 'empty' ? p.tags.length === 0 : rule.op === 'not_empty' ? p.tags.length > 0 : p.tags.includes(v) !== neg);
    case 'hasEmail':
      return (p) => !!p.email === (v !== 'false');
    case 'hasPhone':
      return (p) => !!p.phone === (v !== 'false');
    case 'age':
      return (p) => compare(rule.op, age(p.birthDate, ctx.now), n);
    case 'birthdayMonth':
      return (p) => (!!p.birthDate && Number(p.birthDate.slice(5, 7)) === n) !== neg;
    case 'joinedDays':
      return (p) => within(p.joinedAt, n, ctx.now) !== neg;
    case 'lastAttendedDays':
      return (p) => (rule.op === 'empty' ? !p.lastAttendedAt : within(p.lastAttendedAt, n, ctx.now) !== neg);
    case 'group':
      return set(ctx.db.all('groupMembers').filter((m) => !v || m.groupId === v).map((m) => m.personId));
    case 'team':
      return set(ctx.db.all('teams').filter((t) => !v || t.id === v).flatMap((t) => t.members.map((m) => m.personId)));
    case 'gaveDays': {
      const donors = ctx.db.all('donations').filter((d) => d.status === 'succeeded' && d.donorId && !d.eventId && !d.formResponseId && within(giftDate(d), n, ctx.now));
      return set(donors.map((d) => d.donorId!));
    }
    case 'formResponse':
      return set(ctx.db.all('formResponses').filter((r) => r.formId === v && r.status !== 'cancelled' && r.personId).map((r) => r.personId!));
    case 'workflow':
      return set(ctx.db.all('workflowCards').filter((c) => c.workflowId === v && c.status === 'active').map((c) => c.personId));
    case 'custom': {
      const id = rule.customFieldId ?? '';
      return (p) => {
        const val = p.custom?.[id];
        const empty = val === null || val === undefined || val === '';
        if (rule.op === 'empty') return empty;
        if (rule.op === 'not_empty') return !empty;
        if (rule.op === 'gt' || rule.op === 'lt') return !empty && (rule.op === 'gt' ? Number(val) > n : Number(val) < n);
        if (rule.op === 'contains') return !empty && String(val).toLowerCase().includes(v.toLowerCase());
        return (String(val ?? '') === v) !== neg;
      };
    }
  }
  return () => false;
}

export function listMembers(ctx: Ctx, list: Pick<SmartList, 'rules' | 'match'>): Collections['people'][] {
  const matchers = list.rules.map((r) => ruleMatcher(ctx, r));
  const people = ctx.db.all('people').filter((p) => p.status !== 'inactive' || list.rules.some((r) => r.field === 'status' && r.value === 'inactive'));
  if (!matchers.length) return people;
  return people.filter((p) => (list.match === 'any' ? matchers.some((m) => m(p)) : matchers.every((m) => m(p))));
}

function cleanRules(raw: unknown): ListRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 20).map((r: Record<string, unknown>) => ({
    field: String(r.field) as ListRule['field'],
    op: (String(r.op || 'is')) as ListRule['op'],
    value: String(r.value ?? ''),
    ...(r.customFieldId ? { customFieldId: String(r.customFieldId) } : {}),
  }));
}

const listView = (ctx: Ctx, l: SmartList): SmartListView => ({ ...l, count: listMembers(ctx, l).length });

// ----- workflows -----

const staffName = (ctx: Ctx, id: string | null) => (id ? ctx.db.get('staff', id)?.name ?? null : null);

function dueFor(ctx: Ctx, w: Workflow, stepIndex: number) {
  return new Date(ctx.now.getTime() + (w.steps[stepIndex]?.dueDays ?? 0) * DAY).toISOString();
}

function cardView(ctx: Ctx, c: WorkflowCard): WorkflowCardView {
  const w = ctx.db.get('workflows', c.workflowId);
  const p = ctx.db.get('people', c.personId);
  return {
    ...c,
    personName: p ? fullName(p) : 'Removed person',
    personPhone: p?.phone ?? null,
    stepTitle: w?.steps[c.stepIndex]?.title ?? (c.status === 'done' ? 'Done' : ''),
    workflowName: w?.name ?? '',
    assigneeName: staffName(ctx, c.assignedTo),
    overdue: c.status === 'active' && c.dueAt < ctx.now.toISOString(),
  };
}

function workflowView(ctx: Ctx, w: Workflow): WorkflowView {
  const cards = ctx.db.all('workflowCards').filter((c) => c.workflowId === w.id);
  const active = cards.filter((c) => c.status === 'active');
  return {
    ...w,
    active_cards: active.length,
    done_cards: cards.filter((c) => c.status === 'done').length,
    overdue: active.filter((c) => c.dueAt < ctx.now.toISOString()).length,
    stepCounts: w.steps.map((_, i) => active.filter((c) => c.stepIndex === i).length),
  };
}

/** Adds a person to a workflow at its first step, unless they are already on it. */
export function startWorkflow(ctx: Ctx, workflowId: string, personId: string, note = '') {
  const w = ctx.db.get('workflows', workflowId);
  if (!w || !w.steps.length) return null;
  const existing = ctx.db.all('workflowCards').find((c) => c.workflowId === w.id && c.personId === personId && c.status === 'active');
  if (existing) return existing;
  return ctx.db.put('workflowCards', {
    id: ctx.id('wc'),
    workflowId: w.id,
    personId,
    stepIndex: 0,
    status: 'active',
    assignedTo: w.steps[0].assigneeId ?? w.defaultAssigneeId,
    dueAt: dueFor(ctx, w, 0),
    createdAt: ctx.now.toISOString(),
    completedAt: null,
    history: [{ at: ctx.now.toISOString(), by: ctx.staff?.name ?? 'Flockwise', action: 'added', note }],
  });
}

/** Runs workflows set to start automatically for a trigger (e.g. a new visitor). */
export function triggerWorkflows(ctx: Ctx, trigger: Workflow['trigger'], personId: string, triggerId: string | null = null) {
  for (const w of ctx.db.all('workflows')) if (w.active && w.trigger === trigger && (trigger !== 'form' || w.triggerId === triggerId)) startWorkflow(ctx, w.id, personId, `Started automatically (${trigger.replace('_', ' ')})`);
}

/** Smart-list workflows pick up anyone newly matching the list. Called from the scheduler. */
export function runListWorkflows(ctx: Ctx) {
  for (const w of ctx.db.all('workflows')) {
    if (!w.active || w.trigger !== 'list' || !w.triggerId) continue;
    const list = ctx.db.get('smartLists', w.triggerId);
    if (!list) continue;
    const seen = new Set(ctx.db.all('workflowCards').filter((c) => c.workflowId === w.id).map((c) => c.personId));
    for (const p of listMembers(ctx, list)) if (!seen.has(p.id)) startWorkflow(ctx, w.id, p.id, `Matched “${list.name}”`);
  }
}

function cleanSteps(ctx: Ctx, raw: unknown, existing: WorkflowStep[] = []): WorkflowStep[] {
  if (!Array.isArray(raw)) return existing;
  const steps = raw.slice(0, 20).map((s: Record<string, unknown>) => ({
    id: String(s.id || ctx.id('ws')),
    title: String(s.title ?? '').trim().slice(0, 120),
    dueDays: Math.max(0, Math.min(365, Math.round(Number(s.dueDays) || 0))),
    assigneeId: s.assigneeId ? String(s.assigneeId) : null,
  })).filter((s) => s.title);
  if (!steps.length) throw new ApiError(422, 'invalid', 'Add at least one step.', { steps: 'Required' });
  return steps;
}

function cleanWorkflow(ctx: Ctx, body: Record<string, unknown>, existing?: Workflow): Partial<Workflow> {
  const input = pick<Workflow>(body, ['name', 'description', 'trigger', 'triggerId', 'defaultAssigneeId', 'active']);
  if (body.steps !== undefined) input.steps = cleanSteps(ctx, body.steps, existing?.steps);
  if (input.trigger && !['manual', 'new_visitor', 'form', 'list'].includes(input.trigger)) throw new ApiError(422, 'invalid', 'Unknown trigger.');
  if (input.trigger === 'manual' || input.trigger === 'new_visitor') input.triggerId = null;
  return input;
}

export function registerWorkflows(r: Router) {
  // ----- custom fields -----
  r.get('/admin/people-fields', { perm: 'people.view' }, (ctx) => ctx.db.all('customFields').sort((x, y) => x.order - y.order));
  r.post('/admin/people-fields', { perm: 'settings' }, (ctx) => {
    requireFields(ctx.body, ['label']);
    const type = FIELD_TYPES.includes(ctx.body.type) ? ctx.body.type : 'text';
    const f: CustomField = {
      id: ctx.id('cf'),
      label: String(ctx.body.label).trim().slice(0, 80),
      type,
      options: Array.isArray(ctx.body.options) ? ctx.body.options.map(String).map((s: string) => s.trim()).filter(Boolean) : [],
      order: ctx.db.count('customFields'),
    };
    ctx.audit('created', 'settings', f.id, `Added the custom field “${f.label}”`);
    return ctx.db.put('customFields', f);
  });
  r.patch('/admin/people-fields/:id', { perm: 'settings' }, (ctx) => {
    const f = find(ctx, 'customFields', ctx.params[0], 'Field');
    const patch = pick<CustomField>(ctx.body, ['label', 'options', 'order']);
    if (patch.options) patch.options = (patch.options as unknown[]).map(String).filter(Boolean);
    return ctx.db.put('customFields', { ...f, ...patch });
  });
  r.del('/admin/people-fields/:id', { perm: 'settings' }, (ctx) => {
    const f = find(ctx, 'customFields', ctx.params[0], 'Field');
    ctx.db.del('customFields', f.id);
    for (const p of ctx.db.all('people')) if (p.custom && f.id in p.custom) {
      const { [f.id]: _gone, ...rest } = p.custom;
      ctx.db.put('people', { ...p, custom: rest });
    }
    ctx.audit('deleted', 'settings', f.id, `Removed the custom field “${f.label}”`);
    return undefined;
  });

  // ----- smart lists -----
  r.get('/admin/lists', { perm: 'people.view' }, (ctx) => ctx.db.all('smartLists').sort((x, y) => x.name.localeCompare(y.name)).map((l) => listView(ctx, l)));
  r.post('/admin/lists/preview', { perm: 'people.view' }, (ctx) => {
    const people = listMembers(ctx, { rules: cleanRules(ctx.body.rules), match: ctx.body.match === 'any' ? 'any' : 'all' });
    return { count: people.length, sample: people.slice(0, 8).map((p) => ({ id: p.id, name: fullName(p) })) };
  });
  r.post('/admin/lists', { perm: 'people.view' }, (ctx) => {
    requireFields(ctx.body, ['name']);
    const l = ctx.db.put('smartLists', {
      id: ctx.id('sl'),
      name: String(ctx.body.name).trim().slice(0, 80),
      description: String(ctx.body.description ?? ''),
      match: ctx.body.match === 'any' ? 'any' : 'all',
      rules: cleanRules(ctx.body.rules),
      createdAt: ctx.now.toISOString(),
      createdBy: ctx.staff?.name ?? '',
    });
    ctx.audit('created', 'list', l.id, `Created the list “${l.name}”`);
    return listView(ctx, l);
  });
  r.patch('/admin/lists/:id', { perm: 'people.view' }, (ctx) => {
    const l = find(ctx, 'smartLists', ctx.params[0], 'List');
    const patch = pick<SmartList>(ctx.body, ['name', 'description', 'match']);
    if (ctx.body.rules !== undefined) patch.rules = cleanRules(ctx.body.rules);
    return listView(ctx, ctx.db.put('smartLists', { ...l, ...patch }));
  });
  r.del('/admin/lists/:id', { perm: 'people.view' }, (ctx) => {
    const l = find(ctx, 'smartLists', ctx.params[0], 'List');
    ctx.db.del('smartLists', l.id);
    return undefined;
  });
  r.get('/admin/lists/:id/people', { perm: 'people.view' }, (ctx) => {
    const l = find(ctx, 'smartLists', ctx.params[0], 'List');
    const people = listMembers(ctx, l).sort((x, y) => x.lastName.localeCompare(y.lastName) || x.firstName.localeCompare(y.firstName));
    const res = page(people, ctx.query.cursor, 100);
    return { ...res, data: res.data.map((p) => personView(ctx, p)), list: listView(ctx, l) };
  });

  // ----- workflows -----
  r.get('/admin/workflows', { perm: ['people.view', 'care'] }, (ctx) => ctx.db.all('workflows').sort((x, y) => x.name.localeCompare(y.name)).map((w) => workflowView(ctx, w)));
  r.post('/admin/workflows', { perm: 'people.edit' }, (ctx) => {
    requireFields(ctx.body, ['name']);
    const w = ctx.db.put('workflows', {
      name: '',
      description: '',
      steps: [],
      trigger: 'manual',
      triggerId: null,
      defaultAssigneeId: ctx.staff?.id ?? null,
      active: true,
      ...cleanWorkflow(ctx, ctx.body),
      id: ctx.id('wf'),
      createdAt: ctx.now.toISOString(),
    });
    if (!w.steps.length) throw new ApiError(422, 'invalid', 'Add at least one step.', { steps: 'Required' });
    ctx.audit('created', 'workflow', w.id, `Created the workflow “${w.name}”`);
    return workflowView(ctx, w);
  });
  r.get('/admin/workflows/:id', { perm: ['people.view', 'care'] }, (ctx) => {
    const w = find(ctx, 'workflows', ctx.params[0], 'Workflow');
    const show = ctx.query.status ?? 'active';
    const cards = ctx.db.all('workflowCards').filter((c) => c.workflowId === w.id && (show === 'all' || c.status === show)).sort((x, y) => x.dueAt.localeCompare(y.dueAt));
    return { workflow: workflowView(ctx, w), cards: cards.map((c) => cardView(ctx, c)) };
  });
  r.patch('/admin/workflows/:id', { perm: 'people.edit' }, (ctx) => {
    const w = find(ctx, 'workflows', ctx.params[0], 'Workflow');
    const next = ctx.db.put('workflows', { ...w, ...cleanWorkflow(ctx, ctx.body, w) });
    // Cards past the last step after steps were removed move to the last step.
    for (const c of ctx.db.all('workflowCards')) if (c.workflowId === w.id && c.status === 'active' && c.stepIndex >= next.steps.length) ctx.db.put('workflowCards', { ...c, stepIndex: next.steps.length - 1 });
    return workflowView(ctx, next);
  });
  r.del('/admin/workflows/:id', { perm: 'people.edit' }, (ctx) => {
    const w = find(ctx, 'workflows', ctx.params[0], 'Workflow');
    for (const c of ctx.db.all('workflowCards')) if (c.workflowId === w.id) ctx.db.del('workflowCards', c.id);
    ctx.db.del('workflows', w.id);
    ctx.audit('deleted', 'workflow', w.id, `Deleted the workflow “${w.name}”`);
    return undefined;
  });
  r.post('/admin/workflows/:id/cards', { perm: ['people.edit', 'care'] }, (ctx) => {
    const w = find(ctx, 'workflows', ctx.params[0], 'Workflow');
    let ids: string[] = Array.isArray(ctx.body.personIds) ? ctx.body.personIds.map(String) : [];
    if (ctx.body.listId) ids = [...ids, ...listMembers(ctx, find(ctx, 'smartLists', String(ctx.body.listId), 'List')).map((p) => p.id)];
    const added = [...new Set(ids)].filter((id) => ctx.db.get('people', id)).map((id) => startWorkflow(ctx, w.id, id, String(ctx.body.note ?? ''))).filter(Boolean);
    ctx.audit('updated', 'workflow', w.id, `Added ${added.length} ${added.length === 1 ? 'person' : 'people'} to “${w.name}”`);
    return { added: added.length };
  });
  r.get('/admin/workflow-cards', { perm: ['people.view', 'care'] }, (ctx) => {
    const mine = ctx.query.mine === 'true';
    const personId = ctx.query.personId;
    return ctx.db
      .all('workflowCards')
      .filter((c) => (personId ? c.personId === personId : c.status === 'active' && (!mine || c.assignedTo === ctx.staff?.id)))
      .sort((x, y) => x.dueAt.localeCompare(y.dueAt))
      .map((c) => cardView(ctx, c));
  });
  r.patch('/admin/workflow-cards/:id', { perm: ['people.edit', 'care'] }, (ctx) => {
    const c = find(ctx, 'workflowCards', ctx.params[0], 'Card');
    const w = find(ctx, 'workflows', c.workflowId, 'Workflow');
    const action = String(ctx.body.action ?? '');
    const note = String(ctx.body.note ?? '').slice(0, 1000);
    const by = ctx.staff?.name ?? 'Staff';
    let next: WorkflowCard = { ...c };
    if (action === 'advance') {
      if (c.stepIndex + 1 >= w.steps.length) next = { ...c, status: 'done', completedAt: ctx.now.toISOString() };
      else next = { ...c, stepIndex: c.stepIndex + 1, dueAt: dueFor(ctx, w, c.stepIndex + 1), assignedTo: w.steps[c.stepIndex + 1].assigneeId ?? c.assignedTo };
    } else if (action === 'back') {
      next = { ...c, status: 'active', completedAt: null, stepIndex: Math.max(0, c.status === 'done' ? c.stepIndex : c.stepIndex - 1) };
    } else if (action === 'done') next = { ...c, status: 'done', completedAt: ctx.now.toISOString() };
    else if (action === 'remove') next = { ...c, status: 'removed', completedAt: ctx.now.toISOString() };
    else if (action === 'snooze') next = { ...c, dueAt: new Date(new Date(c.dueAt).getTime() + Math.max(1, Number(ctx.body.days) || 7) * DAY).toISOString() };
    else if (action === 'assign') next = { ...c, assignedTo: ctx.body.assignedTo ? find(ctx, 'staff', String(ctx.body.assignedTo), 'Team member').id : null };
    else if (action !== 'note') throw new ApiError(422, 'invalid', 'Unknown action.');
    next.history = [...c.history, { at: ctx.now.toISOString(), by, action, note }];
    return cardView(ctx, ctx.db.put('workflowCards', next));
  });
}
