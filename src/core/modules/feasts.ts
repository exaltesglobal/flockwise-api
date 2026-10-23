// Love-feast and kitchen planner: pick the event, pick a menu (biryani lunch, tea and snacks,
// South Indian meal, or your own), and the RSVP count turns into a shopping list with quantities
// and an estimated cost, split per head or per family if the church is not paying.
import type { Ctx, Router } from '../engine.js';
import { ApiError } from '../errors.js';
import type { Feast, FeastDish, FeastIngredient, FeastSplit, FeastTemplate, FeastUnit, FeastView, FeastsHub, ShoppingItem } from '../types.js';
import { find, fullName, money, rsvpsFor } from '../util.js';
import { familyKey } from './zones.js';

const UNITS: FeastUnit[] = ['kg', 'g', 'l', 'ml', 'pcs', 'bunch', 'packet'];
const SPLITS: FeastSplit[] = ['church', 'per_head', 'per_family'];
const clean = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
const num = (v: unknown, fallback = 0) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : fallback; };

const ing = (name: string, perHead: number, unit: FeastUnit, rupeesPerUnit: number): FeastIngredient => ({ name, perHead, unit, costPerUnit: Math.round(rupeesPerUnit * 100) });
export const FEAST_TEMPLATES: FeastTemplate[] = [
  {
    id: 'biryani', name: 'Chicken biryani lunch', description: 'Biryani, raita, a sweet, and plates. The usual Sunday love feast.',
    dishes: [
      { name: 'Chicken biryani', ingredients: [ing('Basmati rice', 0.12, 'kg', 110), ing('Chicken', 0.2, 'kg', 240), ing('Onions', 0.06, 'kg', 40), ing('Tomatoes', 0.03, 'kg', 40), ing('Ginger-garlic paste', 0.01, 'kg', 220), ing('Biryani masala', 0.006, 'kg', 650), ing('Cooking oil', 0.02, 'l', 140), ing('Ghee', 0.005, 'kg', 620), ing('Mint and coriander', 0.03, 'bunch', 10), ing('Green chillies', 0.005, 'kg', 80)] },
      { name: 'Onion raita', ingredients: [ing('Curd', 0.06, 'kg', 80), ing('Onions', 0.02, 'kg', 40)] },
      { name: 'Gulab jamun', ingredients: [ing('Gulab jamun', 2, 'pcs', 8)] },
      { name: 'Plates and water', ingredients: [ing('Paper plates', 1.1, 'pcs', 2.5), ing('Spoons', 1.1, 'pcs', 1), ing('Water cans (20 l)', 0.03, 'pcs', 50)] },
    ],
  },
  {
    id: 'southmeal', name: 'South Indian meal', description: 'Rice, sambar, a vegetable curry, chicken curry, curd and pickle on banana leaf or plate.',
    dishes: [
      { name: 'Rice', ingredients: [ing('Rice (sona masoori)', 0.15, 'kg', 60)] },
      { name: 'Sambar', ingredients: [ing('Toor dal', 0.03, 'kg', 150), ing('Mixed vegetables', 0.05, 'kg', 50), ing('Sambar powder', 0.004, 'kg', 400), ing('Tamarind', 0.005, 'kg', 200), ing('Onions', 0.02, 'kg', 40), ing('Tomatoes', 0.02, 'kg', 40)] },
      { name: 'Chicken curry', ingredients: [ing('Chicken', 0.18, 'kg', 240), ing('Onions', 0.04, 'kg', 40), ing('Tomatoes', 0.03, 'kg', 40), ing('Ginger-garlic paste', 0.008, 'kg', 220), ing('Chilli and coriander powder', 0.006, 'kg', 350), ing('Cooking oil', 0.015, 'l', 140), ing('Coconut', 0.1, 'pcs', 35)] },
      { name: 'Curd, pickle and papad', ingredients: [ing('Curd', 0.05, 'kg', 80), ing('Pickle', 0.01, 'kg', 250), ing('Papad', 1, 'pcs', 1.5)] },
      { name: 'Banana leaves and water', ingredients: [ing('Banana leaves', 1.1, 'pcs', 3), ing('Water cans (20 l)', 0.03, 'pcs', 50)] },
    ],
  },
  {
    id: 'vegpulao', name: 'Vegetable pulao and paneer', description: 'A vegetarian lunch for fasting seasons or mixed gatherings.',
    dishes: [
      { name: 'Vegetable pulao', ingredients: [ing('Basmati rice', 0.12, 'kg', 110), ing('Mixed vegetables', 0.06, 'kg', 50), ing('Onions', 0.04, 'kg', 40), ing('Ghee', 0.008, 'kg', 620), ing('Whole spices', 0.003, 'kg', 900), ing('Mint and coriander', 0.02, 'bunch', 10)] },
      { name: 'Paneer butter masala', ingredients: [ing('Paneer', 0.08, 'kg', 420), ing('Tomatoes', 0.06, 'kg', 40), ing('Onions', 0.03, 'kg', 40), ing('Cream', 0.015, 'l', 300), ing('Butter', 0.008, 'kg', 560), ing('Kasuri methi and spices', 0.003, 'kg', 600)] },
      { name: 'Raita and sweet', ingredients: [ing('Curd', 0.06, 'kg', 80), ing('Cucumber', 0.03, 'kg', 40), ing('Gulab jamun', 2, 'pcs', 8)] },
      { name: 'Plates and water', ingredients: [ing('Paper plates', 1.1, 'pcs', 2.5), ing('Spoons', 1.1, 'pcs', 1), ing('Water cans (20 l)', 0.03, 'pcs', 50)] },
    ],
  },
  {
    id: 'teasnacks', name: 'Tea and snacks after service', description: 'Chai, samosas and biscuits in the courtyard.',
    dishes: [
      { name: 'Masala chai', ingredients: [ing('Tea leaves', 0.004, 'kg', 450), ing('Milk', 0.08, 'l', 60), ing('Sugar', 0.012, 'kg', 45), ing('Ginger and cardamom', 0.002, 'kg', 400)] },
      { name: 'Snacks', ingredients: [ing('Samosa', 2, 'pcs', 12), ing('Biscuits', 0.04, 'packet', 30)] },
      { name: 'Cups', ingredients: [ing('Paper cups', 1.2, 'pcs', 1.2), ing('Napkins', 0.02, 'packet', 40)] },
    ],
  },
  { id: 'custom', name: 'Your own menu', description: 'Start empty and add dishes and ingredients per head yourself.', dishes: [] },
];

/** Round a quantity the way a shopper would write it on the list. */
export function roundQty(qty: number, unit: FeastUnit): number {
  if (unit === 'pcs' || unit === 'bunch' || unit === 'packet') return Math.ceil(qty - 1e-9);
  if (unit === 'g' || unit === 'ml') return Math.ceil(qty / 10) * 10;
  return Math.ceil(qty * 4) / 4; // kg and l to the quarter
}

export function shoppingList(menu: FeastDish[], heads: number): ShoppingItem[] {
  const byKey = new Map<string, ShoppingItem & { raw: number }>();
  for (const d of menu) for (const i of d.ingredients) {
    const key = `${i.name.toLowerCase()}|${i.unit}`;
    const cur = byKey.get(key) ?? { name: i.name, unit: i.unit, qty: 0, costPerUnit: i.costPerUnit, cost: null, dishes: [], raw: 0 };
    cur.raw += i.perHead * heads;
    if (cur.costPerUnit === null && i.costPerUnit !== null) cur.costPerUnit = i.costPerUnit;
    if (!cur.dishes.includes(d.name)) cur.dishes.push(d.name);
    byKey.set(key, cur);
  }
  return [...byKey.values()].map(({ raw, ...it }) => {
    const qty = roundQty(raw, it.unit);
    return { ...it, qty, cost: it.costPerUnit === null ? null : Math.round(qty * it.costPerUnit) };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function cleanMenu(ctx: Ctx, input: unknown, cur: FeastDish[]): FeastDish[] {
  if (!Array.isArray(input)) return cur;
  return input.slice(0, 30).map((d: Record<string, unknown>, i) => {
    const name = clean(d.name, 80);
    if (!name) throw new ApiError(422, 'validation', `Dish ${i + 1} needs a name.`);
    const cookId = d.cookId ? find(ctx, 'people', String(d.cookId), 'Person').id : null;
    const cook = cookId ? ctx.db.get('people', cookId) : null;
    const ingredients: FeastIngredient[] = (Array.isArray(d.ingredients) ? d.ingredients : []).slice(0, 40).map((x: Record<string, unknown>) => {
      const n = clean(x.name, 60);
      if (!n) throw new ApiError(422, 'validation', `An ingredient in ${name} has no name.`);
      const unit = UNITS.includes(x.unit as FeastUnit) ? (x.unit as FeastUnit) : 'kg';
      const costPerUnit = x.costPerUnit === null || x.costPerUnit === undefined || x.costPerUnit === '' ? null : Math.round(num(x.costPerUnit));
      return { name: n, perHead: num(x.perHead), unit, costPerUnit };
    });
    const id = typeof d.id === 'string' && d.id ? d.id : ctx.id('dish');
    return { id, name, ingredients, cookId, cookName: cook ? fullName(cook) : '' };
  });
}

function view(ctx: Ctx, f: Feast): FeastView {
  const ev = ctx.db.get('events', f.eventId);
  const people = rsvpsFor(ctx, f.eventId).map((r) => ctx.db.get('people', r.personId)).filter((p): p is NonNullable<typeof p> => !!p);
  const rsvps = people.length;
  const families = new Set(people.map(familyKey)).size;
  const heads = f.headsOverride ?? rsvps + f.extraHeads;
  const shopping = shoppingList(f.menu, heads);
  const estimatedCost = shopping.reduce((s, i) => s + (i.cost ?? 0), 0);
  return {
    ...f,
    event: ev ? { id: ev.id, title: ev.title, startsAt: ev.startsAt, location: ev.location } : null,
    rsvps, families, heads, shopping, estimatedCost,
    perHead: heads ? Math.ceil(estimatedCost / heads / 100) * 100 : 0,
    perFamily: families ? Math.ceil(estimatedCost / families / 100) * 100 : 0,
  };
}

export function registerFeasts(r: Router) {
  const EDIT = ['events', 'volunteers'] as ('events' | 'volunteers')[];
  r.get('/admin/feasts', { staff: true }, (ctx): FeastsHub => {
    const cutoff = ctx.now.getTime() - 14 * 86_400_000;
    const feasts = ctx.db.all('feasts').map((f) => view(ctx, f))
      .filter((f) => ctx.query.all === '1' || !f.event || Date.parse(f.event.startsAt) >= cutoff)
      .sort((a, b) => (a.event?.startsAt ?? '').localeCompare(b.event?.startsAt ?? ''));
    const taken = new Set(ctx.db.all('feasts').map((f) => f.eventId));
    const events = ctx.db.all('events')
      .filter((e) => Date.parse(e.endsAt) >= ctx.now.getTime() && !taken.has(e.id))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt)).slice(0, 60)
      .map((e) => ({ id: e.id, title: e.title, startsAt: e.startsAt, going: rsvpsFor(ctx, e.id).length }));
    return { feasts, templates: FEAST_TEMPLATES, units: UNITS, events };
  });
  r.post('/admin/feasts', { perm: EDIT }, (ctx) => {
    const ev = find(ctx, 'events', String(ctx.body.eventId ?? ''), 'Event');
    if (ctx.db.all('feasts').some((f) => f.eventId === ev.id)) throw new ApiError(409, 'duplicate', 'This event already has a kitchen plan.');
    const tpl = FEAST_TEMPLATES.find((t) => t.id === ctx.body.template) ?? FEAST_TEMPLATES[FEAST_TEMPLATES.length - 1];
    const menu = cleanMenu(ctx, tpl.dishes.map((d) => ({ ...d })), []);
    const f: Feast = {
      id: ctx.id('feast'), eventId: ev.id, name: clean(ctx.body.name, 80) || tpl.name, template: tpl.id, menu,
      extraHeads: Math.round(num(ctx.body.extraHeads)), headsOverride: null, split: 'church', notes: '',
      createdAt: ctx.now.toISOString(), createdBy: ctx.staff?.name ?? 'office',
    };
    ctx.db.put('feasts', f);
    ctx.audit('created', 'feast', f.id, `Kitchen plan “${f.name}” for ${ev.title}`);
    return view(ctx, f);
  });
  r.get('/admin/feasts/:id', { staff: true }, (ctx) => view(ctx, find(ctx, 'feasts', ctx.params[0], 'Kitchen plan')));
  r.patch('/admin/feasts/:id', { perm: EDIT }, (ctx) => {
    const f = find(ctx, 'feasts', ctx.params[0], 'Kitchen plan');
    const b = ctx.body;
    const next: Feast = {
      ...f,
      name: b.name === undefined ? f.name : clean(b.name, 80) || f.name,
      menu: cleanMenu(ctx, b.menu, f.menu),
      extraHeads: b.extraHeads === undefined ? f.extraHeads : Math.round(num(b.extraHeads)),
      headsOverride: b.headsOverride === undefined ? f.headsOverride : b.headsOverride === null || b.headsOverride === '' ? null : Math.max(0, Math.round(num(b.headsOverride))),
      split: SPLITS.includes(b.split) ? b.split : f.split,
      notes: b.notes === undefined ? f.notes : clean(b.notes, 2000),
    };
    ctx.db.put('feasts', next);
    const v = view(ctx, next);
    ctx.audit('updated', 'feast', f.id, `Kitchen plan “${next.name}”: ${v.heads} heads, ${money(ctx, v.estimatedCost)} estimated`);
    return v;
  });
  r.del('/admin/feasts/:id', { perm: EDIT }, (ctx) => {
    const f = find(ctx, 'feasts', ctx.params[0], 'Kitchen plan');
    ctx.db.del('feasts', f.id);
    ctx.audit('deleted', 'feast', f.id, `Removed kitchen plan “${f.name}”`);
    return { ok: true };
  });
  r.get('/admin/feasts/:id/list.csv', { staff: true }, (ctx) => {
    const v = view(ctx, find(ctx, 'feasts', ctx.params[0], 'Kitchen plan'));
    const cell = (x: unknown) => { const t = x === null || x === undefined ? '' : String(x); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const lines = [['Item', 'Quantity', 'Unit', 'For', 'Rate (₹)', 'Cost (₹)'].join(',')];
    for (const i of v.shopping) lines.push([i.name, i.qty, i.unit, i.dishes.join('; '), i.costPerUnit === null ? '' : i.costPerUnit / 100, i.cost === null ? '' : i.cost / 100].map(cell).join(','));
    lines.push(['', '', '', `${v.heads} heads`, 'Total', v.estimatedCost / 100].map(cell).join(','));
    return { __raw: true as const, contentType: 'text/csv; charset=utf-8', filename: 'shopping-list.csv', body: lines.join('\r\n') };
  });
}
