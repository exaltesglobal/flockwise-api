// Every shape the Flockwise API sends or stores. This folder (src/core) is the single
// implementation of the church logic: the API server runs it against MySQL, and the web
// app's demo mode runs the very same code in the browser. Keep it free of Node and DOM APIs.
// Money is in minor units (paise / cents). Times are ISO 8601 UTC strings. Dates are YYYY-MM-DD.

// ---------- member contract (docs/API.md, shared with the mobile app) ----------

export type Currency = 'INR' | 'USD' | 'GBP' | 'AUD' | 'AED' | 'CAD' | 'EUR' | 'SGD';
export type LanguageCode = 'en' | 'hi' | 'ta' | 'te' | 'ml' | 'kn';

export type Church = {
  id: string;
  name: string;
  city: string;
  country: string;
  currency: Currency;
  logoUrl?: string | null;
  paymentProvider: 'razorpay' | 'stripe';
};

export type Member = {
  id: string;
  firstName: string;
  lastName: string;
  phone?: string | null;
  email?: string | null;
  photoUrl?: string | null;
  language: LanguageCode;
  householdName?: string | null;
};

export type StaffRole = 'owner' | 'admin' | 'pastor' | 'finance' | 'leader' | 'coordinator' | 'checkin';

export type Session = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  member: Member;
  church: Church;
  staff?: { role: StaffRole; permissions: Permission[] } | null;
};

export type OtpRequest = { requestId: string; channel: 'email'; expiresInSeconds: number };

export type Announcement = { id: string; title: string; body: string; publishedAt: string; imageUrl?: string | null };

export type RsvpStatus = 'going' | 'not_going';

export type ChurchEvent = {
  id: string;
  kind: 'service' | 'event';
  title: string;
  description: string;
  startsAt: string;
  endsAt: string;
  location: string;
  imageUrl?: string | null;
  goingCount: number;
  capacity?: number | null;
  myRsvp: RsvpStatus | null;
  /** Ticket price in minor units for paid events; null or 0 means free. */
  price?: number | null;
  campusName?: string | null;
  checkedIn?: boolean;
};

export type HomeFeed = { nextService: ChurchEvent | null; announcements: Announcement[]; upcomingEvents: ChurchEvent[] };

export type Group = {
  id: string;
  name: string;
  description: string;
  meetingSchedule: string;
  location: string;
  leaderName: string;
  memberCount: number;
  membership: 'member' | 'requested' | 'none';
  type?: GroupType;
};

export type Fund = { id: string; name: string; description: string; taxDeductible: boolean };
export type GiveFrequency = 'once' | 'monthly';
export type GiveIntentInput = { fundId: string; amount: number; currency: Currency; frequency: GiveFrequency; donorCitizenship: 'IN' | 'OTHER'; pan?: string };
export type GiveIntent = { donationId: string; checkoutUrl: string };
export type DonationStatus = 'pending' | 'succeeded' | 'failed' | 'refunded';
export type Donation = { id: string; fundName: string; amount: number; currency: Currency; frequency: GiveFrequency; status: DonationStatus; createdAt: string; receiptUrl?: string | null };
export type Paginated<T> = { data: T[]; nextCursor: string | null };
export type ApiErrorBody = { error: { code: string; message: string; fields?: Record<string, string> } };

// ---------- people ----------

export type PersonStatus = 'member' | 'regular' | 'visitor' | 'inactive';
export type Consent = { email: boolean; sms: boolean; whatsapp: boolean; directory: boolean };

export type Person = {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  gender: 'male' | 'female' | null;
  birthDate: string | null;
  status: PersonStatus;
  householdName: string | null;
  address: string | null;
  language: LanguageCode;
  tags: string[];
  notes: string | null;
  joinedAt: string;
  lastAttendedAt: string | null;
  groups: { id: string; name: string }[];
  campusId: string | null;
  baptismDate: string | null;
  anniversary: string | null;
  /** Shown on kids' check-in labels. */
  allergies: string | null;
  medicalNotes: string | null;
  consent: Consent;
  /** Personal check-in code, encoded in the member's QR as FW1:<code>. */
  checkinCode: string;
};

export type PersonInput = Partial<Omit<Person, 'id' | 'joinedAt' | 'lastAttendedAt' | 'groups' | 'checkinCode'>> & { firstName: string; lastName: string };
export type PeopleQuery = { q?: string; status?: PersonStatus | ''; campusId?: string; tag?: string; cursor?: string };
export type PeoplePage = { data: Person[]; nextCursor: string | null; total: number };
export type ImportSource = 'excel' | 'csv' | 'elvanto' | 'planning_center';
export type ImportResult = { created: number; updated: number; skipped: number; errors: { row: number; message: string }[] };

/** Everything the office sees on one person's page. */
export type PersonTimeline = {
  person: Person;
  household: { id: string; name: string; status: PersonStatus; age: number | null }[];
  attendance: { eventId: string; title: string; at: string }[];
  serving: { teamName: string; positionName: string; eventTitle: string; startsAt: string; status: AssignmentStatus }[];
  giving: { thisYear: number; lastGiftAt: string | null; recurring: boolean } | null;
  care: { id: string; title: string; status: CareStatus; createdAt: string }[];
};

// ---------- campuses ----------

export type Campus = { id: string; name: string; city: string; address: string; serviceTimes: string };

// ---------- events ----------

export type AdminEvent = Omit<ChurchEvent, 'myRsvp' | 'checkedIn'> & {
  published: boolean;
  attendance: number | null;
  campusId: string | null;
  checkinEnabled: boolean;
  checkinCount: number;
};
export type EventInput = Omit<AdminEvent, 'id' | 'goingCount' | 'attendance' | 'checkinCount' | 'campusName'>;
export type EventAttendee = { personId: string; name: string; phone: string | null; rsvp: boolean; checkedIn: boolean; paid: boolean | null };

// ---------- groups ----------

export type GroupType = 'cell' | 'ministry' | 'class' | 'other';
export type AdminGroup = Omit<Group, 'membership'> & { isOpen: boolean; pendingRequests: number; type: GroupType; zone: string; leaderId: string | null };
export type GroupInput = Omit<AdminGroup, 'id' | 'memberCount' | 'pendingRequests'>;
export type JoinRequest = { id: string; groupId: string; groupName: string; person: { id: string; name: string; phone: string | null }; requestedAt: string };
export type GroupMeeting = { id: string; groupId: string; date: string; presentIds: string[]; guests: number; notes: string; recordedBy: string };
export type GroupDetail = { group: AdminGroup; members: { id: string; name: string; phone: string | null; status: PersonStatus }[]; meetings: GroupMeeting[] };

// ---------- giving ----------

export type PaymentMethod = 'upi' | 'card' | 'netbanking' | 'wallet' | 'cash' | 'cheque' | 'bank_transfer';

/** Stored donation row. Event tickets are donations to the hidden "Event registrations" fund with eventId set. */
export type DonationRecord = {
  id: string;
  donorId: string | null;
  donorName: string;
  donorEmail: string | null;
  donorPhone: string | null;
  fundId: string;
  fundName: string;
  amount: number;
  currency: Currency;
  frequency: GiveFrequency;
  status: DonationStatus;
  method: PaymentMethod | null;
  pan: string | null;
  donorCitizenship: 'IN' | 'OTHER';
  fcra: boolean;
  provider: 'razorpay' | 'stripe' | 'fake' | 'offline' | 'demo';
  /** Razorpay payment link (plink_) or subscription (sub_) id. */
  providerRef: string | null;
  /** Razorpay payment id (pay_). Unique so webhook retries cannot double count. */
  providerPaymentId: string | null;
  createdAt: string;
  paidAt: string | null;
  eventId: string | null;
  receiptNumber: string | null;
};

export type AdminDonation = Donation & {
  donorId: string | null;
  donorName: string;
  fundId: string;
  method: PaymentMethod;
  pan: string | null;
  donorCitizenship: 'IN' | 'OTHER';
  fcra: boolean;
  receiptNumber: string | null;
};
export type OfflineDonationInput = { donorId: string | null; donorName: string; fundId: string; amount: number; method: 'cash' | 'cheque' | 'bank_transfer'; pan?: string; donorCitizenship: 'IN' | 'OTHER'; receivedAt: string };
export type DonationQuery = { fundId?: string; from?: string; to?: string; q?: string; cursor?: string };
export type DonationPage = { data: AdminDonation[]; nextCursor: string | null; total: number; totalAmount: number };

export type FundRecord = { id: string; name: string; description: string; taxDeductible: boolean; active: boolean; goal: number | null; system?: boolean };
export type AdminFund = Fund & { active: boolean; raisedThisYear: number; goal: number | null; pledged: number };
export type FundInput = Omit<AdminFund, 'id' | 'raisedThisYear' | 'pledged'>;

export type Receipts80g = {
  financialYear: string;
  donors: { donorId: string | null; name: string; pan: string | null; total: number; count: number; modes: PaymentMethod[] }[];
};

export type Pledge = { id: string; personId: string; personName: string; fundId: string; fundName: string; amount: number; startDate: string; endDate: string; createdAt: string };
export type PledgeView = Pledge & { given: number; currency: Currency };

export type GivingStatement = {
  church: { name: string; address: string; pan: string | null; registration80g: string | null };
  donor: { id: string; name: string; pan: string | null; address: string | null };
  financialYear: string;
  currency: Currency;
  gifts: { id: string; date: string; fundName: string; amount: number; method: PaymentMethod | null; receiptNumber: string | null; eligible80g: boolean }[];
  total: number;
  eligible80g: number;
};

// ---------- announcements ----------

export type AdminAnnouncement = Announcement & { status: 'draft' | 'published' };
export type AnnouncementInput = Pick<AdminAnnouncement, 'title' | 'body' | 'status'>;

// ---------- check-in ----------

export type Room = { id: string; name: string; minAge: number; maxAge: number; capacity: number | null };
export type CheckinMethod = 'staff' | 'kiosk' | 'qr' | 'self';
export type Checkin = {
  id: string;
  eventId: string;
  personId: string;
  personName: string;
  householdName: string | null;
  at: string;
  method: CheckinMethod;
  isChild: boolean;
  roomId: string | null;
  roomName: string | null;
  securityCode: string | null;
  allergies: string | null;
  checkedOutAt: string | null;
};
export type CheckinSummary = {
  event: AdminEvent;
  total: number;
  children: number;
  stillIn: number;
  rooms: { room: Room; count: number }[];
  checkins: Checkin[];
};
export type CheckinCandidate = { id: string; name: string; age: number | null; isChild: boolean; allergies: string | null; roomId: string | null; roomName: string | null; checkedIn: boolean };
export type CheckinFamily = { householdName: string | null; people: CheckinCandidate[] };
export type CheckinLabel = { kind: 'child' | 'guardian'; name: string; room: string | null; securityCode: string; allergies: string | null; event: string; date: string };
export type CheckinResult = { checkins: Checkin[]; securityCode: string | null; labels: CheckinLabel[] };

// ---------- volunteers ----------

export type Position = { id: string; name: string; needed: number };
export type Team = { id: string; name: string; description: string; color: string; leaderId: string | null; positions: Position[]; members: { personId: string; positionIds: string[] }[] };
export type TeamView = Team & { leaderName: string | null; memberDetails: { personId: string; name: string; positionIds: string[]; lastServedAt: string | null; timesServed90d: number }[] };
export type AssignmentStatus = 'pending' | 'accepted' | 'declined';
export type Assignment = { id: string; eventId: string; teamId: string; positionId: string; personId: string; status: AssignmentStatus; createdAt: string; respondedAt: string | null; note: string | null };
export type Blockout = { id: string; personId: string; from: string; to: string; reason: string };
export type ScheduleSlot = {
  team: { id: string; name: string; color: string };
  position: Position;
  assignments: (Assignment & { name: string })[];
  open: number;
};
export type Schedule = { event: AdminEvent; slots: ScheduleSlot[] };
export type ScheduleOverview = { event: AdminEvent; needed: number; filled: number; accepted: number; declined: number; pending: number }[];
export type AvailablePerson = { personId: string; name: string; available: boolean; reason: string | null; lastServedAt: string | null; timesServed90d: number };
export type MyServing = {
  assignments: (Assignment & { event: ChurchEvent; teamName: string; positionName: string; plan: PlanItem[] })[];
  teams: { id: string; name: string; positions: string[] }[];
  blockouts: Blockout[];
};

// ---------- service planning ----------

export type PlanItemKind = 'song' | 'reading' | 'sermon' | 'prayer' | 'announcement' | 'offering' | 'video' | 'other';
export type PlanItem = { id: string; kind: PlanItemKind; title: string; songId: string | null; key: string | null; minutes: number; notes: string; person: string };
export type Plan = { id: string; eventId: string; theme: string; notes: string; items: PlanItem[]; updatedAt: string };
export type Song = { id: string; title: string; author: string; defaultKey: string; bpm: number | null; ccli: string; tags: string[]; lyrics: string };
export type SongView = Song & { timesUsed: number; lastUsedAt: string | null };
export type ServiceSummary = { event: AdminEvent; items: number; minutes: number; songs: string[]; theme: string; volunteers: { filled: number; needed: number } };
export type ServiceDetail = { event: AdminEvent; plan: Plan; team: { teamName: string; positionName: string; name: string; status: AssignmentStatus }[] };

// ---------- messaging ----------

export type Channel = 'email' | 'sms' | 'whatsapp';
export type AudienceType = 'everyone' | 'status' | 'group' | 'team' | 'tag' | 'campus' | 'people' | 'event';
export type Audience = { type: AudienceType; ids: string[] };
export type MessageStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed';
export type Message = {
  id: string;
  channel: Channel;
  audience: Audience;
  audienceLabel: string;
  subject: string;
  body: string;
  status: MessageStatus;
  scheduledAt: string | null;
  sentAt: string | null;
  createdAt: string;
  createdBy: string;
  stats: { recipients: number; sent: number; failed: number; skipped: number };
  /** True when no provider is configured for the channel and delivery was only logged. */
  simulated: boolean;
  source: 'manual' | 'automation' | 'system';
};
export type MessageInput = { channel: Channel; audience: Audience; subject?: string; body: string; scheduledAt?: string | null; send?: boolean };
export type AudiencePreview = { total: number; reachable: number; optedOut: number; noContact: number; sample: string[] };
export type Template = { id: string; name: string; channel: Channel; subject: string; body: string };
export type Automation = { enabled: boolean; channel: Channel; subject: string; body: string };
export type Automations = {
  birthday: Automation;
  anniversary: Automation;
  welcome: Automation & { createFollowUp: boolean };
  missing: Automation & { weeks: number; createFollowUp: boolean };
  volunteerReminder: Automation & { daysBefore: number };
};
export type ChannelStatus = Record<Channel, { configured: boolean; provider: string }>;

// ---------- pastoral care ----------

export type CareType = 'follow_up' | 'visitor' | 'hospital' | 'counselling' | 'bereavement' | 'prayer' | 'absent' | 'other';
export type CareStatus = 'open' | 'in_progress' | 'closed';
export type CareNote = { id: string; at: string; by: string; text: string };
export type CareCase = {
  id: string;
  personId: string | null;
  personName: string;
  type: CareType;
  title: string;
  status: CareStatus;
  priority: 'normal' | 'urgent';
  assignedTo: string | null;
  assignedName: string | null;
  dueAt: string | null;
  createdAt: string;
  closedAt: string | null;
  notes: CareNote[];
  source: 'manual' | 'automation' | 'prayer';
  confidential: boolean;
};
export type CareInput = Pick<CareCase, 'personId' | 'type' | 'title' | 'priority' | 'assignedTo' | 'dueAt' | 'confidential'> & { note?: string };
export type AtRiskPerson = { id: string; name: string; phone: string | null; status: PersonStatus; lastAttendedAt: string | null; weeksAway: number; openCaseId: string | null };
export type PrayerRequest = {
  id: string;
  personId: string | null;
  name: string;
  text: string;
  visibility: 'pastors' | 'church';
  status: 'open' | 'answered';
  prayedBy: string[];
  createdAt: string;
  answeredNote: string | null;
};
export type PrayerView = Omit<PrayerRequest, 'prayedBy'> & { prayedCount: number; iPrayed: boolean; mine: boolean };

// ---------- directory ----------

export type DirectoryEntry = { householdName: string; area: string | null; people: { id: string; name: string; phone: string | null; email: string | null }[] };
export type MemberPreferences = { consent: Consent; checkinCode: string; campusId: string | null };

// ---------- dashboards ----------

export type Dashboard = {
  currency: Currency;
  people: { total: number; members: number; newThisMonth: number };
  attendance: { lastSunday: number; trend: { date: string; count: number }[] };
  giving: { thisMonth: number; lastMonth: number; trend: { month: string; amount: number }[] };
  pendingJoinRequests: number;
  upcomingEvents: AdminEvent[];
  recentDonations: AdminDonation[];
  birthdaysThisWeek: { id: string; name: string; date: string }[];
  care: { open: number; overdue: number; atRisk: number; prayer: number };
  serving: { openSlots: number; pending: number; nextEventTitle: string | null };
};

export type Insights = {
  currency: Currency;
  funnel: { status: PersonStatus; count: number }[];
  newPeople: { month: string; count: number }[];
  attendance: { date: string; count: number }[];
  checkins: { date: string; adults: number; children: number }[];
  givingByFund: { fund: string; amount: number }[];
  givers: { recurring: number; regular: number; occasional: number; lapsed: number };
  engagement: { inGroup: number; serving: number; giving: number; total: number };
  retention: { visitorsLast90: number; becameRegular: number };
  care: { open: number; closedLast30: number; avgDaysToClose: number | null };
};

// ---------- settings, staff, audit ----------

export type ChurchSettings = Church & {
  address: string;
  phone: string;
  email: string;
  website: string;
  timezone: string;
  languages: LanguageCode[];
  payments: { provider: 'razorpay' | 'stripe'; connected: boolean; accountId: string | null };
  fcra: { registered: boolean; registrationNumber: string | null; accountLast4: string | null };
  receipts80g: { enabled: boolean; registrationNumber: string | null; pan: string | null };
  /** Children are people younger than this; they check in to rooms with security codes. */
  childAgeLimit: number;
};

export type Permission =
  | 'people.view'
  | 'people.edit'
  | 'giving.view'
  | 'giving.edit'
  | 'events'
  | 'groups'
  | 'comms'
  | 'care'
  | 'checkin'
  | 'volunteers'
  | 'services'
  | 'settings'
  | 'staff'
  | 'insights';

export type StaffMember = { id: string; personId: string | null; name: string; email: string; phone: string | null; role: StaffRole; status: 'active' | 'invited'; lastActiveAt: string | null };

export type AuditEntry = { id: string; at: string; actorId: string | null; actorName: string; action: string; entity: string; entityId: string | null; summary: string };

// ---------- internal records ----------

export type OtpRecord = { id: string; email: string; codeHash: string; audience: 'admin' | 'member'; createdAt: string; expiresAt: string; attempts: number; used: boolean };
export type RefreshRecord = { id: string; tokenHash: string; personId: string; staffId: string | null; scope: 'admin' | 'member'; createdAt: string; expiresAt: string; revoked: boolean };
export type RsvpRecord = { id: string; eventId: string; personId: string; at: string };
export type MemberRecord = { id: string; groupId: string; personId: string; since: string };
export type AttendancePoint = { id: string; date: string; count: number };
export type MetaRecord = { id: string; value: string };

/** Every collection the engine stores. The key is the record kind. */
export type Collections = {
  settings: ChurchSettings & { id: string };
  automations: Automations & { id: string };
  people: Omit<Person, 'groups'>;
  campuses: Campus;
  events: Omit<AdminEvent, 'goingCount' | 'checkinCount' | 'campusName'>;
  rsvps: RsvpRecord;
  groups: Omit<AdminGroup, 'memberCount' | 'pendingRequests'>;
  groupMembers: MemberRecord;
  joinRequests: Omit<JoinRequest, 'groupName'>;
  groupMeetings: GroupMeeting;
  funds: FundRecord;
  donations: DonationRecord;
  pledges: Pledge;
  plans: Plan;
  announcements: AdminAnnouncement;
  staff: StaffMember;
  rooms: Room;
  checkins: Checkin;
  teams: Team;
  assignments: Assignment;
  blockouts: Blockout;
  songs: Song;
  messages: Message;
  templates: Template;
  care: CareCase;
  prayer: PrayerRequest;
  audit: AuditEntry;
  otps: OtpRecord;
  refreshTokens: RefreshRecord;
  attendanceHistory: AttendancePoint;
  meta: MetaRecord;
};
export type Kind = keyof Collections;
export const KINDS = [
  'settings', 'automations', 'people', 'campuses', 'events', 'rsvps', 'groups', 'groupMembers', 'joinRequests', 'groupMeetings',
  'funds', 'donations', 'pledges', 'plans', 'announcements', 'staff', 'rooms', 'checkins', 'teams', 'assignments', 'blockouts',
  'songs', 'messages', 'templates', 'care', 'prayer', 'audit', 'otps', 'refreshTokens', 'attendanceHistory', 'meta',
] as const satisfies readonly Kind[];
