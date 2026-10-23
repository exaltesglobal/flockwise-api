// The denomination's annual return: nine forms, every line filled from the records, the office
// overrides what it knows better, submits (which freezes the figures), reopens, exports.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const clock = Date.parse('2026-11-02T05:00:00.000Z'); // Monday, 10:30 am IST, FY 2026-27
const env = createDemoEnv({ now: () => new Date(clock), webUrl: 'https://app.example.church' });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(audience: 'admin' | 'member', email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown) => { const [p, qs] = path.split('?'); return engine.handle({ method, path: p, body, auth, query: qs ? Object.fromEntries(new URLSearchParams(qs)) : {} }) as Promise<any>; };
const fails = async (p: Promise<unknown>, status: number, code?: string) => { const e: any = await p.then(() => null, (err) => err); assert.ok(e, `expected ${status}`); assert.equal(e.status, status, e.message); if (code) assert.equal(e.code, code); };
const line = (v: any, key: string) => v.sections.flatMap((s: any) => s.lines).find((l: any) => l.key === key);

test('the forms are listed and the CSI return comes pre-filled from the records', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const priya = await signIn('member', 'priya@example.com');
  await fails(call(priya, 'GET', '/admin/annual-return'), 403);

  const templates = await call(owner, 'GET', '/admin/annual-return/templates');
  assert.equal(templates.length, 9);
  assert.ok(templates.some((t: any) => t.id === 'csi' && t.body.includes('Church of South India')));
  assert.ok(templates.every((t: any) => t.lines > 20));

  const v = await call(owner, 'GET', '/admin/annual-return?template=csi&year=2026');
  assert.equal(v.template.id, 'csi');
  assert.equal(v.label, '2026-27');
  assert.equal(v.from, '2026-04-01');
  assert.equal(v.to, '2027-03-31');
  assert.equal(v.return, null);
  assert.equal(v.header.body, templates.find((t: any) => t.id === 'csi').body);
  assert.equal(v.header.unit, v.church.name);
  assert.ok(v.header.minister.length > 0, 'the owner is the presbyter by default');
  assert.ok(v.sections.map((s: any) => s.id).includes('finance'));

  const families = line(v, 'families');
  assert.equal(families.source, 'auto');
  assert.ok(families.auto > 0 && families.value === families.auto && !families.overridden);
  assert.ok(line(v, 'communicants').auto > 0);
  assert.ok(line(v, 'avgAttendance').auto >= 846, 'last Sunday counted 846');
  assert.ok(line(v, 'highestAttendance').auto >= line(v, 'avgAttendance').auto);
  assert.equal(typeof line(v, 'incomeTotal').auto, 'number');
  assert.equal(line(v, 'assessment').source, 'manual');
  assert.equal(line(v, 'assessment').value, null);
  assert.equal(line(v, 'committee').kind, 'text');
  assert.equal(line(v, 'minister').value, v.header.minister, 'the presbyter line follows the header');
});

test('override a line and the header, submit to freeze, reopen, export', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  await fails(call(owner, 'GET', '/admin/annual-return?template=nope'), 404);
  await fails(call(owner, 'PUT', '/admin/annual-return', { template: 'csi', year: 2026, values: { families: 'many' } }), 422);

  let v = await call(owner, 'PUT', '/admin/annual-return', { template: 'csi', year: 2026, values: { families: 240, assessment: 1200000, secretary: 'Mr. Thomas Mathew' }, header: { above: 'Madras Diocese', code: 'MD-042' }, notes: 'Figures checked by the committee on 2 Nov.' });
  assert.equal(v.return.status, 'draft');
  assert.equal(line(v, 'families').value, 240);
  assert.equal(line(v, 'families').overridden, true);
  assert.ok(line(v, 'families').auto !== 240, 'the data figure is kept beside the override');
  assert.equal(line(v, 'assessment').value, 1200000);
  assert.equal(line(v, 'secretary').value, 'Mr. Thomas Mathew');
  assert.equal(v.header.above, 'Madras Diocese');
  assert.equal(v.header.code, 'MD-042');
  assert.ok(v.header.minister.length > 0, 'untouched header fields stay');
  assert.equal(v.return.notes, 'Figures checked by the committee on 2 Nov.');
  assert.deepEqual(v.years, [{ year: 2026, label: '2026-27', status: 'draft' }]);

  // Clearing a value goes back to the data; the chosen form is remembered.
  v = await call(owner, 'PUT', '/admin/annual-return', { template: 'csi', year: 2026, values: { families: '' } });
  assert.equal(line(v, 'families').overridden, false);
  assert.equal(line(v, 'families').value, line(v, 'families').auto);
  const remembered = await call(owner, 'GET', '/admin/annual-return');
  assert.equal(remembered.template.id, 'csi');

  const csv = await call(owner, 'GET', '/admin/annual-return/export.csv?template=csi&year=2026');
  assert.ok(csv.csv.startsWith('CSI pastorate annual return 2026-27\n'));
  assert.ok(csv.csv.includes('"Income and expenditure","Diocesan assessment due","12000.00"'));
  assert.ok(csv.csv.includes('"Leadership and staff","Pastorate committee secretary","Mr. Thomas Mathew","","office"'));

  // Submit freezes the figures as they stand.
  const s = await call(owner, 'POST', '/admin/annual-return/submit', { template: 'csi', year: 2026 });
  assert.equal(s.return.status, 'submitted');
  assert.ok(s.return.submittedAt);
  assert.equal(s.return.submittedBy, 'Pastor Samuel Raj');
  assert.equal(s.return.snapshot.assessment, 1200000);
  assert.equal(s.return.snapshot.families, line(v, 'families').auto);
  await fails(call(owner, 'PUT', '/admin/annual-return', { template: 'csi', year: 2026, values: { families: 1 } }), 409, 'submitted');

  // Reopen and the figures are live again.
  const r = await call(owner, 'POST', '/admin/annual-return/reopen', { template: 'csi', year: 2026 });
  assert.equal(r.return.status, 'draft');
  assert.equal(r.return.snapshot, null);
  await fails(call(owner, 'POST', '/admin/annual-return/reopen', { template: 'csi', year: 2019 }), 404);

  // Another body's form has its own lines.
  const ag = await call(owner, 'GET', '/admin/annual-return?template=ag&year=2026');
  assert.ok(line(ag, 'spiritBaptisms'));
  assert.equal(ag.return, null);
});
