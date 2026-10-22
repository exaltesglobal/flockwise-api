// Church networks and dioceses: a network office signs in, makes a network, churches join with its
// code, and the office sees combined totals. Nothing about a single person crosses over.
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.WEB_URL = 'https://app.example';
process.env.API_PUBLIC_URL = 'https://api.example';
process.env.CHURCH_ID = 'ch_main';
process.env.CHURCH_NAME = 'First Church';
process.env.CHURCH_SLUG = 'first';
process.env.OWNER_EMAIL = 'owner@first.test';
process.env.PLATFORM_ADMINS = 'team@flockwise.test';

const { createApp } = await import('../src/app.js');
const { buildServer, bootstrap } = await import('../src/server.js');

globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;

const server = buildServer();
bootstrap(server);
const codes = new Map<string, string>();
server.hooks.sendOtpEmail = async (to, code) => void codes.set(to, code);
const app = createApp(server);

const req = (method: string, path: string, body?: unknown, opts: { token?: string; church?: string } = {}) =>
  app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}), ...(opts.church ? { 'X-Church': opts.church } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ok = async (res: Response, status = 200) => {
  const text = await res.text();
  assert.equal(res.status, status, text);
  return text ? JSON.parse(text) : undefined;
};

async function leader(email: string) {
  const r = await ok(await req('POST', '/v1/networks/auth/request', { email }));
  return (await ok(await req('POST', '/v1/networks/auth/verify', { requestId: r.requestId, code: codes.get(email.toLowerCase()) }))).token as string;
}

let lead = '';
let net: any;
let owner = '';
let grace: any;

test('a network office signs in and makes a network with a join code', async () => {
  assert.equal((await req('GET', '/v1/networks/mine')).status, 401);
  lead = await leader('Bishop@Diocese.test');
  net = await ok(await req('POST', '/v1/networks/new', { name: 'Diocese of the Deccan', kind: 'diocese' }, { token: lead }));
  assert.equal(net.kind, 'diocese');
  assert.equal(net.churches, 0);
  const mine = await ok(await req('GET', '/v1/networks/mine', undefined, { token: lead }));
  assert.deepEqual(mine.map((n: any) => n.id), [net.id]);
  const o = await ok(await req('GET', `/v1/networks/${net.id}`, undefined, { token: lead }));
  assert.match(o.network.code, /^[A-Z0-9-]{6,}$/);
  net = o.network;
  assert.equal((await req('POST', '/v1/networks/new', { name: 'x' }, { token: lead })).status, 422);
});

test('churches join with the code, choosing whether to share giving', async () => {
  const r = await ok(await req('POST', '/v1/auth/otp/request', { email: 'owner@first.test', audience: 'admin' }));
  owner = (await ok(await req('POST', '/v1/auth/otp/verify', { requestId: r.requestId, code: codes.get('owner@first.test') }))).accessToken;
  assert.equal((await ok(await req('GET', '/v1/admin/networks', undefined, { token: owner }))).available, true);
  assert.equal((await req('GET', '/v1/admin/networks/preview?code=NOPE-NOPE', undefined, { token: owner })).status, 404);
  const p = await ok(await req('GET', `/v1/admin/networks/preview?code=${encodeURIComponent(net.code.toLowerCase())}`, undefined, { token: owner }));
  assert.equal(p.name, 'Diocese of the Deccan');
  const joined = await ok(await req('POST', '/v1/admin/networks/join', { code: net.code, shareGiving: true }, { token: owner }));
  assert.equal(joined.shareGiving, true);
  assert.equal(joined.churches, 1);
  assert.equal((await req('POST', '/v1/admin/networks/join', { code: 'WRONG-CODE' }, { token: owner })).status, 404);

  const start = await ok(await req('POST', '/v1/signup/start', { email: 'pastor@grace.test' }));
  grace = await ok(await req('POST', '/v1/signup/complete', { requestId: start.requestId, code: codes.get('pastor@grace.test'), churchName: 'Grace Fellowship', ownerName: 'Pastor Ravi', slug: 'grace-hyd', city: 'Hyderabad' }));
  await ok(await req('POST', '/v1/admin/networks/join', { code: net.code, shareGiving: false }, { token: grace.session.accessToken }));
  const list = await ok(await req('GET', '/v1/admin/networks', undefined, { token: grace.session.accessToken }));
  assert.equal(list.networks[0].churches, 2);
});

test('the network office sees totals only, never people', async () => {
  const res = await req('GET', `/v1/networks/${net.id}`, undefined, { token: lead });
  const text = await res.clone().text();
  const o = await ok(res);
  assert.equal(o.totals.churches, 2);
  assert.equal(o.churches.length, 2);
  assert.equal(o.giving.churches, 1);
  assert.equal(o.totals.people, o.churches.reduce((s: number, c: any) => s + c.people, 0));
  const g = o.churches.find((c: any) => c.name === 'Grace Fellowship');
  assert.equal(g.givingByMonth, null);
  for (const leak of ['owner@first.test', 'pastor@grace.test', 'Pastor Ravi', '"email"', '"phone"']) assert.ok(!text.includes(leak), `leaked ${leak}`);

  // Another leader cannot see it until added.
  const other = await leader('someone@else.test');
  assert.equal((await req('GET', `/v1/networks/${net.id}`, undefined, { token: other })).status, 404);
  assert.equal((await req('PATCH', `/v1/networks/${net.id}`, { admins: ['someone@else.test'] }, { token: lead })).status, 422);
  await ok(await req('PATCH', `/v1/networks/${net.id}`, { admins: ['bishop@diocese.test', 'someone@else.test'] }, { token: lead }));
  await ok(await req('GET', `/v1/networks/${net.id}`, undefined, { token: other }));
});

test('a church can stop sharing giving or leave, and the office can remove a church', async () => {
  const off = await ok(await req('PATCH', `/v1/admin/networks/${net.id}`, { shareGiving: false }, { token: owner }));
  assert.equal(off.shareGiving, false);
  assert.equal((await ok(await req('GET', `/v1/networks/${net.id}`, undefined, { token: lead }))).giving.churches, 0);

  await ok(await req('DELETE', `/v1/admin/networks/${net.id}`, undefined, { token: grace.session.accessToken }), 204);
  assert.equal((await ok(await req('GET', `/v1/networks/${net.id}`, undefined, { token: lead }))).totals.churches, 1);

  const o = await ok(await req('DELETE', `/v1/networks/${net.id}/churches/ch_main`, undefined, { token: lead }));
  assert.equal(o.totals.churches, 0);
  assert.deepEqual((await ok(await req('GET', '/v1/admin/networks', undefined, { token: owner }))).networks, []);

  // A new code stops the old one working.
  const fresh = await ok(await req('POST', `/v1/networks/${net.id}/code`, undefined, { token: lead }));
  assert.notEqual(fresh.network.code, net.code);
  assert.equal((await req('POST', '/v1/admin/networks/join', { code: net.code }, { token: owner })).status, 404);

  await ok(await req('POST', '/v1/networks/auth/sign-out', undefined, { token: lead }), 204);
  assert.equal((await req('GET', '/v1/networks/mine', undefined, { token: lead })).status, 401);
});
