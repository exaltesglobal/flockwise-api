// Door QR attendance: the leader's phone shows a code that changes every minute; members scan it
// and are marked present. Old codes and other events' codes are refused.
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.WEB_URL = 'https://app.example';
process.env.API_PUBLIC_URL = 'https://api.example';
process.env.CHURCH_ID = 'ch_main';
process.env.CHURCH_NAME = 'First Church';
process.env.CHURCH_SLUG = 'first';
process.env.OWNER_EMAIL = 'owner@first.test';

const { createApp } = await import('../src/app.js');
const { buildServer, bootstrap } = await import('../src/server.js');

const server = buildServer();
bootstrap(server);
const codes = new Map<string, string>();
server.hooks.sendOtpEmail = async (to, code) => void codes.set(to, code);
const app = createApp(server);

const req = (method: string, path: string, body?: unknown, token?: string) =>
  app.request(path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const ok = async (res: Response, status = 200) => {
  const text = await res.text();
  assert.equal(res.status, status, text);
  return text ? JSON.parse(text) : undefined;
};
async function signIn(audience: 'admin' | 'member', email: string) {
  const r = await ok(await req('POST', '/v1/auth/otp/request', { email, audience }));
  return (await ok(await req('POST', '/v1/auth/otp/verify', { requestId: r.requestId, code: codes.get(email.toLowerCase()) }))).accessToken as string;
}

let owner = '';
let member = '';
let ev: any;
let later: any;
let door: any;

test('the leader gets a door code for a service that is on now', async () => {
  owner = await signIn('admin', 'owner@first.test');
  await ok(await req('POST', '/v1/admin/people', { firstName: 'Mary', lastName: 'Joseph', email: 'mary@example.test', status: 'member' }, owner));
  member = await signIn('member', 'mary@example.test');
  const now = Date.now();
  ev = await ok(await req('POST', '/v1/admin/events', { title: 'Sunday Service', startsAt: new Date(now - 600_000).toISOString(), endsAt: new Date(now + 5_400_000).toISOString(), location: 'Main hall', checkinEnabled: true }, owner));
  later = await ok(await req('POST', '/v1/admin/events', { title: 'Next week', startsAt: new Date(now + 7 * 86_400_000).toISOString(), endsAt: new Date(now + 7 * 86_400_000 + 7_200_000).toISOString(), location: 'Main hall', checkinEnabled: true }, owner));
  door = await ok(await req('GET', `/v1/admin/checkin/${ev.id}/door`, undefined, owner));
  assert.match(door.token, /^[A-Z0-9]{8}$/);
  assert.equal(door.path, `/app/door?e=${ev.id}&t=${door.token}`);
  assert.ok(door.rotatesInSeconds > 0 && door.rotatesInSeconds <= 60);
  assert.equal(door.present, 0);
  // Members cannot read the leader's code.
  assert.equal((await req('GET', `/v1/admin/checkin/${ev.id}/door`, undefined, member)).status, 403);
});

test('a member scans it and is marked present; bad codes and other events are refused', async () => {
  assert.equal((await req('GET', `/v1/door/${ev.id}?t=NOPE1234`, undefined, member)).status, 410);
  const other = await ok(await req('GET', `/v1/admin/checkin/${later.id}/door`, undefined, owner));
  assert.equal((await req('GET', `/v1/door/${ev.id}?t=${other.token}`, undefined, member)).status, 410);
  // Next week's code is right for its event, but that service is not on yet.
  assert.equal((await req('GET', `/v1/door/${later.id}?t=${other.token}`, undefined, member)).status, 422);
  assert.equal((await req('GET', `/v1/door/${ev.id}?t=${door.token}`)).status, 401);

  const view = await ok(await req('GET', `/v1/door/${ev.id}?t=${door.token}`, undefined, member));
  assert.equal(view.title, 'Sunday Service');
  assert.deepEqual(view.members.map((m: any) => [m.name, m.checkedIn]), [['Mary Joseph', false]]);

  const res = await ok(await req('POST', `/v1/door/${ev.id}`, { token: door.token.toLowerCase() }, member));
  assert.equal(res.checkedIn.length, 1);
  assert.equal(res.event.members[0].checkedIn, true);
  // Scanning twice does not double count.
  const again = await ok(await req('POST', `/v1/door/${ev.id}`, { token: door.token }, member));
  assert.equal(again.checkedIn.length, 0);

  const after = await ok(await req('GET', `/v1/admin/checkin/${ev.id}/door`, undefined, owner));
  assert.equal(after.present, 1);
  assert.equal(after.scanned, 1);
  assert.equal(after.recent[0].name, 'Mary Joseph');
  const summary = await ok(await req('GET', `/v1/admin/checkin/${ev.id}`, undefined, owner));
  assert.equal(summary.checkins.filter((c: any) => c.method === 'qr').length, 1);
});
