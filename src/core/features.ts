// Features a church can switch on and off (Settings › Features), so the office menu shows only
// what this church uses. Switching one off hides it; no records are touched. Core features are
// always on. A church that has never chosen gets the `on` defaults below.

export type FeatureGroup = 'people' | 'care' | 'sundays' | 'money' | 'comms' | 'seasonal';

export type FeatureInfo = {
  key: string;
  label: string;
  /** One line on what it is for, shown on the switch card. */
  body: string;
  group: FeatureGroup;
  /** On for a church that has not chosen yet. */
  on: boolean;
  /** Always on; no switch. */
  core?: boolean;
};

export const FEATURE_GROUPS: { id: FeatureGroup; label: string }[] = [
  { id: 'people', label: 'People and groups' },
  { id: 'care', label: 'Care and growth' },
  { id: 'sundays', label: 'Sundays and events' },
  { id: 'money', label: 'Giving and accounts' },
  { id: 'comms', label: 'Messages and media' },
  { id: 'seasonal', label: 'Seasonal and occasional' },
];

export const FEATURES: FeatureInfo[] = [
  // People and groups
  { key: 'people', label: 'People', body: 'Everyone in the church, families and their history.', group: 'people', on: true, core: true },
  { key: 'groups', label: 'Groups', body: 'Small groups, cells and fellowships with meetings and attendance.', group: 'people', on: true, core: true },
  { key: 'lists', label: 'Saved lists', body: 'Lists that keep themselves up to date, such as "youth not seen in a month".', group: 'people', on: true },
  { key: 'zones', label: 'Area visits', body: 'Zones or prayer cells with leaders and home visits.', group: 'people', on: true },
  { key: 'registers', label: 'Registers', body: 'Baptism, marriage and membership registers with certificates.', group: 'people', on: true },
  { key: 'safeguarding', label: 'Safeguarding', body: 'Checks and training for people who work with children.', group: 'people', on: true },
  { key: 'registration', label: 'Online registration', body: 'A link and QR code where families register themselves; the office approves them into People.', group: 'people', on: true },
  { key: 'import', label: 'Import', body: 'Bring people in from Excel, Google Sheets or another system.', group: 'people', on: true, core: true },
  // Care and growth
  { key: 'care', label: 'Care & prayer', body: 'Care cases, prayer requests and who has not been seen.', group: 'care', on: true, core: true },
  { key: 'workflows', label: 'Follow-ups', body: 'Step-by-step follow-up for visitors and new believers.', group: 'care', on: true },
  { key: 'vigils', label: 'Prayer vigils', body: 'Fill a 24-hour or night prayer chain, slot by slot.', group: 'care', on: false },
  { key: 'benevolence', label: 'Benevolence', body: 'Requests for help, approvals and payments from the welfare fund.', group: 'care', on: false },
  { key: 'occasions', label: 'Weddings & funerals', body: 'Plan weddings, funerals and dedications with checklists.', group: 'care', on: false },
  { key: 'discipleship', label: 'Discipleship', body: 'Mentors and the people they walk with.', group: 'care', on: false },
  { key: 'courses', label: 'Classes & courses', body: 'Bible school, membership class and baptism class with attendance.', group: 'care', on: false },
  { key: 'library', label: 'Library', body: 'Lend books and keep track of who has them.', group: 'care', on: false },
  { key: 'skills', label: 'Skills & board', body: 'Who can help with what, and a board for needs and offers.', group: 'care', on: false },
  // Sundays and events
  { key: 'events', label: 'Services & events', body: 'Services, meetings and events with RSVPs and tickets.', group: 'sundays', on: true, core: true },
  { key: 'calendar', label: 'Calendar & rooms', body: 'The church calendar and room bookings.', group: 'sundays', on: true },
  { key: 'forms', label: 'Forms & sign-ups', body: 'Registrations, payments and sign-up forms.', group: 'sundays', on: true },
  { key: 'services', label: 'Service planning', body: 'Order of service, songs, the projector and the band view.', group: 'sundays', on: true, core: true },
  { key: 'volunteers', label: 'Volunteers', body: 'Teams, rotas and who is serving when.', group: 'sundays', on: true, core: true },
  { key: 'checkin', label: 'Check-in', body: 'Sunday attendance and children\'s check-in with labels.', group: 'sundays', on: true, core: true },
  { key: 'sunday-school', label: 'Sunday school', body: 'Classes, teachers and lessons for children.', group: 'sundays', on: true },
  { key: 'sermons', label: 'Sermons', body: 'Sermon notes, series and recordings for members.', group: 'sundays', on: true },
  { key: 'livestream', label: 'Livestream', body: 'Go live to YouTube or Facebook from the service plan.', group: 'sundays', on: true },
  { key: 'practice', label: 'Choir practice', body: 'Rehearsal attendance and part recordings for singers.', group: 'sundays', on: false },
  { key: 'recap', label: 'Sunday in 60 seconds', body: 'A short recap of the service to send out on Sunday evening.', group: 'sundays', on: false },
  { key: 'reading', label: 'Bible reading plan', body: 'A reading plan the whole church follows together.', group: 'sundays', on: false },
  { key: 'rides', label: 'Sunday lifts', body: 'Match people who need a lift with drivers.', group: 'sundays', on: false },
  { key: 'missed-call', label: 'Missed-call line', body: 'People with basic phones give a missed call to hear the week\'s news.', group: 'sundays', on: false },
  // Giving and accounts
  { key: 'giving', label: 'Giving', body: 'Online and cash giving, 80G receipts and statements.', group: 'money', on: true, core: true },
  { key: 'accounts', label: 'Accounts & expenses', body: 'Income, expenses, vouchers and budgets.', group: 'money', on: true },
  { key: 'offerings', label: 'Special offerings', body: 'Harvest festival, building fund and other special collections.', group: 'money', on: false },
  { key: 'missions', label: 'Missions', body: 'Missionaries you support and what they need.', group: 'money', on: false },
  { key: 'bank', label: 'Bank reconciliation', body: 'Match the bank statement with gifts and expenses.', group: 'money', on: false },
  { key: 'assets', label: 'Assets', body: 'Furniture, instruments and equipment with service dates.', group: 'money', on: false },
  { key: 'annual-return', label: 'Annual return', body: 'The yearly figures for the registrar or diocese.', group: 'money', on: false },
  // Messages and media
  { key: 'messages', label: 'Messages', body: 'Email, SMS and WhatsApp to the people you choose.', group: 'comms', on: true, core: true },
  { key: 'announcements', label: 'Announcements', body: 'News on the member app and the weekly notices.', group: 'comms', on: true, core: true },
  { key: 'team-hub', label: 'Staff chat', body: 'Chat and tasks for the staff and team leaders.', group: 'comms', on: true },
  { key: 'media', label: 'Media library', body: 'Photos, videos and files in one place.', group: 'comms', on: true },
  { key: 'bulletin', label: 'Bulletin', body: 'A printable Sunday bulletin made from the plan and notices.', group: 'comms', on: false },
  { key: 'insights', label: 'Reports', body: 'Attendance, giving and growth over time.', group: 'comms', on: true, core: true },
  // Seasonal and occasional
  { key: 'celebrations', label: 'Celebrations', body: 'Birthdays and anniversaries with a greeting in one tap.', group: 'seasonal', on: true },
  { key: 'video-greetings', label: 'Video greetings', body: 'Short video wishes recorded by the pastor.', group: 'seasonal', on: false },
  { key: 'carols', label: 'Carol rounds', body: 'Plan Christmas carol rounds house by house.', group: 'seasonal', on: false },
  { key: 'feasts', label: 'Love feasts & kitchen', body: 'Menus, quantities and the kitchen team for church meals.', group: 'seasonal', on: false },
  { key: 'camps', label: 'Camps & retreats', body: 'Family sign-ups, rooms and bus seats for camps.', group: 'seasonal', on: false },
  { key: 'rentals', label: 'Hall hire', body: 'Rent the hall or ground to outsiders and take payment.', group: 'seasonal', on: false },
  { key: 'elections', label: 'Elections & AGM', body: 'Nominations, voting and minutes for the annual meeting.', group: 'seasonal', on: false },
];

const BY_KEY = new Map(FEATURES.map((f) => [f.key, f]));

/** Whether a feature is on for a church with these choices (unknown keys count as on). */
export function featureOn(choices: Partial<Record<string, boolean>> | null | undefined, key: string): boolean {
  const f = BY_KEY.get(key);
  if (!f) return true;
  if (f.core) return true;
  return choices?.[key] ?? f.on;
}

/** Keeps only known, switchable features with true/false values. */
export function cleanFeatures(raw: unknown, prev?: Partial<Record<string, boolean>>): Record<string, boolean> {
  const out: Record<string, boolean> = { ...(prev ?? {}) } as Record<string, boolean>;
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const f = BY_KEY.get(k);
    if (f && !f.core && typeof v === 'boolean') out[k] = v;
  }
  return out;
}
