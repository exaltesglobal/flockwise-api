// Chitthi (WhatsApp through Agape Labs' platform), API keys and the MCP server.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoEnv } from '../src/core/demo.js';
import { createChurchEngine, Db } from '../src/core/index.js';
import { seedDemo } from '../src/core/seed.js';

const env = createDemoEnv();
const db = new Db();
seedDemo(db, env);
const engine = createChurchEngine(db, env);

async function signIn(email: string) {
  const otp = (await engine.handle({ method: 'POST', path: '/auth/otp/request', body: { email, audience: 'admin' }, auth: null })) as { requestId: string };
  const s = (await engine.handle({ method: 'POST', path: '/auth/otp/verify', body: { requestId: otp.requestId, code: '123456' }, auth: null })) as any;
  return JSON.parse(atob(s.accessToken.slice(5)));
}
const call = (auth: any, method: string, path: string, body?: unknown) => engine.handle({ method, path, body, auth }) as Promise<any>;
const withKey = (apiKey: string, method: string, path: string, body?: unknown, query?: Record<string, string>) => engine.handle({ method, path, body, auth: null, apiKey, query }) as Promise<any>;

test('chitthi: connect, pick a template, send WhatsApp through it, disconnect', async () => {
  const a = await signIn('pastor@gracechurch.in');
  let st = await call(a, 'GET', '/admin/integrations');
  assert.equal(st.chitthi.connected, false);
  assert.match(st.chitthi.signupUrl, /ref=flockwise/);
  await assert.rejects(call(a, 'POST', '/admin/integrations/chitthi', { apiKey: 'nope' }), /chk_live_/);
  await assert.rejects(call(a, 'POST', '/admin/integrations/chitthi', { apiKey: 'chk_live_badbadbad123' }), /did not accept/);
  st = await call(a, 'POST', '/admin/integrations/chitthi', { apiKey: 'chk_live_abcdefgh12345678', template: 'church_update' });
  assert.equal(st.connected, true);
  assert.equal(st.workspace, 'Grace Church WhatsApp');
  assert.equal(st.keyHint, 'chk_live_…5678');
  assert.ok(!JSON.stringify(st).includes('abcdefgh12345678'), 'the key never comes back');
  assert.equal(db.get('integrations', 'chitthi')!.apiKeySealed, 'demo:chk_live_abcdefgh12345678');

  const tpl = await call(a, 'GET', '/admin/integrations/chitthi/templates');
  assert.equal(tpl.available, true);
  assert.equal(tpl.data[1].params, 2);
  const ch = await call(a, 'GET', '/admin/messages/channels');
  assert.equal(ch.whatsapp.configured, true);
  assert.match(ch.whatsapp.provider, /Chitthi/);

  env.outbox.length = 0;
  const msg = await call(a, 'POST', '/admin/messages', { channel: 'whatsapp', audience: { type: 'people', ids: ['p_samuel'] }, body: 'Hi {{firstName}},\nservice at 9', send: true });
  const sent = await call(a, 'GET', '/admin/messages');
  const row = (sent.data ?? sent).find((m: any) => m.id === msg.id);
  assert.equal(row.simulated, false);
  const out = env.outbox.find((o) => o.subject === 'chitthi:church_update');
  assert.ok(out, 'went through Chitthi with the template');
  assert.equal(out!.text, 'Hi Samuel, · service at 9');

  await call(a, 'PATCH', '/admin/integrations/chitthi', { template: 'church_update_hi', language: 'hi', params: 2 });
  env.outbox.length = 0;
  assert.deepEqual(await call(a, 'POST', '/admin/integrations/chitthi/test', { phone: '9848012345' }), { ok: true });
  assert.match(env.outbox[0].text, /^Pastor \| Test from Flockwise/);

  st = await call(a, 'DELETE', '/admin/integrations/chitthi');
  assert.equal(st.connected, false);
});

test('api keys: read-only and full access, revoke, cannot escalate', async () => {
  const a = await signIn('office@gracechurch.in');
  const made = await call(a, 'POST', '/admin/api-keys', { name: 'Zapier' });
  assert.match(made.secret, /^fw_live_/);
  assert.equal(made.key.access, 'read');
  assert.ok(!('hash' in made.key));
  const people = await withKey(made.secret, 'GET', '/admin/people', undefined, { q: 'Samuel' });
  assert.ok(people.data.length >= 1);
  await assert.rejects(withKey(made.secret, 'POST', '/admin/announcements', { title: 'x', body: 'y' }), /only read/);
  await assert.rejects(withKey(made.secret, 'GET', '/admin/api-keys'), /cannot use/);
  await assert.rejects(withKey(made.secret, 'GET', '/me'), /cannot use/);
  const full = await call(a, 'POST', '/admin/api-keys', { name: 'Claude', access: 'full' });
  const ann = await withKey(full.secret, 'POST', '/admin/announcements', { title: 'From the API', body: 'Hello' });
  assert.equal(ann.title, 'From the API');
  await assert.rejects(withKey(full.secret, 'PATCH', '/admin/staff/st_2', { role: 'owner' }), /cannot use/);
  const list = await call(a, 'GET', '/admin/api-keys');
  assert.equal(list.length, 2);
  assert.ok(list[0].lastUsedAt);
  await call(a, 'DELETE', `/admin/api-keys/${made.key.id}`);
  await assert.rejects(withKey(made.secret, 'GET', '/admin/people'), /not valid/);
  await assert.rejects(withKey('fw_live_madeup', 'GET', '/admin/people'), /not valid/);
});

test('mcp: initialize, list tools, call read and write tools', async () => {
  const a = await signIn('pastor@gracechurch.in');
  const ro = (await call(a, 'POST', '/admin/api-keys', { name: 'Claude (read)' })).secret;
  const rw = (await call(a, 'POST', '/admin/api-keys', { name: 'Claude', access: 'full' })).secret;
  await assert.rejects(engine.mcp({ jsonrpc: '2.0', id: 1, method: 'initialize' }, null), /API key/);
  const init: any = await engine.mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, ro);
  assert.equal(init.result.serverInfo.name, 'flockwise');
  assert.equal(await engine.mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, ro), null);
  const roTools: any = await engine.mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ro);
  const rwTools: any = await engine.mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, rw);
  assert.ok(!roTools.result.tools.some((t: any) => t.name === 'send_message'));
  assert.ok(rwTools.result.tools.some((t: any) => t.name === 'send_message'));
  const found: any = await engine.mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_people', arguments: { query: 'Samuel' } } }, ro);
  assert.match(found.result.content[0].text, /Samuel/);
  const denied: any = await engine.mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'add_person', arguments: { firstName: 'Asha' } } }, ro);
  assert.equal(denied.result.isError, true);
  const added: any = await engine.mcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'add_person', arguments: { firstName: 'Asha', lastName: 'Kurian', phone: '9000000001' } } }, rw);
  assert.equal(JSON.parse(added.result.content[0].text).firstName, 'Asha');
  const missing: any = await engine.mcp({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_person', arguments: {} } }, ro);
  assert.equal(missing.result.isError, true);
  const notFound: any = await engine.mcp({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_person', arguments: { personId: 'p_nobody' } } }, ro);
  assert.equal(notFound.result.isError, true);
  const unknown: any = await engine.mcp({ jsonrpc: '2.0', id: 8, method: 'nope' }, ro);
  assert.equal(unknown.error.code, -32601);
  for (const t of rwTools.result.tools) {
    const r: any = await engine.mcp({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: t.name, arguments: { eventId: 'ev_1', personId: 'p_samuel', title: 'T', body: 'B', channel: 'email', subject: 'S', audienceType: 'people', audienceIds: ['p_samuel'], firstName: 'Z' } } }, rw);
    assert.ok(!r.result.isError, `${t.name}: ${r.result.content[0].text}`);
  }
});
