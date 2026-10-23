// Prayer wall kiosk and QR prayer cards: a visitor sends a request from the card's QR, the lobby
// tablet shows shared requests and counts "I prayed" taps, the office holds the kiosk key.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const clock = Date.parse('2026-11-02T05:00:00.000Z');
const env = createDemoEnv({ now: () => new Date(clock) });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(audience: 'admin' | 'member', email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown) => { const [p, qs] = path.split('?'); return engine.handle({ method, path: p, body, auth, query: qs ? Object.fromEntries(new URLSearchParams(qs)) : {} }) as Promise<any>; };
const fails = async (p: Promise<unknown>, status: number) => { const e: any = await p.then(() => null, (err) => err); assert.ok(e, `expected ${status}`); assert.equal(e.status, status, e.message); };

test('a prayer card in the pew, the lobby kiosk, and the office key', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const priya = await signIn('member', 'priya@example.com');

  const pub = await call(null, 'GET', '/public/prayer');
  assert.equal(pub.enabled, true);
  assert.equal(pub.church.name, 'Grace Community Church');
  assert.ok(pub.stats.open >= 0);
  const church = await call(null, 'GET', '/public/church');
  assert.equal(church.prayer, true);

  // From the QR card: no name, kept for the pastors.
  await fails(call(null, 'POST', '/public/prayer', { text: 'Hi' }), 422);
  let n = env.outbox.length;
  const r1 = await call(null, 'POST', '/public/prayer', { text: 'My son has his board exams next week. Please pray for peace and a clear mind.' });
  assert.equal(r1.ok, true);
  assert.match(r1.message, /^Thank you\./);
  const p1 = db.get('prayer', r1.id)!;
  assert.equal(p1.name, 'A visitor'); assert.equal(p1.visibility, 'pastors'); assert.equal(p1.source, 'card'); assert.equal(p1.personId, null);
  assert.ok(env.outbox.slice(n).some((o) => /Prayer request from A visitor \(prayer card\)/.test(o.subject)), 'pastors are told');
  // From the kiosk, with a phone that matches a member: linked to them; shared on the wall.
  const r2 = await call(null, 'POST', '/public/prayer', { text: 'Thank God for a safe delivery. Pray for the baby and for Anita.', name: 'Priya', phone: '98765 43210', share: true, source: 'kiosk' });
  const p2 = db.get('prayer', r2.id)!;
  assert.equal(p2.personId, 'p_priya'); assert.equal(p2.name, 'Priya Thomas'); assert.equal(p2.visibility, 'church'); assert.equal(p2.source, 'kiosk'); assert.equal(p2.contact, null);
  assert.match(r2.message, /Priya\. .*the church will join them/);
  // A stranger's phone is kept for follow-up.
  const r3 = await call(null, 'POST', '/public/prayer', { text: 'Pray for my mother in hospital.', name: 'Ravi Kumar', phone: '9000012345', share: true });
  assert.equal(db.get('prayer', r3.id)!.contact, '9000012345');
  // Members see the shared ones on their wall, with first-name privacy for strangers handled by the kiosk view.
  const mine = await call(priya, 'GET', '/prayer');
  assert.ok(mine.data.some((p: any) => p.id === r2.id && p.mine));

  // The kiosk needs the key.
  await fails(call(null, 'GET', '/public/prayer/wall'), 403);
  await fails(call(null, 'GET', '/public/prayer/wall?k=wrong'), 403);
  let k = await call(owner, 'GET', '/admin/prayer/kiosk');
  assert.equal(k.key.length, 20);
  assert.ok(k.kioskUrl.endsWith(`/pray/wall?k=${k.key}`));
  assert.ok(k.publicUrl.endsWith('/pray'));
  assert.equal(k.stats.fromCards, 2); assert.equal(k.stats.fromKiosk, 1);
  let wall = await call(null, 'GET', `/public/prayer/wall?k=${k.key}&device=tab1`);
  const w3 = wall.requests.find((x: any) => x.id === r3.id);
  assert.equal(w3.name, 'Ravi K.');
  assert.ok(!('contact' in w3) && !('personId' in w3));
  assert.ok(!wall.requests.some((x: any) => x.id === r1.id), 'pastors-only requests stay off the wall');
  // "I prayed" counts once per device.
  let t = await call(null, 'POST', `/public/prayer/wall/${r3.id}/pray?k=${k.key}`, { device: 'tab1' });
  assert.equal(t.prayedCount, 1); assert.equal(t.iPrayed, true);
  t = await call(null, 'POST', `/public/prayer/wall/${r3.id}/pray?k=${k.key}`, { device: 'tab1' });
  assert.equal(t.prayedCount, 1);
  t = await call(null, 'POST', `/public/prayer/wall/${r3.id}/pray?k=${k.key}`, { device: 'phone9' });
  assert.equal(t.prayedCount, 2);
  await fails(call(null, 'POST', `/public/prayer/wall/${r1.id}/pray?k=${k.key}`, { device: 'tab1' }), 404);
  await fails(call(null, 'POST', `/public/prayer/wall/${r3.id}/pray`, { device: 'tab1' }), 403);
  // Priya praying in the app adds to the same count.
  const pv = await call(priya, 'POST', `/prayer/${r3.id}/pray`);
  assert.equal(pv.prayedCount, 3);
  // The office sees the source.
  const adm = await call(owner, 'GET', '/admin/prayer');
  assert.equal(adm.data.find((p: any) => p.id === r2.id).source, 'kiosk');

  // Rotate the key: the old link dies. Switch the public form off: cards stop working, the wall stays.
  const old = k.key;
  k = await call(owner, 'POST', '/admin/prayer/kiosk', { rotate: true });
  assert.notEqual(k.key, old);
  await fails(call(null, 'GET', `/public/prayer/wall?k=${old}`), 403);
  wall = await call(null, 'GET', `/public/prayer/wall?k=${k.key}`);
  assert.ok(wall.requests.length >= 2);
  k = await call(owner, 'POST', '/admin/prayer/kiosk', { enabled: false });
  assert.equal(k.enabled, false);
  await fails(call(null, 'POST', '/public/prayer', { text: 'Anything at all please' }), 404);
  assert.equal((await call(null, 'GET', '/public/church')).prayer, false);
  await fails(call(priya, 'GET', '/admin/prayer/kiosk'), 403);
});
