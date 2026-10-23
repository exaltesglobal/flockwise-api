// Importing people and past gifts from Planning Center and Elvanto exports: column guessing,
// households from a family id, groups and campuses by name, matching on the old system's id,
// and gifts that never import twice.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { detectKind, guessColumns, normaliseDate, normaliseMethod, normalisePhone, rowsToGifts, rowsToPeople, type GiftTarget, type PeopleTarget } from '../src/core/import-presets.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const clock = Date.parse('2026-10-23T05:00:00.000Z');
const env = createDemoEnv({ now: () => new Date(clock), webUrl: 'https://app.example.church' });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(audience: 'admin' | 'member', email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown) => engine.handle({ method, path, body, auth, query: {} }) as Promise<any>;

const PCO_HEADERS = ['Person ID', 'First Name', 'Last Name', 'Nickname', 'Gender', 'Birthdate', 'Anniversary', 'Child', 'Status', 'Inactive Reason', 'Membership', 'Marital Status', 'Campus', 'Household Name', 'Household Primary Contact', 'Mobile Phone Number', 'Home Phone Number', 'Home Email', 'Work Email', 'Home Address Street Line 1', 'Home Address City', 'Home Address State', 'Home Address Zip Code', 'Medical Notes'];
const PCO_ROWS = [
  ['11', 'Ravi', 'Kumar', '', 'M', '03/15/1980', '11/02/2005', '', 'active', '', 'Member', 'Married', 'Kompally', 'Kumar Household', 'TRUE', '(987) 650-0011', '', 'ravi.kumar@example.com', 'ravi@work.example', '12 MG Road', 'Hyderabad', 'TS', '500003', ''],
  ['12', 'Sunita', 'Kumar', '', 'F', '07/22/1982', '11/02/2005', '', 'active', '', 'Member', 'Married', 'Kompally', 'Kumar Household', '', '98765 00012', '', 'sunita.kumar@example.com', '', '12 MG Road', 'Hyderabad', 'TS', '500003', ''],
  ['13', 'Arjun', 'Kumar', 'AJ', 'M', '05/01/2015', '', 'TRUE', 'active', '', '', '', 'Kompally', 'Kumar Household', '', '', '', '', '', '12 MG Road', 'Hyderabad', 'TS', '500003', 'Peanut allergy'],
  ['14', 'Mary', 'Joseph', '', 'F', '01/30/1990', '', '', 'inactive', 'Moved', 'Visitor', '', '', '', '', '9876500014', '', 'mary.joseph@example.com', '', '', '', '', '', ''],
];

test('Planning Center headings are matched and US dates read correctly', () => {
  const m = guessColumns('people', PCO_HEADERS) as PeopleTarget[];
  assert.equal(m[0], 'externalId');
  assert.equal(m[1], 'firstName');
  assert.equal(m[2], 'lastName');
  assert.equal(m[3], ''); // Nickname: first name already taken
  assert.equal(m[5], 'birthDate');
  assert.equal(m[7], 'child');
  assert.equal(m[8], 'inactive'); // Status (active/inactive) loses to Membership and becomes the inactive flag
  assert.equal(m[9], 'inactive');
  assert.equal(m[10], 'status');
  assert.equal(m[12], 'campus');
  assert.equal(m[13], 'householdName');
  assert.equal(m[14], 'householdRole');
  assert.equal(m[15], 'phone');
  assert.equal(m[17], 'email');
  assert.equal(m[18], ''); // Work Email: email already taken
  assert.equal(m[19], 'addressPart');
  assert.equal(m[23], 'medicalNotes');
  assert.equal(detectKind(PCO_HEADERS), 'people');
  assert.equal(normaliseDate('03/15/1980', 'planning_center'), '1980-03-15');
  assert.equal(normaliseDate('15/03/1980', 'csv'), '1980-03-15');
  assert.equal(normaliseDate('15/03/1980', 'planning_center'), '1980-03-15'); // 15 cannot be a month
  assert.equal(normaliseDate('24-10-91'), '1991-10-24');
  assert.equal(normalisePhone('(987) 650-0011'), '+91 98765 00011');
  assert.equal(normalisePhone('0 98765 00012'), '+91 98765 00012');
  const people = rowsToPeople('planning_center', m, PCO_ROWS);
  assert.equal(people.length, 4);
  assert.equal(people[0].birthDate, '1980-03-15');
  assert.equal(people[0].householdRole, 'primary');
  assert.equal(people[0].address, '12 MG Road, Hyderabad, TS, 500003');
  assert.equal(people[0].email, 'ravi.kumar@example.com');
  assert.equal(people[0].notes, 'Married');
  assert.equal(people[2].householdRole, 'child');
  assert.equal(people[2].medicalNotes, 'Peanut allergy');
  assert.equal(people[3].status, 'inactive'); // Status inactive + Inactive Reason
});

test('importing a Planning Center file creates households, a campus and matches on Person ID next time', async () => {
  const admin = await signIn('admin', 'pastor@gracechurch.in');
  const m = guessColumns('people', PCO_HEADERS) as PeopleTarget[];
  const rows = rowsToPeople('planning_center', m, PCO_ROWS);
  const r1 = await call(admin, 'POST', '/admin/people/import', { rows, source: 'planning_center', dedupeBy: 'email' });
  assert.equal(r1.created, 4);
  assert.equal(r1.errors.length, 0);
  assert.deepEqual(r1.campuses, ['Kompally']);
  const ravi = db.all('people').find((p) => p.externalId === '11')!;
  assert.equal(ravi.householdName, 'Kumar Household');
  assert.equal(ravi.anniversary, '2005-11-02');
  assert.ok(ravi.campusId);
  assert.equal(db.get('campuses', ravi.campusId!)!.name, 'Kompally');
  const arjun = db.all('people').find((p) => p.externalId === '13')!;
  assert.equal(arjun.householdName, 'Kumar Household');
  assert.equal(arjun.medicalNotes, 'Peanut allergy');
  // Same file again, with Ravi's mobile changed and no email column: matched by Person ID, not added twice.
  const again = PCO_ROWS.map((r) => [...r]);
  again[0][15] = '98765 00099';
  const r2 = await call(admin, 'POST', '/admin/people/import', { rows: rowsToPeople('planning_center', m, again), source: 'planning_center', dedupeBy: 'phone' });
  assert.equal(r2.created, 0);
  assert.equal(r2.updated, 1);
  assert.equal(r2.skipped, 3);
  assert.equal(db.get('people', ravi.id)!.phone, '+91 98765 00099');
});

const ELVANTO_HEADERS = ['ID', 'Firstname', 'Preferred Name', 'Middle Name', 'Lastname', 'Email', 'Phone', 'Mobile', 'Date of Birth', 'Gender', 'Marital Status', 'Status', 'Category', 'Family ID', 'Family Relationship', 'Locations', 'Departments', 'Demographics', 'Address', 'Address 2', 'City', 'State', 'Postcode', 'Country', 'Archived', 'Deceased'];
const ELVANTO_ROWS = [
  ['e1', 'Thomas', 'Tom', '', 'Mathew', 'tom.mathew@example.com', '', '98765 00101', '12/08/1975', 'Male', 'Married', 'Active', 'Member', 'F1', 'Primary Contact', 'Main', 'Ushers, Choir', 'Adults', '4 Church Lane', '', 'Kochi', 'KL', '682001', 'India', 'No', 'No'],
  ['e2', 'Annamma', '', '', 'Mathew', 'anna.mathew@example.com', '', '98765 00102', '02/03/1978', 'Female', 'Married', 'Active', 'Member', 'F1', 'Spouse', 'Main', 'Choir', 'Adults', '4 Church Lane', '', 'Kochi', 'KL', '682001', 'India', 'No', 'No'],
  ['e3', 'Jose', '', '', 'Mathew', '', '', '', '09/09/2012', 'Male', '', 'Active', 'Member', 'F1', 'Child', 'Main', '', 'Kids', '4 Church Lane', '', 'Kochi', 'KL', '682001', 'India', 'No', 'No'],
  ['e4', 'Old', '', '', 'Member', 'old@example.com', '', '98765 00104', '01/01/1950', 'Male', '', 'Archived', 'Member', '', '', 'Main', '', '', '', '', '', '', '', '', 'Yes', 'No'],
];

test('an Elvanto export links the family, creates department groups and archives the archived', async () => {
  const admin = await signIn('admin', 'pastor@gracechurch.in');
  const m = guessColumns('people', ELVANTO_HEADERS) as PeopleTarget[];
  assert.equal(m[1], 'firstName');
  assert.equal(m[4], 'lastName');
  assert.equal(m[6], ''); // Phone loses to Mobile
  assert.equal(m[7], 'phone');
  assert.equal(m[2], ''); // Preferred Name loses to Firstname
  const fixed = m;
  assert.equal(fixed[11], 'inactive'); // Elvanto Status: Active/Archived/Contact
  assert.equal(fixed[12], 'status'); // Elvanto Category: Member/Visitor…
  assert.equal(fixed[13], 'householdKey');
  assert.equal(fixed[14], 'householdRole');
  assert.equal(fixed[15], 'campus');
  assert.equal(fixed[16], 'groups');
  assert.equal(fixed[17], 'tags');
  assert.equal(fixed[24], 'inactive');
  const rows = rowsToPeople('elvanto', fixed, ELVANTO_ROWS);
  assert.equal(rows[0].birthDate, '1975-08-12');
  assert.deepEqual(rows[0].groups, ['Ushers', 'Choir']);
  assert.equal(rows[3].status, 'inactive');
  const before = db.count('groups');
  const r = await call(admin, 'POST', '/admin/people/import', { rows, source: 'elvanto', dedupeBy: 'phone' });
  assert.equal(r.created, 4);
  assert.equal(r.households, 1);
  assert.deepEqual(r.groups, ['Ushers', 'Choir']);
  assert.equal(db.count('groups'), before + 2);
  const jose = db.all('people').find((p) => p.externalId === 'e3')!;
  assert.equal(jose.householdName, 'Mathew family');
  assert.equal(jose.status, 'member');
  const choir = db.all('groups').find((g) => g.name === 'Choir')!;
  assert.equal(db.all('groupMembers').filter((gm) => gm.groupId === choir.id).length, 2);
  assert.equal(db.all('people').find((p) => p.externalId === 'e4')!.status, 'inactive');
});

const GIVING_HEADERS = ['Donation ID', 'Received At', 'First Name', 'Last Name', 'Email', 'Amount', 'Fund', 'Payment Method', 'Payment Status', 'Check Number'];
const GIVING_ROWS = [
  ['d1', '2026-04-05', 'Priya', 'Thomas', 'priya@example.com', '₹2,500.00', 'General Fund', 'Cash', 'succeeded', ''],
  ['d2', '2026-04-12', 'Ravi', 'Kumar', 'ravi.kumar@example.com', '1000', 'Building Fund', 'Check', 'succeeded', '004512'],
  ['d3', '2026-04-19', 'Someone', 'Unknown', '', '500', 'General Fund', 'ACH', 'succeeded', ''],
  ['d4', '2026-04-26', 'Priya', 'Thomas', 'priya@example.com', '0', 'General Fund', 'Cash', 'failed', ''],
];

test('a Planning Center Giving export becomes offline gifts, matched to donors, never twice', async () => {
  const admin = await signIn('admin', 'pastor@gracechurch.in');
  assert.equal(detectKind(GIVING_HEADERS), 'gifts');
  const m = guessColumns('gifts', GIVING_HEADERS) as GiftTarget[];
  assert.deepEqual(m, ['externalId', 'date', 'donorFirst', 'donorLast', 'donorEmail', 'amount', 'fund', 'method', 'notes', 'reference']);
  assert.equal(normaliseMethod('Check'), 'cheque');
  assert.equal(normaliseMethod('ACH'), 'bank_transfer');
  assert.equal(normaliseMethod('Google Pay'), 'upi');
  const { gifts, problems } = rowsToGifts('planning_center', m, GIVING_ROWS);
  assert.equal(gifts.length, 3);
  assert.equal(problems.length, 1); // the ₹0 failed row
  assert.equal(gifts[0].amount, 250_000);
  assert.equal(gifts[0].donorName, 'Priya Thomas');
  assert.equal(gifts[1].method, 'cheque');
  const before = db.count('donations');
  const r = await call(admin, 'POST', '/admin/giving/import', { rows: gifts, source: 'planning_center' });
  assert.equal(r.created, 3);
  assert.equal(r.matched, 2);
  assert.equal(r.unmatched, 1);
  assert.equal(r.total, 400_000);
  assert.deepEqual(r.funds, ['General Fund']);
  assert.equal(db.count('donations'), before + 3);
  const priya = db.all('donations').find((d) => d.providerPaymentId === 'import:d1')!;
  assert.equal(priya.donorId, 'p_priya');
  assert.equal(priya.provider, 'offline');
  assert.equal(priya.receiptNumber, null);
  assert.equal(priya.paidAt.slice(0, 10), '2026-04-05');
  const cheque = db.all('donations').find((d) => d.providerPaymentId === 'import:d2')!;
  assert.equal(cheque.fundId, 'fd_building');
  assert.equal(cheque.receiptNumber, '004512');
  // The same file again: nothing added.
  const r2 = await call(admin, 'POST', '/admin/giving/import', { rows: gifts, source: 'planning_center' });
  assert.equal(r2.created, 0);
  assert.equal(r2.duplicates, 3);
  // Without ids, the same donor, date, amount and fund is still a duplicate.
  const r3 = await call(admin, 'POST', '/admin/giving/import', { rows: gifts.map((g) => ({ ...g, externalId: undefined })), source: 'csv' });
  assert.equal(r3.created, 0);
  assert.equal(r3.duplicates, 3);
  // Priya's statement shows the imported gift.
  const member = await signIn('member', 'priya@example.com');
  const hist = await call(member, 'GET', '/giving/donations');
  assert.ok(hist.data.some((d: any) => d.amount === 250_000 && d.fundName === 'General Fund'));
});
