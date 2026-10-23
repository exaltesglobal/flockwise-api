// Features on/off: a church picks what shows in its office menu; core features can't be switched off.
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
const { featureOn } = await import('../src/core/features.js');

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

test('features: defaults, switching, and core ones stay on', async () => {
  const r = await ok(await req('POST', '/v1/auth/otp/request', { email: 'owner@first.test', audience: 'admin' }));
  const owner = (await ok(await req('POST', '/v1/auth/otp/verify', { requestId: r.requestId, code: codes.get('owner@first.test') }))).accessToken as string;

  const before = await ok(await req('GET', '/v1/admin/settings', undefined, owner));
  assert.equal(featureOn(before.features, 'carols'), false);
  assert.equal(featureOn(before.features, 'sermons'), true);

  const s = await ok(await req('PATCH', '/v1/admin/settings', { features: { carols: true, sermons: false, people: false, nonsense: true, camps: 'yes' } }, owner));
  assert.deepEqual(s.features, { carols: true, sermons: false });
  assert.equal(featureOn(s.features, 'people'), true);

  const again = await ok(await req('PATCH', '/v1/admin/settings', { features: { carols: false } }, owner));
  assert.deepEqual(again.features, { carols: false, sermons: false });
});
