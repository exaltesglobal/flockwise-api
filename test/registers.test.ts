// Church registers: numbering, people records following the register, corrections as notes,
// voiding instead of deleting, certificates and transfer letters.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const env = createDemoEnv();
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(audience: 'admin' | 'member', email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown, query?: Record<string, string>) => engine.handle({ method, path, body, auth, query }) as Promise<any>;

test('registers: baptism and marriage entries, corrections, void and certificates', async () => {
  const a = await signIn('admin', 'pastor@gracechurch.in');
  const year = new Date().getUTCFullYear();
  const sum = await call(a, 'GET', '/admin/registers/summary');
  const baptisms = sum.kinds.find((k: any) => k.kind === 'baptism');
  assert.ok(baptisms.total >= 3 && sum.fields.marriage.length > 5);

  await assert.rejects(call(a, 'POST', '/admin/registers', { kind: 'baptism', name: 'No Date' }), /required/);

  const child = await call(a, 'POST', '/admin/people', { firstName: 'Baby', lastName: 'Register', birthDate: `${year}-01-05` });
  const e = await call(a, 'POST', '/admin/registers', { kind: 'baptism', date: `${year}-09-28`, personId: child.id, officiant: 'Rev. Samuel Raj', details: { birthDate: `${year}-01-05`, fatherName: 'Paul Register', gender: 'Male' } });
  assert.match(e.number, new RegExp(`^BAP/${year}/\\d{4}$`));
  assert.equal(e.name, 'Baby Register');
  assert.equal(e.place, 'Grace Community Church, Hyderabad');
  const n = Number(e.number.slice(-4));
  const e2 = await call(a, 'POST', '/admin/registers', { kind: 'baptism', date: `${year}-09-28`, name: 'Second Child', details: { birthDate: `${year}-02-01` } });
  assert.equal(Number(e2.number.slice(-4)), n + 1);
  assert.equal(db.get('people', child.id)!.baptismDate, `${year}-09-28`);

  const fixed = await call(a, 'PATCH', `/admin/registers/${e.id}`, { details: { fatherName: 'Paul Registar' }, reason: 'Spelling in parish file' });
  assert.equal(fixed.details.fatherName, 'Paul Registar');
  assert.match(fixed.notes[0].text, /Father's name: "Paul Register" → "Paul Registar"\. Reason: Spelling/);

  const c1 = await call(a, 'POST', `/admin/registers/${e.id}/certificate`);
  const c2 = await call(a, 'POST', `/admin/registers/${e.id}/certificate`);
  assert.equal(c1.title, 'Certificate of Baptism');
  assert.equal(c2.copy, 2);
  assert.ok(c1.rows.some((r: any) => r.label === "Father's name" && r.value === 'Paul Registar'));
  // The QR on the certificate: one code per entry, same on every copy; anyone can check it.
  assert.match(c1.verifyUrl, /\/verify\/[A-Z2-9]{10}$/);
  assert.equal(c2.verifyUrl, c1.verifyUrl);
  const code = c1.verifyUrl.split('/').pop();
  const check = await call(null, 'GET', `/public/verify/${code.toLowerCase()}`);
  assert.equal(check.ok, true);
  assert.equal(check.number, e.number);
  assert.equal(check.title, 'Certificate of Baptism');
  assert.equal(check.copies, 2);
  assert.ok(!('details' in check) && !('notes' in check), 'only what confirms it');
  await assert.rejects(call(null, 'GET', '/public/verify/NOPE123456'), /No certificate/);

  await assert.rejects(call(a, 'POST', `/admin/registers/${e2.id}/void`, {}), /reason/);
  const v = await call(a, 'POST', `/admin/registers/${e2.id}/void`, { reason: 'Entered twice' });
  assert.equal(v.status, 'void');
  const vc = await call(a, 'POST', `/admin/registers/${e2.id}/certificate`).catch((err: any) => err);
  assert.equal(vc.status, 409);
  await assert.rejects(call(a, 'PATCH', `/admin/registers/${e2.id}`, { name: 'x' }), /void/);
  const list = await call(a, 'GET', '/admin/registers', undefined, { kind: 'baptism' });
  assert.ok(!list.data.some((x: any) => x.id === e2.id), 'void entries hidden by default');
  const found = await call(a, 'GET', '/admin/registers', undefined, { q: 'registar' });
  assert.equal(found.data[0].id, e.id);

  const groom = await call(a, 'POST', '/admin/people', { firstName: 'Ben', lastName: 'Groom' });
  const bride = await call(a, 'POST', '/admin/people', { firstName: 'Ann', lastName: 'Bride' });
  await assert.rejects(call(a, 'POST', '/admin/registers', { kind: 'marriage', date: `${year}-10-01`, personId: groom.id, spouseId: bride.id, details: { witness1: 'A' } }), /required/);
  const m = await call(a, 'POST', '/admin/registers', { kind: 'marriage', date: `${year}-10-01`, personId: groom.id, spouseId: bride.id, details: { witness1: 'A Witness', witness2: 'B Witness' } });
  assert.equal(m.details.brideName, 'Ann Bride');
  assert.equal(db.get('people', bride.id)!.anniversary, `${year}-10-01`);
  const theirs = await call(a, 'GET', `/admin/people/${bride.id}/registers`);
  assert.equal(theirs[0].id, m.id);

  const t = await call(a, 'POST', '/admin/registers', { kind: 'transfer', date: `${year}-10-10`, personId: groom.id, markInactive: true, details: { toChurch: 'CSI Christ Church, Chennai', reason: 'Moving for work' } });
  assert.equal(db.get('people', groom.id)!.status, 'inactive');
  const letter = await call(a, 'POST', `/admin/registers/${t.id}/certificate`);
  assert.match(letter.letter, /CSI Christ Church, Chennai[\s\S]*Ben Groom[\s\S]*moving for work/);
});

test('registers: who can do what', async () => {
  const fin = await signIn('admin', 'accounts@gracechurch.in');
  await assert.rejects(call(fin, 'POST', '/admin/registers', { kind: 'baptism', date: '2026-01-01', name: 'X', details: { birthDate: '2025-01-01' } }), /access/);
  const m = await signIn('member', 'priya@example.com');
  await assert.rejects(call(m, 'GET', '/admin/registers'));
});
