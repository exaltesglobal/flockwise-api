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
  /** Open registration form for this event (GET /forms/:id), if any. */
  registrationFormId?: string | null;
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
  /** Values for the church's custom fields, keyed by field id. */
  custom?: Record<string, string | number | boolean | null>;
  /** Personal check-in code, encoded in the member's QR as FW1:<code>. */
  checkinCode: string;
  /** The zone, prayer cell or family unit the household belongs to. */
  zoneId?: string | null;
};

export type PersonInput = Partial<Omit<Person, 'id' | 'joinedAt' | 'lastAttendedAt' | 'groups' | 'checkinCode'>> & { firstName: string; lastName: string };
export type PeopleQuery = { q?: string; status?: PersonStatus | ''; campusId?: string; zoneId?: string; tag?: string; cursor?: string };
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
  /** Set when this payment is for a registration form response. */
  formResponseId?: string | null;
  /** Deposit batch for cash and cheque counted together. */
  batchId?: string | null;
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
export type PledgeView = Pledge & { given: number; currency: Currency; /** The AutoPay paying this pledge, if any. */ autopay?: { id: string; status: RecurringStatus; amount: number } | null };

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
export type CheckinMethod = 'staff' | 'kiosk' | 'qr' | 'self' | 'app';
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
  /** Set when the person is scheduled to serve at this event. */
  volunteer?: { teamName: string; positionName: string } | null;
  /** Set when the check-in was made on a desk without internet and synced later. */
  clientId?: string | null;
};
export type CheckinSummary = {
  event: AdminEvent;
  total: number;
  children: number;
  stillIn: number;
  rooms: { room: Room; count: number }[];
  checkins: Checkin[];
  headcounts: Headcount[];
  headcountTotal: number;
  volunteers: { scheduled: number; checkedIn: number; missing: { personId: string; name: string; teamName: string; positionName: string }[] };
};
export type CheckinCandidate = { id: string; name: string; age: number | null; isChild: boolean; allergies: string | null; roomId: string | null; roomName: string | null; checkedIn: boolean };
export type CheckinFamily = { householdName: string | null; people: CheckinCandidate[] };
export type CheckinLabel = { kind: 'child' | 'guardian' | 'volunteer'; name: string; room: string | null; securityCode: string; allergies: string | null; event: string; date: string };
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
export type PlanItem = {
  id: string; kind: PlanItemKind; title: string; songId: string | null; key: string | null; minutes: number; notes: string; person: string;
  /** Section order for this service, e.g. ["Verse 1", "Chorus", "Verse 2", "Chorus"]. Empty uses the song's own order. */
  arrangement?: string[];
  /** Words to project for readings, announcements and sermon points. */
  text?: string;
};
export type Plan = { id: string; eventId: string; theme: string; notes: string; items: PlanItem[]; updatedAt: string; rehearsalAt?: string | null; rehearsalNotes?: string };
export type Song = {
  id: string; title: string; author: string; defaultKey: string; bpm: number | null; ccli: string; tags: string[]; lyrics: string; chordChart?: string; attachments?: SongAttachment[];
  /** Lyrics in a second language with the same section headings, shown under the main lyrics. */
  lyricsAlt?: string;
  /** Default section order. */
  arrangement?: string[];
};
export type SongView = Song & { timesUsed: number; lastUsedAt: string | null };
export type ServiceSummary = { event: AdminEvent; items: number; minutes: number; songs: string[]; theme: string; volunteers: { filled: number; needed: number } };
export type ServiceDetail = { event: AdminEvent; plan: Plan; team: { teamName: string; positionName: string; name: string; status: AssignmentStatus }[] };

// ---------- messaging ----------

export type Channel = 'email' | 'sms' | 'whatsapp';
export type AudienceType = 'everyone' | 'status' | 'group' | 'team' | 'tag' | 'campus' | 'people' | 'event' | 'list';
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
  /** Email to pastors and care staff listing upcoming birthdays and anniversaries. */
  staffDigest: { enabled: boolean; daysAhead: number };
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
  publicPage?: PublicPage;
  presentation?: Partial<PresentationTheme>;
  /** Secret in the projector, stage and OBS overlay links so those screens need no sign-in. */
  screenKey?: string;
  /** AI requests allowed each month (the plan's allowance). */
  aiMonthlyLimit?: number;
  /** The church's own word for a zone: Zone, Prayer cell, Kudumba unit, Ward, Area. */
  zoneLabel?: string;
  tally?: Partial<TallySettings>;
  privacy?: Partial<PrivacySettings>;
  livestream?: Partial<LiveSettings>;
  /** Parents may check their family in from the member app (default on). */
  phoneCheckin?: boolean;
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

// ---------- forms & registrations ----------

export type FormFieldType = 'text' | 'textarea' | 'select' | 'multiselect' | 'checkbox' | 'date' | 'number' | 'email' | 'phone';
export type FormField = { id: string; label: string; type: FormFieldType; required: boolean; options: string[]; helpText: string };
/** A price option on a registration form. Price in minor units; 0 is free. */
export type TicketType = { id: string; name: string; price: number; capacity: number | null };
export type DiscountCode = { code: string; percentOff: number | null; amountOff: number | null; maxUses: number | null; used: number };
export type FormStatus = 'draft' | 'open' | 'closed';
export type Form = {
  id: string;
  title: string;
  description: string;
  eventId: string | null;
  fields: FormField[];
  ticketTypes: TicketType[];
  /** Total places (sum of ticket quantities, or one per response when there are no tickets). */
  capacity: number | null;
  waitlist: boolean;
  discountCodes: DiscountCode[];
  opensAt: string | null;
  closesAt: string | null;
  status: FormStatus;
  /** Anyone with the link can register, without signing in. */
  isPublic: boolean;
  addTag: string | null;
  addToGroupId: string | null;
  workflowId: string | null;
  confirmationMessage: string;
  createdAt: string;
};
export type FormInput = Omit<Form, 'id' | 'createdAt'>;
export type FormAnswer = string | string[] | boolean | number | null;
export type FormResponseStatus = 'confirmed' | 'waitlisted' | 'pending_payment' | 'cancelled';
export type FormResponse = {
  id: string;
  formId: string;
  personId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  answers: Record<string, FormAnswer>;
  tickets: { ticketTypeId: string; qty: number }[];
  amount: number;
  discountCode: string | null;
  status: FormResponseStatus;
  donationId: string | null;
  createdAt: string;
};
export type FormView = Form & { places: number; confirmed: number; waitlisted: number; pending: number; revenue: number; eventTitle: string | null };
export type PublicForm = {
  id: string;
  title: string;
  description: string;
  fields: FormField[];
  ticketTypes: (TicketType & { remaining: number | null })[];
  event: { id: string; title: string; startsAt: string; location: string } | null;
  isOpen: boolean;
  closedReason: string | null;
  spotsLeft: number | null;
  waitlist: boolean;
  hasDiscounts: boolean;
  currency: Currency;
  churchName: string;
  isPublic: boolean;
};
export type FormSubmission = {
  name?: string;
  email?: string;
  phone?: string;
  answers: Record<string, FormAnswer>;
  tickets?: { ticketTypeId: string; qty: number }[];
  discountCode?: string;
};
export type FormSubmitResult = { response: FormResponse; checkoutUrl: string | null; message: string };

// ---------- calendar & resource booking ----------

export type ResourceKind = 'room' | 'equipment' | 'vehicle' | 'other';
export type Resource = { id: string; name: string; kind: ResourceKind; capacity: number | null; description: string; needsApproval: boolean; approverIds: string[] };
export type BookingStatus = 'pending' | 'approved' | 'declined' | 'cancelled';
export type Booking = {
  id: string;
  title: string;
  resourceIds: string[];
  startsAt: string;
  endsAt: string;
  eventId: string | null;
  requestedBy: string;
  requestedByName: string;
  status: BookingStatus;
  notes: string;
  setupMinutes: number;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
};
export type BookingConflict = { bookingId: string; title: string; resourceName: string; startsAt: string; endsAt: string; status: BookingStatus };
export type BookingView = Booking & { resources: { id: string; name: string }[]; conflicts: BookingConflict[]; canDecide: boolean };
export type CalendarItem = { id: string; type: 'event' | 'booking'; title: string; startsAt: string; endsAt: string; status: string; resources: string[]; color: string };

// ---------- people: custom fields, smart lists, workflows ----------

export type CustomFieldType = 'text' | 'number' | 'date' | 'select' | 'checkbox';
export type CustomField = { id: string; label: string; type: CustomFieldType; options: string[]; order: number };
export type ListRuleField =
  | 'status' | 'tag' | 'campus' | 'gender' | 'age' | 'joinedDays' | 'lastAttendedDays' | 'group' | 'team' | 'gaveDays' | 'birthdayMonth'
  | 'hasEmail' | 'hasPhone' | 'formResponse' | 'workflow' | 'custom';
export type ListRuleOp = 'is' | 'is_not' | 'gt' | 'lt' | 'within' | 'not_within' | 'contains' | 'empty' | 'not_empty';
export type ListRule = { field: ListRuleField; op: ListRuleOp; value: string; customFieldId?: string };
export type SmartList = { id: string; name: string; description: string; match: 'all' | 'any'; rules: ListRule[]; createdAt: string; createdBy: string };
export type SmartListView = SmartList & { count: number };
export type WorkflowStep = { id: string; title: string; dueDays: number; assigneeId: string | null };
export type WorkflowTrigger = 'manual' | 'new_visitor' | 'form' | 'list';
export type Workflow = { id: string; name: string; description: string; steps: WorkflowStep[]; trigger: WorkflowTrigger; triggerId: string | null; defaultAssigneeId: string | null; active: boolean; createdAt: string };
export type WorkflowCardStatus = 'active' | 'done' | 'removed';
export type WorkflowCard = {
  id: string;
  workflowId: string;
  personId: string;
  stepIndex: number;
  status: WorkflowCardStatus;
  assignedTo: string | null;
  dueAt: string;
  createdAt: string;
  completedAt: string | null;
  history: { at: string; by: string; action: string; note: string }[];
};
export type WorkflowCardView = WorkflowCard & { personName: string; personPhone: string | null; stepTitle: string; workflowName: string; assigneeName: string | null; overdue: boolean };
export type WorkflowView = Workflow & { active_cards: number; done_cards: number; overdue: number; stepCounts: number[] };

// ---------- services: live, CCLI ----------

export type SongAttachment = { id: string; name: string; url: string; kind: 'chart' | 'lyrics' | 'audio' | 'video' | 'other' };
export type LiveState = { id: string; eventId: string; itemIndex: number; startedAt: string | null; itemStartedAt: string | null; endedAt: string | null };
export type LiveView = { event: AdminEvent; plan: Plan; live: LiveState; itemEndsAt: string | null; serviceEndsAt: string | null };
export type CcliRow = { songId: string; title: string; author: string; ccli: string; uses: number; dates: string[] };

// ---------- check-in: headcounts ----------

export type Headcount = { id: string; eventId: string; area: string; count: number; recordedBy: string; at: string };

// ---------- giving: batches ----------

export type BatchStatus = 'open' | 'committed';
export type Batch = { id: string; name: string; date: string; status: BatchStatus; expectedTotal: number | null; notes: string; createdBy: string; createdAt: string; committedAt: string | null; committedBy: string | null };
export type BatchView = Batch & { count: number; total: number; byMethod: { method: string; count: number; total: number }[]; difference: number | null };

// ---------- groups: posts, resources, finder ----------

export type GroupPost = { id: string; groupId: string; authorId: string; authorName: string; text: string; at: string; pinned: boolean };
export type GroupResource = { id: string; groupId: string; name: string; url: string; addedBy: string; addedByName: string; at: string };
export type GroupDetailMember = { group: Group; isLeader: boolean; members: { id: string; name: string }[]; posts: GroupPost[]; resources: GroupResource[]; nextMeeting: string | null };
export type PublicGroup = { id: string; name: string; description: string; meetingSchedule: string; location: string; type: GroupType; zone: string; leaderName: string; memberCount: number };

// ---------- publishing ----------

export type Sermon = {
  id: string;
  title: string;
  speaker: string;
  date: string;
  series: string;
  scripture: string;
  description: string;
  videoUrl: string;
  audioUrl: string;
  notesUrl: string;
  imageUrl: string;
  published: boolean;
  eventId: string | null;
  createdAt: string;
};
export type PublicPage = { enabled: boolean; tagline: string; about: string; serviceTimes: string; heroImageUrl: string; showEvents: boolean; showGroups: boolean; showSermons: boolean; showGiving: boolean };
export type PublicChurch = {
  church: Church;
  page: PublicPage;
  contact: { address: string; phone: string; email: string; website: string };
  events: { id: string; title: string; startsAt: string; endsAt: string; location: string; description: string; formId: string | null }[];
  sermons: Sermon[];
  groups: PublicGroup[];
  forms: { id: string; title: string; description: string }[];
  campaigns?: PublicCampaign[];
};

// ---------- celebrations ----------

export type CelebrationKind = 'birthday' | 'anniversary' | 'baptism';
export type Celebration = {
  personId: string;
  name: string;
  kind: CelebrationKind;
  /** This year's date (or next year's, when it has passed). */
  date: string;
  daysAway: number;
  /** Age turning, or years married / since baptism. */
  years: number | null;
  isChild: boolean;
  phone: string | null;
  email: string | null;
  householdName: string | null;
  greeted: boolean;
  wishes: number;
};
export type Greeting = { id: string; personId: string; kind: CelebrationKind; year: number; fromId: string | null; fromName: string; message: string; channel: Channel | 'wall'; at: string };
export type MemberCelebration = { personId: string; name: string; kind: CelebrationKind; date: string; daysAway: number; isMe: boolean; wishedByMe: boolean; wishes: number };
export type MemberCelebrations = { upcoming: MemberCelebration[]; myWishes: { kind: CelebrationKind; fromName: string; message: string; at: string }[] };

// ---------- presentation ----------

export type Slide = {
  id: string;
  itemIndex: number;
  itemTitle: string;
  kind: 'title' | 'lyrics' | 'text';
  /** Section name, e.g. "Chorus". */
  label: string;
  lines: string[];
  /** Second-language lines, when the song has them. */
  alt: string[];
  /** Chord-and-lyric lines for the stage display. */
  chords: string[];
};
export type PresentationTheme = { background: string; textColor: string; imageUrl: string; fontScale: number; linesPerSlide: number; showAlt: boolean; titleSlides: boolean; uppercase: boolean };
export type PresentationMode = 'live' | 'blank' | 'logo' | 'countdown';
/** A name strap for the livestream: speaker, reader, Bible reference or announcement. */
export type LowerThird = { id: string; title: string; subtitle: string };
export type PresentationState = {
  id: string; eventId: string; index: number; mode: PresentationMode; message: string; updatedAt: string;
  /** The lower-third showing on the livestream overlay, if any. */
  lowerThird?: LowerThird | null;
  /** Lower-thirds the media team prepared for this service. */
  lowerThirds?: LowerThird[];
  /** Whether the livestream overlay shows the lyrics bar. */
  overlayLyrics?: boolean;
  /** When the countdown ends (defaults to the service start). */
  countdownTo?: string | null;
};
export type PresentationView = {
  event: { id: string; title: string; startsAt: string; endsAt: string };
  churchName: string;
  logoUrl: string | null;
  slides: Slide[];
  state: PresentationState;
  theme: PresentationTheme;
  timer: { itemTitle: string | null; itemEndsAt: string | null; serviceEndsAt: string | null };
  /** Published announcements, rotated on the countdown screen. */
  announcements: { title: string; body: string }[];
  /** Lower-thirds suggested from the plan (preacher, readers, references). */
  suggestedLowerThirds: LowerThird[];
  /** Key for the sign-in-free screen links (projector PC, OBS Browser Source). Office logins only. */
  screenKey?: string;
};
export type SongStats = {
  top: { songId: string; title: string; uses: number; lastUsedAt: string | null }[];
  resting: { songId: string; title: string; lastUsedAt: string | null }[];
  byLeader: { person: string; songs: number; distinct: number; favourite: string | null }[];
  keys: { key: string; uses: number }[];
};

// ---------- AI ----------

export type AiStatus = { enabled: boolean; used: number; limit: number; month: string };
export type AiPurpose = 'message' | 'announcement' | 'greeting' | 'social' | 'prayer';
export type AiDraft = { subject: string; text: string };
export type AiAnswer = { answer: string; toolsUsed: string[] };
export type AiSetlist = { songs: { songId: string; title: string; reason: string }[]; note: string };
export type AiSermonKind = 'outline' | 'discussion' | 'social' | 'kids' | 'summary';

// ---------- integrations ----------

/** The church's Chitthi connection: WhatsApp messages go out through its Chitthi workspace. */
/** A church's own Razorpay account for gifts, with the secrets sealed by the host. */
export type RazorpaySealed = { keyId: string; keySecretSealed: string; webhookSecretSealed: string };
export type RazorpayConfig = { id: 'razorpay'; main: RazorpaySealed; fcra: RazorpaySealed | null; connectedAt: string; connectedBy: string };
export type PaymentsStatus = { connected: boolean; keyId: string | null; mode: 'live' | 'test' | null; fcraKeyId: string | null; webhookPath: string; serverKeys: boolean };
export type ChitthiConfig = {
  id: 'chitthi';
  /** The Chitthi API key, sealed by the host; never sent to the browser. */
  apiKeySealed: string;
  keyHint: string;
  workspace: string;
  /** Approved template for messages outside the 24-hour window; empty sends plain text. */
  template: string;
  language: string;
  /** How many {{n}} body values the template takes. */
  params: number;
  connectedAt: string;
  connectedBy: string;
  lastError: string | null;
  lastSentAt: string | null;
};
export type ChitthiStatus = {
  connected: boolean; workspace: string; keyHint: string; template: string; language: string; params: number;
  connectedAt: string | null; lastError: string | null; lastSentAt: string | null; signupUrl: string;
};
export type ChitthiTemplate = { name: string; language: string; category: string; body: string; params: number };

/** A key for the public API and the MCP server. It acts as the staff member who made it. */
export type ApiKeyRecord = { id: string; name: string; prefix: string; hash: string; staffId: string; access: 'read' | 'full'; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };
export type ApiKeyView = Omit<ApiKeyRecord, 'hash'> & { createdByName: string };

/** Church registers: baptism, confirmation, marriage and burial entries, and membership transfer letters. */
export type RegisterKind = 'baptism' | 'confirmation' | 'marriage' | 'burial' | 'transfer';
export type RegisterField = { key: string; label: string; type: 'text' | 'date' | 'number' | 'select' | 'textarea'; options?: string[]; required?: boolean; group?: string };
export type RegisterNote = { at: string; by: string; text: string };
export type RegisterEntry = {
  id: string;
  kind: RegisterKind;
  /** Entry number, e.g. BAP/2026/0007: per register and calendar year, never reused. */
  number: string;
  /** Date of the baptism, marriage, burial, or the letter. YYYY-MM-DD. */
  date: string;
  place: string;
  officiant: string;
  /** The person baptised, confirmed, buried or transferred; for a marriage, the groom. */
  personId: string | null;
  /** For a marriage, the bride. */
  spouseId: string | null;
  /** The name as written in the register. */
  name: string;
  details: Record<string, string>;
  remarks: string | null;
  status: 'recorded' | 'void';
  voidReason: string | null;
  /** Marginal notes: corrections (made automatically on edit) and later remarks. */
  notes: RegisterNote[];
  certificatesIssued: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
};
export type RegisterEntryInput = Partial<Pick<RegisterEntry, 'date' | 'place' | 'officiant' | 'personId' | 'spouseId' | 'name' | 'details' | 'remarks'>> & { kind: RegisterKind };
export type RegisterSummary = { kind: RegisterKind; total: number; thisYear: number; last: string | null };
export type Certificate = {
  entry: RegisterEntry;
  title: string;
  church: { name: string; address: string; city: string; phone: string; email: string; logoUrl: string | null };
  rows: { label: string; value: string }[];
  /** Body of a transfer letter; null for certificates. */
  letter: string | null;
  issuedAt: string;
  copy: number;
};

/** A zone, area, prayer cell or family unit (kudumba unit, ward) that households belong to. */
export type Zone = {
  id: string;
  name: string;
  /** An area can contain smaller units. */
  parentId: string | null;
  leaderIds: string[];
  meetingDay: string | null;
  area: string | null;
  notes: string | null;
  active: boolean;
  createdAt: string;
};
export type ZoneView = Zone & {
  leaders: { id: string; name: string; phone: string | null }[];
  families: number;
  people: number;
  visitedThisYear: number;
  lastVisitAt: string | null;
  children: number;
};
export type ZoneFamily = {
  /** The household name, or `solo:<personId>` for someone without a household. */
  key: string;
  name: string;
  address: string | null;
  phone: string | null;
  people: { id: string; name: string; status: PersonStatus; age: number | null }[];
  lastVisitAt: string | null;
  visitsThisYear: number;
  nextVisitOn: string | null;
};
export type ZoneDetail = { zone: ZoneView; families: ZoneFamily[]; visits: VisitView[]; units: ZoneView[] };
export type VisitPurpose = 'home' | 'new_family' | 'hospital' | 'house_blessing' | 'bereavement' | 'other';
export type Visit = {
  id: string;
  /** The household visited (same key as ZoneFamily). */
  familyKey: string;
  familyName: string;
  personIds: string[];
  zoneId: string | null;
  purpose: VisitPurpose;
  status: 'planned' | 'done' | 'cancelled';
  plannedFor: string | null;
  visitedOn: string | null;
  /** Staff ids, and names for visitors who are not staff. */
  visitorIds: string[];
  visitorNames: string[];
  notes: string | null;
  prayerPoints: string | null;
  followUp: string | null;
  confidential: boolean;
  createdAt: string;
  createdBy: string;
};
export type VisitView = Visit & { zoneName: string | null; visitors: string[] };
export type ZoneReportRow = { zoneId: string | null; zoneName: string; families: number; visited: number; percent: number; visitsDone: number; planned: number };

/** An expense head in the church accounts (Salaries, Electricity, Missions support...). */
export type AccountHead = {
  id: string;
  name: string;
  /** The ledger name in Tally, when it differs. */
  tallyName: string | null;
  /** Tally group for new ledgers, e.g. Indirect Expenses. */
  tallyGroup: string;
  /** Budget per financial year label (e.g. "2026-27"), in minor units. */
  budgets: Record<string, number>;
  active: boolean;
};
export type ExpenseStatus = 'submitted' | 'approved' | 'rejected' | 'paid';
export type ExpenseMethod = 'bank_transfer' | 'upi' | 'cheque' | 'cash';
export type Expense = {
  id: string;
  /** Voucher number, e.g. PV/2026-27/0012, given when paid. */
  voucherNumber: string | null;
  date: string;
  headId: string;
  amount: number;
  payee: string;
  description: string;
  method: ExpenseMethod | null;
  reference: string | null;
  /** Paid from the FCRA account. */
  fcra: boolean;
  billUrl: string | null;
  status: ExpenseStatus;
  submittedBy: string;
  submittedById: string | null;
  submittedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  paidAt: string | null;
};
export type ExpenseView = Expense & { headName: string; /** True when the signed-in staff member asked for this. */ mine: boolean };
/** How Flockwise names things when it writes Tally vouchers. */
export type TallySettings = {
  companyName: string;
  bankLedger: string;
  cashLedger: string;
  fcraBankLedger: string;
  /** Tally ledger name per fund id; the fund's own name otherwise. */
  fundLedgers: Record<string, string>;
  incomeGroup: string;
};
export type AccountsSummary = {
  fy: string;
  income: { fundId: string; name: string; amount: number; gifts: number }[];
  expenses: { headId: string; name: string; budget: number; spent: number; committed: number }[];
  months: { month: string; income: number; expense: number }[];
  totals: { income: number; expense: number; budget: number; pendingApproval: number };
};

export type Collections = {
  settings: ChurchSettings & { id: string };
  integrations: ChitthiConfig | RazorpayConfig | RazorpaySetup | WaBotConfig;
  kycFiles: KycFile;
  recurring: RecurringGift;
  botMessages: BotMessage;
  campaigns: Campaign;
  envelopes: OfferingEnvelope;
  inKind: InKindGift;
  auctionLots: AuctionLot;
  consentLog: ConsentEvent;
  dataRequests: DataRequest;
  parentPages: ParentPage;
  bulletins: Bulletin;
  ssClasses: SsClass;
  ssLessons: SsLesson;
  ssAttendance: SsAttendance;
  ssExams: SsExam;
  ssMarks: SsMark;
  missionaries: Missionary;
  missionSupport: MissionSupport;
  missionReports: MissionReport;
  missionPayouts: MissionPayout;
  streams: LiveStream;
  streamViews: StreamView;
  apiKeys: ApiKeyRecord;
  automations: Automations & { id: string };
  greetings: Greeting;
  presentations: PresentationState;
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
  forms: Form;
  formResponses: FormResponse;
  resources: Resource;
  bookings: Booking;
  customFields: CustomField;
  smartLists: SmartList;
  workflows: Workflow;
  workflowCards: WorkflowCard;
  live: LiveState;
  headcounts: Headcount;
  batches: Batch;
  groupPosts: GroupPost;
  groupResources: GroupResource;
  sermons: Sermon;
  registers: RegisterEntry;
  zones: Zone;
  visits: Visit;
  accountHeads: AccountHead;
  expenses: Expense;
};
export type Kind = keyof Collections;
export const KINDS = [
  'settings', 'automations', 'people', 'campuses', 'events', 'rsvps', 'groups', 'groupMembers', 'joinRequests', 'groupMeetings',
  'funds', 'donations', 'pledges', 'plans', 'announcements', 'staff', 'rooms', 'checkins', 'teams', 'assignments', 'blockouts',
  'songs', 'messages', 'templates', 'care', 'prayer', 'audit', 'otps', 'refreshTokens', 'attendanceHistory', 'meta',
  'forms', 'formResponses', 'resources', 'bookings', 'customFields', 'smartLists', 'workflows', 'workflowCards', 'live', 'headcounts',
  'batches', 'groupPosts', 'groupResources', 'sermons', 'greetings', 'presentations', 'integrations', 'apiKeys',
  'registers', 'zones', 'visits', 'accountHeads', 'expenses', 'kycFiles', 'recurring', 'botMessages', 'campaigns', 'envelopes', 'inKind', 'auctionLots', 'consentLog', 'dataRequests', 'parentPages', 'bulletins',
  'ssClasses', 'ssLessons', 'ssAttendance', 'ssExams', 'ssMarks',
  'missionaries', 'missionSupport', 'missionReports', 'missionPayouts',
  'streams', 'streamViews',
] as const satisfies readonly Kind[];

// ----- assisted Razorpay setup: Flockwise's team opens the church's Razorpay account and does its KYC -----
export type RazorpaySetupStatus = 'pending_payment' | 'paid' | 'in_progress' | 'done' | 'refunded';
export type ChurchOrgType = 'trust' | 'society' | 'section8' | 'parent';
export type KycDocKind = 'pan' | 'registration' | 'bank_proof' | 'signatory_id' | 'authorisation' | 'reg_12a_80g' | 'fcra' | 'address_proof' | 'other';
export type KycDoc = { id: string; kind: KycDocKind; fileName: string; mime: string; size: number; uploadedAt: string; uploadedBy: string };
export type RazorpaySetup = {
  id: 'razorpaySetup';
  status: RazorpaySetupStatus;
  /** In paise. */
  amount: number;
  paymentRef: string | null;
  paymentUrl: string | null;
  requestedBy: string;
  requestedByEmail: string;
  createdAt: string;
  paidAt: string | null;
  doneAt: string | null;
  orgType: ChurchOrgType | null;
  /** WhatsApp number our team uses to reach the church about missing papers. */
  contactPhone: string;
  docs: KycDoc[];
  docsSubmittedAt: string | null;
  /** From the Flockwise team, shown to the church (e.g. "Please send a clearer cheque photo"). */
  teamNote: string;
};
/** The bytes of one KYC document, sealed. Removed once setup is done or refunded. */
export type KycFile = { id: string; sealed: string };
export type RazorpaySetupView = {
  price: number;
  currency: 'INR';
  /** False when the server cannot take the fee online yet. */
  online: boolean;
  partnerUrl: string;
  setup: RazorpaySetup | null;
  /** Documents still needed before the church can send them to us. */
  missing: KycDocKind[];
};

// ----- recurring gifts: Razorpay subscriptions, approved once by UPI AutoPay, card or e-mandate -----
/** pending: waiting for the giver to approve the mandate; failing: a charge failed and Razorpay is retrying; halted: retries ran out. */
export type RecurringStatus = 'pending' | 'active' | 'failing' | 'paused' | 'halted' | 'cancelled' | 'completed';
export type RecurringGift = {
  id: string;
  donorId: string | null;
  donorName: string;
  fundId: string;
  fundName: string;
  /** Each charge, in paise. */
  amount: number;
  currency: Currency;
  status: RecurringStatus;
  /** Razorpay subscription id (sub_). */
  providerRef: string | null;
  fcra: boolean;
  method: PaymentMethod | null;
  /** Paying off a pledge in monthly charges. */
  pledgeId: string | null;
  /** Number of charges, or null for "until I stop it". */
  totalCount: number | null;
  chargedCount: number;
  totalGiven: number;
  lastChargedAt: string | null;
  nextChargeAt: string | null;
  createdAt: string;
  endedAt: string | null;
};
export type RecurringSummary = { active: number; monthly: number; failing: number; pending: number; currency: Currency };

// ----- WhatsApp assistant: answers members and visitors on the church's WhatsApp number (through Chitthi) -----
export type BotIntent = 'menu' | 'services' | 'events' | 'prayer_ask' | 'prayer' | 'give' | 'sermon' | 'new' | 'talk' | 'stop' | 'start' | 'unknown';
export type WaBotConfig = {
  id: 'waBot';
  enabled: boolean;
  /** Chitthi webhook subscription for message.received. */
  hookId: string | null;
  secretSealed: string | null;
  /** First lines of the menu, e.g. "Welcome to Grace Church! 🙏" */
  welcome: string;
  connectedAt: string;
  connectedBy: string;
  lastMessageAt: string | null;
  lastError: string | null;
};
export type BotMessage = { id: string; at: string; phone: string; name: string; personId: string | null; text: string; intent: BotIntent; reply: string; sent: boolean };
export type WaBotStatus = {
  chitthiConnected: boolean;
  enabled: boolean;
  welcome: string;
  connectedAt: string | null;
  lastMessageAt: string | null;
  lastError: string | null;
  last30: { messages: number; people: number; prayers: number; newcomers: number; talk: number };
  recent: BotMessage[];
};

// ---------- special offerings: harvest festival, building fund and other campaigns ----------

export type CampaignKind = 'harvest' | 'building' | 'thanksgiving' | 'mission' | 'special';
export type Campaign = {
  id: string;
  name: string;
  kind: CampaignKind;
  description: string;
  /** Gifts to this fund between the dates count towards the campaign. */
  fundId: string;
  goal: number | null;
  startsOn: string;
  endsOn: string | null;
  /** Show the progress bar on the church's public page and in the member app. */
  showPublic: boolean;
  status: 'active' | 'closed';
  createdAt: string;
  createdBy: string;
};
/** A numbered offering envelope given to a family, and what came back in it. */
export type OfferingEnvelope = {
  id: string;
  campaignId: string;
  number: number;
  personId: string | null;
  familyName: string;
  promised: number | null;
  amount: number | null;
  method: PaymentMethod | null;
  receivedAt: string | null;
  donationId: string | null;
};
/** Produce, gold, livestock or other things brought as an offering, often auctioned at harvest festival. */
export type InKindGift = {
  id: string;
  campaignId: string;
  donorId: string | null;
  donorName: string;
  item: string;
  quantity: string;
  /** Estimated value, in paise. Counted only when the item is not sold at the auction. */
  value: number;
  forAuction: boolean;
  note: string;
  receivedAt: string;
};
export type AuctionLot = {
  id: string;
  campaignId: string;
  inKindId: string | null;
  title: string;
  bidderId: string | null;
  bidderName: string;
  amount: number;
  paid: boolean;
  method: PaymentMethod | null;
  paidAt: string | null;
  donationId: string | null;
  createdAt: string;
};
export type CampaignProgress = { raised: number; gifts: number; envelopes: number; auction: number; inKind: number; givers: number; goal: number | null; percent: number | null; auctionUnpaid: number };
export type CampaignView = Campaign & { fundName: string; progress: CampaignProgress; envelopesOut: number; envelopesBack: number };
export type CampaignDetail = CampaignView & { envelopes: OfferingEnvelope[]; inKind: InKindGift[]; lots: AuctionLot[]; topGivers: { name: string; amount: number }[] };
export type PublicCampaign = { id: string; name: string; kind: CampaignKind; description: string; fundId: string; goal: number | null; raised: number; percent: number | null; givers: number; endsOn: string | null };
export type MemberCampaign = PublicCampaign & { envelope: { number: number; promised: number | null; amount: number | null } | null };

// ---------- privacy: India's Digital Personal Data Protection Act, 2023 ----------

export type ConsentPurpose = 'email' | 'sms' | 'whatsapp' | 'directory';
export type ConsentSource = 'member' | 'staff' | 'whatsapp' | 'import' | 'form';
/** One change to a person's consent, kept as proof of what they agreed to and when. */
export type ConsentEvent = { id: string; personId: string; at: string; purpose: ConsentPurpose; granted: boolean; source: ConsentSource; by: string };
export type DataRequestKind = 'access' | 'correction' | 'erasure' | 'grievance';
export type DataRequestStatus = 'open' | 'done' | 'declined';
export type DataRequest = {
  id: string;
  personId: string | null;
  personName: string;
  contact: string;
  kind: DataRequestKind;
  details: string;
  status: DataRequestStatus;
  createdAt: string;
  dueAt: string;
  closedAt: string | null;
  closedBy: string | null;
  response: string;
};
export type PrivacySettings = {
  /** The person members contact about their data (the Act's grievance officer). */
  officerName: string;
  officerEmail: string;
  officerPhone: string;
  /** Shown to members next to their consent choices. */
  notice: string;
  /** Flag people who have not attended for this many months, so the office can review their data. */
  reviewAfterMonths: number;
};
export type PrivacyOverview = {
  settings: PrivacySettings;
  requests: DataRequest[];
  open: number;
  overdue: number;
  optedOut: Record<ConsentPurpose, number>;
  people: number;
  toReview: number;
  minorsWithContact: number;
};
export type MemberPrivacy = { consent: Consent; log: ConsentEvent[]; requests: DataRequest[]; officer: { name: string; email: string; phone: string }; notice: string; church: string };

// ---------- parent pager ----------

export type PageReason = 'come' | 'pickup' | 'feeding' | 'custom';
/** A message to a child's parents during a service, sent from check-in. */
export type ParentPage = {
  id: string;
  eventId: string;
  checkinId: string;
  childName: string;
  roomName: string | null;
  securityCode: string | null;
  reason: PageReason;
  note: string;
  text: string;
  sentTo: { name: string; to: string; channel: Channel; ok: boolean; error?: string }[];
  at: string;
  by: string;
  resolvedAt: string | null;
};

// ---------- digital bulletin ----------

export type BulletinSection = 'order' | 'announcements' | 'events' | 'celebrations' | 'serving' | 'giving';
export type Bulletin = {
  id: string;
  eventId: string | null;
  /** The Sunday (or service day) it is for. YYYY-MM-DD. */
  date: string;
  title: string;
  /** A short word from the pastor at the top. */
  intro: string;
  /** Scripture or a verse for the week. */
  verse: string;
  sections: BulletinSection[];
  status: 'draft' | 'published';
  publishedAt: string | null;
  /** In the share link, so people can open it from WhatsApp without signing in. */
  shareKey: string;
  createdAt: string;
  updatedAt: string;
};
export type BulletinView = Bulletin & {
  church: { name: string; address: string; logoUrl: string | null; phone: string; website: string };
  service: { title: string; startsAt: string; location: string; theme: string } | null;
  order: { kind: PlanItemKind; title: string; person: string }[];
  announcements: { id: string; title: string; body: string }[];
  events: { id: string; title: string; startsAt: string; location: string }[];
  celebrations: { name: string; kind: CelebrationKind; date: string; years: number | null }[];
  serving: { team: string; names: string[] }[];
  giving: { url: string; campaigns: PublicCampaign[] };
  shareUrl: string;
};

// ---------- Sunday school ----------

export type SsClass = {
  id: string;
  name: string;
  minAge: number;
  maxAge: number;
  /** The kids' check-in room the class meets in, so check-ins can fill the register. */
  roomId: string | null;
  teacherIds: string[];
  studentIds: string[];
  order: number;
  createdAt: string;
};
export type SsLesson = {
  id: string;
  /** null means every class has this lesson. */
  classId: string | null;
  date: string;
  title: string;
  scripture: string;
  memoryVerse: string;
  notes: string;
};
/** One class on one Sunday. id is `${classId}:${date}`. */
export type SsAttendance = {
  id: string;
  classId: string;
  date: string;
  present: string[];
  /** Children who said the memory verse. */
  verse: string[];
  visitors: number;
  /** Class offering, in paise. */
  offering: number;
  markedBy: string;
  markedAt: string;
};
export type SsExam = {
  id: string;
  name: string;
  date: string;
  maxMarks: number;
  classIds: string[];
  /** Published results show to parents and can be sent on WhatsApp. */
  status: 'open' | 'published';
  createdAt: string;
};
/** id is `${examId}:${personId}`. marks null means absent. */
export type SsMark = { id: string; examId: string; personId: string; classId: string; marks: number | null };

export type SsPerson = { id: string; name: string; age: number | null };
export type SsClassView = SsClass & {
  teachers: SsPerson[];
  students: number;
  roomName: string | null;
  /** Average share present over the last 8 marked Sundays. */
  attendance: number | null;
  lastMarked: string | null;
};
export type SsStudentRow = SsPerson & { present: number; of: number; percent: number | null; verses: number; streak: number };
export type SsClassDetail = SsClassView & {
  roster: SsStudentRow[];
  sessions: { date: string; present: number; of: number; visitors: number; offering: number }[];
  lessons: SsLesson[];
};
export type SsRegister = {
  classId: string;
  className: string;
  date: string;
  saved: boolean;
  lesson: SsLesson | null;
  students: (SsPerson & { present: boolean; verse: boolean; checkedIn: boolean })[];
  visitors: number;
  offering: number;
};
export type SsGrade = 'A+' | 'A' | 'B' | 'C' | 'D';
export type SsExamView = SsExam & { classes: { id: string; name: string; entered: number; of: number }[] };
export type SsResultRow = SsPerson & { marks: number | null; /** Marked absent, as opposed to not entered yet. */ absent: boolean; percent: number | null; grade: SsGrade | null; rank: number | null };
export type SsExamResults = SsExamView & { results: { classId: string; name: string; average: number | null; rows: SsResultRow[] }[] };
export type SsPrizes = {
  from: string;
  to: string;
  classes: {
    classId: string;
    name: string;
    toppers: { exam: string; rank: number; name: string; marks: number; maxMarks: number }[];
    attendance: { name: string; present: number; of: number }[];
    verses: { name: string; verses: number }[];
  }[];
};
export type SsOverview = {
  sunday: string;
  classes: SsClassView[];
  students: number;
  teachers: number;
  markedThisSunday: number;
  unassigned: SsPerson[];
  nextLesson: SsLesson | null;
};
export type MemberSundaySchool = {
  children: {
    id: string;
    name: string;
    className: string | null;
    teachers: string[];
    attendance: { present: number; of: number; percent: number | null };
    verses: number;
    lesson: SsLesson | null;
    results: { exam: string; date: string; marks: number | null; maxMarks: number; grade: SsGrade | null; rank: number | null }[];
  }[];
};

// ---------- missions support ----------

export type Missionary = {
  id: string;
  /** A person, a couple ("Rev. & Mrs. John") or a mission organisation's project. */
  name: string;
  photoUrl: string | null;
  /** Where they serve: a district, state or country. */
  field: string;
  organisation: string;
  work: string;
  since: string | null;
  status: 'active' | 'ended';
  /** Gifts for this missionary go to their own fund, so receipts and totals stay separate. */
  fundId: string;
  /** What they need each month, in paise. */
  monthlyNeed: number | null;
  email: string | null;
  phone: string | null;
  prayerPoints: string;
  /** Shown to members in the app. */
  showPublic: boolean;
  createdAt: string;
};
/** A monthly commitment: a member, a family, a group or the church budget itself. */
export type MissionSupport = {
  id: string;
  missionaryId: string;
  kind: 'member' | 'church';
  personId: string | null;
  name: string;
  /** Per month, in paise. */
  amount: number;
  startedOn: string;
  endedOn: string | null;
  createdAt: string;
};
export type MissionReport = {
  id: string;
  missionaryId: string;
  date: string;
  title: string;
  body: string;
  prayerPoints: string;
  /** Shown to members in the app. */
  published: boolean;
  sentAt: string | null;
  sentCount: number;
  createdAt: string;
};
/** Money the church sent on to the missionary. */
export type MissionPayout = {
  id: string;
  missionaryId: string;
  date: string;
  amount: number;
  method: 'bank_transfer' | 'upi' | 'cheque' | 'cash';
  reference: string;
  note: string;
  by: string;
  createdAt: string;
};
export type SupportStatus = 'autopay' | 'on_track' | 'behind' | 'church' | 'ended';
export type MissionaryView = Missionary & {
  fundName: string;
  /** Active monthly commitments, in paise. */
  committed: number;
  supporters: number;
  /** monthlyNeed minus committed, when a need is set. */
  gap: number | null;
  receivedFy: number;
  sentFy: number;
  /** Everything received to the fund minus everything sent on. */
  balance: number;
  lastReportAt: string | null;
  lastPayoutAt: string | null;
};
export type MissionSupportView = MissionSupport & { status: SupportStatus; given3m: number; expected3m: number };
export type MissionaryDetail = MissionaryView & {
  support: MissionSupportView[];
  reports: MissionReport[];
  payouts: MissionPayout[];
  months: { month: string; received: number; sent: number }[];
};
export type MissionsOverview = {
  missionaries: MissionaryView[];
  committed: number;
  needed: number;
  receivedFy: number;
  sentFy: number;
  behind: { missionaryId: string; missionaryName: string; supportId: string; name: string }[];
};
export type MemberMission = {
  id: string;
  name: string;
  photoUrl: string | null;
  field: string;
  organisation: string;
  work: string;
  prayerPoints: string;
  fundId: string;
  monthlyNeed: number | null;
  committed: number;
  reports: { id: string; date: string; title: string; body: string; prayerPoints: string }[];
  mine: { amount: number; status: SupportStatus } | null;
};

// ---------- offline check-in: the desk keeps this pack and syncs what it did when back online ----------

export type OfflinePerson = {
  id: string;
  name: string;
  household: string | null;
  age: number | null;
  isChild: boolean;
  roomId: string | null;
  roomName: string | null;
  allergies: string | null;
  /** Personal QR code, so member QR scans work offline. */
  code: string;
  /** Last four digits of the mobile number, for search. The full number never leaves the server. */
  phone4: string | null;
};
export type OfflinePack = {
  event: { id: string; title: string; startsAt: string };
  generatedAt: string;
  people: OfflinePerson[];
  /** Who was checked in when the pack was made. */
  checkedIn: string[];
  serving: { personId: string; teamName: string; positionName: string }[];
};
export type OfflineItem = { clientId: string; personIds: string[]; method: CheckinMethod; at: string; code: string | null };
export type OfflineSyncResult = {
  clientId: string;
  ok: boolean;
  checkins: Checkin[];
  /** Already checked in on another desk, so nothing new was recorded for them. */
  skipped: { personId: string; name: string; securityCode: string | null }[];
  error?: string;
};

// ----- livestream: YouTube live on the church page and in the member app, with online attendance -----
export type LiveSettings = {
  /** The church's YouTube channel (UC…), used when no stream is scheduled. */
  channelId: string;
  /** Minutes someone must watch to count as attending online. */
  countAfterMinutes: number;
  /** Show the stream on the public church page to people who are not signed in. */
  publicWatch: boolean;
};
export type LiveStatus = 'scheduled' | 'live' | 'ended';
export type LiveStream = {
  id: string;
  title: string;
  youtubeId: string;
  eventId: string | null;
  startsAt: string;
  /** Set by "Go live"; a scheduled stream also counts as live from its start time. */
  startedAt: string | null;
  endedAt: string | null;
  /** The online count written to the event's headcount when the stream ended. */
  recorded: number | null;
  createdAt: string;
};
/** One viewer of one stream. Viewers send a ping every minute while the video is on screen. */
export type StreamView = {
  id: string;
  streamId: string;
  /** A random id the viewer's browser keeps, or the member's person id. */
  viewer: string;
  personId: string | null;
  source: 'app' | 'public';
  /** Minutes since the stream started in which this viewer pinged. */
  minutes: number[];
  firstAt: string;
  lastAt: string;
};
export type LiveStreamView = LiveStream & {
  status: LiveStatus;
  eventTitle: string | null;
  /** Pinged in the last two minutes. */
  watching: number;
  viewers: number;
  /** Watched at least countAfterMinutes. */
  attended: number;
  members: number;
  avgMinutes: number;
  peak: number;
};
export type LiveStreamDetail = LiveStreamView & {
  /** Viewers in each minute from the start. */
  timeline: { minute: number; count: number }[];
  people: { personId: string; name: string; householdName: string | null; minutes: number; firstAt: string }[];
  guests: number;
};
export type LiveOverview = { settings: LiveSettings; live: LiveStreamView | null; upcoming: LiveStreamView[]; past: LiveStreamView[] };
/** What a viewer sees: the stream that is live, else the next one, else the channel's live page. */
export type LiveNow = {
  stream: { id: string; title: string; youtubeId: string; status: LiveStatus; startsAt: string; watching: number } | null;
  channelId: string | null;
  church: string;
};

// ----- family accounts: one adult's login manages the household and checks the children in -----
export type FamilyMember = {
  id: string;
  firstName: string;
  lastName: string;
  name: string;
  age: number | null;
  birthDate: string | null;
  gender: 'male' | 'female' | null;
  isChild: boolean;
  isMe: boolean;
  /** Has an email of their own, so they sign in themselves. */
  hasLogin: boolean;
  phone: string | null;
  allergies: string | null;
  medicalNotes: string | null;
  roomName: string | null;
  /** The parent can change this person's details: children, and adults without their own login. */
  editable: boolean;
};
export type FamilyView = { householdName: string | null; members: FamilyMember[] };
export type FamilyCheckinEvent = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location: string;
  /** Phone check-in is open from an hour before the start until the end. */
  open: boolean;
  opensAt: string;
  members: { id: string; name: string; isChild: boolean; roomName: string | null; allergies: string | null; checkedIn: boolean; securityCode: string | null }[];
};
export type FamilyCheckinResult = { securityCode: string | null; checkedIn: string[]; event: FamilyCheckinEvent };

// ----- church networks and dioceses: combined, anonymous stats across many churches -----
export type NetworkKind = 'network' | 'diocese' | 'denomination' | 'association';
export type Network = { id: string; name: string; kind: NetworkKind; code: string; admins: string[]; createdAt: string; createdBy: string };
export type NetworkMembership = { networkId: string; churchId: string; joinedAt: string; joinedBy: string; shareGiving: boolean };
/** A network as the church office sees it. */
export type ChurchNetworkLink = { id: string; name: string; kind: NetworkKind; joinedAt: string; shareGiving: boolean; churches: number };
/** What the host does for one church: list, preview a join code, join, change sharing, leave. */
export type ChurchNetworkHost = {
  list(): ChurchNetworkLink[];
  preview(code: string): { id: string; name: string; kind: NetworkKind; churches: number } | null;
  join(code: string, shareGiving: boolean, by: string): ChurchNetworkLink;
  update(networkId: string, shareGiving: boolean): ChurchNetworkLink;
  leave(networkId: string): void;
};
/** Totals only, never names of people: what one church shares with its network. */
export type NetworkChurchStats = {
  churchId: string;
  name: string;
  city: string;
  slug: string;
  joinedAt: string;
  currency: Currency;
  people: number;
  members: number;
  households: number;
  newPeople90: number;
  groups: number;
  inGroups: number;
  serving: number;
  baptismsThisYear: number;
  lastSunday: number;
  /** Average of the last four Sundays, and its change against the four before (percent). */
  avgAttendance: number;
  attendanceChange: number | null;
  attendance: { date: string; count: number }[];
  shareGiving: boolean;
  /** Last 12 months; null when the church does not share giving. */
  giving12m: number | null;
  givingByMonth: { month: string; amount: number }[] | null;
  onlineLastStream: number | null;
  lastActiveAt: string | null;
};
export type NetworkOverview = {
  network: Network;
  churches: NetworkChurchStats[];
  totals: { churches: number; people: number; members: number; households: number; newPeople90: number; inGroups: number; serving: number; baptismsThisYear: number; lastSunday: number; avgAttendance: number };
  /** Every church's Sunday attendance added up, by week (Monday dates). */
  attendance: { weekStart: string; count: number }[];
  /** Giving from the churches that share it, in the network's main currency. */
  giving: { currency: Currency; churches: number; months: { month: string; amount: number }[]; total: number };
};
export type NetworkSummary = { id: string; name: string; kind: NetworkKind; churches: number };
