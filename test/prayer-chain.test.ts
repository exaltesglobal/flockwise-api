// The prayer chain (opt in, send a request out, PRAYED replies) and the two-way "we miss you" check-in.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { answer, intentOf } from '../src/core/modules/whatsapp-bot.js';
import { seedDemo } from '../src/core/seed.js';

// A fixed mid-morning so the daily automations run.
const env = createDemoEnv({ now: () => new Date('2026-10-22T05:00:00.000Z') });
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(audience: 'admin' | 'member', email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown) => engine.handle({ method, path, body, auth }) as Promise<any>;

test('intentOf knows the prayer-chain words', () => {
  assert.equal(intentOf('Join prayer chain'), 'chain_join');
  assert.equal(intentOf('prayer chain'), 'chain_join');
  assert.equal(intentOf('leave the prayer chain'), 'chain_leave');
  assert.equal(intentOf('Prayed 🙏'), 'prayed');
  assert.equal(intentOf('🙏'), 'prayed');
  assert.equal(intentOf('Amen'), 'prayed');
  assert.equal(intentOf('please pray for my exam'), 'prayer_ask');
});

test('members join the chain, the office sends a request, PRAYED on WhatsApp counts', async () => {
  const member = await signIn('member', 'priya@example.com');
  const before = await call(member, 'GET', '/me/preferences');
  assert.equal(before.prayerChain, false);
  const prefs = await call(member, 'PATCH', '/me/preferences', { prayerChain: true });
  assert.equal(prefs.prayerChain, true);

  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const chain = await call(owner, 'GET', '/admin/prayer/chain');
  assert.ok(chain.members >= 1);
  assert.ok(chain.people.some((p: any) => p.name === 'Priya Thomas'));

  // Someone else asks for prayer; the office sends it to the chain.
  const ctx = engine.systemCtx();
  const asker = db.all('people').find((p) => p.status === 'member' && p.id !== member.sub && p.phone)!;
  const pr = db.put('prayer', { id: 'pr_chain_test', personId: asker.id, name: `${asker.firstName} ${asker.lastName}`, text: 'Please pray for my mother in hospital.', visibility: 'pastors', status: 'open', prayedBy: [], createdAt: ctx.now.toISOString(), answeredNote: null });
  const outboxBefore = env.outbox.length;
  const sent = await call(owner, 'POST', `/admin/prayer/${pr.id}/chain`);
  assert.equal(sent.chainCount, 1);
  assert.ok(sent.chainSentAt);
  const wa = env.outbox.slice(outboxBefore).filter((o) => o.channel === 'whatsapp');
  assert.equal(wa.length, 1);
  assert.match(wa[0].text, /Prayer chain/);
  assert.match(wa[0].text, /mother in hospital/);
  assert.match(wa[0].text, /Reply PRAYED/);
  // Her name is private (pastors-only request): first name only.
  assert.doesNotMatch(wa[0].text, new RegExp(asker.lastName));

  // Priya replies PRAYED on WhatsApp.
  const r = answer(ctx, { phone: '+91 98765 43210', name: 'Priya', text: 'Prayed 🙏' });
  assert.equal(r.intent, 'prayed');
  assert.match(r.reply, /1 person has prayed/);
  assert.deepEqual(db.get('prayer', pr.id)!.prayedBy, [member.sub]);
  // Again does not double count.
  assert.match(answer(ctx, { phone: '+91 98765 43210', name: 'Priya', text: 'amen' }).reply, /1 person has prayed/);

  // Leaving and joining on WhatsApp.
  assert.equal(answer(ctx, { phone: '+91 98765 43210', name: 'Priya', text: 'leave prayer chain' }).intent, 'chain_leave');
  assert.equal(db.get('people', member.sub)!.prayerChain, false);
  assert.equal(answer(ctx, { phone: '+91 98765 43210', name: 'Priya', text: 'join prayer chain' }).intent, 'chain_join');
  assert.equal(db.get('people', member.sub)!.prayerChain, true);
  // An unknown number is pointed at the app first.
  assert.match(answer(ctx, { phone: '+91 90000 00000', name: 'Stranger', text: 'join prayer chain' }).reply, /sign in to our app/);
});

test('"we miss you" asks how they are; 1/2/3 replies land on the care case, which goes to the zone leader', async () => {
  const owner = await signIn('admin', 'pastor@gracechurch.in');
  const ctx = engine.systemCtx();
  const staff = db.all('staff').find((s) => s.role === 'owner')!;
  assert.ok(staff.personId, 'the demo owner has a person record');
  const zone = db.put('zones', { id: 'zn_test', name: 'Test zone', parentId: null, leaderIds: [staff.personId], meetingDay: null, area: null, notes: null, active: true, createdAt: ctx.now.toISOString() });
  // Three regulars who have not been in for a month, in that zone, with WhatsApp consent.
  const away = db.all('people').filter((p) => p.status === 'member' && p.phone && p.id !== staff.personId).slice(0, 3);
  for (const p of away) db.put('people', { ...p, zoneId: zone.id, lastAttendedAt: new Date(ctx.now.getTime() - 30 * 86_400_000).toISOString(), consent: { ...p.consent, whatsapp: true } });
  for (const c of db.all('care')) if (away.some((p) => p.id === c.personId)) db.del('care', c.id);
  await call(owner, 'PUT', '/admin/messages/automations', { missing: { enabled: true, channel: 'whatsapp', weeks: 3, createFollowUp: true } });

  const outboxBefore = env.outbox.length;
  await engine.tick();
  const msgs = env.outbox.slice(outboxBefore).filter((o) => o.channel === 'whatsapp' && o.subject === 'We miss you' && away.some((p) => o.to === p.phone));
  assert.equal(msgs.length, 3);
  assert.match(msgs[0].text, /Reply 1 if all is well, 2 if you are travelling/);
  const cases = db.all('care').filter((c) => away.some((p) => p.id === c.personId));
  assert.equal(cases.length, 3);
  assert.ok(cases.every((c) => c.type === 'absent' && c.assignedTo === staff.id), 'cases go to the zone leader');

  const [a, b, c] = away;
  const ok = answer(ctx, { phone: a.phone!, name: a.firstName, text: '1' });
  assert.equal(ok.intent, 'checkin_ok');
  assert.equal(db.all('care').find((x) => x.personId === a.id)!.status, 'closed');

  const travel = answer(ctx, { phone: b.phone!, name: b.firstName, text: 'Travelling to my native place' });
  assert.equal(travel.intent, 'checkin_away');
  const bCase = db.all('care').find((x) => x.personId === b.id)!;
  assert.equal(bCase.status, 'open');
  assert.match(bCase.notes.at(-1)!.text, /travelling/);

  const wantsCall = answer(ctx, { phone: c.phone!, name: c.firstName, text: '3' });
  assert.equal(wantsCall.intent, 'checkin_call');
  const cCase = db.all('care').find((x) => x.personId === c.id)!;
  assert.equal(cCase.priority, 'urgent');
  assert.match(cCase.notes.at(-1)!.text, /asked for a call/);

  // Once answered, "1" means the services menu again.
  assert.equal(answer(ctx, { phone: a.phone!, name: a.firstName, text: '1' }).intent, 'services');
});
