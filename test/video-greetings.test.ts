// The pastor's video greeting: set up once per kind, sent as a personal link on the morning of
// the birthday (parents for a child), watched and replied to without signing in, never twice.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

let clock = Date.parse('2026-11-02T05:00:00.000Z'); // Monday, 10:30 am IST
const env = createDemoEnv({ now: () => new Date(clock), webUrl: 'https://app.example.church' });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(audience: 'admin' | 'member', email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown) => { const [p, qs] = path.split('?'); return engine.handle({ method, path: p, body, auth, query: qs ? Object.fromEntries(new URLSearchParams(qs)) : {} }) as Promise<any>; };
const pub = (method: string, path: string, body?: unknown) => engine.handle({ method, path, body: body ?? null, auth: null, query: {} }) as Promise<any>;
const fails = async (p: Promise<unknown>, status: number, code?: string) => { const e: any = await p.then(() => null, (err) => err); assert.ok(e, `expected ${status}`); assert.equal(e.status, status, e.message); if (code) assert.equal(e.code, code); };

test('set up the recordings, then the morning tick sends everyone celebrating their own link once', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const priya = await signIn('member', 'priya@example.com');
  await fails(call(priya, 'GET', '/admin/video-greetings'), 403);

  let hub = await call(owner, 'GET', '/admin/video-greetings');
  assert.deepEqual(hub.greetings.map((g: any) => g.id), ['birthday', 'child', 'anniversary']);
  assert.ok(hub.greetings.every((g: any) => !g.enabled));
  await fails(call(owner, 'PUT', '/admin/video-greetings/birthday', { enabled: true }), 422);
  await fails(call(owner, 'PUT', '/admin/video-greetings/birthday', { videoUrl: 'not a link' }), 422);
  const b = await call(owner, 'PUT', '/admin/video-greetings/birthday', { videoUrl: 'https://cdn.example.church/pastor-birthday.mp4', fromName: 'Pastor Samuel Raj', enabled: true });
  assert.equal(b.enabled, true);
  assert.ok(b.message.includes('{{firstName}}'));
  await call(owner, 'PUT', '/admin/video-greetings/child', { videoUrl: 'https://cdn.example.church/pastor-kids.mp4', fromName: 'Pastor Samuel Raj', message: 'Happy birthday, {{firstName}}! Jesus loves you.', enabled: true });

  // Priya and her son Joel both have their birthday today.
  await call(owner, 'PATCH', '/admin/people/p_priya', { birthDate: '1990-11-02' });
  await call(owner, 'PATCH', '/admin/people/p_joel', { birthDate: '2018-11-02' });
  await call(priya, 'POST', '/me/devices', { token: 'ExponentPushToken[priya]', platform: 'android', app: 'member' });

  env.outbox.length = 0;
  await engine.tick();
  const links = await call(owner, 'GET', '/admin/video-greetings/links');
  const mine = links.find((l: any) => l.personId === 'p_priya'), joel = links.find((l: any) => l.personId === 'p_joel');
  assert.ok(mine && joel, JSON.stringify(links));
  assert.equal(mine.videoKind, 'birthday');
  assert.equal(joel.videoKind, 'child');
  assert.ok(joel.sentTo.includes('p_priya') && joel.sentTo.includes('p_arun'), 'a child’s link goes to the parents');
  assert.ok(!joel.sentTo.includes('p_anna'));
  assert.match(mine.url, /^https:\/\/app\.example\.church\/g\/[A-Za-z0-9]{12}$/);
  const pushes = env.outbox.filter((o) => o.channel === 'push' && o.to === 'ExponentPushToken[priya]');
  assert.ok(pushes.some((o) => o.subject === 'Happy birthday, Priya!'), JSON.stringify(pushes));
  assert.ok(pushes.some((o) => o.subject === 'A birthday greeting for Joel'));
  assert.ok(env.outbox.some((o) => o.channel === 'whatsapp' && o.to === '+91 98765 43210' && o.text.includes(`/g/${mine.id}`)), 'WhatsApp carries the personal link');

  const n = (await call(owner, 'GET', '/admin/video-greetings/links')).length;
  await engine.tick();
  clock += 3 * 3_600_000;
  await engine.tick();
  assert.equal((await call(owner, 'GET', '/admin/video-greetings/links')).length, n, 'never twice in a year');

  // The celebrations list now shows Priya as greeted; the member app shows both links.
  const today = await call(owner, 'GET', '/admin/celebrations?days=0&kind=birthday');
  assert.equal(today.find((c: any) => c.personId === 'p_priya').greeted, true);
  const mem = await call(priya, 'GET', '/celebrations');
  assert.ok(mem.videoGreetings.length >= 2, 'hers, Joel’s (and anyone else in the household celebrating)');
  assert.ok(mem.videoGreetings.some((g: any) => g.forMe && g.token === mine.id));
  assert.ok(mem.videoGreetings.some((g: any) => !g.forMe && g.firstName === 'Joel'));

  // The page itself: no sign-in, first name and the video only; watching and replying are recorded.
  const page = await pub('GET', `/public/greetings/${mine.id}`);
  assert.equal(page.firstName, 'Priya');
  assert.equal(page.years, 36);
  assert.equal(page.videoUrl, 'https://cdn.example.church/pastor-birthday.mp4');
  assert.equal(page.message, 'Happy birthday, Priya! May the Lord bless you and keep you this year.');
  assert.equal(page.church.brand.primary, '#7a2e2e');
  assert.equal(Object.keys(page).includes('phone'), false);
  await fails(pub('GET', '/public/greetings/nope'), 404);
  await pub('POST', `/public/greetings/${mine.id}/watched`);
  await pub('POST', `/public/greetings/${mine.id}/reply`, { message: 'Thank you pastor, this made my day!' });
  await fails(pub('POST', `/public/greetings/${mine.id}/reply`, { message: '' }), 400);
  hub = await call(owner, 'GET', '/admin/video-greetings');
  const bd = hub.greetings.find((g: any) => g.id === 'birthday');
  const adults = (await call(owner, 'GET', '/admin/video-greetings/links')).filter((l: any) => l.videoKind === 'birthday' && !l.test).length;
  assert.ok(adults >= 1);
  assert.equal(bd.sentThisYear, adults);
  assert.equal(bd.watched, 1);
  assert.equal(bd.replies, 1);
  assert.equal(hub.recent.find((l: any) => l.id === mine.id).reply, 'Thank you pastor, this made my day!');

  // A test send goes to the staff member's own record and is not counted.
  const t = await call(owner, 'POST', '/admin/video-greetings/birthday/test');
  assert.equal(t.personId, 'p_samuel');
  assert.equal(t.test, true);
  hub = await call(owner, 'GET', '/admin/video-greetings');
  assert.equal(hub.greetings.find((g: any) => g.id === 'birthday').sentThisYear, adults, 'tests are not counted');
  await call(owner, 'DELETE', '/admin/video-greetings/child');
  hub = await call(owner, 'GET', '/admin/video-greetings');
  assert.equal(hub.greetings.find((g: any) => g.id === 'child').enabled, false);
});
