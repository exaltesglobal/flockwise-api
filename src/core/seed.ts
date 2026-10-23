// Sample church used by the web demo (and by the API when SEED_DEMO=true). Dates are
// relative to `now` so the demo always has a service this Sunday.
import { bootstrapChurch } from './bootstrap.js';
import type { Db } from './db.js';
import type { Env } from './engine.js';
import type { Checkin, Collections, PlanItem } from './types.js';

const DAY = 86_400_000;

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MALE = ['Samuel', 'Joseph', 'Rahul', 'John', 'David', 'Abraham', 'Daniel', 'Thomas', 'Mathew', 'Jacob', 'Arun', 'Vijay', 'Suresh', 'Prakash', 'Anil', 'Kiran', 'Joel', 'Stephen', 'Paul', 'Peter', 'Ravi', 'Sunil', 'Ajay', 'Benny', 'Rajesh', 'Vinod', 'Christopher', 'Emmanuel', 'Noel', 'Aaron'];
const FEMALE = ['Anita', 'Mercy', 'Grace', 'Sarah', 'Esther', 'Ruth', 'Mary', 'Rachel', 'Deborah', 'Sneha', 'Divya', 'Shalini', 'Kavya', 'Asha', 'Lydia', 'Hannah', 'Leena', 'Jessy', 'Sheela', 'Nisha', 'Reena', 'Angel', 'Blessy', 'Jasmine', 'Susan', 'Rebecca', 'Merlin', 'Glory', 'Christina', 'Joy'];
const SURNAMES = ['Varghese', 'Daniel', 'Joseph', 'Mathew', 'Raj', 'Kumar', 'George', 'Abraham', 'Samuel', 'Jacob', 'Philip', 'Chacko', 'Pillai', 'Reddy', 'Rao', 'Das', "D'Souza", 'Fernandes', 'Pereira', 'Masih', 'Paul', 'John', 'Kurian', 'Cherian', 'Ninan', 'Rodrigues', 'Lobo', 'Gomes', 'Prasad', 'Isaac'];
const AREAS = ['Kondapur', 'Gachibowli', 'Madhapur', 'Kukatpally', 'Begumpet', 'Secunderabad', 'Ameerpet', 'Miyapur', 'Banjara Hills', 'Uppal'];
const TAGS = ['Choir', 'Usher', 'Media team', 'Welcome team', 'Youth', 'Baptised', 'New believer'];
const ALLERGIES = ['Peanuts', 'Dairy', 'Eggs', 'Asthma inhaler in bag'];
const CODE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const DEMO_MEMBER = 'p_priya';

export function seedDemo(db: Db, env: Env) {
  const r = rng(20261022);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const now = env.now().getTime();
  const iso = (t: number) => new Date(t).toISOString();
  // Times are set in India time (UTC+5:30).
  const at = (days: number, hour: number, minute = 0) => {
    const d = new Date(now + days * DAY + 330 * 60_000);
    d.setUTCHours(hour, minute, 0, 0);
    return new Date(d.getTime() - 330 * 60_000).toISOString();
  };
  const todayIst = new Date(now + 330 * 60_000);
  const toSunday = (7 - todayIst.getUTCDay()) % 7 || 7;
  const code = () => Array.from({ length: 8 }, () => CODE[Math.floor(r() * CODE.length)]).join('');
  let seq = 0;
  const id = (p: string) => `${p}_${++seq}`;

  bootstrapChurch(db, env, { id: 'ch_demo', name: 'Grace Community Church', country: 'IN', currency: 'INR', city: 'Hyderabad' });
  db.put('settings', {
    ...db.get('settings', 'church')!,
    address: 'Plot 12, Road No. 3, Kondapur, Hyderabad, Telangana 500084',
    phone: '+91 40 2345 6789',
    email: 'office@gracechurch.in',
    website: 'https://gracechurch.in',
    languages: ['en', 'hi', 'te'],
    payments: { provider: 'razorpay', connected: true, accountId: 'acc_Demo12345' },
    fcra: { registered: true, registrationNumber: '010230456', accountLast4: '4821' },
    receipts80g: { enabled: true, registrationNumber: 'AAATG1234QF20214', pan: 'AAATG1234Q' },
  });
  db.put('meta', { id: 'demoMember', value: DEMO_MEMBER });
  db.put('funds', { id: 'fd_building', name: 'Building Fund', description: 'New sanctuary construction.', taxDeductible: true, active: true, goal: 5_000_000_000 });
  db.put('funds', { id: 'fd_missions', name: 'Missions', description: 'Church planting in North India.', taxDeductible: false, active: true, goal: null });
  db.put('funds', { id: 'fd_harvest', name: 'Harvest Festival 2026', description: 'Our annual harvest thanksgiving: envelopes, produce and the auction.', taxDeductible: true, active: true, goal: 50_000_000 });
  db.put('funds', { id: 'fd_relief', name: 'Flood Relief 2025', description: 'Closed appeal.', taxDeductible: true, active: false, goal: null });

  db.put('campuses', { id: 'cp_kondapur', name: 'Kondapur (main)', city: 'Hyderabad', address: 'Road No. 3, Kondapur', serviceTimes: 'Sun 9:00 am English, 11:30 am Telugu' });
  db.put('campuses', { id: 'cp_secbad', name: 'Secunderabad', city: 'Hyderabad', address: 'SD Road, Secunderabad', serviceTimes: 'Sun 10:00 am English' });

  // ----- people -----
  const people: Collections['people'][] = [];
  const add = (p: Partial<Collections['people']> & { firstName: string; lastName: string }) => {
    const status = p.status ?? (r() < 0.72 ? 'member' : r() < 0.6 ? 'regular' : r() < 0.6 ? 'visitor' : 'inactive');
    const person: Collections['people'] = {
      id: p.id ?? `p_${people.length + 1}`,
      phone: `+91 9${Math.floor(r() * 1e9).toString().padStart(9, '0').replace(/(\d{4})(\d{5})/, '$1 $2')}`,
      email: r() < 0.7 ? `${p.firstName.toLowerCase()}.${p.lastName.toLowerCase().replace(/[^a-z]/g, '')}@example.com` : null,
      gender: null,
      birthDate: `${1955 + Math.floor(r() * 50)}-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`,
      householdName: null,
      address: `${pick(AREAS)}, Hyderabad`,
      language: r() < 0.12 ? 'hi' : r() < 0.1 ? 'te' : 'en',
      tags: r() < 0.4 ? [pick(TAGS)] : [],
      notes: null,
      joinedAt: iso(now - Math.floor(r() * 900) * DAY),
      lastAttendedAt: status === 'inactive' ? iso(now - (60 + Math.floor(r() * 200)) * DAY) : iso(now - Math.floor(r() * 14) * DAY),
      campusId: r() < 0.8 ? 'cp_kondapur' : 'cp_secbad',
      baptismDate: null,
      anniversary: null,
      allergies: null,
      medicalNotes: null,
      consent: { email: true, sms: r() < 0.95, whatsapp: r() < 0.92, directory: r() < 0.55 },
      checkinCode: code(),
      ...p,
      status,
    };
    // Children carry no phone or email of their own; their parents' details are on the parents' records.
    const yrs = person.birthDate ? new Date(now).getUTCFullYear() - Number(person.birthDate.slice(0, 4)) : 99;
    if (yrs < 16 && !p.phone) Object.assign(person, { phone: null, email: p.email ?? null });
    people.push(person);
    return person;
  };
  const kidBirth = (age: number) => `${new Date(now).getUTCFullYear() - age}-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`;

  const thomas = 'Thomas family';
  add({ id: DEMO_MEMBER, firstName: 'Priya', lastName: 'Thomas', gender: 'female', phone: '+91 98765 43210', email: 'priya@example.com', householdName: thomas, status: 'member', tags: ['Choir'], birthDate: '1991-10-24', anniversary: '2013-11-16', address: 'Kondapur, Hyderabad', campusId: 'cp_kondapur', consent: { email: true, sms: true, whatsapp: true, directory: true }, checkinCode: 'PRIYA7K2' });
  add({ id: 'p_arun', firstName: 'Arun', lastName: 'Thomas', gender: 'male', householdName: thomas, status: 'member', address: 'Kondapur, Hyderabad', anniversary: '2013-11-16', campusId: 'cp_kondapur' });
  add({ id: 'p_joel', firstName: 'Joel', lastName: 'Thomas', gender: 'male', householdName: thomas, status: 'member', email: null, birthDate: kidBirth(8), allergies: 'Peanuts', address: 'Kondapur, Hyderabad', campusId: 'cp_kondapur' });
  add({ id: 'p_anna', firstName: 'Anna', lastName: 'Thomas', gender: 'female', householdName: thomas, status: 'member', email: null, birthDate: kidBirth(4), address: 'Kondapur, Hyderabad', campusId: 'cp_kondapur' });
  add({ id: 'p_samuel', firstName: 'Samuel', lastName: 'Raj', gender: 'male', email: 'pastor@gracechurch.in', phone: '+91 98480 12345', status: 'member', householdName: 'Raj family', campusId: 'cp_kondapur' });

  for (let h = 0; h < 52; h++) {
    const last = SURNAMES[h % SURNAMES.length];
    const size = r() < 0.25 ? 1 : r() < 0.4 ? 2 : r() < 0.7 ? 3 : 4;
    const household = size > 1 ? `${last} family${h >= SURNAMES.length ? ' (2)' : ''}` : null;
    const address = `${pick(AREAS)}, Hyderabad`;
    const campusId = r() < 0.8 ? 'cp_kondapur' : 'cp_secbad';
    const status = r() < 0.75 ? 'member' : r() < 0.6 ? 'regular' : r() < 0.6 ? 'visitor' : 'inactive';
    for (let i = 0; i < size; i++) {
      const female = i === 1 ? true : i === 0 ? r() < 0.4 : r() < 0.5;
      const child = i >= 2;
      add({
        firstName: pick(female ? FEMALE : MALE),
        lastName: last,
        gender: female ? 'female' : 'male',
        householdName: household,
        address,
        campusId,
        status,
        ...(child ? { birthDate: kidBirth(1 + Math.floor(r() * 12)), email: null, allergies: r() < 0.2 ? pick(ALLERGIES) : null, tags: [] } : {}),
      });
    }
  }
  for (let i = 0; i < 3; i++) {
    const d = new Date(now + (i * 2 + 1) * DAY);
    people[12 + i * 7].birthDate = `19${80 + i * 4}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  for (let i = 0; i < 6; i++) {
    const p = people[people.length - 1 - i];
    p.joinedAt = iso(now - (i * 3 + 1) * DAY);
    p.status = 'visitor';
    p.lastAttendedAt = iso(now - (i * 3 + 1) * DAY);
  }
  // A few regulars who have drifted away (at-risk list).
  for (const i of [20, 33, 47, 61, 75]) if (people[i]) people[i].lastAttendedAt = iso(now - (25 + i) * DAY);
  for (const p of people) db.put('people', p);
  const adults = people.filter((p) => !p.birthDate || new Date(now).getUTCFullYear() - Number(p.birthDate.slice(0, 4)) >= 16);
  const kids = people.filter((p) => !adults.includes(p));

  // ----- staff -----
  db.put('staff', { id: 'st_1', personId: 'p_samuel', name: 'Pastor Samuel Raj', email: 'pastor@gracechurch.in', phone: '+91 98480 12345', role: 'owner', status: 'active', lastActiveAt: iso(now) });
  db.put('staff', { id: 'st_2', personId: null, name: 'Leena George', email: 'office@gracechurch.in', phone: '+91 98480 22222', role: 'admin', status: 'active', lastActiveAt: at(-1, 17) });
  db.put('staff', { id: 'st_3', personId: null, name: 'Vinod Mathew', email: 'accounts@gracechurch.in', phone: null, role: 'finance', status: 'active', lastActiveAt: at(-4, 11) });
  // Team hub: the office channel and the worship team's channel, with a few posts.
  db.put('hubChannels', { id: 'hub_staff', name: 'Office team', kind: 'staff', teamId: null, memberKeys: [], createdBy: 'system', createdAt: at(-20, 9), archived: false });
  db.put('hubChannels', { id: 'hub_team_tm_worship', name: 'Worship', kind: 'team', teamId: 'tm_worship', memberKeys: [], createdBy: 'system', createdAt: at(-20, 9), archived: false });
  db.put('hubPosts', { id: 'hp_1', channelId: 'hub_staff', kind: 'notice', text: 'Staff prayer and planning this Thursday at 10 am in the office. We will set the December calendar, so bring your ministry dates.', authorKey: 'p:p_samuel', authorName: 'Pastor Samuel Raj', at: at(-2, 9), pinned: true, mentions: [], task: null });
  db.put('hubPosts', { id: 'hp_2', channelId: 'hub_staff', kind: 'message', text: 'The projector in the main hall flickers after 20 minutes. Has anyone called the vendor?', authorKey: 's:st_2', authorName: 'Leena George', at: at(-1, 11), pinned: false, mentions: [], task: null });
  db.put('hubPosts', { id: 'hp_3', channelId: 'hub_staff', kind: 'message', text: '@Leena I spoke to them; a technician comes Friday morning.', authorKey: 's:st_5', authorName: 'David Samuel', at: at(-1, 12), pinned: false, mentions: ['s:st_2'], task: null });
  db.put('hubPosts', { id: 'hp_4', channelId: 'hub_staff', kind: 'task', text: 'Print 80 copies of the Sunday bulletin and leave them at the welcome desk.', authorKey: 's:st_2', authorName: 'Leena George', at: at(-1, 15), pinned: false, mentions: [], task: { assigneeKey: 's:st_4', assigneeName: 'Mercy Daniel', dueAt: at(2, 9), done: false, doneAt: null, doneByName: null } });
  db.put('hubPosts', { id: 'hp_5', channelId: 'hub_team_tm_worship', kind: 'notice', text: 'Rehearsal moved to Saturday 5 pm this week. Set list is on the service plan; please learn Amazing Grace in G.', authorKey: 's:st_5', authorName: 'David Samuel', at: at(-1, 18), pinned: true, mentions: [], task: null });
  db.put('hubPosts', { id: 'hp_6', channelId: 'hub_team_tm_worship', kind: 'message', text: 'Can someone bring a spare DI box on Saturday?', authorKey: 'p:p_priya', authorName: 'Priya Thomas', at: at(0, 8), pinned: false, mentions: [], task: null });
  // A role the church made itself: zone leaders see and care for their own zone only.
  db.put('roles', { id: 'role_zone', name: 'Zone leader', description: 'Visits families, follows up absentees and logs prayer needs in their own zone.', permissions: ['people.view', 'care', 'groups'], scope: 'zone', createdAt: at(-30, 10) });
  db.put('staff', { id: 'st_4', personId: null, name: 'Mercy Daniel', email: 'mercy@gracechurch.in', phone: null, role: 'pastor', status: 'active', lastActiveAt: at(-2, 10) });
  db.put('staff', { id: 'st_5', personId: null, name: 'David Samuel', email: 'worship@gracechurch.in', phone: null, role: 'coordinator', status: 'active', lastActiveAt: at(-1, 20) });
  db.put('staff', { id: 'st_6', personId: null, name: 'Rahul Varghese', email: 'rahul@example.com', phone: null, role: 'leader', status: 'invited', lastActiveAt: null });

  // ----- events -----
  type Ev = Collections['events'];
  const ev = (e: Partial<Ev> & Pick<Ev, 'id' | 'title' | 'startsAt' | 'endsAt'>): Ev => ({ kind: 'event', description: '', location: 'Main Sanctuary', imageUrl: null, capacity: null, published: true, attendance: null, campusId: 'cp_kondapur', checkinEnabled: true, price: null, ...e });
  const events: Ev[] = [
    ev({ id: 'ev_1', kind: 'service', title: 'Sunday Worship (English)', description: 'Join us for worship, the Word and fellowship. Kids church runs alongside the service.', startsAt: at(toSunday, 9), endsAt: at(toSunday, 11) }),
    ev({ id: 'ev_2', kind: 'service', title: 'Sunday Worship (Telugu)', description: 'Telugu service with live English translation on headsets.', startsAt: at(toSunday, 11, 30), endsAt: at(toSunday, 13) }),
    ev({ id: 'ev_9', kind: 'service', title: 'Sunday Worship (English)', description: 'Join us for worship at the Secunderabad campus.', startsAt: at(toSunday, 10), endsAt: at(toSunday, 11, 45), location: 'Secunderabad Hall', campusId: 'cp_secbad' }),
    ev({ id: 'ev_10', kind: 'service', title: 'Sunday Worship (English)', description: 'Join us for worship, the Word and fellowship.', startsAt: at(toSunday + 7, 9), endsAt: at(toSunday + 7, 11) }),
    ev({ id: 'ev_3', title: 'Youth Night', description: 'Games, worship and a short talk for ages 13 to 19. Snacks provided.', startsAt: at(2, 18, 30), endsAt: at(2, 21), location: 'Fellowship Hall', capacity: 120 }),
    ev({ id: 'ev_4', title: 'Blood Donation Camp', description: 'Give blood, save lives. Volunteers needed for registration and refreshments.', startsAt: at(6, 9), endsAt: at(6, 15), location: 'Fellowship Hall', capacity: 150 }),
    ev({ id: 'ev_5', title: 'Marriage Enrichment Evening', description: 'An evening for couples with dinner, a talk and time to connect. The ticket covers dinner for two.', startsAt: at(12, 19), endsAt: at(12, 21, 30), location: 'Banquet Room, 2nd floor', capacity: 40, price: 150000 }),
    ev({ id: 'ev_6', title: 'Christmas Carol Service', description: 'Carols, readings and the Christmas story. Invite your neighbours!', startsAt: at(60, 18), endsAt: at(60, 20), published: false }),
    ev({ id: 'ev_7', kind: 'service', title: 'Sunday Worship (English)', description: 'Last week’s service.', startsAt: at(toSunday - 7, 9), endsAt: at(toSunday - 7, 11), attendance: 846 }),
    ev({ id: 'ev_8', title: 'Men’s Breakfast', description: 'Breakfast and a talk on work and faith.', startsAt: at(-5, 8), endsAt: at(-5, 10), location: 'Fellowship Hall', capacity: 60, attendance: 47 }),
  ];
  for (const e of events) db.put('events', e);
  for (const e of events) {
    if (!e.published || e.price) continue;
    const share = e.kind === 'service' ? 0.5 : Math.min(0.5, ((e.capacity ?? 100) * (0.3 + r() * 0.4)) / adults.length);
    for (const p of adults) if (p.id !== DEMO_MEMBER && r() < share) db.put('rsvps', { id: id('rv'), eventId: e.id, personId: p.id, at: iso(now - Math.floor(r() * 5) * DAY) });
  }
  db.put('rsvps', { id: id('rv'), eventId: 'ev_3', personId: DEMO_MEMBER, at: iso(now - DAY) });

  // Attendance history for the dashboard trend.
  for (let i = 12; i >= 2; i--) {
    const d = new Date(now + (toSunday - 7 * i) * DAY + 330 * 60_000).toISOString().slice(0, 10);
    db.put('attendanceHistory', { id: d, date: d, count: Math.round(760 + (12 - i) * 8 + r() * 70 - (i === 5 ? 120 : 0)) });
  }
  // Check-ins from last Sunday (adults + kids in rooms).
  const last = events.find((e) => e.id === 'ev_7')!;
  const rooms = db.all('rooms');
  const roomFor = (age: number) => rooms.find((rm) => age >= rm.minAge && age <= rm.maxAge) ?? null;
  for (const p of people.filter((x) => x.status !== 'inactive' && r() < 0.45)) {
    const age = p.birthDate ? new Date(now).getUTCFullYear() - Number(p.birthDate.slice(0, 4)) : 30;
    const child = age < 13;
    const room = child ? roomFor(age) : null;
    const c: Checkin = { id: id('ci'), eventId: last.id, personId: p.id, personName: `${p.firstName} ${p.lastName}`, householdName: p.householdName, at: new Date(new Date(last.startsAt).getTime() - Math.floor(r() * 25) * 60_000).toISOString(), method: r() < 0.5 ? 'qr' : r() < 0.6 ? 'kiosk' : 'staff', isChild: child, roomId: room?.id ?? null, roomName: room?.name ?? null, securityCode: child ? Array.from({ length: 4 }, () => CODE[Math.floor(r() * CODE.length)]).join('') : null, allergies: child ? p.allergies : null, checkedOutAt: child ? last.endsAt : null };
    db.put('checkins', c);
  }

  // ----- groups -----
  type Gr = Collections['groups'];
  const groups: Gr[] = [
    { id: 'gr_1', name: 'Kondapur Home Group', description: 'Bible study and prayer for families in Kondapur and Gachibowli.', meetingSchedule: 'Wednesdays, 7:30 pm', location: 'Kondapur', leaderName: 'Joseph & Anita', isOpen: true, type: 'cell', zone: 'West zone', leaderId: null },
    { id: 'gr_2', name: 'Young Professionals', description: 'For working adults in their 20s and 30s. Meets near HITEC City.', meetingSchedule: 'Fridays, 8:00 pm', location: 'HITEC City', leaderName: 'Rahul Varghese', isOpen: true, type: 'cell', zone: 'West zone', leaderId: null },
    { id: 'gr_3', name: "Women's Prayer Fellowship", description: 'Prayer, worship and encouragement every Saturday morning.', meetingSchedule: 'Saturdays, 10:00 am', location: 'Prayer Room', leaderName: 'Mercy Daniel', isOpen: true, type: 'ministry', zone: '', leaderId: null },
    { id: 'gr_4', name: 'Worship Team', description: 'Musicians and singers serving on Sundays. Auditions required.', meetingSchedule: 'Thursdays, 7:00 pm', location: 'Main Sanctuary', leaderName: 'David Samuel', isOpen: false, type: 'ministry', zone: '', leaderId: null },
    { id: 'gr_5', name: 'Secunderabad Home Group', description: 'A friendly mid-week group for anyone near Secunderabad and Begumpet.', meetingSchedule: 'Tuesdays, 7:30 pm', location: 'Secunderabad', leaderName: 'Paul & Grace Kurian', isOpen: true, type: 'cell', zone: 'East zone', leaderId: null },
    { id: 'gr_6', name: 'Alpha Course', description: 'Explore life, faith and meaning over dinner. 10 weeks, all welcome.', meetingSchedule: 'Mondays, 7:00 pm', location: 'Fellowship Hall', leaderName: 'Stephen Joseph', isOpen: true, type: 'class', zone: '', leaderId: null },
  ];
  for (const g of groups) db.put('groups', g);
  for (const g of groups) for (const p of adults) if (p.id !== DEMO_MEMBER && r() < 0.1) db.put('groupMembers', { id: id('gm'), groupId: g.id, personId: p.id, since: iso(now - Math.floor(r() * 400) * DAY) });
  db.put('groupMembers', { id: id('gm'), groupId: 'gr_1', personId: DEMO_MEMBER, since: iso(now - 200 * DAY) });
  for (const [k, i] of [5, 22, 41, 63].entries()) {
    const p = adults[i];
    db.put('joinRequests', { id: `jr_${k + 1}`, groupId: k % 3 === 0 ? 'gr_2' : 'gr_5', person: { id: p.id, name: `${p.firstName} ${p.lastName}`, phone: p.phone }, requestedAt: iso(now - (k + 1) * 0.7 * DAY) });
  }
  for (let w = 1; w <= 4; w++) {
    const members = db.all('groupMembers').filter((m) => m.groupId === 'gr_1').map((m) => m.personId);
    db.put('groupMeetings', { id: id('gmt'), groupId: 'gr_1', date: new Date(now - w * 7 * DAY).toISOString().slice(0, 10), presentIds: members.filter(() => r() < 0.75), guests: Math.floor(r() * 3), notes: w === 1 ? 'Studied Philippians 4. Prayed for the Kurian family.' : '', recordedBy: 'Joseph Varghese' });
  }

  // ----- giving -----
  const funds = db.all('funds');
  const amounts = [50000, 100000, 100000, 200000, 250000, 500000, 500000, 1000000, 1500000, 2500000, 5000000];
  let receipt = 0;
  const fy = (t: number) => {
    const d = new Date(t);
    const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
    return `${y}-${String(y + 1).slice(2)}`;
  };
  const gift = (g: Partial<Collections['donations']> & Pick<Collections['donations'], 'donorName' | 'fundId' | 'amount' | 'createdAt'>): Collections['donations'] => {
    const fund = funds.find((f) => f.id === g.fundId)!;
    const status = g.status ?? 'succeeded';
    return {
      id: g.id ?? id('dn'),
      donorId: null,
      donorEmail: null,
      donorPhone: null,
      fundName: fund.name,
      currency: 'INR',
      frequency: 'once',
      status,
      method: 'upi',
      pan: null,
      donorCitizenship: 'IN',
      fcra: false,
      provider: 'razorpay',
      providerRef: null,
      providerPaymentId: null,
      paidAt: status === 'succeeded' ? g.createdAt : null,
      eventId: null,
      receiptNumber: status === 'succeeded' && g.fundId !== 'fd_events' ? `${fy(new Date(g.createdAt).getTime())}/${String(++receipt).padStart(5, '0')}` : null,
      ...g,
    };
  };
  for (let i = 0; i < 420; i++) {
    const donor = r() < 0.08 ? null : pick(adults.slice(5));
    const fund = r() < 0.7 ? funds[0] : r() < 0.6 ? funds.find((f) => f.id === 'fd_building')! : funds.find((f) => f.id === 'fd_missions')!;
    const m = r();
    const method = m < 0.6 ? 'upi' : m < 0.75 ? 'card' : m < 0.85 ? 'netbanking' : m < 0.95 ? 'cash' : 'cheque';
    const foreign = r() < 0.03;
    const roll = r();
    db.put(
      'donations',
      gift({
        donorId: donor?.id ?? null,
        donorName: donor ? `${donor.firstName} ${donor.lastName}` : 'Anonymous (cash box)',
        fundId: fund.id,
        amount: pick(amounts),
        frequency: r() < 0.3 ? 'monthly' : 'once',
        status: roll < 0.96 ? 'succeeded' : roll < 0.98 ? 'failed' : 'refunded',
        createdAt: iso(now - Math.floor(r() * 200) * DAY - Math.floor(r() * DAY)),
        method,
        provider: method === 'cash' || method === 'cheque' ? 'offline' : 'razorpay',
        pan: donor && r() < 0.45 ? `${'ABCDEFGHJK'[Math.floor(r() * 10)]}${'PQRSTU'[Math.floor(r() * 6)]}XPT${Math.floor(1000 + r() * 8999)}${'ABCDEFGH'[Math.floor(r() * 8)]}` : null,
        donorCitizenship: foreign ? 'OTHER' : 'IN',
        fcra: foreign,
      }),
    );
  }
  for (let mo = 0; mo < 6; mo++) db.put('donations', gift({ donorId: DEMO_MEMBER, donorName: 'Priya Thomas', donorEmail: 'priya@example.com', fundId: 'fd_tithe', amount: 500000, frequency: 'monthly', createdAt: at(-20 - mo * 30, 10), pan: 'ABCPT1234K', method: 'upi', providerRef: 'sub_demo_priya' }));
  // Monthly gifts on UPI AutoPay (Razorpay subscriptions), in every state the office sees.
  const recurring = (o: Partial<Collections['recurring']> & Pick<Collections['recurring'], 'id' | 'donorId' | 'donorName' | 'fundId' | 'amount' | 'chargedCount'>) => {
    const fund = funds.find((f) => f.id === o.fundId)!;
    db.put('recurring', {
      fundName: fund.name, currency: 'INR', status: 'active', providerRef: `sub_demo_${o.id}`, fcra: false, method: 'upi', pledgeId: null, totalCount: null,
      totalGiven: o.amount * o.chargedCount, lastChargedAt: at(-20, 10), nextChargeAt: at(10, 10), createdAt: at(-20 - (o.chargedCount - 1) * 30, 10), endedAt: null, ...o,
    });
  };
  recurring({ id: 'rg_priya', donorId: DEMO_MEMBER, donorName: 'Priya Thomas', fundId: 'fd_tithe', amount: 500000, chargedCount: 6, providerRef: 'sub_demo_priya' });
  const states: Collections['recurring']['status'][] = ['active', 'active', 'active', 'active', 'active', 'active', 'active', 'failing', 'paused', 'halted', 'pending'];
  for (const [i, p] of adults.slice(30, 30 + states.length).entries()) {
    const status = states[i];
    const charged = status === 'pending' ? 0 : 2 + (i % 9);
    recurring({
      id: `rg_${i + 1}`, donorId: p.id, donorName: `${p.firstName} ${p.lastName}`, fundId: i % 4 === 3 ? 'fd_missions' : 'fd_tithe', amount: pick([100000, 200000, 250000, 500000, 1000000]), chargedCount: charged, status,
      method: status === 'pending' ? null : i % 5 === 4 ? 'card' : 'upi', lastChargedAt: charged ? at(-15 - i, 10) : null, nextChargeAt: ['halted', 'pending'].includes(status) ? null : at(15 - i, 10),
    });
  }
  recurring({ id: 'rg_pledge', donorId: adults[10].id, donorName: `${adults[10].firstName} ${adults[10].lastName}`, fundId: 'fd_building', amount: 250000, chargedCount: 3, pledgeId: 'pl_2', totalCount: 12 });
  db.put('donations', gift({ donorId: DEMO_MEMBER, donorName: 'Priya Thomas', fundId: 'fd_missions', amount: 100000, createdAt: at(-45, 12), method: 'card' }));
  db.put('pledges', { id: 'pl_1', personId: DEMO_MEMBER, personName: 'Priya Thomas', fundId: 'fd_building', fundName: 'Building Fund', amount: 6000000, startDate: at(-90, 0).slice(0, 10), endDate: at(275, 0).slice(0, 10), createdAt: at(-90, 10) });
  db.put('donations', gift({ donorId: DEMO_MEMBER, donorName: 'Priya Thomas', fundId: 'fd_building', amount: 1500000, createdAt: at(-60, 11), pan: 'ABCPT1234K' }));
  for (const [i, p] of adults.slice(10, 22).entries())
    db.put('pledges', { id: `pl_${i + 2}`, personId: p.id, personName: `${p.firstName} ${p.lastName}`, fundId: 'fd_building', fundName: 'Building Fund', amount: pick([2500000, 5000000, 10000000, 12000000]), startDate: at(-90, 0).slice(0, 10), endDate: at(275, 0).slice(0, 10), createdAt: at(-90 + i, 10) });
  // ----- harvest festival -----
  db.put('campaigns', { id: 'cp_harvest', name: 'Harvest Festival 2026', kind: 'harvest', description: 'Bring the first fruits of the year. Envelopes go to every family; produce brought on harvest Sunday is auctioned after the service.', fundId: 'fd_harvest', goal: 50_000_000, startsOn: at(-21, 0).slice(0, 10), endsOn: at(9, 0).slice(0, 10), showPublic: true, status: 'active', createdAt: at(-21, 10), createdBy: 'Samuel Raj' });
  const families = new Map<string, Collections['people']>();
  for (const p of adults) if (!families.has(p.householdName ?? p.id)) families.set(p.householdName ?? p.id, p);
  [...families.values()].slice(0, 36).forEach((p, i) => {
    const back = i % 3 !== 2;
    const amount = back ? pick([100000, 200000, 250000, 500000, 1000000, 1500000]) : null;
    const d = back ? gift({ donorId: p.id, donorName: p.householdName ?? `${p.firstName} ${p.lastName}`, fundId: 'fd_harvest', amount: amount!, createdAt: at(-14 + (i % 12), 11), method: i % 4 === 0 ? 'upi' : 'cash' }) : null;
    if (d) db.put('donations', d);
    db.put('envelopes', { id: `ev_${i + 1}`, campaignId: 'cp_harvest', number: i + 1, personId: p.id, familyName: p.householdName ?? `${p.firstName} ${p.lastName}`, promised: i % 5 === 0 ? 500000 : null, amount, method: d?.method ?? null, receivedAt: d?.paidAt ?? null, donationId: d?.id ?? null });
  });
  const produce: [string, string, number, boolean][] = [['Rice', '2 bags (50 kg)', 600000, true], ['Coconuts', '40', 120000, true], ['Bananas', '6 bunches', 90000, true], ['Country chicken', '2', 160000, true], ['Gold ring', '1 (4 g)', 2400000, false], ['Pumpkin', '1 large', 30000, true]];
  produce.forEach(([item, quantity, value, forAuction], i) => {
    const p = adults[30 + i];
    db.put('inKind', { id: `ik_${i + 1}`, campaignId: 'cp_harvest', donorId: p.id, donorName: `${p.firstName} ${p.lastName}`, item, quantity, value, forAuction, note: '', receivedAt: at(-7, 10) });
  });
  ([[1, 1100000, true], [2, 450000, true], [4, 520000, true], [3, 300000, false]] as const).forEach(([n, amount, paid], i) => {
    const p = adults[40 + i];
    const item = produce[n - 1];
    const d = paid ? gift({ donorId: p.id, donorName: `${p.firstName} ${p.lastName}`, fundId: 'fd_harvest', amount, createdAt: at(-7, 13), method: 'cash' }) : null;
    if (d) db.put('donations', d);
    db.put('auctionLots', { id: `al_${i + 1}`, campaignId: 'cp_harvest', inKindId: `ik_${n}`, title: `${item[1]} ${item[0].toLowerCase()}`, bidderId: p.id, bidderName: `${p.firstName} ${p.lastName}`, amount, paid, method: d?.method ?? null, paidAt: d?.paidAt ?? null, donationId: d?.id ?? null, createdAt: at(-7, 12, i) });
  });
  db.put('donations', gift({ donorId: DEMO_MEMBER, donorName: 'Priya Thomas', fundId: 'fd_harvest', amount: 500000, createdAt: at(-3, 20), method: 'upi' }));
  // ----- missionaries the church supports -----
  {
    const rm = rng(4242); // own stream so the rest of the demo data stays the same
    let n = 0;
    const defs: [string, string, string, string, string, number, number, string][] = [
      ['ms_kujur', 'Rev. Joseph & Mary Kujur', 'Gumla, Jharkhand', 'Gossner Evangelical Lutheran Church', 'Village churches and an evening tuition centre for 60 Oraon children.', 2_500_000, 1_000_000, 'Rains washed out the road to Basia: pray for safe travel. Two new house churches in Palkot. The tuition centre needs a second teacher.'],
      ['ms_ashadeep', 'Asha Deep Children\'s Home', 'Kandhamal, Odisha', 'India Mission Trust', 'A home for 24 girls, with schooling, meals and care.', 4_000_000, 1_500_000, 'Board exam results in May. A new roof before the monsoon. Health for the house mother, Anita.'],
      ['ms_lalrem', 'Samuel & Ruth Lalremruata', 'Lower Subansiri, Arunachal Pradesh', 'Bible translation partnership', 'Translating the New Testament into Nyishi with a local team.', 3_000_000, 0, 'The team is checking Mark with village readers. Visa and permit renewals for the inner-line area.'],
    ];
    const pool = adults.filter((p) => p.status === 'member').slice(4);
    // A day in a past month (mo months back), at 10:00 IST.
    const monthDay = (mo: number, d: number) => { const t = new Date(now); return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - mo, d, 4, 30)).toISOString(); };
    const sentIn = new Map<string, number>();
    for (const [mid, name, field, organisation, work, need, church, prayer] of defs) {
      const fundId = `fd_${mid.slice(3)}`;
      funds.push(db.put('funds', { id: fundId, name: `Missions · ${name}`, description: `Support for ${name} in ${field}.`, taxDeductible: true, active: true, goal: null }));
      db.put('missionaries', { id: mid, name, photoUrl: null, field, organisation, work, since: at(-900 - defs.findIndex((x) => x[0] === mid) * 400, 0).slice(0, 10), status: 'active', fundId, monthlyNeed: need, email: null, phone: null, prayerPoints: prayer, showPublic: true, createdAt: at(-900, 10) });
      if (church) db.put('missionSupport', { id: `mss_${mid}_church`, missionaryId: mid, kind: 'church', personId: null, name: 'Church budget', amount: church, startedOn: at(-400, 0).slice(0, 10), endedOn: null, createdAt: at(-400, 10) });
      const supporters = pool.splice(0, 5 + Math.floor(rm() * 4));
      if (mid === 'ms_kujur') supporters.push(db.get('people', DEMO_MEMBER)!);
      supporters.forEach((p, i) => {
        const amount = [50000, 100000, 100000, 200000, 250000, 500000][Math.floor(rm() * 6)];
        const behind = i === 1 && mid !== 'ms_lalrem';
        db.put('missionSupport', { id: `mss_${mid}_${i}`, missionaryId: mid, kind: 'member', personId: p.id, name: `${p.firstName} ${p.lastName}`, amount, startedOn: at(-200, 0).slice(0, 10), endedOn: null, createdAt: at(-200, 10) });
        for (let mo = 1; mo <= 6; mo++) {
          if (behind && mo <= 3) continue;
          db.put('donations', gift({ id: `dn_ms_${++n}`, donorId: p.id, donorName: `${p.firstName} ${p.lastName}`, fundId, amount, createdAt: monthDay(mo, 3 + Math.floor(rm() * 12)), method: rm() < 0.7 ? 'upi' : 'bank_transfer' }));
          sentIn.set(`${mid}:${mo}`, (sentIn.get(`${mid}:${mo}`) ?? 0) + amount);
        }
      });
      // The church budget share is booked as a monthly transfer into the fund, then everything is sent on.
      for (let mo = 1; mo <= 6; mo++) {
        if (church) db.put('donations', gift({ id: `dn_ms_${++n}`, donorId: null, donorName: 'Church budget', fundId, amount: church, createdAt: monthDay(mo, 1), method: 'bank_transfer' }));
        const due = (sentIn.get(`${mid}:${mo}`) ?? 0) + church;
        db.put('missionPayouts', { id: `msp_${mid}_${mo}`, missionaryId: mid, date: monthDay(mo - 1, 2).slice(0, 10), amount: due, method: 'bank_transfer', reference: `NEFT${String(Math.floor(rm() * 1e8)).padStart(8, '0')}`, note: '', by: 'Vinod Mathew', createdAt: monthDay(mo - 1, 2) });
      }
    }
    db.put('missionReports', { id: 'msr_1', missionaryId: 'ms_kujur', date: at(-12, 0).slice(0, 10), title: 'Baptisms at Palkot', body: 'Eleven people were baptised in the river at Palkot last Sunday, most of them from two families who started coming to the house church in March. The tuition centre reopened after the harvest and 64 children came on the first evening.', prayerPoints: 'A second teacher for the tuition centre\nSafe travel on the Basia road', published: true, sentAt: at(-12, 18), sentCount: 7, createdAt: at(-12, 17) });
    db.put('missionReports', { id: 'msr_2', missionaryId: 'ms_ashadeep', date: at(-40, 0).slice(0, 10), title: 'New roof is on', body: 'Thanks to your gifts the new roof went on two weeks before the rains. The girls moved back into the big dormitory and the study room is dry again.', prayerPoints: 'Board exams in March\nHealth for Anita', published: true, sentAt: at(-40, 18), sentCount: 6, createdAt: at(-40, 17) });
  }
  db.put('meta', { id: `receipt:${fy(now)}`, value: String(receipt) });

  // ----- this Sunday's bulletin -----
  db.put('bulletins', { id: 'bl_1', eventId: 'ev_1', date: at(toSunday, 9).slice(0, 10), title: 'Sunday Worship (English)', intro: 'Welcome to Grace Church! If this is your first Sunday with us, please stop by the welcome desk after the service. We would love to meet you.', verse: '“Bring the whole tithe into the storehouse… and see if I will not throw open the floodgates of heaven.” Malachi 3:10', sections: ['order', 'announcements', 'events', 'celebrations', 'serving', 'giving'], status: 'published', publishedAt: at(-1, 18), shareKey: 'demo7bulln', createdAt: at(-2, 10), updatedAt: at(-1, 18) });

  // ----- livestream: last Sunday's stream with its online viewers, and this Sunday's scheduled -----
  {
    const rl = rng(5150);
    const settingsRec = db.get('settings', 'church')!;
    db.put('settings', { ...settingsRec, livestream: { channelId: 'UCgracechurchhyderabad01', countAfterMinutes: 5, publicWatch: true } });
    const lastStart = at(toSunday - 7, 9);
    const watchers = adults.filter((p) => p.id !== DEMO_MEMBER && rl() < 0.12);
    let guests = 0;
    const viewers = [...watchers.map((p) => p.id), ...Array.from({ length: 96 }, () => `g${(++guests).toString(36).padStart(8, '0')}`)];
    let attended = 0;
    for (const viewer of viewers) {
      const join = Math.floor(rl() * 25);
      const stay = rl() < 0.15 ? 1 + Math.floor(rl() * 4) : 20 + Math.floor(rl() * (118 - join - 20));
      const minutes = Array.from({ length: stay }, (_, i) => join + i);
      if (minutes.length >= 5) attended++;
      const person = !viewer.startsWith('g');
      db.put('streamViews', { id: `st_last:${viewer}`, streamId: 'st_last', viewer, personId: person ? viewer : null, source: person ? 'app' : 'public', minutes, firstAt: iso(Date.parse(lastStart) + join * 60_000), lastAt: iso(Date.parse(lastStart) + (join + stay) * 60_000) });
    }
    db.put('streams', { id: 'st_last', title: 'Sunday Worship (English)', youtubeId: 'DEMOSTREAM1', eventId: 'ev_7', startsAt: lastStart, startedAt: iso(Date.parse(lastStart) - 4 * 60_000), endedAt: at(toSunday - 7, 11), recorded: attended, createdAt: at(toSunday - 9, 10) });
    db.put('streams', { id: 'st_next', title: 'Sunday Worship (English)', youtubeId: 'DEMOSTREAM2', eventId: 'ev_1', startsAt: at(toSunday, 9), startedAt: null, endedAt: null, recorded: null, createdAt: at(-1, 10) });
  }

  // ----- announcements -----
  db.put('announcements', { id: 'an_1', title: 'Christmas choir auditions', body: 'Auditions for the Christmas choir are open after both services this Sunday. Speak to Pastor Samuel at the welcome desk.', publishedAt: at(-1, 9), status: 'published', imageUrl: null });
  db.put('announcements', { id: 'an_2', title: 'Blood donation drive', body: 'Together with a city blood bank we are hosting a donation camp in the fellowship hall. Please bring a photo ID.', publishedAt: at(-3, 18), status: 'published', imageUrl: null });
  db.put('announcements', { id: 'an_3', title: 'New sanctuary update', body: 'Draft: the foundation work is complete. Photos and next steps to follow.', publishedAt: at(0, 8), status: 'draft', imageUrl: null });

  // ----- volunteers -----
  const teamDefs: [string, string, string, [string, number][]][] = [
    ['tm_worship', 'Worship', '#1F6B5C', [['Worship leader', 1], ['Vocals', 3], ['Keys', 1], ['Guitar', 1], ['Drums', 1]]],
    ['tm_media', 'Media & Sound', '#3B82F6', [['Sound desk', 1], ['Slides', 1], ['Livestream', 1]]],
    ['tm_welcome', 'Welcome & Ushers', '#F2A93B', [['Greeter', 3], ['Usher', 4]]],
    ['tm_kids', "Kids' Church", '#A855F7', [['Teacher', 3], ['Helper', 3], ['Check-in desk', 1]]],
  ];
  const pool = adults.filter((p) => p.status === 'member' || p.status === 'regular');
  let cursor = 0;
  for (const [tid, name, color, pos] of teamDefs) {
    const positions = pos.map(([n, needed], i) => ({ id: `${tid}_p${i + 1}`, name: n, needed }));
    const size = positions.reduce((t, p) => t + p.needed, 0) * 2 + 2;
    const members = Array.from({ length: size }, () => pool[cursor++ % pool.length]).map((p, i) => ({ personId: p.id, positionIds: [positions[i % positions.length].id, ...(r() < 0.3 ? [positions[(i + 1) % positions.length].id] : [])] }));
    if (tid === 'tm_worship') members.push({ personId: DEMO_MEMBER, positionIds: [positions[1].id] });
    db.put('teams', { id: tid, name, description: '', color, leaderId: members[0].personId, positions, members: [...new Map(members.map((m) => [m.personId, m])).values()] });
  }
  // Rota for this Sunday (part filled) and last Sunday (done).
  for (const evId of ['ev_7', 'ev_1']) {
    for (const t of db.all('teams')) {
      for (const pos of t.positions) {
        const cands = t.members.filter((m) => m.positionIds.includes(pos.id) && m.personId !== DEMO_MEMBER);
        const fill = evId === 'ev_7' ? pos.needed : Math.max(0, pos.needed - (r() < 0.4 ? 1 : 0));
        for (const m of cands.slice(evId === 'ev_7' ? 0 : 1, (evId === 'ev_7' ? 0 : 1) + fill)) {
          const roll = r();
          db.put('assignments', { id: id('as'), eventId: evId, teamId: t.id, positionId: pos.id, personId: m.personId, status: evId === 'ev_7' ? 'accepted' : roll < 0.6 ? 'accepted' : roll < 0.9 ? 'pending' : 'declined', createdAt: iso(now - 6 * DAY), respondedAt: null, note: null });
        }
      }
    }
  }
  // The demo member can open the team app with this password (no forced change in the demo).
  db.put('teamLogins', { id: DEMO_MEMBER, personId: DEMO_MEMBER, email: 'priya@example.com', passwordHash: env.hashPassword('demo1234'), mustChangePassword: false, disabled: false, createdAt: iso(now - 30 * DAY), lastSignInAt: null, failedAt: [], resetCodeHash: null, resetExpiresAt: null, resetAttempts: 0 });
  db.put('assignments', { id: 'as_priya', eventId: 'ev_1', teamId: 'tm_worship', positionId: 'tm_worship_p2', personId: DEMO_MEMBER, status: 'pending', createdAt: iso(now - 2 * DAY), respondedAt: null, note: null });
  db.put('blockouts', { id: 'bo_1', personId: pool[3].id, from: at(toSunday + 7, 0).slice(0, 10), to: at(toSunday + 14, 0).slice(0, 10), reason: 'Travelling to Kerala' });
  db.put('blockouts', { id: 'bo_2', personId: pool[8].id, from: at(toSunday, 0).slice(0, 10), to: at(toSunday, 0).slice(0, 10), reason: 'Family wedding' });

  // ----- Sunday school: classes, 10 Sundays of registers, lessons and a published exam -----
  {
    const rs = rng(1977); // own stream so the rest of the demo data stays the same
    const yrs = (p: Collections['people']) => (p.birthDate ? Math.floor((now - Date.parse(`${p.birthDate}T00:00:00Z`)) / (365.25 * DAY)) : null);
    const teachers = (db.get('teams', 'tm_kids')?.members ?? []).map((m) => m.personId);
    const defs: [string, number, number, string | null][] = [['Beginners', 3, 5, 'rm_tots'], ['Primary', 6, 8, 'rm_kids'], ['Junior', 9, 11, 'rm_kids'], ['Intermediate', 12, 14, null], ['Senior', 15, 17, null]];
    const cls = defs.map(([name, minAge, maxAge, roomId], i) => ({
      id: `ssc_${i + 1}`, name, minAge, maxAge, roomId, order: i, createdAt: at(-200, 10),
      teacherIds: teachers.slice(i * 2, i * 2 + 2),
      studentIds: people.filter((p) => p.status !== 'inactive' && (yrs(p) ?? -1) >= minAge && (yrs(p) ?? -1) <= maxAge).map((p) => p.id),
    }));
    for (const c of cls) db.put('ssClasses', c);
    const sundays = Array.from({ length: 10 }, (_, i) => at(toSunday - 7 * (i + 1), 9).slice(0, 10));
    for (const c of cls)
      for (const date of sundays) {
        const present = c.studentIds.filter(() => rs() < 0.82);
        db.put('ssAttendance', { id: `${c.id}:${date}`, classId: c.id, date, present, verse: present.filter(() => rs() < 0.55), visitors: rs() < 0.3 ? 1 : 0, offering: present.length * [1000, 2000, 500][Math.floor(rs() * 3)], markedBy: 'Mercy Daniel', markedAt: `${date}T06:30:00.000Z` });
      }
    const lessons: [number, string, string, string][] = [
      [-7, 'Joseph forgives his brothers', 'Genesis 45:1-15', 'Be kind and compassionate to one another, forgiving each other. Ephesians 4:32'],
      [0, 'Ruth stays with Naomi', 'Ruth 1:1-18', 'Where you go I will go, and where you stay I will stay. Ruth 1:16'],
      [7, 'David and Goliath', '1 Samuel 17:32-50', 'The Lord who rescued me from the paw of the lion will rescue me. 1 Samuel 17:37'],
      [14, 'Daniel in the lions\' den', 'Daniel 6:10-23', 'My God sent his angel, and he shut the mouths of the lions. Daniel 6:22'],
    ];
    lessons.forEach(([d, title, scripture, memoryVerse], i) => db.put('ssLessons', { id: `ssl_${i + 1}`, classId: null, date: at(toSunday + d, 9).slice(0, 10), title, scripture, memoryVerse, notes: '' }));
    // This week's memory verse game: about half of each class has started, a few are word perfect.
    const taught = at(toSunday - 7, 9).slice(0, 10);
    const verseText = 'Be kind and compassionate to one another, forgiving each other.';
    for (const c of cls)
      for (const pid of c.studentIds) {
        // Priya's children: Joel has not started (so the demo can play), Anna has only read it.
        const roll = pid === 'p_joel' ? 1 : pid === 'p_anna' ? 0.5 : rs();
        if (roll > 0.55) continue;
        const read = roll < 0.55, blanks = roll < 0.4, recite = roll < 0.22;
        const when = (h: number) => at(toSunday - 6, h);
        db.put('verseGames', {
          id: `${pid}:ssl_1`, personId: pid, classId: c.id, lessonId: 'ssl_1', week: taught, verse: verseText, reference: 'Ephesians 4:32',
          done: { read: read ? when(17) : null, blanks: blanks ? when(18) : null, recite: recite ? when(19) : null },
          scores: { read: read ? 10 : 0, blanks: blanks ? 20 : 0, recite: recite ? (rs() < 0.6 ? 30 : 20) : 0 },
          attempts: (read ? 1 : 0) + (blanks ? 1 : 0) + (recite ? 2 : 0), bestAccuracy: recite ? 90 + Math.floor(rs() * 10) : blanks ? null : null, updatedAt: when(19),
        });
      }
    db.put('ssExams', { id: 'sse_1', name: 'Half-yearly exam', date: at(-110, 0).slice(0, 10), maxMarks: 100, classIds: cls.map((c) => c.id), status: 'published', createdAt: at(-120, 10) });
    for (const c of cls) for (const pid of c.studentIds) db.put('ssMarks', { id: `sse_1:${pid}`, examId: 'sse_1', personId: pid, classId: c.id, marks: rs() < 0.08 ? null : Math.round(48 + rs() * 50) });

    // AGM: the committee election is open until Sunday after the meeting; last month's resolution is published.
    const voters = people.filter((p) => p.status === 'member' && p.id !== DEMO_MEMBER && (yrs(p) ?? 30) >= 18);
    const stand = voters.filter((p) => p.id !== 'p_arun').slice(3, 9);
    const roles = ['Standing for secretary', 'Standing for treasurer', 'Youth representative', 'Standing for secretary', 'Women\'s fellowship representative', 'Building committee'];
    const candidates = stand.map((p, i) => ({ id: `cd_${i + 1}`, personId: p.id, name: `${p.firstName} ${p.lastName}`, note: roles[i] }));
    db.put('elections', {
      id: 'el_1', title: 'Church committee 2027–2029', kind: 'election', description: 'Three seats on the church committee for the next two years. Vote for up to three. The count is declared after the AGM.', seats: 3, candidates,
      eligibility: 'members_18', status: 'open', meetingAt: at(toSunday, 11, 30), venue: 'Main hall, Kondapur', opensAt: at(-3, 10), closesAt: at(toSunday, 13), closedAt: null, paperVotes: {}, paperInvalid: 0,
      returningOfficer: 'Mercy Daniel', resultsPublished: false, createdAt: at(-10, 10), createdBy: 'Mercy Daniel',
    });
    const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = (n: number) => Array.from({ length: n }, () => alpha[Math.floor(rs() * alpha.length)]).join('');
    voters.forEach((p, i) => {
      if (rs() > 0.42) return;
      const picks = [...candidates].sort(() => rs() - 0.5).slice(0, 1 + Math.floor(rs() * 3)).map((c) => c.id);
      const when = at(-2 + Math.floor(rs() * 3), 8 + Math.floor(rs() * 12));
      db.put('ballots', { id: `bl_${code(14).toLowerCase()}`, electionId: 'el_1', choices: picks, receipt: code(8), castHour: `${when.slice(0, 13)}:00Z`, via: 'app' });
      db.put('ballotStubs', { id: `el_1:${p.id}`, electionId: 'el_1', personId: p.id, castAt: when, via: 'app', markedBy: null });
      void i;
    });
    db.put('elections', {
      id: 'el_2', title: 'Adopt the audited accounts for 2025–26', kind: 'resolution', description: 'That the audited accounts for the year ended 31 March 2026, as circulated, be adopted.', seats: 1,
      candidates: [{ id: 'for', personId: null, name: 'For', note: '' }, { id: 'against', personId: null, name: 'Against', note: '' }, { id: 'abstain', personId: null, name: 'Abstain', note: '' }],
      eligibility: 'members_18', status: 'closed', meetingAt: at(-21, 11, 30), venue: 'Main hall, Kondapur', opensAt: at(-24, 10), closesAt: at(-21, 13), closedAt: at(-21, 13), paperVotes: { for: 12, against: 2, abstain: 1 }, paperInvalid: 1,
      returningOfficer: 'Mercy Daniel', resultsPublished: true, createdAt: at(-30, 10), createdBy: 'Mercy Daniel',
    });
    voters.slice(0, 57).forEach((p, i) => {
      const choice = i < 48 ? 'for' : i < 53 ? 'against' : 'abstain';
      const when = at(-23 + Math.floor(rs() * 3), 8 + Math.floor(rs() * 12));
      db.put('ballots', { id: `bl_${code(14).toLowerCase()}`, electionId: 'el_2', choices: [choice], receipt: code(8), castHour: `${when.slice(0, 13)}:00Z`, via: 'app' });
      db.put('ballotStubs', { id: `el_2:${p.id}`, electionId: 'el_2', personId: p.id, castAt: when, via: 'app', markedBy: null });
    });
    db.put('ssExams', { id: 'sse_2', name: 'Annual exam', date: at(toSunday + 35, 0).slice(0, 10), maxMarks: 100, classIds: cls.map((c) => c.id), status: 'open', createdAt: at(-3, 10) });
  }

  // ----- songs and plans -----
  const songs: [string, string, string, number][] = [
    ['Goodness of God', 'Bethel Music', 'A', 63],
    ['Way Maker', 'Sinach', 'E', 68],
    ['Build My Life', 'Housefires', 'G', 70],
    ['Yesu Raja', 'Traditional (Telugu)', 'D', 90],
    ['10,000 Reasons', 'Matt Redman', 'G', 73],
    ['Living Hope', 'Phil Wickham', 'C', 72],
    ['Mahima Ho', 'Hindi worship', 'F', 84],
    ['Great Are You Lord', 'All Sons & Daughters', 'G', 72],
    ['Cornerstone', 'Hillsong', 'C', 72],
    ['How Great Is Our God', 'Chris Tomlin', 'C', 78],
    ['Nee Prema', 'Telugu worship', 'E', 76],
    ['Agnus Dei', 'Michael W. Smith', 'A', 66],
  ];
  songs.forEach(([title, author, key, bpm], i) => db.put('songs', { id: `sg_${i + 1}`, title, author, defaultKey: key, bpm, ccli: String(4000000 + i * 1371), tags: i % 3 === 0 ? ['Opener'] : i % 3 === 1 ? ['Worship'] : ['Response'], lyrics: '' }));
  const item = (kind: PlanItem['kind'], title: string, minutes: number, extra: Partial<PlanItem> = {}): PlanItem => ({ id: id('pi'), kind, title, songId: null, key: null, minutes, notes: '', person: '', ...extra });
  const song = (n: number, person = 'Worship team') => item('song', songs[n - 1][0], 5, { songId: `sg_${n}`, key: songs[n - 1][2], person });
  db.put('plans', { id: 'ev_7', eventId: 'ev_7', theme: 'Hope that holds', notes: '', updatedAt: iso(now - 8 * DAY), items: [item('other', 'Welcome & call to worship', 3, { person: 'Leena George' }), song(1), song(2), song(4), item('announcement', 'Church news', 4, { person: 'Leena George' }), item('offering', 'Tithes & offering', 4), item('reading', 'Romans 5:1-5', 3, { person: 'Arun Thomas' }), item('sermon', 'Hope that does not disappoint', 35, { person: 'Pastor Samuel Raj' }), song(6), item('prayer', 'Closing prayer & blessing', 3, { person: 'Pastor Samuel Raj' })] });
  db.put('plans', { id: 'ev_1', eventId: 'ev_1', theme: 'The Good Shepherd', notes: 'Baby dedication after the sermon (Kurian family).', updatedAt: iso(now - DAY), items: [item('other', 'Welcome & call to worship', 3, { person: 'Leena George' }), song(3), song(5), song(7), item('announcement', 'Church news & Youth Night', 4, { person: 'Leena George' }), item('offering', 'Tithes & offering', 4), item('reading', 'John 10:1-18', 3, { person: 'Priya Thomas' }), item('sermon', 'I am the Good Shepherd', 35, { person: 'Pastor Samuel Raj' }), item('other', 'Baby dedication', 8, { person: 'Pastor Samuel Raj' }), song(12), item('prayer', 'Blessing', 2, { person: 'Pastor Samuel Raj' })] });

  // ----- messaging -----
  db.put('templates', { id: 'tp_1', name: 'Sunday reminder', channel: 'whatsapp', subject: '', body: 'Hi {{firstName}}, see you this Sunday at {{church}}! English service 9:00 am, Telugu 11:30 am.' });
  db.put('templates', { id: 'tp_2', name: 'Monthly newsletter', channel: 'email', subject: '{{church}} this month', body: 'Hi {{firstName}},\n\nHere is what is happening at {{church}} this month...\n\nOpen the app: {{appLink}}' });
  db.put('templates', { id: 'tp_3', name: 'Prayer meeting', channel: 'sms', subject: '', body: 'Prayer meeting tonight 7 pm in the prayer room. All welcome. - {{church}}' });
  const msg = (m: Partial<Collections['messages']> & Pick<Collections['messages'], 'channel' | 'audienceLabel' | 'body'>): Collections['messages'] => ({ id: id('ms'), audience: { type: 'everyone', ids: [] }, subject: '', status: 'sent', scheduledAt: null, sentAt: null, createdAt: iso(now - 3 * DAY), createdBy: 'Leena George', stats: { recipients: 0, sent: 0, failed: 0, skipped: 0 }, simulated: false, source: 'manual', ...m });
  db.put('messages', msg({ channel: 'whatsapp', audienceLabel: 'Everyone', body: 'Hi {{firstName}}, see you this Sunday at {{church}}! English service 9:00 am, Telugu 11:30 am.', sentAt: at(-2, 18), stats: { recipients: 214, sent: 196, failed: 3, skipped: 15 } }));
  db.put('messages', msg({ channel: 'email', audienceLabel: 'Members', subject: 'Building fund update', body: 'Hi {{firstName}},\n\nThank you for giving so generously...', sentAt: at(-9, 10), stats: { recipients: 160, sent: 121, failed: 0, skipped: 39 } }));
  db.put('messages', msg({ channel: 'sms', audienceLabel: 'Worship', body: 'Practice moved to 6:30 pm on Thursday. - David', sentAt: at(-4, 12), createdBy: 'David Samuel', audience: { type: 'team', ids: ['tm_worship'] }, stats: { recipients: 18, sent: 18, failed: 0, skipped: 0 } }));
  db.put('messages', msg({ channel: 'whatsapp', audienceLabel: 'Members, Regulars', body: 'Christmas carol practice starts next week! Reply YES to join the choir.', status: 'scheduled', scheduledAt: at(3, 18), audience: { type: 'status', ids: ['member', 'regular'] } }));

  // ----- care and prayer -----
  const care = (c: Partial<Collections['care']> & Pick<Collections['care'], 'personName' | 'title' | 'type'>): Collections['care'] => ({ id: id('cc'), personId: null, status: 'open', priority: 'normal', assignedTo: null, assignedName: null, dueAt: null, createdAt: iso(now - 2 * DAY), closedAt: null, notes: [], source: 'manual', confidential: false, ...c });
  const pp = (i: number) => adults[i];
  db.put('care', care({ personId: pp(30).id, personName: `${pp(30).firstName} ${pp(30).lastName}`, type: 'hospital', title: 'In Apollo hospital after knee surgery', priority: 'urgent', assignedTo: 'st_4', assignedName: 'Mercy Daniel', dueAt: at(0, 18), notes: [{ id: id('cn'), at: at(-1, 19), by: 'Mercy Daniel', text: 'Spoke to his wife. Surgery went well; visiting tomorrow evening.' }], status: 'in_progress' }));
  db.put('care', care({ personId: people[people.length - 1].id, personName: `${people[people.length - 1].firstName} ${people[people.length - 1].lastName}`, type: 'visitor', title: 'First-time visitor last Sunday', dueAt: at(1, 12), source: 'automation' }));
  db.put('care', care({ personId: people[people.length - 2].id, personName: `${people[people.length - 2].firstName} ${people[people.length - 2].lastName}`, type: 'visitor', title: 'Asked about baptism classes', assignedTo: 'st_1', assignedName: 'Pastor Samuel Raj', dueAt: at(-1, 12) }));
  db.put('care', care({ personId: pp(40).id, personName: `${pp(40).firstName} ${pp(40).lastName}`, type: 'bereavement', title: 'Mother passed away', assignedTo: 'st_1', assignedName: 'Pastor Samuel Raj', confidential: true, dueAt: at(2, 12) }));
  db.put('care', care({ personId: pp(20).id, personName: `${pp(20).firstName} ${pp(20).lastName}`, type: 'absent', title: 'Not seen for 6 weeks', source: 'automation', dueAt: at(3, 12) }));
  db.put('care', care({ personId: pp(50).id, personName: `${pp(50).firstName} ${pp(50).lastName}`, type: 'counselling', title: 'Pre-marriage counselling', status: 'closed', closedAt: at(-3, 12), createdAt: at(-30, 12), assignedTo: 'st_1', assignedName: 'Pastor Samuel Raj' }));
  const prayer = (p: Partial<Collections['prayer']> & Pick<Collections['prayer'], 'name' | 'text'>): Collections['prayer'] => ({ id: id('pr'), personId: null, visibility: 'church', status: 'open', prayedBy: [], createdAt: iso(now - DAY), answeredNote: null, ...p });
  db.put('prayer', prayer({ personId: pp(15).id, name: `${pp(15).firstName} ${pp(15).lastName}`, text: 'Please pray for my job interview on Friday.', prayedBy: adults.slice(0, 14).map((p) => p.id), createdAt: at(-1, 8) }));
  db.put('prayer', prayer({ personId: pp(25).id, name: `${pp(25).firstName} ${pp(25).lastName}`, text: 'Healing for my father, who has dengue.', prayedBy: adults.slice(3, 30).map((p) => p.id), createdAt: at(-2, 21) }));
  db.put('prayer', prayer({ personId: pp(35).id, name: `${pp(35).firstName} ${pp(35).lastName}`, text: 'Struggling with anxiety and sleep. Would appreciate prayer and a call.', visibility: 'pastors', createdAt: at(-1, 23) }));
  db.put('prayer', prayer({ personId: DEMO_MEMBER, name: 'Priya Thomas', text: 'Joel starts at a new school next week. Pray that he settles in and makes friends.', prayedBy: adults.slice(5, 12).map((p) => p.id), createdAt: at(-3, 9) }));
  db.put('prayer', prayer({ personId: pp(45).id, name: `${pp(45).firstName} ${pp(45).lastName}`, text: 'Thank you for praying for our visa. It was approved!', status: 'answered', answeredNote: 'Visa approved', prayedBy: adults.slice(0, 22).map((p) => p.id), createdAt: at(-12, 9) }));

  // ----- forms, calendar, lists, workflows, sermons, batches, groups -----
  const field = (fid: string, label: string, type: Collections['forms']['fields'][number]['type'], required = false, options: string[] = []) => ({ id: fid, label, type, required, options, helpText: '' });
  db.put('forms', { id: 'fm_blood', title: 'Blood Donation Camp: donor sign-up', description: 'Pick a time slot so we can spread donors through the day. Please eat well before you come.', eventId: 'ev_4', fields: [field('slot', 'Preferred time', 'select', true, ['9-11 am', '11 am-1 pm', '1-3 pm']), field('group', 'Blood group (if known)', 'select', false, ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-', "Don't know"]), field('first', 'This is my first time donating', 'checkbox')], ticketTypes: [], capacity: 80, waitlist: true, discountCodes: [], opensAt: null, closesAt: at(6, 8), status: 'open', isPublic: true, addTag: 'Blood donor', addToGroupId: null, workflowId: null, confirmationMessage: "Thank you for signing up to give blood! We'll send a reminder the day before.", createdAt: iso(now - 6 * DAY) });
  db.put('forms', { id: 'fm_baptism', title: 'Baptism class registration', description: 'A four-week class for anyone thinking about baptism. Classes run on Sunday afternoons.', eventId: null, fields: [field('saved', 'How long have you been following Jesus?', 'text', true), field('story', 'Tell us a little about your faith journey', 'textarea')], ticketTypes: [], capacity: null, waitlist: false, discountCodes: [], opensAt: null, closesAt: null, status: 'open', isPublic: true, addTag: 'Baptism class', addToGroupId: null, workflowId: null, confirmationMessage: "Thanks! Pastor Samuel will call you this week.", createdAt: iso(now - 20 * DAY) });
  db.put('forms', { id: 'fm_camp', title: 'Youth Camp 2026', description: 'Three days at Vikarabad with worship, games and teaching. Ages 13-19.', eventId: null, fields: [field('age', 'Age', 'number', true), field('tshirt', 'T-shirt size', 'select', true, ['S', 'M', 'L', 'XL']), field('parent', 'Parent or guardian phone', 'phone', true), field('medical', 'Allergies or medical needs', 'textarea')], ticketTypes: [{ id: 'tt_camper', name: 'Camper', price: 250000, capacity: null }, { id: 'tt_leader', name: 'Leader', price: 150000, capacity: 10 }], capacity: 60, waitlist: true, discountCodes: [{ code: 'EARLYBIRD', percentOff: 20, amountOff: null, maxUses: 30, used: 4 }, { code: 'SIBLING', percentOff: null, amountOff: 50000, maxUses: null, used: 2 }], opensAt: null, closesAt: at(30, 23), status: 'open', isPublic: true, addTag: 'Youth camp 2026', addToGroupId: null, workflowId: null, confirmationMessage: "You're in! A packing list will come by email.", createdAt: iso(now - 10 * DAY) });
  const responder = adults.filter((p) => p.email).slice(60, 75);
  responder.forEach((p, i) => {
    const formId = i < 8 ? 'fm_blood' : i < 11 ? 'fm_baptism' : 'fm_camp';
    const answers: Collections['formResponses']['answers'] = formId === 'fm_blood' ? { slot: ['9-11 am', '11 am-1 pm', '1-3 pm'][i % 3], group: ['O+', 'B+', 'A+', "Don't know"][i % 4], first: i % 3 === 0 } : formId === 'fm_baptism' ? { saved: `${i} years`, story: '' } : { age: 14 + (i % 5), tshirt: 'M', parent: p.phone ?? '', medical: '' };
    const tickets = formId === 'fm_camp' ? [{ ticketTypeId: 'tt_camper', qty: 1 }] : [];
    db.put('formResponses', { id: `fr_${i}`, formId, personId: p.id, name: `${p.firstName} ${p.lastName}`, email: p.email, phone: p.phone, answers, tickets, amount: formId === 'fm_camp' ? 250000 : 0, discountCode: null, status: 'confirmed', donationId: null, createdAt: iso(now - (10 - i / 2) * DAY) });
  });

  for (const rs of [
    { id: 'rs_sanct', name: 'Main Sanctuary', kind: 'room', capacity: 900, description: 'Stage, sound and projection.', needsApproval: true, approverIds: ['st_2'] },
    { id: 'rs_hall', name: 'Fellowship Hall', kind: 'room', capacity: 150, description: 'Tables and chairs for 150. Kitchen next door.', needsApproval: false, approverIds: [] },
    { id: 'rs_prayer', name: 'Prayer Room', kind: 'room', capacity: 25, description: '', needsApproval: false, approverIds: [] },
    { id: 'rs_class', name: 'Classroom 1', kind: 'room', capacity: 30, description: 'Whiteboard and TV.', needsApproval: false, approverIds: [] },
    { id: 'rs_proj', name: 'Portable projector', kind: 'equipment', capacity: null, description: 'Epson, with HDMI cable and screen.', needsApproval: false, approverIds: [] },
    { id: 'rs_van', name: 'Church van', kind: 'vehicle', capacity: 12, description: 'Driver must be approved by the office.', needsApproval: true, approverIds: ['st_2'] },
  ] as Collections['resources'][]) db.put('resources', rs);
  const booking = (b: Partial<Collections['bookings']> & Pick<Collections['bookings'], 'title' | 'resourceIds' | 'startsAt' | 'endsAt'>): Collections['bookings'] => ({ id: id('bk'), eventId: null, requestedBy: 'st_2', requestedByName: 'Leena George', status: 'approved', notes: '', setupMinutes: 0, createdAt: iso(now - 5 * DAY), decidedBy: 'Leena George', decidedAt: iso(now - 5 * DAY), decisionNote: null, ...b });
  db.put('bookings', booking({ title: 'Youth Night', resourceIds: ['rs_hall', 'rs_proj'], startsAt: at(2, 18, 30), endsAt: at(2, 21), eventId: 'ev_3', setupMinutes: 60 }));
  db.put('bookings', booking({ title: 'Blood Donation Camp', resourceIds: ['rs_hall'], startsAt: at(6, 9), endsAt: at(6, 15), eventId: 'ev_4', setupMinutes: 90 }));
  db.put('bookings', booking({ title: 'Worship practice', resourceIds: ['rs_sanct'], startsAt: at(1, 19), endsAt: at(1, 21), requestedBy: 'st_5', requestedByName: 'David Samuel', status: 'pending', decidedBy: null, decidedAt: null }));
  db.put('bookings', booking({ title: 'Senior citizens outing', resourceIds: ['rs_van'], startsAt: at(4, 9), endsAt: at(4, 16), requestedBy: 'st_4', requestedByName: 'Mercy Daniel', status: 'pending', decidedBy: null, decidedAt: null, notes: 'Trip to Chilkur for 10 seniors.' }));
  db.put('bookings', booking({ title: 'Bible study', resourceIds: ['rs_class'], startsAt: at(3, 19), endsAt: at(3, 20, 30) }));

  db.put('customFields', { id: 'cf_profession', label: 'Profession', type: 'text', options: [], order: 0 });
  db.put('customFields', { id: 'cf_blood', label: 'Blood group', type: 'select', options: ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'], order: 1 });
  db.put('customFields', { id: 'cf_saved', label: 'Year saved', type: 'number', options: [], order: 2 });
  const jobs = ['Software engineer', 'Teacher', 'Nurse', 'Doctor', 'Business owner', 'Accountant', 'Student', 'Homemaker'];
  adults.slice(0, 40).forEach((p, i) => db.put('people', { ...db.get('people', p.id)!, custom: { cf_profession: jobs[i % jobs.length], cf_blood: ['O+', 'B+', 'A+', 'AB+'][i % 4], cf_saved: 1995 + (i % 28) } }));

  db.put('smartLists', { id: 'sl_new', name: 'New visitors (last 60 days)', description: 'Visitors who joined recently.', match: 'all', rules: [{ field: 'status', op: 'is', value: 'visitor' }, { field: 'joinedDays', op: 'within', value: '60' }], createdAt: iso(now - 30 * DAY), createdBy: 'Leena George' });
  db.put('smartLists', { id: 'sl_missing', name: 'Members not seen in 4 weeks', description: '', match: 'all', rules: [{ field: 'status', op: 'is', value: 'member' }, { field: 'lastAttendedDays', op: 'not_within', value: '28' }], createdAt: iso(now - 30 * DAY), createdBy: 'Pastor Samuel Raj' });
  db.put('smartLists', { id: 'sl_young', name: 'Young adults (18-30)', description: '', match: 'all', rules: [{ field: 'age', op: 'gt', value: '17' }, { field: 'age', op: 'lt', value: '31' }], createdAt: iso(now - 30 * DAY), createdBy: 'Leena George' });
  db.put('smartLists', { id: 'sl_nogroup', name: 'Members not in a group', description: 'Good people to invite to a home group.', match: 'all', rules: [{ field: 'status', op: 'is', value: 'member' }, { field: 'group', op: 'is_not', value: '' }], createdAt: iso(now - 30 * DAY), createdBy: 'Leena George' });

  db.put('workflows', { id: 'wf_visitor', name: 'New visitor follow-up', description: 'Make every first-time guest feel welcome.', steps: [{ id: 'ws_1', title: 'Phone call within 2 days', dueDays: 2, assigneeId: 'st_4' }, { id: 'ws_2', title: 'Send welcome pack', dueDays: 5, assigneeId: 'st_2' }, { id: 'ws_3', title: 'Invite to lunch with the pastor', dueDays: 14, assigneeId: 'st_1' }, { id: 'ws_4', title: 'Connect to a home group', dueDays: 30, assigneeId: null }], trigger: 'manual', triggerId: null, defaultAssigneeId: 'st_4', active: true, createdAt: iso(now - 60 * DAY) });
  db.put('workflows', { id: 'wf_baptism', name: 'Baptism journey', description: 'From class sign-up to baptism Sunday.', steps: [{ id: 'ws_b1', title: 'Welcome call', dueDays: 3, assigneeId: 'st_1' }, { id: 'ws_b2', title: 'Attend the 4-week class', dueDays: 30, assigneeId: null }, { id: 'ws_b3', title: 'Testimony interview', dueDays: 40, assigneeId: 'st_1' }, { id: 'ws_b4', title: 'Baptism Sunday', dueDays: 50, assigneeId: 'st_1' }], trigger: 'form', triggerId: 'fm_baptism', defaultAssigneeId: 'st_1', active: true, createdAt: iso(now - 60 * DAY) });
  people.filter((p) => p.status === 'visitor').slice(-6).forEach((p, i) => db.put('workflowCards', { id: `wc_v${i}`, workflowId: 'wf_visitor', personId: p.id, stepIndex: i % 3, status: 'active', assignedTo: ['st_4', 'st_2', 'st_1'][i % 3], dueAt: iso(now + (i - 2) * DAY), createdAt: iso(now - (8 + i) * DAY), completedAt: null, history: [{ at: iso(now - (8 + i) * DAY), by: 'Leena George', action: 'added', note: '' }] }));
  responder.slice(8, 11).forEach((p, i) => db.put('workflowCards', { id: `wc_b${i}`, workflowId: 'wf_baptism', personId: p.id, stepIndex: i % 2, status: 'active', assignedTo: 'st_1', dueAt: iso(now + (i * 5 - 1) * DAY), createdAt: iso(now - 9 * DAY), completedAt: null, history: [] }));

  const sermon = (sid: string, title: string, speaker: string, daysAgo: number, series: string, scripture: string, description: string, notes = ''): Collections['sermons'] => ({ id: sid, title, speaker, date: new Date(now - daysAgo * DAY).toISOString().slice(0, 10), series, scripture, description, videoUrl: 'https://www.youtube.com/@gracechurchhyd', audioUrl: '', notesUrl: '', imageUrl: '', notes, published: true, eventId: null, createdAt: iso(now - daysAgo * DAY) });
  db.put('sermons', sermon('sm_1', 'Hope that does not disappoint', 'Pastor Samuel Raj', 7, 'Romans: The Gospel of Grace', 'Romans 5:1-5', 'Suffering produces perseverance, character and a hope that holds.', '## Peace with God (v1)\nJustified by faith, so we have peace, not a truce. Illustration: the two brothers who stopped speaking for eleven years.\n\n## Rejoicing in suffering (v3-4)\nSuffering → perseverance → character → hope. Not a formula; a road the Spirit walks us down.\n\n## Hope does not disappoint (v5)\nGod’s love poured out, not dripped. Application: whom will you make peace with this week?'));
  db.put('sermons', sermon('sm_2', 'No condemnation', 'Pastor Samuel Raj', 14, 'Romans: The Gospel of Grace', 'Romans 8:1-11', 'Life in the Spirit for those who are in Christ Jesus.'));
  db.put('sermons', sermon('sm_3', 'Faith that works', 'Mercy Daniel', 21, 'James', 'James 2:14-26', 'What does living faith look like on a Monday morning?'));
  db.put('sermons', sermon('sm_4', 'The God who sees', 'Pastor Samuel Raj', 28, 'Stand-alone', 'Genesis 16', 'Hagar meets the God who sees her in the wilderness.'));

  // Last Sunday's "Sunday in 60 seconds", already published, so the member app and the share page have one to show.
  {
    const ev7 = events.find((e) => e.id === 'ev_7')!;
    const plan7 = db.get('plans', 'ev_7')!;
    const songs7 = plan7.items.filter((i) => i.kind === 'song').map((i) => i.title);
    const ci7 = db.all('checkins').filter((c) => c.eventId === 'ev_7');
    const facts: Collections['recaps']['facts'] = {
      eventId: 'ev_7', eventTitle: ev7.title, date: ev7.startsAt.slice(0, 10), attendance: 846, children: ci7.filter((c) => c.isChild).length, firstTimers: ['Kiran', 'Deepa'],
      sermon: { title: 'Hope that does not disappoint', speaker: 'Pastor Samuel Raj', scripture: 'Romans 5:1-5', oneLiner: 'Suffering produces perseverance, character and a hope that holds.' },
      songs: songs7, celebrations: [], prayers: { requests: 6, prayed: 41 }, giving: null, nextEvents: [{ title: 'Youth Night', startsAt: at(2, 18, 30), location: 'Fellowship Hall' }],
    };
    db.put('recaps', {
      id: 'rc_1', eventId: 'ev_7', eventTitle: ev7.title, date: facts.date, language: 'en', headline: 'A Sunday of hope that holds', status: 'published', createdAt: iso(Date.parse(ev7.endsAt) + 3 * 3_600_000), createdBy: 'Leena George', publishedAt: iso(Date.parse(ev7.endsAt) + 4 * 3_600_000), notified: 0,
      caption: '✨ Sunday in 60 seconds\n846 of us worshipped together.\nPastor Samuel preached "Hope that does not disappoint" from Romans 5.\nA warm welcome to Kiran and Deepa 🙏\nNext: Youth Night, Tuesday.\n— Grace Community Church',
      stats: { attendance: 846, children: facts.children, firstTimers: 2, prayed: 41, songs: songs7.length },
      facts,
      slides: [
        { title: 'This Sunday', text: `846 of us gathered at Grace Community Church, ${facts.children} of them in kids church.`, stat: '846' },
        { title: 'The Word', text: 'Suffering produces perseverance, character and a hope that holds. (Pastor Samuel Raj)', stat: 'Romans 5:1-5' },
        { title: 'We sang', text: songs7.slice(0, 3).join(' · '), stat: `${songs7.length} songs` },
        { title: 'Our family', text: 'We welcomed Kiran and Deepa for the first time, and prayed 41 times for six requests on the prayer wall.', stat: '2 new' },
        { title: 'Coming up', text: 'Youth Night on Tuesday at the Fellowship Hall. See you Sunday!', stat: 'Tuesday' },
      ],
    });
  }

  // The demo church's brand kit: a simple mark so the logo shows beside the name everywhere.
  const demoLogo = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#7a2e2e"/><path d="M32 10v44M18 24h28" stroke="#fff" stroke-width="7" stroke-linecap="round"/><path d="M12 50c8-10 32-10 40 0" fill="none" stroke="#e9b949" stroke-width="4" stroke-linecap="round"/></svg>');
  db.put('settings', { ...db.get('settings', 'church')!, logoUrl: demoLogo, brand: { primary: '#7a2e2e', accent: '#e9b949', font: 'classic', logoDarkUrl: null, tagline: 'A home for everyone in Hyderabad' }, publicPage: { enabled: true, tagline: 'A home for everyone in Hyderabad', about: 'Grace Community Church has been serving Hyderabad since 1998. We are a family of families from every part of India, meeting in English and Telugu.', serviceTimes: 'Sundays 9:00 am (English) and 11:30 am (Telugu), Kondapur\nSundays 10:00 am, Secunderabad Hall', heroImageUrl: '', showEvents: true, showGroups: true, showSermons: true, showGiving: true } });

  const cash = db.all('donations').filter((d) => d.method === 'cash' || d.method === 'cheque').slice(0, 12);
  if (cash.length) {
    db.put('batches', { id: 'bt_1', name: 'Sunday offering (last week)', date: new Date(now - 7 * DAY).toISOString().slice(0, 10), status: 'committed', expectedTotal: cash.reduce((sum, d) => sum + d.amount, 0), notes: 'Counted by Vinod and Leena.', createdBy: 'Vinod Mathew', createdAt: iso(now - 7 * DAY), committedAt: iso(now - 6 * DAY), committedBy: 'Vinod Mathew' });
    for (const d of cash) db.put('donations', { ...d, batchId: 'bt_1' });
  }
  db.put('batches', { id: 'bt_2', name: 'Sunday offering (this week)', date: new Date(now).toISOString().slice(0, 10), status: 'open', expectedTotal: null, notes: '', createdBy: 'Vinod Mathew', createdAt: iso(now), committedAt: null, committedBy: null });

  // Two Indian-language songs with simple original words, so the projector can show them in English letters too.
  db.put('songs', { ...db.get('songs', 'sg_4')!, lyrics: 'Verse 1\nయేసు రాజా నీకే స్తుతి\nనా ప్రాణమా ఆయనను స్తుతించుము\nనీ ప్రేమ నిత్యము నిలుచును\n\nChorus\nస్తుతి స్తుతి స్తుతి యేసయ్యా\nమహిమ మహిమ నీకే యేసయ్యా', copyright: 'Public domain' });
  db.put('songs', { ...db.get('songs', 'sg_7')!, lyrics: 'Verse 1\nमहिमा हो, महिमा हो\nयीशु के नाम की महिमा हो\nवह राजाओं का राजा है\n\nChorus\nहल्लेलूयाह, हल्लेलूयाह\nयीशु मसीह प्रभु है', copyright: 'Public domain' });
  db.put('songs', { ...db.get('songs', 'sg_1')!, chordChart: '{title: Goodness of God}\n{key: A}\n\n[Verse 1]\n[A]I love You, [D]Lord\nOh Your [A]mercy never [E]fails me\n[A]All my [D]days\nI\'ve been [A]held in Your [E]hands\n\n[Chorus]\n[D]All my life You have been [A]faithful\n[E]All my life You have been so, so [F#m]good\n[D]With every breath that I am [A]able\n[E]Oh I will sing of the goodness of [A]God', attachments: [{ id: 'sa_1', name: 'Lead sheet (PDF)', url: 'https://example.com/goodness-of-god.pdf', kind: 'chart' }, { id: 'sa_2', name: 'Original recording', url: 'https://www.youtube.com/watch?v=n0FBb6hnwTo', kind: 'video' }] });

  // Public-domain hymns with full lyrics, so the projector and stage display have real words to show.
  const hymns: [string, string, string, number, string, string[]][] = [
    ['Amazing Grace', 'John Newton (1779)', 'G', 72,
      'Verse 1\nAmazing grace! How sweet the sound\nThat saved a wretch like me!\nI once was lost, but now am found;\nWas blind, but now I see.\n\nVerse 2\n’Twas grace that taught my heart to fear,\nAnd grace my fears relieved;\nHow precious did that grace appear\nThe hour I first believed.\n\nVerse 3\nThrough many dangers, toils and snares,\nI have already come;\n’Tis grace hath brought me safe thus far,\nAnd grace will lead me home.\n\nVerse 4\nWhen we’ve been there ten thousand years,\nBright shining as the sun,\nWe’ve no less days to sing God’s praise\nThan when we’d first begun.',
      ['Verse 1', 'Verse 2', 'Verse 3', 'Verse 4']],
    ['Blessed Assurance', 'Fanny Crosby (1873)', 'D', 100,
      'Verse 1\nBlessed assurance, Jesus is mine!\nO what a foretaste of glory divine!\nHeir of salvation, purchase of God,\nBorn of His Spirit, washed in His blood.\n\nChorus\nThis is my story, this is my song,\nPraising my Savior all the day long;\nThis is my story, this is my song,\nPraising my Savior all the day long.\n\nVerse 2\nPerfect submission, perfect delight,\nVisions of rapture now burst on my sight;\nAngels descending bring from above\nEchoes of mercy, whispers of love.\n\nVerse 3\nPerfect submission, all is at rest;\nI in my Savior am happy and blest,\nWatching and waiting, looking above,\nFilled with His goodness, lost in His love.',
      ['Verse 1', 'Chorus', 'Verse 2', 'Chorus', 'Verse 3', 'Chorus']],
    ['It Is Well with My Soul', 'Horatio Spafford (1873)', 'C', 66,
      'Verse 1\nWhen peace like a river attendeth my way,\nWhen sorrows like sea billows roll;\nWhatever my lot, Thou hast taught me to say,\nIt is well, it is well with my soul.\n\nChorus\nIt is well with my soul,\nIt is well, it is well with my soul.\n\nVerse 2\nThough Satan should buffet, though trials should come,\nLet this blest assurance control,\nThat Christ has regarded my helpless estate,\nAnd hath shed His own blood for my soul.\n\nVerse 3\nAnd Lord, haste the day when my faith shall be sight,\nThe clouds be rolled back as a scroll;\nThe trump shall resound, and the Lord shall descend,\nEven so, it is well with my soul.',
      ['Verse 1', 'Chorus', 'Verse 2', 'Chorus', 'Verse 3', 'Chorus']],
  ];
  hymns.forEach(([title, author, key, bpm, lyrics, arrangement], i) =>
    db.put('songs', { id: `sg_h${i + 1}`, title, author, defaultKey: key, bpm, ccli: '', tags: ['Hymn'], lyrics, arrangement }));
  // A simple folk harmonisation of Amazing Grace (public domain) so the musicians' view has chords to show.
  db.put('songs', { ...db.get('songs', 'sg_h1')!, chordChart: '{title: Amazing Grace}\n{key: G}\n\n[Verse 1]\nA[G]mazing grace! How [G7]sweet the [C]sound\nThat [G]saved a wretch like [D]me!\nI [G]once was lost, but [G7]now am [C]found;\nWas [G]blind, but [D]now I [G]see.\n\n[Verse 2]\n’Twas [G]grace that taught my [G7]heart to [C]fear,\nAnd [G]grace my fears re[D]lieved;\nHow [G]precious did that [G7]grace ap[C]pear\nThe [G]hour I [D]first be[G]lieved.\n\n[Verse 3]\nThrough [G]many dangers, [G7]toils and [C]snares,\nI [G]have already [D]come;\n’Tis [G]grace hath brought me [G7]safe thus [C]far,\nAnd [G]grace will [D]lead me [G]home.\n\n[Verse 4]\nWhen [G]we’ve been there ten [G7]thousand [C]years,\nBright [G]shining as the [D]sun,\nWe’ve [G]no less days to [G7]sing God’s [C]praise\nThan [G]when we’d [D]first be[G]gun.' });
  const plan1 = db.get('plans', 'ev_1')!;
  db.put('plans', {
    ...plan1,
    rehearsalAt: at(Math.max(1, toSunday - 3), 19),
    rehearsalNotes: 'Run the closing hymn twice. Start Amazing Grace a cappella, band in on verse 2.',
    items: plan1.items.map((it) =>
      it.kind === 'reading'
        ? { ...it, text: 'John 10:11-14 (KJV)\n\nI am the good shepherd: the good shepherd giveth his life for the sheep.\n\nBut he that is an hireling, and not the shepherd, whose own the sheep are not, seeth the wolf coming, and leaveth the sheep, and fleeth: and the wolf catcheth them, and scattereth them.\n\nThe hireling fleeth, because he is an hireling, and careth not for the sheep.\n\nI am the good shepherd, and know my sheep, and am known of mine.' }
        : it.songId === 'sg_12' ? { ...it, title: 'Amazing Grace', songId: 'sg_h1', key: 'G' } : it),
  });

  const grMembers = db.all('groupMembers').filter((m) => m.groupId === 'gr_1').map((m) => db.get('people', m.personId)!).filter(Boolean);
  if (grMembers.length >= 2) {
    db.put('groupPosts', { id: 'gp_1', groupId: 'gr_1', authorId: grMembers[0].id, authorName: `${grMembers[0].firstName} ${grMembers[0].lastName}`, text: 'This week we are at the Josephs’ home. Bring a friend! We continue in James chapter 2.', at: iso(now - DAY), pinned: true });
    db.put('groupPosts', { id: 'gp_2', groupId: 'gr_1', authorId: grMembers[1].id, authorName: `${grMembers[1].firstName} ${grMembers[1].lastName}`, text: 'Please pray for my mother’s surgery on Thursday.', at: iso(now - DAY / 2), pinned: false });
  }
  db.put('groupResources', { id: 'gr_r1', groupId: 'gr_1', name: 'James study guide', url: 'https://example.com/james-study-guide.pdf', addedBy: grMembers[0]?.id ?? '', addedByName: grMembers[0] ? `${grMembers[0].firstName} ${grMembers[0].lastName}` : 'Leader', at: iso(now - 10 * DAY) });

  // ----- audit -----
  const audit = (daysAgo: number, actor: string, action: string, entity: string, summary: string) => db.put('audit', { id: id('au'), at: iso(now - daysAgo * DAY), actorId: null, actorName: actor, action, entity, entityId: null, summary });
  audit(0.2, 'Leena George', 'created', 'event', 'Created event Blood Donation Camp');
  audit(0.5, 'Vinod Mathew', 'recorded', 'donation', 'Recorded cash gift from Sunday offering');
  audit(1, 'Pastor Samuel Raj', 'invited', 'staff', 'Invited Rahul Varghese as Group leader');
  audit(2, 'David Samuel', 'updated', 'plan', 'Updated the order of service for Sunday Worship (English)');
  audit(3, 'Leena George', 'imported', 'person', 'Imported people from excel: 12 added, 3 updated');
  void kids;

  // Celebrations this week, so the demo always has someone to greet.
  const md = (days: number) => new Date(now + days * DAY).toISOString().slice(5, 10);
  const celebrate = db.all('people').filter((p) => p.id !== DEMO_MEMBER && p.status === 'member' && p.consent.directory && !!p.birthDate && Number(p.birthDate.slice(0, 4)) < new Date(now).getUTCFullYear() - 25).slice(0, 3);
  if (celebrate[0]) db.put('people', { ...celebrate[0], birthDate: `${celebrate[0].birthDate?.slice(0, 4) ?? '1985'}-${md(0)}` });
  if (celebrate[1]) db.put('people', { ...celebrate[1], birthDate: `${celebrate[1].birthDate?.slice(0, 4) ?? '1990'}-${md(2)}` });
  if (celebrate[2]) db.put('people', { ...celebrate[2], anniversary: `2010-${md(4)}` });

  // ----- church registers -----
  const counters = new Map<string, number>();
  const reg = (kind: Collections['registers']['kind'], date: string, name: string, details: Record<string, string>, extra: Partial<Collections['registers']> = {}) => {
    const prefix = { baptism: 'BAP', confirmation: 'CNF', marriage: 'MAR', burial: 'BUR', transfer: 'TRF' }[kind];
    const key = `register:${kind}:${date.slice(0, 4)}`;
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    db.put('meta', { id: key, value: String(n) });
    db.put('registers', { id: id('rg'), kind, number: `${prefix}/${date.slice(0, 4)}/${String(n).padStart(4, '0')}`, date, place: 'Grace Community Church, Hyderabad', officiant: 'Rev. Samuel Raj', personId: null, spouseId: null, name, details, remarks: null, status: 'recorded', voidReason: null, notes: [], certificatesIssued: 0, createdAt: `${date}T10:00:00.000Z`, createdBy: 'Leena George', updatedAt: `${date}T10:00:00.000Z`, ...extra });
  };
  const thisYear = new Date(now).getUTCFullYear();
  reg('marriage', '2013-11-16', 'Arun Thomas', { groomAge: '27', groomStatus: 'Bachelor', groomFather: 'Thomas Mathew', groomAddress: 'Kondapur, Hyderabad', brideName: 'Priya Varghese', brideAge: '22', brideStatus: 'Spinster', brideFather: 'George Varghese', brideAddress: 'Secunderabad', bannsDates: '27 Oct, 3 Nov and 10 Nov 2013', witness1: 'John Varghese', witness2: 'Mary Joseph' }, { personId: 'p_arun', spouseId: DEMO_MEMBER });
  reg('baptism', `${thisYear}-01-14`, 'Ananya Reddy', { birthDate: `${thisYear - 1}-09-02`, birthPlace: 'Hyderabad', gender: 'Female', fatherName: 'Kiran Reddy', motherName: 'Sneha Reddy', address: 'Madhapur, Hyderabad', godparents: 'Rahul and Anita Varghese' });
  reg('baptism', `${thisYear}-04-20`, 'Joel Daniel', { birthDate: `${thisYear - 1}-12-11`, birthPlace: 'Secunderabad', gender: 'Male', fatherName: 'Daniel Paul', motherName: 'Grace Daniel', address: 'SD Road, Secunderabad', godparents: 'Samuel and Ruth Kumar' });
  reg('baptism', `${thisYear}-08-31`, 'Esther Joseph', { birthDate: `${thisYear}-03-18`, birthPlace: 'Hyderabad', gender: 'Female', fatherName: 'Joseph Mathew', motherName: 'Leah Joseph', address: 'Gachibowli, Hyderabad', godparents: 'Vinod and Susan Mathew' }, { certificatesIssued: 1 });
  reg('confirmation', `${thisYear}-05-25`, 'Rohan Thomas', { birthDate: `${thisYear - 15}-02-09`, baptismDate: `${thisYear - 15}-04-15`, baptismPlace: 'Grace Community Church, Hyderabad', fatherName: 'Thomas Mathew', motherName: 'Mercy Thomas', sponsor: 'David Samuel' });
  reg('burial', `${thisYear}-06-12`, 'Mathew Abraham', { deathDate: `${thisYear}-06-10`, age: '84', relation: 'Husband of Annamma Abraham', address: 'Kukatpally, Hyderabad', causeOfDeath: 'Old age', cemetery: 'Christian Cemetery, Narayanguda', graveNumber: 'C-114' });
  reg('transfer', `${thisYear}-07-03`, 'Sam and Rebecca John', { toChurch: 'St. Mark’s CSI Church, Bengaluru', toAddress: 'MG Road, Bengaluru 560001', memberSince: '2016-03-06', family: 'Their children Aaron and Hannah John', reason: 'Moving for work' });

  // ----- zones and home visits -----
  db.put('settings', { ...db.get('settings', 'church')!, zoneLabel: 'Prayer cell' });
  const zoneDefs = [
    { id: 'zn_kondapur', name: 'Kondapur', area: 'Kondapur, Kothaguda', meetingDay: 'Wednesday 7:30 pm', match: ['Kondapur', 'Kothaguda'] },
    { id: 'zn_madhapur', name: 'Madhapur & Hitech City', area: 'Madhapur, Hitech City, Gachibowli', meetingDay: 'Thursday 7:30 pm', match: ['Madhapur', 'Gachibowli', 'Hitech'] },
    { id: 'zn_secbad', name: 'Secunderabad', area: 'Secunderabad, Begumpet', meetingDay: 'Friday 7 pm', match: ['Secunderabad', 'Begumpet', 'Bowenpally'] },
    { id: 'zn_kukatpally', name: 'Kukatpally & Miyapur', area: 'Kukatpally, Miyapur, KPHB', meetingDay: 'Tuesday 7:30 pm', match: ['Kukatpally', 'Miyapur', 'KPHB'] },
  ];
  const adultsByZone = new Map<string, Collections['people'][]>();
  const zonePeople = db.all('people').filter((p) => p.status !== 'inactive');
  zonePeople.forEach((p, i) => {
    const hit = zoneDefs.find((z) => z.match.some((m) => (p.address ?? '').includes(m)));
    // Most households are in a cell; a few are still waiting to be placed.
    const zone = hit ?? (i % 6 === 5 ? null : zoneDefs[i % zoneDefs.length]);
    if (!zone) return;
    db.put('people', { ...db.get('people', p.id)!, zoneId: zone.id });
    if (!p.birthDate || Number(p.birthDate.slice(0, 4)) < new Date(now).getUTCFullYear() - 25) adultsByZone.set(zone.id, [...(adultsByZone.get(zone.id) ?? []), p]);
  });
  // Households share a zone with their first member.
  const firstZone = new Map<string, string | null | undefined>();
  for (const p of db.all('people')) {
    if (!p.householdName) continue;
    if (!firstZone.has(p.householdName)) firstZone.set(p.householdName, p.zoneId);
    else if (p.zoneId !== firstZone.get(p.householdName)) db.put('people', { ...p, zoneId: firstZone.get(p.householdName) ?? null });
  }
  for (const z of zoneDefs) {
    const leaders = (adultsByZone.get(z.id) ?? []).filter((p) => p.id !== DEMO_MEMBER).slice(0, 2).map((p) => p.id);
    db.put('zones', { id: z.id, name: z.name, parentId: null, leaderIds: leaders, meetingDay: z.meetingDay, area: z.area, notes: null, active: true, createdAt: iso(now - 300 * DAY) });
  }
  const famKey = (p: Collections['people']) => (p.householdName ? `h:${p.householdName}` : `solo:${p.id}`);
  const fams = new Map<string, Collections['people'][]>();
  for (const p of db.all('people').filter((x) => x.zoneId && x.status !== 'inactive')) fams.set(famKey(p), [...(fams.get(famKey(p)) ?? []), p]);
  const purposes = ['home', 'home', 'home', 'new_family', 'hospital', 'house_blessing'] as const;
  const notesFor: Record<(typeof purposes)[number], string[]> = {
    home: ['Prayed together for the children’s exams.', 'Father’s job situation; pray for steady work.', 'Grandmother unwell; would like communion at home.', 'New baby; family asked for a dedication date.'],
    new_family: ['Moved from Kerala last month. Shared the cell meeting details.'],
    hospital: ['Recovering after surgery, doing well.'],
    house_blessing: ['Blessed the new flat. Joyful time with neighbours.'],
  };
  [...fams.entries()].forEach(([key, members], i) => {
    if (i % 3 === 2) return; // about a third not visited yet this year
    const daysAgo = 10 + ((i * 37) % 240);
    const purpose = purposes[i % purposes.length];
    db.put('visits', { id: id('vs'), familyKey: key, familyName: key.startsWith('h:') ? key.slice(2) : `${members[0].firstName} ${members[0].lastName}`, personIds: members.map((p) => p.id), zoneId: members[0].zoneId ?? null, purpose, status: 'done', plannedFor: null, visitedOn: iso(now - daysAgo * DAY).slice(0, 10), visitorIds: [i % 2 ? 'st_4' : 'st_1'], visitorNames: i % 4 === 0 ? ['Cell leader'] : [], notes: notesFor[purpose][i % notesFor[purpose].length], prayerPoints: null, followUp: i % 5 === 0 ? 'Visit again next month' : null, confidential: false, createdAt: iso(now - daysAgo * DAY), createdBy: 'Pastor Samuel Raj' });
  });
  [...fams.entries()].filter((_, i) => i % 3 === 2).slice(0, 4).forEach(([key, members], i) => {
    db.put('visits', { id: id('vs'), familyKey: key, familyName: key.startsWith('h:') ? key.slice(2) : `${members[0].firstName} ${members[0].lastName}`, personIds: members.map((p) => p.id), zoneId: members[0].zoneId ?? null, purpose: 'home', status: 'planned', plannedFor: iso(now + (i + 1) * 2 * DAY).slice(0, 10), visitedOn: null, visitorIds: ['st_1'], visitorNames: [], notes: null, prayerPoints: null, followUp: null, confidential: false, createdAt: iso(now), createdBy: 'Pastor Samuel Raj' });
  });

  // ----- church accounts -----
  const fyStart = (() => { const d = new Date(now); const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1; return y; })();
  const fyLabel = `${fyStart}-${String(fyStart + 1).slice(2)}`;
  const headDefs: [string, string, number][] = [
    ['ah_salary', 'Salaries and honorarium', 1_800_000], ['ah_power', 'Electricity and water', 240_000], ['ah_rent', 'Rent and lease', 0], ['ah_maint', 'Maintenance and repairs', 300_000],
    ['ah_missions', 'Missions support', 600_000], ['ah_benev', 'Benevolence and charity', 250_000], ['ah_events', 'Events and programmes', 400_000], ['ah_media', 'Sound, media and equipment', 350_000],
    ['ah_print', 'Printing and stationery', 60_000], ['ah_travel', 'Travel and conveyance', 120_000], ['ah_bank', 'Bank charges', 12_000], ['ah_building', 'Building fund expenses', 5_000_000],
  ];
  for (const [hid, name, rupees] of headDefs) db.put('accountHeads', { id: hid, name, tallyName: null, tallyGroup: 'Indirect Expenses', budgets: rupees ? { [fyLabel]: rupees * 100 } : {}, active: true });
  let pv = 0;
  const exp = (daysAgo: number, headId: string, rupees: number, payee: string, description: string, status: Collections['expenses']['status'], method: Collections['expenses']['method'] = 'bank_transfer', by = 'Leena George') => {
    const date = iso(now - daysAgo * DAY).slice(0, 10);
    const paid = status === 'paid';
    db.put('expenses', { id: id('ex'), voucherNumber: paid ? `PV/${fyLabel}/${String(++pv).padStart(4, '0')}` : null, date, headId, amount: rupees * 100, payee, description, method: paid || status === 'approved' ? method : null, reference: paid && method !== 'cash' ? `UTR${100000 + pv * 7919}` : null, fcra: false, billUrl: null, status, submittedBy: by, submittedById: by === 'Leena George' ? 'st_2' : 'st_5', submittedAt: iso(now - (daysAgo + 1) * DAY), decidedBy: status === 'submitted' ? null : 'Vinod Mathew', decidedAt: status === 'submitted' ? null : iso(now - daysAgo * DAY), decisionNote: status === 'rejected' ? 'Please get a second quote first.' : null, paidAt: paid ? iso(now - daysAgo * DAY) : null });
  };
  for (let m = 0; m < 6; m++) {
    exp(5 + m * 30, 'ah_salary', 145_000, 'Staff salaries', `Salaries for ${new Date(now - (5 + m * 30) * DAY).toLocaleDateString('en-IN', { month: 'long' })}`, 'paid');
    exp(8 + m * 30, 'ah_power', 17_400 + m * 650, 'TSSPDCL', 'Electricity bill, church hall', 'paid', 'upi');
    exp(12 + m * 30, 'ah_missions', 50_000, 'North India church planting', 'Monthly missions support', 'paid');
  }
  exp(20, 'ah_media', 38_500, 'Sri Sai Audio, Ameerpet', 'Two wireless handheld microphones', 'paid', 'upi', 'David Samuel');
  exp(33, 'ah_events', 22_000, 'Hotel Annapurna Caterers', 'Youth retreat lunch for 110', 'paid', 'cheque');
  exp(41, 'ah_benev', 15_000, 'Ramesh K.', 'School fees support (family in need)', 'paid', 'bank_transfer');
  exp(3, 'ah_maint', 12_800, 'Venkat Electricals', 'Repair of hall fans and wiring', 'approved', 'cash');
  exp(1, 'ah_media', 64_000, 'Musicland, Abids', 'New keyboard for the worship team', 'submitted', null, 'David Samuel');
  exp(2, 'ah_print', 4_200, 'Om Printers', 'Christmas programme flyers, 1,000 copies', 'submitted', null, 'Leena George');
  exp(15, 'ah_events', 90_000, 'Shamiana Tent House', 'Tent and chairs for the outdoor carol service', 'rejected', null, 'David Samuel');
  db.put('settings', { ...db.get('settings', 'church')!, tally: { companyName: 'Grace Community Church Trust', bankLedger: 'HDFC Bank A/c 4821', cashLedger: 'Cash', fcraBankLedger: 'SBI FCRA A/c (New Delhi Main Branch)' } });
  db.put('meta', { id: `voucher:pv:${fyLabel}`, value: String(pv) });
}
