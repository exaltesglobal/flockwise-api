// Connections: Zoom meetings on events, the church's Google Cloud Storage bucket (media
// library with signed uploads), and Canva designs. Outside services are stubbed.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.WEB_URL = 'https://app.example';
process.env.API_PUBLIC_URL = 'https://api.example';
process.env.CHURCH_ID = 'ch_main';
process.env.CHURCH_NAME = 'First Church';
process.env.CHURCH_SLUG = 'first';
process.env.OWNER_EMAIL = 'owner@first.test';
process.env.CANVA_CLIENT_ID = 'canva-app-id';
process.env.CANVA_CLIENT_SECRET = 'canva-app-secret';

const { createApp } = await import('../src/app.js');
const { buildServer, bootstrap } = await import('../src/server.js');
const { googleSignedUrl } = await import('../src/google.js');
type HttpRequest = import('../src/core/index.js').HttpRequest;

const server = buildServer();
bootstrap(server);
const codes = new Map<string, string>();
server.hooks.sendOtpEmail = async (to, code) => void codes.set(to, code);
const calls: HttpRequest[] = [];
const reply = (status: number, data: unknown) => ({ status, headers: {}, text: data === null ? '' : JSON.stringify(data) });
server.hooks.http = async (req) => {
  calls.push(req);
  const u = req.url;
  const auth = req.headers?.Authorization ?? '';
  if (u.startsWith('https://zoom.us/oauth/token')) return auth.includes(Buffer.from('bad-id:').toString('base64').slice(0, 6)) ? reply(400, { reason: 'Invalid client' }) : reply(200, { access_token: 'ztok' });
  if (u === 'https://api.zoom.us/v2/users/me') return reply(200, { email: 'office@first.test', first_name: 'First', last_name: 'Office' });
  if (u === 'https://api.zoom.us/v2/users/me/meetings') return reply(201, { id: 91234567890, join_url: 'https://zoom.us/j/91234567890?pwd=abc', start_url: 'https://zoom.us/s/91234567890?zak=x', password: '112233' });
  if (u.startsWith('https://api.zoom.us/v2/meetings/')) return reply(204, null);
  if (u.includes('storage.googleapis.com/storage/v1/b/missing')) return reply(404, { error: { message: 'Not Found' } });
  if (u.includes('/iam')) return reply(200, { bindings: [] });
  if (u.startsWith('https://storage.googleapis.com/storage/v1/b/')) return req.method === 'DELETE' ? reply(204, null) : reply(200, { name: 'first-media' });
  if (u.endsWith('/oauth/token')) return reply(200, { access_token: 'ctok', refresh_token: 'crefresh', expires_in: 14400 });
  if (u.endsWith('/users/me/profile')) return reply(200, { display_name: 'Anna', team_name: 'First Church' });
  if (u.endsWith('/asset-uploads')) return reply(200, { job: { id: 'j1', status: 'in_progress' } });
  if (u.endsWith('/asset-uploads/j1')) return reply(200, { job: { id: 'j1', status: 'success', asset: { id: 'asset1' } } });
  if (u.endsWith('/designs/DAF1') && req.method === 'GET') return reply(200, { design: { id: 'DAF1', title: 'Christmas card final', urls: { edit_url: 'https://www.canva.com/design/DAF1/edit', view_url: 'https://www.canva.com/design/DAF1/view' }, thumbnail: { url: 'https://document-export.canva.com/thumb.png' } } });
  if (u.endsWith('/exports')) return reply(200, { job: { id: 'e1', status: 'in_progress' } });
  if (u.endsWith('/exports/e1')) return reply(200, { job: { id: 'e1', status: 'success', urls: ['https://export-download.canva.com/p1.png', 'https://export-download.canva.com/p2.png'] } });
  if (u.startsWith('https://export-download.canva.com/')) return { status: 200, headers: {}, text: '', bytes: new Uint8Array([137, 80, 78, 71, 1, 2]) };
  if (u.startsWith('https://storage.googleapis.com/upload/storage/v1/b/first-media/o?')) return reply(200, { name: 'ok' });
  if (u.endsWith('/designs')) return reply(200, { design: { id: 'DAF1', title: 'Christmas card', urls: { edit_url: 'https://www.canva.com/design/DAF1/edit', view_url: 'https://www.canva.com/design/DAF1/view' } } });
  return reply(404, { message: `no stub for ${u}` });
};
// Real V4 signing with a throwaway key; the token exchange is stubbed.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
server.hooks.google = { accessToken: async (key) => (key.privateKey === 'BAD' ? Promise.reject(new Error('invalid_grant')) : 'gtok'), signedUrl: (key, input) => googleSignedUrl(key, input) };
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
let ev: any;

test('Zoom: connect with the app details, put a meeting on an event, members see the join link', async () => {
  owner = await signIn('admin', 'owner@first.test');
  const st = await ok(await req('GET', '/v1/admin/integrations', undefined, owner));
  assert.equal(st.zoom.connected, false);
  assert.equal(st.gcs.connected, false);
  assert.equal(st.canva.available, true);
  assert.equal((await req('POST', '/v1/admin/integrations/zoom', { accountId: 'acc', clientId: 'bad-id', clientSecret: 's' }, owner)).status, 422);
  const z = await ok(await req('POST', '/v1/admin/integrations/zoom', { accountId: 'acc1', clientId: 'cid', clientSecret: 'csecret' }, owner));
  assert.equal(z.connected, true);
  assert.equal(z.userEmail, 'office@first.test');
  const now = Date.now();
  ev = await ok(await req('POST', '/v1/admin/events', { title: 'Midweek prayer', startsAt: new Date(now + 86_400_000).toISOString(), endsAt: new Date(now + 86_400_000 + 3_600_000).toISOString(), location: 'Online', published: true }, owner));
  const withZoom = await ok(await req('POST', `/v1/admin/events/${ev.id}/zoom`, undefined, owner));
  assert.equal(withZoom.meetingUrl, 'https://zoom.us/j/91234567890?pwd=abc');
  assert.equal(withZoom.zoom.passcode, '112233');
  const create = calls.find((c) => c.url.endsWith('/users/me/meetings'))!;
  const body = JSON.parse(create.body as string);
  assert.equal(body.duration, 60);
  assert.equal(body.topic, 'Midweek prayer');
  assert.ok(!create.body!.toString().includes('csecret'), 'the secret is never sent to the meetings endpoint');
  // Members get the link; the start link and passcode stay in the office.
  await ok(await req('POST', '/v1/admin/people', { firstName: 'Mary', lastName: 'Joseph', email: 'mary@example.test', status: 'member' }, owner));
  const member = await signIn('member', 'mary@example.test');
  const seen = await ok(await req('GET', `/v1/events/${ev.id}`, undefined, member));
  assert.equal(seen.meetingUrl, 'https://zoom.us/j/91234567890?pwd=abc');
  assert.equal(seen.zoom, undefined);
  // Removing the meeting clears the link; a hand-typed link stays.
  const cleared = await ok(await req('DELETE', `/v1/admin/events/${ev.id}/zoom`, undefined, owner));
  assert.equal(cleared.meetingUrl, null);
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/meetings/91234567890')));
  const manual = await ok(await req('PATCH', `/v1/admin/events/${ev.id}`, { meetingUrl: 'https://meet.google.com/abc-defg-hij' }, owner));
  assert.equal(manual.meetingUrl, 'https://meet.google.com/abc-defg-hij');
});

test('Google Cloud Storage: a bucket and key are checked, uploads get signed URLs, private buckets get signed links', async () => {
  const sa = { type: 'service_account', project_id: 'first-church', client_email: 'media@first-church.iam.gserviceaccount.com', private_key: pem };
  assert.equal((await req('POST', '/v1/admin/integrations/gcs', { bucket: 'first-media', serviceAccount: 'not json' }, owner)).status, 422);
  assert.equal((await req('POST', '/v1/admin/integrations/gcs', { bucket: 'missing', serviceAccount: JSON.stringify(sa) }, owner)).status, 422);
  assert.equal((await req('POST', '/v1/admin/integrations/gcs', { bucket: 'first-media', serviceAccount: JSON.stringify({ ...sa, private_key: 'BAD' }) }, owner)).status, 422);
  const g = await ok(await req('POST', '/v1/admin/integrations/gcs', { bucket: 'gs://first-media', serviceAccount: JSON.stringify(sa) }, owner));
  assert.equal(g.connected, true);
  assert.equal(g.bucket, 'first-media');
  assert.equal(g.publicRead, false);
  assert.equal(g.clientEmail, sa.client_email);
  // The private key never comes back.
  const st = await ok(await req('GET', '/v1/admin/integrations', undefined, owner));
  assert.ok(!JSON.stringify(st).includes('PRIVATE KEY'));

  const up = await ok(await req('POST', '/v1/admin/media/uploads', { name: 'Christmas choir.jpg', contentType: 'image/jpeg', size: 123_456, folder: 'events' }, owner));
  assert.equal(up.item.status, 'pending');
  assert.match(up.item.object, /^ch_main\/events\/\d{4}-\d{2}\/md_[\w-]+-Christmas-choir\.jpg$/);
  assert.ok(up.uploadUrl.startsWith('https://storage.googleapis.com/first-media/ch_main/events/'));
  assert.match(up.uploadUrl, /X-Goog-Algorithm=GOOG4-RSA-SHA256/);
  assert.match(up.uploadUrl, /X-Goog-SignedHeaders=content-type%3Bhost/);
  assert.match(up.uploadUrl, /X-Goog-Signature=[0-9a-f]{512}$/);
  assert.equal(up.headers['Content-Type'], 'image/jpeg');
  assert.equal((await req('POST', '/v1/admin/media/uploads', { name: 'x.exe', contentType: 'application/octet-stream' }, owner)).status, 422);

  const done = await ok(await req('POST', `/v1/admin/media/${up.item.id}/complete`, { size: 123_456 }, owner));
  assert.equal(done.status, 'ready');
  // Private bucket: the link is signed for reading.
  assert.match(done.url, /^https:\/\/storage\.googleapis\.com\/first-media\/.*X-Goog-Signature=/);
  assert.match(done.url, /X-Goog-Expires=604800/);
  const list = await ok(await req('GET', '/v1/admin/media?folder=events', undefined, owner));
  assert.equal(list.data.length, 1);
  assert.equal(list.gcs.files, 1);
  assert.equal(list.gcs.bytes, 123_456);
  assert.equal((await ok(await req('GET', '/v1/admin/media?folder=sermons', undefined, owner))).data.length, 0);

  await ok(await req('DELETE', `/v1/admin/media/${up.item.id}`, undefined, owner), 204);
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.includes('/b/first-media/o/')));
  assert.equal((await ok(await req('GET', '/v1/admin/media', undefined, owner))).data.length, 0);
});

test('Canva: the office is sent to Canva, comes back connected, and opens a design from a picture', async () => {
  const start = await ok(await req('GET', '/v1/admin/integrations/canva/connect', undefined, owner));
  assert.ok(start.url.startsWith('https://www.canva.com/api/oauth/authorize?'));
  const u = new URL(start.url);
  assert.equal(u.searchParams.get('client_id'), 'canva-app-id');
  assert.equal(u.searchParams.get('code_challenge_method'), 's256');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://api.example/v1/integrations/canva/callback');
  assert.ok(start.state.startsWith('ch_main.'));
  // Canva redirects to the host route, which hands the code to the church.
  const back = await app.request(`/v1/integrations/canva/callback?code=abc&state=${start.state}`);
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('location'), 'https://app.example/admin/settings?canva=connected#integrations');
  const token = calls.find((c) => c.url.endsWith('/oauth/token') && (c.body as string).includes('authorization_code'))!;
  assert.match(token.body as string, /code_verifier=/);
  const st = await ok(await req('GET', '/v1/admin/integrations', undefined, owner));
  assert.equal(st.canva.connected, true);
  assert.equal(st.canva.userName, 'Anna');
  // A used state cannot be replayed.
  assert.equal((await app.request(`/v1/integrations/canva/callback?code=abc&state=${start.state}`)).headers.get('location')?.includes('canva=error'), true);

  const png = 'data:image/png;base64,' + Buffer.from('fake-png').toString('base64');
  const d = await ok(await req('POST', '/v1/admin/canva/designs', { kind: 'invitation', title: 'Christmas card', imageDataUrl: png }, owner));
  assert.equal(d.editUrl, 'https://www.canva.com/design/DAF1/edit');
  const upload = calls.find((c) => c.url.endsWith('/asset-uploads'))!;
  assert.equal(upload.headers?.['Content-Type'], 'application/octet-stream');
  assert.ok(upload.headers?.['Asset-Upload-Metadata']);
  const make = calls.find((c) => c.url.endsWith('/designs'))!;
  assert.deepEqual(JSON.parse(make.body as string), { design_type: { type: 'custom', width: 1080, height: 1350 }, title: 'Christmas card', asset_id: 'asset1' });
  assert.equal((await ok(await req('GET', '/v1/admin/canva/designs', undefined, owner))).length, 1);
  // Bring it back: fresh title and thumbnail, then a two-page PNG export copied into the media library.
  const fresh = await ok(await req('POST', '/v1/admin/canva/designs/DAF1/refresh', {}, owner));
  assert.equal(fresh.title, 'Christmas card final');
  assert.equal(fresh.thumbnailUrl, 'https://document-export.canva.com/thumb.png');
  const ex = await ok(await req('POST', '/v1/admin/canva/designs/DAF1/export', { format: 'png' }, owner));
  assert.deepEqual(JSON.parse(calls.find((c) => c.url.endsWith('/exports'))!.body as string), { design_id: 'DAF1', format: { type: 'png' } });
  assert.ok(calls.find((c) => c.url.startsWith('https://export-download.canva.com/'))!.binary);
  assert.equal(ex.urls.length, 2);
  assert.equal(ex.media.length, 2);
  assert.equal(ex.media[0].folder, 'events');
  assert.equal(ex.media[1].name, 'Christmas card final (page 2).png');
  const put = calls.find((c) => c.url.startsWith('https://storage.googleapis.com/upload/'))!;
  assert.equal(put.headers?.['Content-Type'], 'image/png');
  assert.ok(put.body instanceof Uint8Array);
  assert.equal(ex.design.lastExport.mediaIds.length, 2);
  assert.equal((await ok(await req('GET', '/v1/admin/media?folder=events', undefined, owner))).data.length, 2);
  const off = await ok(await req('DELETE', '/v1/admin/integrations/canva', undefined, owner));
  assert.equal(off.connected, false);
});
