// Church networks and dioceses. A network leader signs in with an email code at /network, makes a
// network and shares its join code; each church's office joins with that code from Settings. The
// network sees totals for each church (people, attendance, groups, serving, and giving only when the
// church chooses to share it), never anyone's name or details. A church can leave at any time.
// Records live in the platform database next to the church directory.
import type { Db } from './db.js';
import type { Env } from './engine.js';
import { ApiError } from './errors.js';
import type { createChurchEngine } from './index.js';
import { attendanceTrend } from './modules/care.js';
import { activePeople } from './modules/people.js';
import type { ChurchNetworkHost, ChurchNetworkLink, Currency, Network, NetworkChurchStats, NetworkKind, NetworkMembership, NetworkOverview, NetworkSummary, OtpRequest } from './types.js';
import { giftDate } from './util.js';

type ChurchEngine = ReturnType<typeof createChurchEngine>;
type Entry = { id: string; slug: string; name: string; city: string; currency: Currency; status: 'active' | 'suspended' };

export type NetworkDeps = {
  db: Db;
  env: Env;
  engine(id: string): ChurchEngine | undefined;
  entry(id: string): Entry | undefined;
  sendCode(email: string, label: string): Promise<OtpRequest>;
  useCode(requestId: unknown, code: unknown): { email: string; done: () => void };
};

const KINDS: NetworkKind[] = ['network', 'diocese', 'denomination', 'association'];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SESSION_DAYS = 14;
const DAY = 86_400_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();

/** Monday of the week a date falls in. */
function weekStart(date: string) {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** One church's totals for its network. Reads the church's own database; nothing personal leaves it. */
export function churchStats(engine: ChurchEngine, e: Entry, m: NetworkMembership): NetworkChurchStats {
  const ctx = engine.systemCtx();
  const db = engine.db;
  const now = ctx.now;
  const people = db.all('people').filter((p) => p.status !== 'inactive');
  const year = String(now.getUTCFullYear());
  const trend = attendanceTrend(ctx, 12);
  const avg = (xs: { count: number }[]) => (xs.length ? Math.round(xs.reduce((n, x) => n + x.count, 0) / xs.length) : 0);
  const last4 = trend.slice(-4);
  const prev4 = trend.slice(-8, -4);
  const avgAttendance = avg(last4);
  const before = avg(prev4);
  const inGroups = new Set(db.all('groupMembers').map((g) => g.personId)).size;
  const since90 = now.getTime() - 90 * DAY;
  const servingSince = new Date(now.getTime() - 90 * DAY).toISOString();
  const serving = new Set(db.all('assignments').filter((a) => a.status === 'accepted' && a.createdAt >= servingSince).map((a) => a.personId)).size;
  let givingByMonth: { month: string; amount: number }[] | null = null;
  if (m.shareGiving) {
    const months = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + i, 1)).toISOString().slice(0, 7));
    const by = new Map(months.map((x) => [x, 0]));
    for (const d of db.all('donations')) {
      if (d.status !== 'succeeded') continue;
      const k = giftDate(d).slice(0, 7);
      if (by.has(k)) by.set(k, by.get(k)! + d.amount);
    }
    givingByMonth = months.map((month) => ({ month, amount: by.get(month)! }));
  }
  const streams = db.all('streams').filter((s) => s.recorded !== null).sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  const staff = db.all('staff').map((s) => s.lastActiveAt ?? '').sort();
  return {
    churchId: e.id,
    name: db.get('settings', 'church')?.name ?? e.name,
    city: e.city,
    slug: e.slug,
    joinedAt: m.joinedAt,
    currency: e.currency,
    people: activePeople(db),
    members: people.filter((p) => p.status === 'member').length,
    households: new Set(people.map((p) => p.householdName ?? `solo:${p.id}`)).size,
    newPeople90: people.filter((p) => new Date(p.joinedAt).getTime() >= since90).length,
    groups: db.all('groups').length,
    inGroups,
    serving,
    baptismsThisYear: people.filter((p) => p.baptismDate?.startsWith(year)).length,
    lastSunday: trend.at(-1)?.count ?? 0,
    avgAttendance,
    attendanceChange: before ? Math.round(((avgAttendance - before) * 100) / before) : null,
    attendance: trend,
    shareGiving: m.shareGiving,
    giving12m: givingByMonth ? givingByMonth.reduce((n, x) => n + x.amount, 0) : null,
    givingByMonth,
    onlineLastStream: streams[0]?.recorded ?? null,
    lastActiveAt: staff.at(-1) || null,
  };
}

export function createNetworks(deps: NetworkDeps) {
  const { db, env } = deps;
  const now = () => env.now();

  const all = () => db.all('meta').filter((m) => m.id.startsWith('network:')).map((m) => JSON.parse(m.value) as Network);
  const get = (id: string) => {
    const m = db.get('meta', `network:${id}`);
    return m ? (JSON.parse(m.value) as Network) : undefined;
  };
  const put = (n: Network) => db.put('meta', { id: `network:${n.id}`, value: JSON.stringify(n) });
  const memberships = () => db.all('meta').filter((m) => m.id.startsWith('netchurch:')).map((m) => JSON.parse(m.value) as NetworkMembership);
  const membersOf = (networkId: string) => memberships().filter((m) => m.networkId === networkId && deps.entry(m.churchId)?.status === 'active');
  const putMembership = (m: NetworkMembership) => db.put('meta', { id: `netchurch:${m.networkId}:${m.churchId}`, value: JSON.stringify(m) });
  const dropMembership = (networkId: string, churchId: string) => db.del('meta', `netchurch:${networkId}:${churchId}`);
  const byCode = (code: string) => all().find((n) => n.code === code.trim().toUpperCase());
  const newCode = () => {
    for (;;) {
      const c = env.random(8, CODE_ALPHABET);
      if (!byCode(c)) return c;
    }
  };

  function link(n: Network, m: NetworkMembership): ChurchNetworkLink {
    return { id: n.id, name: n.name, kind: n.kind, joinedAt: m.joinedAt, shareGiving: m.shareGiving, churches: membersOf(n.id).length };
  }

  /** What one church's office can do about networks. */
  function hostFor(churchId: string): ChurchNetworkHost {
    const mine = (networkId: string) => {
      const m = memberships().find((x) => x.networkId === networkId && x.churchId === churchId);
      const n = get(networkId);
      if (!m || !n) throw new ApiError(404, 'not_found', 'Your church is not in that network.');
      return { m, n };
    };
    return {
      list: () =>
        memberships()
          .filter((m) => m.churchId === churchId)
          .flatMap((m) => {
            const n = get(m.networkId);
            return n ? [link(n, m)] : [];
          }),
      preview: (code) => {
        const n = byCode(code);
        return n ? { id: n.id, name: n.name, kind: n.kind, churches: membersOf(n.id).length } : null;
      },
      join: (code, shareGiving, by) => {
        const n = byCode(code);
        if (!n) throw new ApiError(404, 'not_found', 'That join code is not right. Ask your network office for it again.');
        const prev = memberships().find((x) => x.networkId === n.id && x.churchId === churchId);
        const m: NetworkMembership = { networkId: n.id, churchId, joinedAt: prev?.joinedAt ?? now().toISOString(), joinedBy: prev?.joinedBy ?? by, shareGiving };
        putMembership(m);
        return link(n, m);
      },
      update: (networkId, shareGiving) => {
        const { m, n } = mine(networkId);
        const next = { ...m, shareGiving };
        putMembership(next);
        return link(n, next);
      },
      leave: (networkId) => {
        mine(networkId);
        dropMembership(networkId, churchId);
      },
    };
  }

  // ----- network leaders -----
  function session(token: string | null | undefined) {
    const m = token ? db.get('meta', `ns:${env.hash(token)}`) : undefined;
    const s = m ? (JSON.parse(m.value) as { email: string; expiresAt: string }) : null;
    if (!s || s.expiresAt < now().toISOString()) throw new ApiError(401, 'unauthorized', 'Please sign in to your network.');
    return s;
  }

  function admin(id: string, email: string) {
    const n = get(id);
    if (!n || !n.admins.includes(email)) throw new ApiError(404, 'not_found', 'Network not found.');
    return n;
  }

  function overview(n: Network): NetworkOverview {
    const churches = membersOf(n.id).flatMap((m) => {
      const e = deps.entry(m.churchId);
      const eng = deps.engine(m.churchId);
      return e && eng ? [churchStats(eng, e, m)] : [];
    });
    churches.sort((a, b) => b.avgAttendance - a.avgAttendance || b.people - a.people);
    const sum = (k: keyof NetworkChurchStats) => churches.reduce((s, c) => s + (Number(c[k]) || 0), 0);
    const weeks = new Map<string, number>();
    const reporting = new Map<string, number>();
    for (const c of churches)
      for (const a of c.attendance) {
        weeks.set(weekStart(a.date), (weeks.get(weekStart(a.date)) ?? 0) + a.count);
        reporting.set(weekStart(a.date), (reporting.get(weekStart(a.date)) ?? 0) + 1);
      }
    // The latest week is left out until as many churches have recorded it as the week before,
    // so a half-counted Sunday does not look like a drop.
    const sorted = [...weeks.keys()].sort();
    while (sorted.length > 1 && reporting.get(sorted.at(-1)!)! < reporting.get(sorted.at(-2)!)!) weeks.delete(sorted.pop()!);
    // Giving adds up only within one currency: the one most of the network's churches use.
    const counts = new Map<Currency, number>();
    for (const c of churches) counts.set(c.currency, (counts.get(c.currency) ?? 0) + 1);
    const currency = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'INR';
    const givers = churches.filter((c) => c.givingByMonth && c.currency === currency);
    const months = (givers[0]?.givingByMonth ?? []).map((x, i) => ({ month: x.month, amount: givers.reduce((s, c) => s + c.givingByMonth![i].amount, 0) }));
    return {
      network: n,
      churches,
      totals: {
        churches: churches.length,
        people: sum('people'),
        members: sum('members'),
        households: sum('households'),
        newPeople90: sum('newPeople90'),
        inGroups: sum('inGroups'),
        serving: sum('serving'),
        baptismsThisYear: sum('baptismsThisYear'),
        lastSunday: sum('lastSunday'),
        avgAttendance: sum('avgAttendance'),
      },
      attendance: [...weeks].sort((a, b) => a[0].localeCompare(b[0])).slice(-12).map(([w, count]) => ({ weekStart: w, count })),
      giving: { currency, churches: givers.length, months, total: months.reduce((s, x) => s + x.amount, 0) },
    };
  }

  const summary = (n: Network): NetworkSummary => ({ id: n.id, name: n.name, kind: n.kind, churches: membersOf(n.id).length });
  const kindOf = (v: unknown): NetworkKind => (KINDS.includes(v as NetworkKind) ? (v as NetworkKind) : 'network');
  const nameOf = (v: unknown) => {
    const name = String(v ?? '').trim().slice(0, 120);
    if (name.length < 3) throw new ApiError(422, 'invalid', 'Enter the network’s name.', { name: 'At least 3 letters' });
    return name;
  };

  /** Requests under /networks. `token` is a network leader's session. */
  async function handle(method: string, parts: string[], body: Record<string, unknown>, token: string | null | undefined): Promise<unknown> {
    const [a, b, c, d] = parts;
    if (a === 'auth' && method === 'POST' && b === 'request') {
      const email = norm(body.email);
      if (!EMAIL_RE.test(email)) throw new ApiError(422, 'invalid', 'Enter a valid email address.', { email: 'Enter a valid email address' });
      return deps.sendCode(email, 'Flockwise networks');
    }
    if (a === 'auth' && method === 'POST' && b === 'verify') {
      const { email, done } = deps.useCode(body.requestId, body.code);
      done();
      const t = env.random(40, 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789');
      const expiresAt = new Date(now().getTime() + SESSION_DAYS * DAY).toISOString();
      db.put('meta', { id: `ns:${env.hash(t)}`, value: JSON.stringify({ email, expiresAt }) });
      return { token: t, email, expiresAt };
    }
    if (a === 'auth' && method === 'POST' && b === 'sign-out') {
      if (token) db.del('meta', `ns:${env.hash(token)}`);
      return undefined;
    }
    const { email } = session(token);
    if (a === 'mine' && method === 'GET') return all().filter((n) => n.admins.includes(email)).map(summary);
    if (a === 'new' && method === 'POST') {
      const n: Network = { id: env.newId('net'), name: nameOf(body.name), kind: kindOf(body.kind), code: newCode(), admins: [email], createdAt: now().toISOString(), createdBy: email };
      put(n);
      return summary(n);
    }
    if (!a) throw new ApiError(404, 'not_found', 'Not found.');
    const n = admin(a, email);
    if (!b && method === 'GET') return overview(n);
    if (!b && method === 'PATCH') {
      const next = { ...n };
      if (body.name !== undefined) next.name = nameOf(body.name);
      if (body.kind !== undefined) next.kind = kindOf(body.kind);
      if (Array.isArray(body.admins)) {
        const list = [...new Set((body.admins as unknown[]).map(norm).filter((x) => EMAIL_RE.test(x)))].slice(0, 20);
        if (!list.includes(email)) throw new ApiError(422, 'invalid', 'Keep yourself on the list, or ask another leader to remove you.');
        next.admins = list;
      }
      put(next);
      return overview(next);
    }
    if (!b && method === 'DELETE') {
      for (const m of memberships().filter((x) => x.networkId === n.id)) dropMembership(n.id, m.churchId);
      db.del('meta', `network:${n.id}`);
      return undefined;
    }
    if (b === 'code' && method === 'POST') {
      put({ ...n, code: newCode() });
      return overview(get(n.id)!);
    }
    if (b === 'churches' && c && !d && method === 'DELETE') {
      dropMembership(n.id, c);
      return overview(n);
    }
    throw new ApiError(404, 'not_found', 'Not found.');
  }

  return { handle, hostFor, overview, all, get };
}
