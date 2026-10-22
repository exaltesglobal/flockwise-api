// Brand kit: colours and font saved with the church, sent with every session, and the letterhead
// (logo beside the name) wrapped around every email the church sends.
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
const { brandedHtml } = await import('../src/core/mail.js');

const server = buildServer();
bootstrap(server);
const codes = new Map<string, string>();
server.hooks.sendOtpEmail = async (to, code) => void codes.set(to, code);
const sent: { to: string; subject: string; text: string; html?: string }[] = [];
server.hooks.deliver = async (_c, batch) => {
  sent.push(...batch);
  return batch.map(() => ({ ok: true }));
};
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
const LOGO = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#733"/></svg>');

test('the office saves a brand kit and bad colours are refused', async () => {
  owner = await signIn('admin', 'owner@first.test');
  const s = await ok(await req('PATCH', '/v1/admin/settings', { logoUrl: LOGO, brand: { primary: '#7A2E2E', accent: '#e9b949', font: 'classic', tagline: 'Since 1998' } }, owner));
  assert.deepEqual(s.brand, { primary: '#7a2e2e', accent: '#e9b949', font: 'classic', logoDarkUrl: null, tagline: 'Since 1998' });
  assert.equal(s.logoUrl, LOGO);
  // A partial change keeps the rest.
  const s2 = await ok(await req('PATCH', '/v1/admin/settings', { brand: { accent: '#ffffff' } }, owner));
  assert.equal(s2.brand.primary, '#7a2e2e');
  assert.equal(s2.brand.accent, '#ffffff');
  assert.equal((await req('PATCH', '/v1/admin/settings', { brand: { primary: 'red' } }, owner)).status, 422);
  assert.equal((await req('PATCH', '/v1/admin/settings', { brand: { font: 'comic' } }, owner)).status, 422);
  assert.equal((await req('PATCH', '/v1/admin/settings', { logoUrl: 'data:image/png;base64,' + 'A'.repeat(500_000) }, owner)).status, 422);
});

test('every session and the public page carry the brand', async () => {
  const r = await ok(await req('POST', '/v1/auth/otp/request', { email: 'owner@first.test', audience: 'admin' }));
  const session = await ok(await req('POST', '/v1/auth/otp/verify', { requestId: r.requestId, code: codes.get('owner@first.test') }));
  assert.equal(session.church.brand.primary, '#7a2e2e');
  assert.equal(session.church.logoUrl, LOGO);
  await ok(await req('PUT', '/v1/admin/public-page', { enabled: true, tagline: 'Welcome', about: '', serviceTimes: '', heroImageUrl: '', showEvents: true, showGroups: true, showSermons: true, showGiving: true }, owner));
  const pub = await ok(await req('GET', '/v1/public/church'));
  assert.equal(pub.church.brand.font, 'classic');
});

test('emails go out on the letterhead: logo beside the name in the brand colour', async () => {
  sent.length = 0;
  await ok(await req('POST', '/v1/admin/staff', { name: 'Anna Thomas', email: 'anna@first.test', role: 'coordinator' }, owner), 200);
  const m = sent.find((x) => x.to === 'anna@first.test')!;
  assert.ok(m, 'invite email sent');
  assert.ok(m.html, 'has an HTML version');
  assert.match(m.html!, /background:#7a2e2e/);
  assert.match(m.html!, /First Church/);
  assert.ok(m.html!.includes(`src="${LOGO.replace(/&/g, '&amp;')}"`), 'logo image in the header');
  assert.match(m.html!, /Georgia/);
  // Links become clickable and text is escaped.
  const h = brandedHtml({ name: 'A <b> Church', logoUrl: null, brand: undefined, address: '', city: '', website: '' }, { text: 'See https://app.example/admin\n\nBye' });
  assert.match(h, /A &lt;b&gt; Church/);
  assert.match(h, /<a href="https:\/\/app.example\/admin"/);
  assert.match(h, /background:#1f6b5c/);
});
