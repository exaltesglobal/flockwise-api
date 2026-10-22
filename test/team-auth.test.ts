// The team mobile app: the office sends a login, the volunteer signs in with a password and a
// team, sees only their own serving, and can change or reset the password.
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

const mails: { to: string; subject: string; text: string }[] = [];
server.hooks.deliver = async (_channel, batch) => {
  mails.push(...batch);
  return batch.map(() => ({ ok: true }));
};
const lastEmail = () => mails.at(-1)!;

const req = (method: string, path: string, body?: unknown, token?: string) =>
  app.request(path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const ok = async (res: Response, status = 200) => {
  const text = await res.text();
  assert.equal(res.status, status, text);
  return text ? JSON.parse(text) : undefined;
};

let owner = '';
let team: any;
let other: any;
let ravi: any;
let temp = '';
let session: any;

test('the office creates a team and sends a volunteer an app login by email', async () => {
  const r = await ok(await req('POST', '/v1/auth/otp/request', { email: 'owner@first.test', audience: 'admin' }));
  owner = (await ok(await req('POST', '/v1/auth/otp/verify', { requestId: r.requestId, code: codes.get('owner@first.test') }))).accessToken;
  ravi = await ok(await req('POST', '/v1/admin/people', { firstName: 'Ravi', lastName: 'Kumar', email: 'Ravi@Example.test', status: 'member' }, owner));
  team = await ok(await req('POST', '/v1/admin/volunteers/teams', { name: 'Worship', positions: [{ name: 'Guitar', needed: 1 }] }, owner));
  other = await ok(await req('POST', '/v1/admin/volunteers/teams', { name: 'Ushers' }, owner));

  // Not on a team yet: no login.
  assert.equal((await req('POST', '/v1/admin/team-logins', { personId: ravi.id }, owner)).status, 422);
  await ok(await req('PUT', `/v1/admin/volunteers/teams/${team.id}/members`, { members: [{ personId: ravi.id, positionIds: [team.positions[0].id] }] }, owner));

  const login = await ok(await req('POST', '/v1/admin/team-logins', { personId: ravi.id }, owner));
  assert.equal(login.email, 'ravi@example.test');
  assert.equal(login.mustChangePassword, true);
  assert.deepEqual(login.teams.map((t: any) => t.name), ['Worship']);
  assert.equal(lastEmail().to, 'ravi@example.test');
  assert.match(lastEmail().subject, /team app login/);
  temp = /Temporary password: (\S+)/.exec(lastEmail().text)?.[1] ?? '';
  assert.equal(temp.length, 12);
  assert.equal((await req('POST', '/v1/admin/team-logins', { personId: ravi.id }, owner)).status, 409);
  const list = await ok(await req('GET', '/v1/admin/team-logins', undefined, owner));
  assert.equal(list.length, 1);
  // The member role cannot do this.
  assert.equal((await req('GET', '/v1/admin/team-logins')).status, 401);
});

test('the volunteer picks a team and signs in; wrong team, wrong password and lockout are refused', async () => {
  const teams = await ok(await req('GET', '/v1/team/teams'));
  assert.deepEqual(teams.map((t: any) => t.name).sort(), ['Ushers', 'Worship']);
  // The office can send a fresh one; the old password stops working.
  const old = temp;
  await ok(await req('POST', `/v1/admin/team-logins/${ravi.id}/reset`, undefined, owner));
  temp = /Temporary password: (\S+)/.exec(lastEmail().text)?.[1] ?? '';
  assert.equal(temp.length, 12);
  assert.notEqual(temp, old);
  assert.equal((await req('POST', '/v1/auth/team/sign-in', { email: 'ravi@example.test', password: old, teamId: team.id })).status, 401);

  assert.equal((await req('POST', '/v1/auth/team/sign-in', { email: 'nobody@example.test', password: temp, teamId: team.id })).status, 401);
  assert.equal((await req('POST', '/v1/auth/team/sign-in', { email: 'ravi@example.test', password: temp, teamId: other.id })).status, 403);
  session = await ok(await req('POST', '/v1/auth/team/sign-in', { email: 'RAVI@example.test ', password: temp, teamId: team.id }));
  assert.equal(session.team.name, 'Worship');
  assert.equal(session.mustChangePassword, true);
  assert.ok(session.accessToken && session.refreshToken);
  // Scope is member: the office is closed to this token.
  assert.equal((await req('GET', '/v1/admin/team-logins', undefined, session.accessToken)).status, 403);

  for (let i = 0; i < 5; i++) assert.equal((await req('POST', '/v1/auth/team/sign-in', { email: 'ravi@example.test', password: 'wrong-wrong', teamId: team.id })).status, 401);
  assert.equal((await req('POST', '/v1/auth/team/sign-in', { email: 'ravi@example.test', password: temp, teamId: team.id })).status, 429);
});

test('serving is filtered to the chosen team and the password can be changed', async () => {
  const ev = await ok(await req('POST', '/v1/admin/events', { title: 'Sunday Service', startsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), endsAt: new Date(Date.now() + 3 * 86_400_000 + 7_200_000).toISOString(), location: 'Main hall' }, owner));
  await ok(await req('POST', '/v1/admin/volunteers/assignments', { eventId: ev.id, teamId: team.id, positionId: team.positions[0].id, personId: ravi.id }, owner));
  const mine = await ok(await req(`GET`, `/v1/me/serving?teamId=${team.id}`, undefined, session.accessToken));
  assert.deepEqual(mine.teams.map((t: any) => t.name), ['Worship']);
  assert.ok(mine.assignments.every((a: any) => a.teamId === team.id));
  const none = await ok(await req(`GET`, `/v1/me/serving?teamId=${other.id}`, undefined, session.accessToken));
  assert.deepEqual(none, { assignments: [], teams: [], blockouts: [] });

  assert.equal((await req('POST', '/v1/auth/team/password', { currentPassword: temp, newPassword: 'short' }, session.accessToken)).status, 422);
  assert.equal((await req('POST', '/v1/auth/team/password', { currentPassword: 'nope-nope', newPassword: 'longenough1' }, session.accessToken)).status, 422);
  await ok(await req('POST', '/v1/auth/team/password', { currentPassword: temp, newPassword: 'my-own-password' }, session.accessToken), 204);
  // The lockout from the earlier test has cleared with the password change.
  const again = await ok(await req('POST', '/v1/auth/team/sign-in', { email: 'ravi@example.test', password: 'my-own-password', teamId: team.id }));
  assert.equal(again.mustChangePassword, false);
});

test('forgot password emails a code, reset signs in, and a disabled login is refused', async () => {
  assert.deepEqual(await ok(await req('POST', '/v1/auth/team/forgot', { email: 'unknown@example.test' })), { sent: true });
  assert.deepEqual(await ok(await req('POST', '/v1/auth/team/forgot', { email: 'ravi@example.test' })), { sent: true });
  const code = /reset code (\d{6})/.exec(lastEmail().subject)?.[1] ?? '';
  assert.equal(code.length, 6);
  assert.equal((await req('POST', '/v1/auth/team/reset', { email: 'ravi@example.test', code: '000000', newPassword: 'another-good-one', teamId: team.id })).status, 422);
  const s = await ok(await req('POST', '/v1/auth/team/reset', { email: 'ravi@example.test', code, newPassword: 'another-good-one', teamId: team.id }));
  assert.equal(s.team.id, team.id);
  // A code works once.
  assert.equal((await req('POST', '/v1/auth/team/reset', { email: 'ravi@example.test', code, newPassword: 'another-good-one', teamId: team.id })).status, 422);

  await ok(await req('DELETE', `/v1/admin/team-logins/${ravi.id}`, undefined, owner), 204);
  assert.equal((await req('POST', '/v1/auth/team/sign-in', { email: 'ravi@example.test', password: 'another-good-one', teamId: team.id })).status, 403);
  assert.equal((await req('POST', '/v1/auth/refresh', { refreshToken: s.refreshToken })).status, 401);
  // Sending a new login brings it back.
  const back = await ok(await req('POST', '/v1/admin/team-logins', { personId: ravi.id }, owner));
  assert.equal(back.disabled, false);
});
