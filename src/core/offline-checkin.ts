// Check-in without internet. The desk downloads a pack of everyone who can check in to the event,
// searches and checks people in from it, prints the same labels, and queues what it did. The server
// replays the queue when the desk is back online (POST /admin/checkin/:eventId/sync). Pure functions,
// shared by the server and the browser.
import type { Checkin, CheckinFamily, CheckinLabel, CheckinMethod, CheckinResult, OfflineItem, OfflinePack } from './types.js';

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const QR_PREFIX = 'FW1:';
export const isSecurityCode = (s: unknown): s is string => typeof s === 'string' && new RegExp(`^[${CODE_ALPHABET}]{4}$`).test(s);

/** Child labels share one security code with a guardian label; volunteers get a team badge. */
export function labelsFor(event: { title: string; startsAt: string }, checkins: Checkin[], guardianName: string | null, code: string | null): CheckinLabel[] {
  const date = event.startsAt.slice(0, 10);
  const labels: CheckinLabel[] = checkins
    .filter((c) => c.isChild)
    .map((c) => ({ kind: 'child' as const, name: c.personName, room: c.roomName, securityCode: code!, allergies: c.allergies, event: event.title, date }));
  if (labels.length) labels.push({ kind: 'guardian', name: guardianName ?? `${labels.length} ${labels.length === 1 ? 'child' : 'children'}`, room: null, securityCode: code!, allergies: null, event: event.title, date });
  for (const c of checkins) if (c.volunteer && !c.isChild) labels.push({ kind: 'volunteer', name: c.personName, room: `${c.volunteer.teamName}${c.volunteer.positionName ? ` · ${c.volunteer.positionName}` : ''}`, securityCode: '', allergies: null, event: event.title, date });
  return labels;
}

/** Search by name, household, the last digits of a mobile number, or a member's QR code. */
export function offlineSearch(pack: OfflinePack, q: string, checkedIn: Set<string>): CheckinFamily[] {
  const raw = q.trim();
  if (raw.replace(/\s/g, '').length < 2) return [];
  const upper = raw.toUpperCase();
  const code = upper.startsWith(QR_PREFIX) ? upper.slice(QR_PREFIX.length) : upper;
  const digits = raw.replace(/\D/g, '');
  const words = raw.toLowerCase().split(/\s+/).filter(Boolean);
  const byCode = pack.people.filter((p) => p.code === code);
  const hits = byCode.length
    ? byCode
    : pack.people.filter((p) => (digits.length >= 4 && digits.length === raw.replace(/[\s+-]/g, '').length ? p.phone4 !== null && digits.endsWith(p.phone4) : words.every((w) => `${p.name} ${p.household ?? ''}`.toLowerCase().includes(w))));
  const seen = new Map<string, CheckinFamily>();
  for (const h of hits) {
    const key = h.household ?? `solo:${h.id}`;
    if (seen.has(key) || seen.size >= 12) continue;
    const members = h.household ? pack.people.filter((p) => p.household === h.household) : [h];
    seen.set(key, {
      householdName: h.household,
      people: members
        .map((p) => ({ id: p.id, name: p.name, age: p.age, isChild: p.isChild, allergies: p.allergies, roomId: p.roomId, roomName: p.roomName, checkedIn: checkedIn.has(p.id) }))
        .sort((x, y) => Number(x.isChild) - Number(y.isChild) || (y.age ?? 0) - (x.age ?? 0)),
    });
  }
  return [...seen.values()];
}

/** Checks people in from the pack. Returns what to show and print now, and the item to sync later. */
export function offlineCheckIn(pack: OfflinePack, personIds: string[], method: CheckinMethod, checkedIn: Set<string>, now: Date, random: (n: number) => number = (n) => Math.floor(Math.random() * n)): { item: OfflineItem; result: CheckinResult } {
  const people = [...new Set(personIds)].map((id) => pack.people.find((p) => p.id === id)).filter((p): p is OfflinePack['people'][number] => !!p);
  const fresh = people.filter((p) => !checkedIn.has(p.id));
  const kids = fresh.filter((p) => p.isChild);
  const code = kids.length ? Array.from({ length: 4 }, () => CODE_ALPHABET[random(CODE_ALPHABET.length)]).join('') : null;
  const clientId = `off_${now.getTime().toString(36)}_${Array.from({ length: 6 }, () => CODE_ALPHABET[random(CODE_ALPHABET.length)]).join('').toLowerCase()}`;
  const at = now.toISOString();
  const checkins: Checkin[] = fresh.map((p, i) => {
    const mine = pack.serving.filter((s) => s.personId === p.id);
    return {
      id: `${clientId}_${i}`,
      eventId: pack.event.id,
      personId: p.id,
      personName: p.name,
      householdName: p.household,
      at,
      method,
      isChild: p.isChild,
      roomId: p.isChild ? p.roomId : null,
      roomName: p.isChild ? p.roomName : null,
      securityCode: p.isChild ? code : null,
      allergies: p.isChild ? p.allergies : null,
      checkedOutAt: null,
      volunteer: mine.length ? { teamName: [...new Set(mine.map((x) => x.teamName))].join(', '), positionName: mine.map((x) => x.positionName).filter(Boolean).join(', ') } : null,
      clientId,
    };
  });
  const guardian = people.find((p) => !p.isChild);
  return {
    item: { clientId, personIds: fresh.map((p) => p.id), method, at, code },
    result: { checkins, securityCode: kids.length ? code : null, labels: labelsFor(pack.event, checkins, guardian?.name ?? null, code) },
  };
}
