// The church's own mailbox and automatic notifications: email leaves from the connected
// address (sign-in codes too), phones registered by the apps get push, and the office can
// switch channels per kind.
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
const shared: { to: string; subject: string }[] = [];
server.hooks.deliver = async (_c, batch) => {
  shared.push(...batch.map((m) => ({ to: m.to, subject: m.subject })));
  return batch.map(() => ({ ok: true }));
};
const mailbox: { from: string; to: string; subject: string; text: string }[] = [];
server.hooks.smtp = async (a, batch) => {
  if (a.pass !== 'app-pass') return batch.map(() => ({ ok: false, error: 'Invalid login' }));
  mailbox.push(...batch.map((m) => ({ from: a.from, to: m.to, subject: m.subject, text: m.text })));
  return batch.map(() => ({ ok: true }));
};
const pushes: { token: string; title: string }[] = [];
let goneTokens = new Set<string>();
server.hooks.push = async (batch) => {
  pushes.push(...batch.map((m) => ({ token: m.token, title: m.title })));
  return batch.map((m) => (goneTokens.has(m.token) ? { ok: false, gone: true, error: 'DeviceNotRegistered' } : { ok: true }));
};
const app = createApp(server);
const settle = () => new Promise((r) => setTimeout(r, 30));

const req = (method: string, path: string, body?: unknown, token?: string) =>
  app.request(path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const ok = async (res: Response, status = 200) => {
  const text = await res.text();
  assert.equal(res.status, status, text);
  return text ? JSON.parse(text) : undefined;
};

let owner = '';
let member = '';
let mary: any;
let team: any;
let ev: any;

test('the office connects the church mailbox; a wrong password is refused', async () => {
  const r = await ok(await req('POST', '/v1/auth/otp/request', { email: 'owner@first.test', audience: 'admin' }));
  owner = (await ok(await req('POST', '/v1/auth/otp/verify', { requestId: r.requestId, code: codes.get('owner@first.test') }))).accessToken;
  const before = await ok(await req('GET', '/v1/admin/integrations', undefined, owner));
  assert.equal(before.email.connected, false);
  const bad = await req('POST', '/v1/admin/integrations/email', { host: 'smtp.gmail.com', port: 465, user: 'office@first.test', password: 'wrong', from: 'office@first.test' }, owner);
  assert.equal(bad.status, 422);
  const st = await ok(await req('POST', '/v1/admin/integrations/email', { host: 'SMTP.gmail.com', port: 465, user: 'office@first.test', password: 'app-pass', from: 'Office@First.test', fromName: 'First Church Office' }, owner));
  assert.equal(st.connected, true);
  assert.equal(st.from, 'office@first.test');
  // The test email went to the person connecting it, from the new address.
  assert.equal(mailbox.at(-1)?.to, 'owner@first.test');
  assert.equal(mailbox.at(-1)?.from, 'office@first.test');
  const after = await ok(await req('GET', '/v1/admin/integrations', undefined, owner));
  assert.equal(after.email.host, 'smtp.gmail.com');
  const ch = await ok(await req('GET', '/v1/admin/channels', undefined, owner)).catch(() => null);
  if (ch) assert.equal(ch.email.provider, 'office@first.test');
});

test('sign-in codes and rota requests now leave from the church mailbox; phones get push', async () => {
  mary = await ok(await req('POST', '/v1/admin/people', { firstName: 'Mary', lastName: 'Joseph', email: 'mary@example.test', status: 'member' }, owner));
  // Member sign-in: the code comes through the mailbox, not the server's OTP sender.
  const n = codes.size;
  const r = await ok(await req('POST', '/v1/auth/otp/request', { email: 'mary@example.test', audience: 'member' }));
  assert.equal(codes.size, n);
  const sent = mailbox.at(-1)!;
  assert.equal(sent.to, 'mary@example.test');
  const code = /(\d{6}) is your/.exec(sent.subject)?.[1] ?? '';
  member = (await ok(await req('POST', '/v1/auth/otp/verify', { requestId: r.requestId, code }))).accessToken;

  const dev = await ok(await req('POST', '/v1/me/devices', { token: 'ExponentPushToken[mary-phone]', platform: 'android', app: 'member' }, member));
  assert.equal(dev.app, 'member');
  // Registering the same phone again does not add a second device.
  await ok(await req('POST', '/v1/me/devices', { token: 'ExponentPushToken[mary-phone]', platform: 'android', app: 'member' }, member));
  const view = await ok(await req('GET', '/v1/admin/notifications', undefined, owner));
  assert.equal(view.devices.member, 1);
  assert.equal(view.emailFrom, 'office@first.test');
  assert.deepEqual(view.rules.find((x: any) => x.kind === 'rota.assigned').rule, { email: true, push: true, whatsapp: false });

  team = await ok(await req('POST', '/v1/admin/volunteers/teams', { name: 'Ushers', positions: [{ name: 'Door', needed: 2 }] }, owner));
  await ok(await req('PUT', `/v1/admin/volunteers/teams/${team.id}/members`, { members: [{ personId: mary.id, positionIds: [team.positions[0].id] }] }, owner));
  const start = Date.now() + 3 * 86_400_000;
  ev = await ok(await req('POST', '/v1/admin/events', { title: 'Sunday Service', startsAt: new Date(start).toISOString(), endsAt: new Date(start + 7_200_000).toISOString(), location: 'Main hall' }, owner));
  const m0 = mailbox.length;
  const p0 = pushes.length;
  await ok(await req('POST', '/v1/admin/volunteers/assignments', { eventId: ev.id, teamId: team.id, positionId: team.positions[0].id, personId: mary.id }, owner));
  await settle();
  assert.equal(mailbox.length, m0 + 1);
  assert.match(mailbox.at(-1)!.subject, /on the rota: Sunday Service/);
  assert.equal(mailbox.at(-1)!.from, 'office@first.test');
  assert.match(mailbox.at(-1)!.text, /https:\/\/app\.example\/app\/serving/);
  assert.equal(pushes.length, p0 + 1);
  assert.equal(pushes.at(-1)!.token, 'ExponentPushToken[mary-phone]');
  const counted = await ok(await req('GET', '/v1/admin/notifications', undefined, owner));
  assert.equal(counted.rules.find((x: any) => x.kind === 'rota.assigned').sentCount, 1);
});

test('moving the service tells the people on it; the office can turn email off per kind', async () => {
  const m0 = mailbox.length;
  const p0 = pushes.length;
  // Same time, new description: nobody is bothered.
  await ok(await req('PATCH', `/v1/admin/events/${ev.id}`, { description: 'Bring a friend' }, owner));
  await settle();
  assert.equal(mailbox.length, m0);
  await ok(await req('PATCH', `/v1/admin/events/${ev.id}`, { location: 'Chapel' }, owner));
  await settle();
  assert.equal(mailbox.length, m0 + 1);
  assert.match(mailbox.at(-1)!.subject, /has changed/);
  assert.equal(pushes.length, p0 + 1);

  const v = await ok(await req('PUT', '/v1/admin/notifications/event.changed', { email: false, push: true, whatsapp: false }, owner));
  assert.deepEqual(v.rules.find((x: any) => x.kind === 'event.changed').rule, { email: false, push: true, whatsapp: false });
  assert.equal((await req('PUT', '/v1/admin/notifications/nope', { email: true }, owner)).status, 404);
  await ok(await req('PATCH', `/v1/admin/events/${ev.id}`, { location: 'Garden' }, owner));
  await settle();
  assert.equal(mailbox.length, m0 + 1);
  assert.equal(pushes.length, p0 + 2);
});

test('a prayer request reaches the pastors; an uninstalled phone is forgotten', async () => {
  const m0 = mailbox.length;
  await ok(await req('POST', '/v1/prayer', { text: 'Please pray for my mother.' }, member));
  await settle();
  // The owner is a pastor-level login with a person record; the member who asked is not told.
  assert.equal(mailbox.length, m0 + 1);
  assert.equal(mailbox.at(-1)!.to, 'owner@first.test');
  assert.match(mailbox.at(-1)!.subject, /Prayer request from Mary Joseph/);

  goneTokens = new Set(['ExponentPushToken[mary-phone]']);
  await ok(await req('PATCH', `/v1/admin/events/${ev.id}`, { location: 'Hall B' }, owner));
  await settle();
  const view = await ok(await req('GET', '/v1/admin/notifications', undefined, owner));
  assert.equal(view.devices.member, 0);
});

test('disconnecting the mailbox sends email through the server again', async () => {
  const st = await ok(await req('DELETE', '/v1/admin/integrations/email', undefined, owner));
  assert.equal(st.connected, false);
  const s0 = shared.length;
  await ok(await req('POST', '/v1/admin/volunteers/assignments', { eventId: ev.id, teamId: team.id, positionId: team.positions[0].id, personId: mary.id, force: true }, owner));
  await settle();
  assert.equal(shared.length, s0 + 1);
  assert.equal(shared.at(-1)!.to, 'mary@example.test');
  assert.equal((await req('POST', '/v1/admin/integrations/email/test', { to: 'x@y.test' }, owner)).status, 404);
});
