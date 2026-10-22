// Flockwise as an MCP server (Model Context Protocol, Streamable HTTP, stateless JSON responses).
// Claude and other AI assistants connect with a church API key and get tools that call the same
// endpoints the church office uses, with the permissions of the staff member who made the key.
import type { AuthClaims, Request } from './engine.js';
import { ApiError } from './errors.js';

type Handle = (req: Request) => Promise<unknown>;
type Json = Record<string, unknown>;
export type Tool = {
  name: string;
  title: string;
  description: string;
  props?: Record<string, Json>;
  required?: string[];
  write?: boolean;
  call: (a: Json) => { method: string; path: string; query?: Record<string, string>; body?: unknown };
};

const PROTOCOL = '2025-06-18';
const str = (description: string, extra: Json = {}): Json => ({ type: 'string', description, ...extra });
const q = (a: Json, keys: string[]) => Object.fromEntries(keys.filter((k) => a[k] !== undefined && a[k] !== '').map((k) => [k, String(a[k])]));
const id = (v: unknown) => encodeURIComponent(String(v ?? ''));

export const TOOLS: Tool[] = [
  { name: 'church_overview', title: 'Church overview', description: 'This week at a glance: attendance, giving, new people, upcoming events and things that need attention.', call: () => ({ method: 'GET', path: '/admin/dashboard' }) },
  { name: 'church_insights', title: 'Growth and engagement insights', description: 'Trends in attendance, giving, group and volunteer engagement, and people drifting away.', call: () => ({ method: 'GET', path: '/admin/insights' }) },
  {
    name: 'search_people', title: 'Search people', description: 'Find members and visitors by name, email, phone or tag. Returns contact details and status.',
    props: { query: str('Name, email or phone to search for'), status: str('member, regular, visitor or inactive'), tag: str('Only people with this tag') },
    call: (a) => ({ method: 'GET', path: '/admin/people', query: { q: String(a.query ?? ''), ...q(a, ['status', 'tag']) } }),
  },
  { name: 'get_person', title: 'Person profile', description: 'One person’s full profile: household, groups, serving, giving summary and notes.', props: { personId: str('The person id from search_people') }, required: ['personId'], call: (a) => ({ method: 'GET', path: `/admin/people/${id(a.personId)}` }) },
  { name: 'person_timeline', title: 'Person timeline', description: 'Everything that happened with a person: attendance, gifts, messages, care notes.', props: { personId: str('The person id') }, required: ['personId'], call: (a) => ({ method: 'GET', path: `/admin/people/${id(a.personId)}/timeline` }) },
  { name: 'upcoming_celebrations', title: 'Birthdays and anniversaries', description: 'Upcoming birthdays, wedding and baptism anniversaries.', props: { days: { type: 'integer', description: 'How many days ahead (default 30)' } }, call: (a) => ({ method: 'GET', path: '/admin/celebrations', query: q(a, ['days']) }) },
  { name: 'list_events', title: 'Events', description: 'Upcoming events and services (or past ones).', props: { when: str('upcoming (default) or past', { enum: ['upcoming', 'past'] }) }, call: (a) => ({ method: 'GET', path: '/admin/events', query: q(a, ['when']) }) },
  { name: 'event_attendees', title: 'Event attendees', description: 'Who is going to, or attended, an event.', props: { eventId: str('The event id from list_events') }, required: ['eventId'], call: (a) => ({ method: 'GET', path: `/admin/events/${id(a.eventId)}/attendees` }) },
  { name: 'service_plan', title: 'Service plan', description: 'The order of service for an event: songs, readings, sermon, who leads each item, and timings.', props: { eventId: str('The event id') }, required: ['eventId'], call: (a) => ({ method: 'GET', path: `/admin/services/${id(a.eventId)}` }) },
  { name: 'volunteer_schedule', title: 'Volunteer rota', description: 'Who is serving at an event, by team, and who has not confirmed.', props: { eventId: str('The event id') }, required: ['eventId'], call: (a) => ({ method: 'GET', path: `/admin/volunteers/schedule/${id(a.eventId)}` }) },
  { name: 'list_groups', title: 'Small groups', description: 'Small groups and ministries with leaders, meeting times and member counts.', call: () => ({ method: 'GET', path: '/admin/groups' }) },
  { name: 'list_donations', title: 'Gifts', description: 'Recent gifts with donor, fund, amount and method. Filter by fund or date (YYYY-MM-DD).', props: { query: str('Donor name'), fundId: str('Fund id'), from: str('From date, YYYY-MM-DD'), to: str('To date, YYYY-MM-DD') }, call: (a) => ({ method: 'GET', path: '/admin/giving/donations', query: { ...q(a, ['fundId', 'from', 'to']), ...(a.query ? { q: String(a.query) } : {}) } }) },
  { name: 'list_care_cases', title: 'Pastoral care', description: 'Open pastoral care cases and follow-ups, with who is assigned.', call: () => ({ method: 'GET', path: '/admin/care' }) },
  { name: 'list_prayer_requests', title: 'Prayer requests', description: 'Prayer requests shared with the church office.', call: () => ({ method: 'GET', path: '/admin/prayer' }) },
  {
    name: 'add_person', title: 'Add a person', description: 'Add a new member or visitor to the church database.', write: true,
    props: { firstName: str('First name'), lastName: str('Last name'), email: str('Email'), phone: str('Mobile number'), status: str('visitor (default), regular or member', { enum: ['visitor', 'regular', 'member'] }) },
    required: ['firstName'],
    call: (a) => ({ method: 'POST', path: '/admin/people', body: { status: 'visitor', ...a } }),
  },
  {
    name: 'create_care_case', title: 'Create a care follow-up', description: 'Open a pastoral care follow-up, optionally for a person.', write: true,
    props: { title: str('What needs follow-up'), personId: str('Person id, if it is about someone'), note: str('Details') },
    required: ['title'],
    call: (a) => ({ method: 'POST', path: '/admin/care', body: a }),
  },
  {
    name: 'post_announcement', title: 'Post an announcement', description: 'Publish an announcement to the member app and website.', write: true,
    props: { title: str('Headline'), body: str('The announcement text'), draft: { type: 'boolean', description: 'Save as a draft instead of publishing' } },
    required: ['title', 'body'],
    call: (a) => ({ method: 'POST', path: '/admin/announcements', body: { title: a.title, body: a.body, status: a.draft ? 'draft' : 'published' } }),
  },
  {
    name: 'send_message', title: 'Send a message', description: 'Send an email, SMS or WhatsApp message to people, a group or a team. Confirm the text and audience with the user first. Use {{firstName}} to personalise.', write: true,
    props: {
      channel: str('email, sms or whatsapp', { enum: ['email', 'sms', 'whatsapp'] }),
      audienceType: str('everyone, status, group, team, tag, campus or people', { enum: ['everyone', 'status', 'group', 'team', 'tag', 'campus', 'people'] }),
      audienceIds: { type: 'array', items: { type: 'string' }, description: 'Ids (or status/tag names) for the audience; empty for everyone' },
      subject: str('Email subject'),
      body: str('The message'),
    },
    required: ['channel', 'audienceType', 'body'],
    call: (a) => ({ method: 'POST', path: '/admin/messages', body: { channel: a.channel, audience: { type: a.audienceType, ids: Array.isArray(a.audienceIds) ? a.audienceIds : [] }, subject: a.subject ?? '', body: a.body, send: true } }),
  },
];

/** Keeps answers within what an assistant can read: long lists are cut to the first 50. */
export function trim(v: unknown): unknown {
  if (Array.isArray(v)) return v.length > 50 ? [...v.slice(0, 50), { note: `${v.length - 50} more not shown` }] : v;
  if (v && typeof v === 'object' && Array.isArray((v as Json).data)) return { ...(v as Json), data: trim((v as Json).data) };
  return v;
}

function listTools(readOnly: boolean) {
  return TOOLS.filter((t) => !readOnly || !t.write).map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: { type: 'object', properties: t.props ?? {}, ...(t.required ? { required: t.required } : {}) },
    annotations: { readOnlyHint: !t.write, destructiveHint: false, openWorldHint: t.name === 'send_message' },
  }));
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Json };

/**
 * Handles one MCP JSON-RPC message (or a batch). Returns null for notifications, which get an
 * empty 202 reply. `apiKey` is the church key from the Authorization header.
 */
export function createMcp(handle: Handle, verify: (apiKey: string) => AuthClaims) {
  async function one(msg: Rpc, auth: AuthClaims, churchName: string): Promise<Json | null> {
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id ?? null, result });
    const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
    if (msg.id === undefined || msg.id === null) return null; // notification (e.g. notifications/initialized)
    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'flockwise', title: 'Flockwise', version: '1.0.0' },
          instructions: `Church management data for ${churchName}. People, events, services, groups, giving, care and messages. Ask before sending messages or changing data.`,
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: listTools(!!auth.readOnly) });
      case 'tools/call': {
        const name = String(msg.params?.name ?? '');
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) return fail(-32602, `Unknown tool: ${name}`);
        if (tool.write && auth.readOnly) return reply({ isError: true, content: [{ type: 'text', text: 'This API key is read-only. Ask a church admin for a full-access key to make changes.' }] });
        const args = (msg.params?.arguments ?? {}) as Json;
        for (const r of tool.required ?? []) if (args[r] === undefined || args[r] === '') return reply({ isError: true, content: [{ type: 'text', text: `Missing ${r}.` }] });
        try {
          const c = tool.call(args);
          const result = await handle({ method: c.method, path: c.path, query: c.query, body: c.body, auth });
          return reply({ content: [{ type: 'text', text: JSON.stringify(trim(result) ?? { ok: true }) }] });
        } catch (e) {
          return reply({ isError: true, content: [{ type: 'text', text: e instanceof ApiError ? e.message : 'Something went wrong.' }] });
        }
      }
      default:
        return fail(-32601, `Method not found: ${msg.method}`);
    }
  }

  return async function mcp(body: unknown, apiKey: string | null | undefined, churchName: string): Promise<unknown> {
    if (!apiKey) throw new ApiError(401, 'invalid_api_key', 'Connect with a Flockwise API key: Authorization: Bearer fw_live_...');
    const auth = verify(apiKey);
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => one(m as Rpc, auth, churchName)))).filter(Boolean);
      return out.length ? out : null;
    }
    if (!body || typeof body !== 'object') return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
    return one(body as Rpc, auth, churchName);
  };
}
