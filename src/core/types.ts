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
  /** Colours and type from Settings › Church › Brand kit, so every screen matches the logo. */
  brand?: BrandKit | null;
  paymentProvider: 'razorpay' | 'stripe';
};

/** The church's brand kit. The logo (Church.logoUrl) always appears beside the name; these go with it. */
export type BrandFont = 'modern' | 'classic' | 'rounded' | 'elegant';
export type BrandKit = {
  /** Buttons, links and headers, as #rrggbb. */
  primary: string;
  /** Highlights and the invitation ribbon, as #rrggbb. */
  accent: string;
  font: BrandFont;
  /** A version of the logo for dark backgrounds (projector, dark mode). Falls back to logoUrl. */
  logoDarkUrl?: string | null;
  /** One line under the name on invitations and the public page. */
  tagline?: string;
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

export type StaffRole = 'owner' | 'admin' | 'pastor' | 'finance' | 'leader' | 'coordinator' | 'checkin' | 'custom';
export type BuiltInRole = Exclude<StaffRole, 'custom'>;
/** What part of the church a custom role is limited to. */
export type RoleScope = 'church' | 'zone' | 'group' | 'team';
export const ROLE_SCOPES: { id: RoleScope; label: string; hint: string }[] = [
  { id: 'church', label: 'Whole church', hint: 'Sees everyone the permissions allow' },
  { id: 'zone', label: 'Their zone(s)', hint: 'Only people in the zones they lead' },
  { id: 'group', label: 'Their group(s)', hint: 'Only members of the groups they lead' },
  { id: 'team', label: 'Their serving team(s)', hint: 'Only volunteers on the teams they lead' },
];
/** A role the church made itself: a name, a list of permissions and how far it reaches. */
export type CustomRole = { id: string; name: string; description: string; permissions: Permission[]; scope: RoleScope; createdAt: string };
export const PERMISSION_INFO: { id: Permission; label: string; hint: string }[] = [
  { id: 'people.view', label: 'See people', hint: 'Directory, families, attendance, celebrations' },
  { id: 'people.edit', label: 'Edit people', hint: 'Add and change people, tags, notes' },
  { id: 'giving.view', label: 'See giving', hint: 'Gifts, pledges and statements' },
  { id: 'giving.edit', label: 'Record giving', hint: 'Enter offerings and expenses' },
  { id: 'events', label: 'Events', hint: 'Create events, registrations, invitations' },
  { id: 'groups', label: 'Groups', hint: 'Small groups, meetings, join requests' },
  { id: 'comms', label: 'Messages', hint: 'WhatsApp, SMS, email, announcements, media library' },
  { id: 'care', label: 'Pastoral care', hint: 'Care cases, prayer requests, visits' },
  { id: 'checkin', label: 'Check-in', hint: 'Kids check-in desk and rooms' },
  { id: 'volunteers', label: 'Volunteers', hint: 'Serving teams and rotas' },
  { id: 'services', label: 'Services', hint: 'Service plans, songs, presentation' },
  { id: 'insights', label: 'Insights', hint: 'Reports and dashboards' },
  { id: 'settings', label: 'Settings', hint: 'Church settings, integrations, billing' },
  { id: 'staff', label: 'Team and roles', hint: 'Invite staff, make roles, give access' },
];

export type Session = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  member: Member;
  church: Church;
  staff?: { role: StaffRole; permissions: Permission[]; roleName?: string; scope?: { kind: RoleScope; ids: string[] } | null } | null;
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
  /** Join link for an online or hybrid meeting (Zoom, Google Meet, YouTube), if any. */
  meetingUrl?: string | null;
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
  /** Joined the prayer chain: gets prayer requests the office sends out, and replies PRAYED. */
  prayerChain?: boolean;
  /** Salary day (1–31; 31 also means the last day of a short month): the morning reminder to tithe. Null = off. */
  titheDay?: number | null;
  /** What they set aside each month, in minor units, shown in the reminder. */
  titheAmount?: number | null;
  /** The person's id in the system they were imported from (Elvanto, Planning Center, an old register), so a second import updates rather than duplicates. */
  externalId?: string | null;
};

export type PersonInput = Partial<Omit<Person, 'id' | 'joinedAt' | 'lastAttendedAt' | 'groups' | 'checkinCode'>> & { firstName: string; lastName: string };
export type PeopleQuery = { q?: string; status?: PersonStatus | ''; campusId?: string; zoneId?: string; tag?: string; cursor?: string };
export type PeoplePage = { data: Person[]; nextCursor: string | null; total: number };
export type ImportSource = 'excel' | 'csv' | 'elvanto' | 'planning_center';
export type ImportResult = { created: number; updated: number; skipped: number; errors: { row: number; message: string }[]; households?: number; groups?: string[]; campuses?: string[] };
/** Result of POST /admin/giving/import. */
export type GiftImportResult = { created: number; duplicates: number; matched: number; unmatched: number; total: number; funds: string[]; errors: { row: number; message: string }[] };

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
  /** The Zoom meeting Flockwise created for this event, if any. */
  zoom?: ZoomMeeting | null;
};
export type ZoomMeeting = { meetingId: string; joinUrl: string; startUrl: string; passcode: string };
export type EventInput = Omit<AdminEvent, 'id' | 'goingCount' | 'attendance' | 'checkinCount' | 'campusName' | 'zoom'>;
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
  /** Set when the payment is for a hall or ground hire (see modules/rentals.ts). */
  rentalId?: string | null;
  /** Deposit batch for cash and cheque counted together. */
  batchId?: string | null;
  /** Set when the gift was scanned from an offering QR code (see modules/offering-qr.ts); the giver's UPI id when Razorpay shares it. */
  qrId?: string | null;
  upiVpa?: string | null;
};

// ----- offering QR codes: a Razorpay UPI QR per fund for the offering box, the screen and the bulletin -----
export type OfferingQr = {
  id: string;
  /** Razorpay's qr_… id; null in the demo, where the code is drawn from `payload`. */
  providerId: string | null;
  fundId: string;
  fundName: string;
  /** Where it hangs: "Offering box", "Building fund stall". */
  name: string;
  /** Razorpay's hosted image of the code. */
  imageUrl: string | null;
  /** A upi:// string to draw the code locally when there is no image. */
  payload: string | null;
  status: 'active' | 'closed';
  createdAt: string;
  createdBy: string;
  closedAt: string | null;
};
export type OfferingQrView = OfferingQr & { giftsThisMonth: number; totalThisMonth: number; giftsAll: number; totalAll: number; lastGiftAt: string | null; publicUrl: string };
export type OfferingQrHub = {
  /** False until the church's Razorpay account is connected (the server creates the codes there). */
  ready: boolean;
  reason: string | null;
  webhookEvent: 'qr_code.credited';
  codes: OfferingQrView[];
  funds: { id: string; name: string }[];
};
// ----- classes and courses: baptism class, membership class, pre-marital, Alpha -----
export type CourseTemplate = 'baptism' | 'membership' | 'premarital' | 'alpha' | 'custom';
export type CourseSession = { id: string; title: string; date: string | null };
export type Course = {
  id: string;
  name: string;
  template: CourseTemplate;
  description: string;
  leaderName: string;
  location: string;
  sessions: CourseSession[];
  /** Sessions a person must attend to complete. */
  minAttendance: number;
  /** Members can sign up from the app. */
  openToEnroll: boolean;
  capacity: number | null;
  /** Tag added to the person when they complete (e.g. "Baptism class done"). */
  completeTag: string | null;
  status: 'open' | 'finished';
  createdAt: string;
};
export type CourseEnrollment = { id: string; courseId: string; personId: string; enrolledAt: string; attended: string[]; status: 'enrolled' | 'completed' | 'dropped'; completedAt: string | null; via: 'office' | 'app' };
export type CourseView = Course & { enrolled: number; completed: number; nextSession: CourseSession | null };
export type CourseRosterRow = CourseEnrollment & { name: string; phone: string | null };
export type CourseDetail = CourseView & { roster: CourseRosterRow[] };
export type CoursesHub = { courses: CourseView[]; templates: { id: CourseTemplate; name: string; sessions: number; minAttendance: number }[] };
export type MyCourse = { id: string; name: string; description: string; leaderName: string; location: string; sessions: CourseSession[]; minAttendance: number; full: boolean; mine: { status: CourseEnrollment['status']; attended: number } | null };

// ----- prayer vigils and fasting chains: members take a slot so the whole time is covered -----
export type VigilKind = 'prayer' | 'fasting';
export type Vigil = { id: string; name: string; kind: VigilKind; purpose: string; startsAt: string; endsAt: string; slotMinutes: number; perSlot: number | null; location: string; status: 'open' | 'closed'; createdAt: string; createdBy: string };
export type VigilSignup = { id: string; vigilId: string; personId: string; slotStart: string; via: 'office' | 'app'; reminded: boolean; createdAt: string };
export type VigilSlot = { start: string; end: string; people: { signupId: string; personId: string; name: string }[] };
export type VigilView = Vigil & { slots: number; covered: number; people: number; nextGap: string | null };
export type VigilDetail = VigilView & { slotList: VigilSlot[] };
export type MyVigil = { id: string; name: string; kind: VigilKind; purpose: string; startsAt: string; endsAt: string; slotMinutes: number; location: string; covered: number; slots: { start: string; end: string; count: number; full: boolean; mine: boolean }[] };

// ----- discipleship: one-to-one mentoring pairs and their meetings -----
export type MentorFocus = 'new_believer' | 'baptism' | 'leadership' | 'marriage' | 'youth' | 'other';
export type Mentorship = { id: string; mentorId: string; menteeId: string; focus: MentorFocus; goal: string; everyDays: number; status: 'active' | 'paused' | 'completed'; startedOn: string; endedOn: string | null; nudgedFor: string | null; createdAt: string };
export type MentorMeeting = { id: string; mentorshipId: string; date: string; topic: string; note: string; loggedBy: string; via: 'office' | 'app'; createdAt: string };
export type MentorshipView = Mentorship & { mentorName: string; menteeName: string; mentorPhone: string | null; menteePhone: string | null; meetings: number; lastMet: string | null; dueOn: string; overdue: boolean };
export type MentorshipDetail = MentorshipView & { log: MentorMeeting[] };
export type DiscipleshipHub = { pairs: MentorshipView[]; counts: { active: number; overdue: number; meetingsThisMonth: number; mentors: number }; needMentor: { personId: string; name: string; joinedAt: string; status: PersonStatus }[] };
export type MyMentoring = {
  mentees: { id: string; name: string; phone: string | null; focus: MentorFocus; goal: string; lastMet: string | null; dueOn: string; overdue: boolean; recent: { date: string; topic: string }[] }[];
  mentors: { id: string; name: string; phone: string | null; focus: MentorFocus; lastMet: string | null }[];
};

// ----- church library: books members can borrow -----
export type LibraryBook = { id: string; title: string; author: string; language: string; category: string; copies: number; isbn: string; note: string; addedAt: string };
export type LibraryLoanStatus = 'requested' | 'out' | 'returned' | 'cancelled';
export type LibraryLoan = { id: string; bookId: string; personId: string; status: LibraryLoanStatus; requestedAt: string | null; borrowedOn: string | null; dueOn: string | null; returnedOn: string | null; remindedFor: string | null; via: 'office' | 'app' };
export type LibraryBookView = LibraryBook & { out: number; available: number; requested: number; timesBorrowed: number };
export type LibraryLoanView = LibraryLoan & { title: string; author: string; name: string; phone: string | null; overdue: boolean };
export type LibraryHub = { books: LibraryBookView[]; loans: LibraryLoanView[]; requests: LibraryLoanView[]; settings: { loanDays: number }; counts: { titles: number; copies: number; out: number; overdue: number; requests: number }; categories: string[] };
export type MyLibrary = { books: { id: string; title: string; author: string; language: string; category: string; available: boolean; mine: LibraryLoanStatus | null }[]; loans: { id: string; bookId: string; title: string; status: LibraryLoanStatus; dueOn: string | null; overdue: boolean }[]; loanDays: number };

// ----- pastoral services: weddings, funerals, dedications, house blessings -----
export type OccasionKind = 'wedding' | 'funeral' | 'dedication' | 'house_blessing' | 'baptism' | 'other';
export type OccasionStatus = 'requested' | 'scheduled' | 'done' | 'cancelled';
export type OccasionTask = { id: string; label: string; done: boolean };
export type Occasion = {
  id: string; kind: OccasionKind; title: string; personIds: string[]; contactName: string; contactPhone: string;
  date: string | null; time: string | null; place: string; pastorId: string | null; status: OccasionStatus;
  checklist: OccasionTask[]; notes: string; requestNote: string; requestedBy: string | null; via: 'office' | 'app';
  remindedFor: string | null; createdAt: string;
};
export type OccasionView = Occasion & { people: { id: string; name: string }[]; pastorName: string | null; requestedByName: string | null; done: number; total: number };
export type OccasionsHub = { upcoming: OccasionView[]; requests: OccasionView[]; past: OccasionView[]; counts: { requests: number; thisMonth: number; thisYear: Record<OccasionKind, number> }; pastors: { id: string; name: string }[] };
export type MyOccasion = { id: string; kind: OccasionKind; title: string; status: OccasionStatus; date: string | null; time: string | null; place: string; pastorName: string | null };

// ----- skills & helping hands: who can do what, and a board for jobs, needs and offers -----
/** One per person (id = person id). */
export type SkillProfile = { id: string; skills: string[]; note: string; serve: boolean; share: boolean; updatedAt: string };
export type BoardKind = 'job' | 'need' | 'offer';
export type BoardPost = { id: string; personId: string; kind: BoardKind; title: string; body: string; place: string; status: 'open' | 'closed' | 'hidden'; createdAt: string; expiresOn: string };
export type BoardPostView = BoardPost & { name: string; phone: string | null; expired: boolean };
export type SkillPerson = { personId: string; name: string; phone: string | null; skills: string[]; note: string; serve: boolean; share: boolean; updatedAt: string };
export type SkillsHub = { people: SkillPerson[]; skills: { skill: string; count: number }[]; posts: BoardPostView[]; counts: { people: number; willingToServe: number; openPosts: number } };
export type MySkills = { mine: { skills: string[]; note: string; serve: boolean; share: boolean } | null; directory: { personId: string; name: string; phone: string | null; skills: string[]; note: string }[]; posts: (BoardPostView & { mine: boolean })[]; suggestions: string[] };

// ----- camps & retreats: sign-ups, rooms and bus seats -----
export type CampRoom = { id: string; name: string; beds: number; for: 'any' | 'male' | 'female' | 'family' };
export type CampBus = { id: string; name: string; seats: number };
export type Camp = { id: string; name: string; startsOn: string; endsOn: string; place: string; fee: number; capacity: number; open: boolean; note: string; rooms: CampRoom[]; buses: CampBus[]; createdAt: string };
export type CampSignup = {
  id: string; campId: string; personId: string; householdKey: string; status: 'going' | 'cancelled';
  medical: string; emergencyName: string; emergencyPhone: string; needsBus: boolean;
  roomId: string | null; busId: string | null; paid: number; via: 'office' | 'app'; signedUpBy: string | null; createdAt: string;
};
export type CampSignupView = CampSignup & { name: string; phone: string | null; gender: 'male' | 'female' | null; age: number | null; household: string };
export type CampView = Camp & { going: number; paidUp: number; due: number; collected: number; roomless: number; busless: number };
export type CampDetail = CampView & { signups: CampSignupView[] };
export type MyCamp = { id: string; name: string; startsOn: string; endsOn: string; place: string; fee: number; note: string; full: boolean; family: { personId: string; name: string; signupId: string | null; room: string | null; bus: string | null; paid: number }[] };

// ----- safeguarding: police verification, training and declarations for people who work with children -----
export type SafeguardKind = 'police' | 'training' | 'declaration' | 'reference';
export type SafeguardCheck = { id: string; kind: SafeguardKind; issuedOn: string; expiresOn: string | null; reference: string | null; note: string | null; recordedBy: string; recordedAt: string };
/** One record per person (id = person id). */
export type SafeguardRecord = { id: string; checks: SafeguardCheck[] };
export type SafeguardSettings = {
  /** Teams whose members must be cleared. */
  teamIds: string[];
  /** Sunday school teachers must be cleared too. */
  sundaySchool: boolean;
  /** Which checks make a person cleared. */
  required: SafeguardKind[];
  /** Months each kind stays valid when no expiry date is given (0 = never expires). */
  validMonths: Record<SafeguardKind, number>;
  /** True: the rota refuses to schedule someone who is not cleared on a team that needs it. False: it only warns. */
  blockRota: boolean;
};
export type SafeguardStatus = 'cleared' | 'expiring' | 'expired' | 'missing';
export type SafeguardPersonView = {
  personId: string;
  name: string;
  phone: string | null;
  roles: string[];
  status: SafeguardStatus;
  /** Per required kind: the latest check, when it runs out, and its state. */
  items: { kind: SafeguardKind; check: SafeguardCheck | null; expiresOn: string | null; state: SafeguardStatus }[];
  checks: SafeguardCheck[];
  /** Upcoming rota slots on a team that needs clearance. */
  scheduled: { eventId: string; title: string; startsAt: string; teamName: string }[];
};
export type SafeguardHub = {
  settings: SafeguardSettings;
  teams: { id: string; name: string }[];
  people: SafeguardPersonView[];
  counts: Record<SafeguardStatus, number>;
  /** Not cleared but on the rota in the next 30 days. */
  atRisk: number;
};

// ----- bank reconciliation: statement lines against gifts, batch deposits and vouchers -----
export type BankAccountId = 'main' | 'fcra';
export type BankMatchKind = 'gift' | 'expense' | 'batch' | 'settlement' | 'charges' | 'interest' | 'ignored';
export type BankStatement = { id: string; account: BankAccountId; bankName: string; from: string; to: string; lines: number; uploadedAt: string; uploadedBy: string };
export type BankLine = {
  id: string;
  statementId: string;
  account: BankAccountId;
  /** YYYY-MM-DD */
  date: string;
  narration: string;
  ref: string | null;
  /** Minor units; credits positive, debits negative. */
  amount: number;
  balance: number | null;
  /** Same line uploaded twice is skipped by this key. */
  key: string;
  match: { kind: BankMatchKind; id: string | null; label: string; by: 'auto' | 'manual'; note: string | null } | null;
  createdAt: string;
};
export type BankSuggestion = { kind: 'gift' | 'expense' | 'batch'; id: string; label: string; date: string; amount: number; why: string };
export type BankLineView = BankLine & { kind: 'razorpay' | 'upi' | 'cheque' | 'cash' | 'neft' | 'charges' | 'interest' | 'other'; suggestions: BankSuggestion[] };
export type BankView = {
  accounts: { id: BankAccountId; label: string }[];
  account: BankAccountId;
  from: string;
  to: string;
  statements: BankStatement[];
  lines: BankLineView[];
  totals: { credits: number; debits: number; matchedCredits: number; matchedDebits: number; unmatched: number; lines: number };
  /** Recorded in Flockwise with a bank method but not seen on any statement line in the period. */
  missing: { gifts: { id: string; date: string; label: string; amount: number }[]; expenses: { id: string; date: string; label: string; amount: number }[] };
  funds: { id: string; name: string }[];
  heads: { id: string; name: string }[];
};
export type BankUploadResult = { statement: BankStatement; added: number; skipped: number; matched: number };

export type PublicOfferingQr = { id: string; name: string; fundName: string; churchName: string; logoUrl: string | null; imageUrl: string | null; payload: string | null; status: OfferingQr['status']; currency: Currency };

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
  church: { name: string; address: string; logoUrl: string | null; pan: string | null; registration80g: string | null };
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
export type CheckinMethod = 'staff' | 'kiosk' | 'qr' | 'self' | 'app' | 'phone';
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
/** Chart colours a church picks for a song: page background, words, chords and section headings. Hex like #1f6b5c. */
export type SongColours = { background?: string; lyrics?: string; chords?: string; headings?: string };
export type Song = {
  id: string; title: string; author: string; defaultKey: string; bpm: number | null; ccli: string; tags: string[]; lyrics: string; chordChart?: string; attachments?: SongAttachment[];
  /** Lyrics in a second language with the same section headings, shown under the main lyrics. */
  lyricsAlt?: string;
  /** Default section order. */
  arrangement?: string[];
  /** The shared song database entry this song was added from. */
  catalogId?: string;
  /** Copyright line to show with the words, e.g. "Public domain" or "© 2011 Thankyou Music". */
  copyright?: string;
  /** The licensed lyrics service the words came from, when not public domain. */
  licensedFrom?: string;
  /** Colours for the chord chart on screen, the musicians' view and PDFs. Empty = the app's defaults. */
  colours?: SongColours;
  /** Part recordings for the choir: soprano, alto, tenor, bass, the melody or the whole song (see modules/practice.ts). */
  parts?: SongPart[];
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
  /** askReply: the WhatsApp asks for a 1/2/3 reply that lands on the care case. assignLeader: the case goes to the person's zone leader. */
  missing: Automation & { weeks: number; createFollowUp: boolean; askReply?: boolean; assignLeader?: boolean };
  volunteerReminder: Automation & { daysBefore: number };
  /** Email to pastors and care staff listing upcoming birthdays and anniversaries. */
  staffDigest: { enabled: boolean; daysAhead: number };
  /** Weekly SMS (or WhatsApp) in each member's own script for those without the app (see modules/sms-digest.ts). */
  smsDigest?: SmsDigestSettings;
  /** The missed-call line for feature phones (see modules/missed-call.ts). */
  missedCall?: MissedCallSettings;
};
/** A missed call from a registered phone marks attendance during a service and asks for prayer at any other time. */
export type MissedCallSettings = {
  enabled: boolean;
  /** Secret in the webhook URL the telephony provider posts to. */
  key: string;
  /** The virtual number members call for attendance; blank means the one number does both. */
  attendanceNumber: string;
  /** The number for prayer; blank means the one number does both. */
  prayerNumber: string;
  /** Mark every adult in the caller's household present too. */
  household: boolean;
  /** Text the caller back in their own language. */
  reply: boolean;
  channel: 'sms' | 'whatsapp';
  /** Exotel, Knowlarity, MyOperator, Ozonetel, Twilio… for the office's own notes. */
  provider: string;
};
export type MissedCallLine = 'attendance' | 'prayer';
export type MissedCallAction = 'checked_in' | 'already' | 'no_service' | 'closed' | 'prayer' | 'unknown' | 'duplicate' | 'off';
export type MissedCall = {
  id: string;
  at: string;
  /** The caller, as dialled (last ten digits kept for matching). */
  from: string;
  to: string;
  line: MissedCallLine;
  personId: string | null;
  personName: string | null;
  action: MissedCallAction;
  eventId: string | null;
  eventTitle: string | null;
  /** Household adults marked present along with the caller. */
  others: number;
  reply: string | null;
  replied: boolean;
  test: boolean;
};
export type MissedCallHub = {
  settings: MissedCallSettings;
  /** Where the provider posts missed calls; null until the server has a public address. */
  webhookUrl: string | null;
  channelReady: boolean;
  serviceNow: { id: string; title: string; startsAt: string } | null;
  stats: { lastSunday: number; checkedIn: number; prayer: number; unknown: number; total: number };
  recent: MissedCall[];
  /** Callers the records do not know, last 30 days, for the office to link. */
  unknown: MissedCall[];
};
export type SmsDigestSettings = { enabled: boolean; day: number; hour: number; audience: 'no_app' | 'everyone'; channel: 'sms' | 'whatsapp'; note: string };
export type SmsDigestPreview = { personId: string | null; name: string; language: LanguageCode; text: string; chars: number; segments: number };
export type SmsDigestStatus = { settings: SmsDigestSettings; recipients: number; byLanguage: Record<string, number>; sample: SmsDigestPreview | null; lastSentAt: string | null; nextAt: string | null; channelReady: boolean };
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
  /** When the office sent it to the prayer chain, and to how many people. */
  chainSentAt?: string | null;
  chainCount?: number;
  /** Where it came from: the member app (default), the public /pray page from a QR card, the lobby kiosk, or WhatsApp. */
  source?: 'app' | 'card' | 'kiosk' | 'whatsapp' | 'phone';
  /** A phone number a visitor left for follow-up, when they are not a member. */
  contact?: string | null;
};
/** A request as the lobby kiosk shows it. */
export type WallRequest = { id: string; name: string; text: string; prayedCount: number; iPrayed: boolean; createdAt: string; status: 'open' | 'answered'; answeredNote: string | null };
export type PrayerWallStats = { open: number; requestsThisWeek: number; prayedThisWeek: number };
export type PublicPrayerInfo = { church: { name: string; logoUrl: string | null; phone: string }; enabled: boolean; stats: PrayerWallStats };
export type PrayerWall = PublicPrayerInfo & { requests: WallRequest[] };
export type PrayerKiosk = { enabled: boolean; publicUrl: string; kioskUrl: string; key: string; stats: PrayerWallStats & { fromCards: number; fromKiosk: number } };
export type PrayerChain = { members: number; people: { id: string; name: string; phone: string | null }[] };
export type PrayerView = Omit<PrayerRequest, 'prayedBy'> & { prayedCount: number; iPrayed: boolean; mine: boolean };

// ---------- directory ----------

export type DirectoryEntry = { householdName: string; area: string | null; people: { id: string; name: string; phone: string | null; email: string | null }[] };
export type MemberPreferences = { consent: Consent; checkinCode: string; campusId: string | null; prayerChain: boolean; titheDay: number | null; titheAmount: number | null };

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
  /** OBS Studio: which scene goes with each kind of plan item. */
  obs?: Partial<ObsSettings>;
  /** Secret in the projector, stage and OBS overlay links so those screens need no sign-in. */
  screenKey?: string;
  /** Secret in the lobby prayer-wall kiosk link (see modules/prayer-wall.ts). */
  prayerKioskKey?: string;
  /** Whether anyone can send a prayer request from /pray (QR cards, kiosk). Default on. */
  publicPrayer?: boolean;
  /** AI requests allowed each month (the plan's allowance). */
  aiMonthlyLimit?: number;
  /** The giving fund that pays benevolence (help) requests; null = guess from the fund names. */
  benevolenceFundId?: string | null;
  /** The church's own word for a zone: Zone, Prayer cell, Kudumba unit, Ward, Area. */
  zoneLabel?: string;
  tally?: Partial<TallySettings>;
  privacy?: Partial<PrivacySettings>;
  livestream?: Partial<LiveSettings>;
  /** Parents may check their family in from the member app (default on). */
  phoneCheckin?: boolean;
  /** Which channels each automatic notification uses; missing kinds use the defaults. */
  notifications?: Partial<Record<NotificationKind, NotificationRule>>;
  /** How many automatic notifications went out, by kind. */
  notificationCounts?: Partial<Record<NotificationKind, number>>;
  brand?: BrandKit;
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

export type StaffMember = {
  id: string; personId: string | null; name: string; email: string; phone: string | null; role: StaffRole; status: 'active' | 'invited'; lastActiveAt: string | null;
  /** The custom role, when role is 'custom'. */
  roleId?: string | null;
  /** Zones, groups or teams this login is limited to (by the role's scope). Empty = whole church. */
  scopeIds?: string[];
};
export type StaffView = StaffMember & { roleName: string; scopeKind: RoleScope; scopeNames: string[]; permissions: Permission[] };
/** A person's office access, as shown on their record. */
export type PersonAccess = { staffId: string | null; role: StaffRole | null; roleId: string | null; roleName: string | null; scopeKind: RoleScope; scopeIds: string[]; status: 'active' | 'invited' | null; email: string | null };

// ---------- team hub: notices, chat threads and tasks for staff and volunteers ----------
/** Who someone is in the hub: a person (`p:<personId>`) or an office login with no person record (`s:<staffId>`). */
export type HubKey = string;
export type HubMember = { key: HubKey; personId: string | null; staffId: string | null; name: string };
export type HubChannelKind = 'staff' | 'team' | 'custom';
export type HubChannel = {
  id: string;
  name: string;
  kind: HubChannelKind;
  /** The serving team this channel belongs to (kind team, or a custom thread made inside a team). */
  teamId: string | null;
  /** Members of a custom thread. Staff and team channels work out their members. */
  memberKeys: HubKey[];
  createdBy: HubKey;
  createdAt: string;
  archived: boolean;
};
export type HubPostKind = 'message' | 'notice' | 'task';
export type HubTask = { assigneeKey: HubKey; assigneeName: string; dueAt: string | null; done: boolean; doneAt: string | null; doneByName: string | null };
export type HubPost = {
  id: string;
  channelId: string;
  kind: HubPostKind;
  text: string;
  authorKey: HubKey;
  authorName: string;
  at: string;
  /** Notices pin to the top until unpinned. */
  pinned: boolean;
  /** People named with @ in the text. */
  mentions: HubKey[];
  task: HubTask | null;
};
export type HubChannelView = HubChannel & { members: HubMember[]; teamName: string | null; unread: number; lastAt: string | null; lastText: string; openTasks: number };
export type HubChannelDetail = { channel: HubChannelView; pinned: HubPost[]; posts: HubPost[]; nextCursor: string | null };
/** A task as the team app shows it. */
export type MyTask = HubPost & { channelName: string; teamId: string | null };
export type HubView = { me: HubMember; channels: HubChannelView[]; tasks: MyTask[]; people: HubMember[] };

export type AuditEntry = { id: string; at: string; actorId: string | null; actorName: string; action: string; entity: string; entityId: string | null; summary: string };

// ---------- internal records ----------

export type OtpRecord = { id: string; email: string; codeHash: string; audience: 'admin' | 'member'; createdAt: string; expiresAt: string; attempts: number; used: boolean };
export type RefreshRecord = { id: string; tokenHash: string; personId: string; staffId: string | null; scope: 'admin' | 'member'; createdAt: string; expiresAt: string; revoked: boolean };
export type RsvpRecord = { id: string; eventId: string; personId: string; at: string };
export type MemberRecord = { id: string; groupId: string; personId: string; since: string };
export type AttendancePoint = { id: string; date: string; count: number };
export type MetaRecord = { id: string; value: string };
/** A team member's password login for the mobile app. Created by the office, never by the member. */
export type TeamLogin = {
  /** Same as the person's id: one login per person. */
  id: string;
  personId: string;
  email: string;
  passwordHash: string;
  mustChangePassword: boolean;
  disabled: boolean;
  createdAt: string;
  lastSignInAt: string | null;
  /** Times of recent wrong passwords, for the 5-per-15-minutes lock. */
  failedAt: string[];
  resetCodeHash: string | null;
  resetExpiresAt: string | null;
  resetAttempts: number;
};
export type TeamLoginView = { personId: string; name: string; email: string; teams: { id: string; name: string }[]; mustChangePassword: boolean; disabled: boolean; createdAt: string; lastSignInAt: string | null };

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
/** The counting room: what the counters found in the plate, by denomination, with their signatures. */
export type CountSheet = {
  /** Notes counted per denomination in major units, e.g. { "500": 12, "100": 40 }. */
  notes: Record<string, number>;
  /** Coins, cheques and UPI/QR in minor units. */
  coins: number; cheques: number; upi: number;
  /** A photo of the count sheet or the plate (https link or a small data: image). */
  photoUrl: string | null;
  /** Two people sign the count; changing the count clears the signatures. */
  counters: { name: string; staffId: string | null; signedAt: string }[];
  total: number;
  countedAt: string; countedBy: string;
};
export type Batch = { id: string; name: string; date: string; status: BatchStatus; expectedTotal: number | null; notes: string; createdBy: string; createdAt: string; committedAt: string | null; committedBy: string | null; sheet?: CountSheet | null };
/** `loose` is cash counted but not entered as named gifts; committing records it as an anonymous offering. */
export type BatchView = Batch & { count: number; total: number; byMethod: { method: string; count: number; total: number }[]; difference: number | null; loose: number; signed: number };

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
  /** The preacher's own notes, typed or dictated, shown to members under the sermon. */
  notes: string;
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
  /** Halls, grounds and rooms the church hires out (see modules/rentals.ts). */
  hire?: PublicRentalSpace[];
  /** Whether /pray takes prayer requests from anyone. */
  prayer?: boolean;
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
export type Greeting = { id: string; personId: string; kind: CelebrationKind; year: number; fromId: string | null; fromName: string; message: string; channel: Channel | 'wall' | 'video'; at: string };
export type MemberCelebration = { personId: string; name: string; kind: CelebrationKind; date: string; daysAway: number; isMe: boolean; wishedByMe: boolean; wishes: number };
export type MemberCelebrations = { upcoming: MemberCelebration[]; myWishes: { kind: CelebrationKind; fromName: string; message: string; at: string }[]; /** The pastor's video greeting for me (or my child) this week, if one was sent. */ videoGreetings: { token: string; firstName: string; kind: CelebrationKind; fromName: string; forMe: boolean }[] };

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
  /** The lines in English letters when they are in an Indian script and the theme asks for it. */
  roman: string[];
};
export type PresentationTheme = {
  background: string; textColor: string; imageUrl: string; fontScale: number; linesPerSlide: number; showAlt: boolean; titleSlides: boolean; uppercase: boolean;
  /** Show Telugu, Hindi, Tamil (and other Indian-script) words in English letters under the lyrics. */
  transliterate?: boolean;
};
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
  /** Live sermon captions on the projector (see modules/present.ts). */
  captions?: CaptionsSettings;
};
/** Live captions: the preacher's words, heard by the media desk's browser, translated for the screen. */
export type CaptionsSettings = {
  on: boolean;
  /** The language being preached in. */
  from: LanguageCode;
  /** The language shown on the screen. */
  to: LanguageCode;
  /** Show the translation with the original under it, the translation alone, or the original alone. */
  show: 'both' | 'translated' | 'original';
};
export type CaptionLine = { id: string; at: string; text: string; translated: string | null };
export type CaptionsLog = { id: string; eventId: string; lines: CaptionLine[]; updatedAt: string };
export type CaptionsView = CaptionsSettings & { lines: CaptionLine[]; count: number };
/** One plan item for the musicians' phones: the full chart in the service key, plus who and what. */
export type BandItem = {
  itemIndex: number;
  id: string;
  kind: PlanItemKind;
  title: string;
  person: string;
  minutes: number;
  notes: string;
  /** Key for this service (the plan item's key, else the song's). */
  key: string | null;
  /** The key the chart is written in. */
  songKey: string | null;
  bpm: number | null;
  author: string;
  /** ChordPro chart (or plain lyrics / reading text when the song has no chords), in songKey. */
  chart: string;
  hasChords: boolean;
  /** Section order for this service, when it differs from the chart. */
  arrangement: string[];
  /** The song's chart colours, when the church set any. */
  colours?: SongColours;
  /** Part recordings the choir can listen to. */
  parts?: SongPart[];
};
/** What the stream does as the presenter moves through the plan. Lives in church settings; the browser on the media desk talks to OBS. */
export type ObsSettings = {
  /** OBS scene names by plan-item kind, plus the countdown and blank screens. Blank = leave the scene alone. */
  scenes: Partial<Record<ObsMoment, string>>;
  /** Switch scenes automatically as the presenter moves through the plan. */
  autoSwitch: boolean;
  /** Put the lyrics bar on the stream whenever a song is on screen, and take it off after. */
  lyricsOnSongs: boolean;
};
export type ObsMoment = PlanItemKind | 'countdown' | 'blank';
export const OBS_MOMENTS: { id: ObsMoment; label: string; hint: string }[] = [
  { id: 'countdown', label: 'Before the service', hint: 'Countdown and announcements' },
  { id: 'song', label: 'Songs', hint: 'Worship team wide shot' },
  { id: 'reading', label: 'Scripture readings', hint: 'Lectern' },
  { id: 'sermon', label: 'Sermon', hint: 'Pulpit close-up' },
  { id: 'prayer', label: 'Prayer', hint: '' },
  { id: 'announcement', label: 'Announcements', hint: '' },
  { id: 'offering', label: 'Offering', hint: 'UPI QR on screen' },
  { id: 'video', label: 'Videos', hint: 'Full-screen media' },
  { id: 'other', label: 'Other items', hint: '' },
  { id: 'blank', label: 'Screens blank', hint: 'e.g. a wide shot or holding card' },
];

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
  /** Every item with its chart, for the musicians' view. */
  charts: BandItem[];
  /** OBS scene plan for the media desk. */
  obs: ObsSettings;
  /** Key for the sign-in-free screen links (projector PC, OBS Browser Source). Office logins only. */
  screenKey?: string;
  /** Live sermon captions: the last few lines for the screens, more for the presenter. */
  captions: CaptionsView;
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
export type AiSermonKind = 'outline' | 'discussion' | 'social' | 'kids' | 'summary' | 'notes';
/** A song read off a photo of a songbook page or a handwritten sheet. */
export type AiScannedSong = { title: string; author: string; key: string; language: string; lyrics: string; chordChart: string; warnings: string[] };
export type AiSongScan = { songs: AiScannedSong[]; pages: number };
/** A spoken visit write-up, structured: what to file, what to pray for, what to do next. */
export type AiVisitNotes = {
  summary: string;
  prayerPoints: string[];
  actions: { text: string; due: string | null }[];
  purpose: VisitPurpose;
  concerns: string[];
  confidential: boolean;
};

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
/** WhatsApp by Chitthi bought with the plan: our team makes the workspace, registers the number and connects the key. */
export type ChitthiSetupStatus = 'requested' | 'in_progress' | 'ready' | 'cancelled';
export type ChitthiSetup = {
  id: 'chitthiSetup';
  status: ChitthiSetupStatus;
  requestedAt: string;
  requestedBy: string;
  requestedByEmail: string;
  /** The WhatsApp number the church wants to send from, and the business name Meta should show. */
  phone: string;
  businessName: string;
  readyAt: string | null;
  /** A note from the Flockwise team that the church sees. */
  teamNote: string;
};
export type ChitthiTemplate = { name: string; language: string; category: string; body: string; params: number };

/** The church's own mailbox (Gmail, Google Workspace, Outlook, Hostinger or any SMTP). Every email leaves from it. */
export type EmailAccountConfig = {
  id: 'email';
  host: string;
  port: number;
  user: string;
  /** The mailbox or app password, sealed by the host; never sent to the browser. */
  passSealed: string;
  from: string;
  fromName: string;
  connectedAt: string;
  connectedBy: string;
  lastError: string | null;
  lastSentAt: string | null;
};
export type EmailAccountStatus = { connected: boolean; host: string; port: number; user: string; from: string; fromName: string; connectedAt: string | null; lastError: string | null; lastSentAt: string | null };

// ----- connections: Zoom, Google Cloud Storage, Canva -----

/** A church's Zoom (Server-to-Server OAuth app), for meeting links on events. */
export type ZoomConfig = { id: 'zoom'; accountId: string; clientId: string; clientSecretSealed: string; userEmail: string; userName: string; connectedAt: string; connectedBy: string; lastError: string | null };
export type ZoomStatus = { connected: boolean; accountId: string; userEmail: string; userName: string; connectedAt: string | null; lastError: string | null; meetings: number };
/** A church's Google Cloud Storage bucket for photos and videos, with the service-account key sealed. */
export type GcsConfig = { id: 'gcs'; bucket: string; projectId: string; clientEmail: string; privateKeySealed: string; /** Whether the bucket lets anyone read objects; otherwise links are signed for a week. */ publicRead: boolean; connectedAt: string; connectedBy: string; lastError: string | null };
export type GcsStatus = { available: boolean; connected: boolean; bucket: string; projectId: string; clientEmail: string; publicRead: boolean; connectedAt: string | null; lastError: string | null; files: number; bytes: number };
/** A church's Canva, connected by a staff member through OAuth; tokens sealed. */
export type CanvaConfig = { id: 'canva'; accessTokenSealed: string; refreshTokenSealed: string; expiresAt: string; userName: string; teamName: string; connectedAt: string; connectedBy: string; lastError: string | null };
export type CanvaStatus = { available: boolean; connected: boolean; userName: string; teamName: string; connectedAt: string | null; lastError: string | null; designs: number };
export type ConnectionsStatus = { chitthi: ChitthiStatus; email: EmailAccountStatus; zoom: ZoomStatus; gcs: GcsStatus; canva: CanvaStatus };

export type MediaFolder = 'general' | 'sermons' | 'events' | 'kids' | 'brand';
export const MEDIA_FOLDERS: { id: MediaFolder; label: string }[] = [
  { id: 'general', label: 'General' }, { id: 'sermons', label: 'Sermons' }, { id: 'events', label: 'Events' }, { id: 'kids', label: 'Kids & Sunday school' }, { id: 'brand', label: 'Brand & logos' },
];
/** A photo, video or file in the church's own bucket. */
export type MediaItem = {
  id: string; name: string; contentType: string; size: number; folder: MediaFolder;
  /** Object path in the bucket. */
  object: string;
  /** Where to see it: a public link, or a signed one that lasts a week. */
  url: string;
  status: 'pending' | 'ready';
  uploadedBy: string; createdAt: string;
};
export type MediaUpload = { item: MediaItem; uploadUrl: string; headers: Record<string, string> };
export type MediaList = { data: MediaItem[]; gcs: GcsStatus };
/** A Canva design Flockwise opened for the church. */
export type CanvaExportFormat = 'png' | 'jpg' | 'pdf';
/** The last time a design was brought back from Canva: Canva's download links last 24 hours; saved copies stay in the media library. */
export type CanvaExport = { format: CanvaExportFormat; urls: string[]; expiresAt: string; mediaIds: string[]; createdAt: string; by: string };
export type CanvaDesign = { id: string; title: string; editUrl: string; viewUrl: string; thumbnailUrl: string | null; kind: string; createdAt: string; updatedAt?: string; lastExport?: CanvaExport | null };
export type CanvaExportResult = { design: CanvaDesign; media: MediaItem[]; urls: string[] };

/** A phone that can receive push notifications, registered by the member app or the team app. */
export type Device = { id: string; personId: string; token: string; platform: 'android' | 'ios' | 'web'; app: 'member' | 'team'; createdAt: string; lastSeenAt: string };

/** Things Flockwise can tell people about on its own. The office picks the channels for each. */
export type NotificationKind = 'rota.assigned' | 'event.changed' | 'announcement.published' | 'prayer.new' | 'prayer.chain' | 'care.assigned' | 'visitor.new' | 'door.scanned' | 'team.notice' | 'team.message' | 'task.assigned' | 'carol.visit' | 'tithe.reminder' | 'ride.update' | 'aid.new' | 'aid.update' | 'asset.due' | 'reading.today' | 'rental.new' | 'practice.reminder' | 'verse.week' | 'election.open' | 'election.result' | 'recap.ready' | 'greeting.video' | 'vigil.reminder' | 'mentor.nudge' | 'library.due' | 'library.request' | 'occasion.request' | 'occasion.scheduled' | 'occasion.reminder' | 'camp.signup';

// ---------- Christmas carol rounds ----------

export type CarolStopStatus = 'planned' | 'visited' | 'not_home' | 'skipped';
/** One home on a night's route. `personIds` are the household members, for reminders. */
export type CarolStop = { familyKey: string; familyName: string; address: string | null; phone: string | null; personIds: string[]; eta: string; status: CarolStopStatus; offering: number | null; note: string; visitedAt: string | null };
export type CarolNight = { id: string; seasonId: string; date: string; startTime: string; teamId: string | null; teamName: string; leaderName: string; zoneId: string | null; area: string; stops: CarolStop[]; notes: string; createdAt: string };
export type CarolNightView = CarolNight & { total: number; visited: number; offering: number; mapsUrl: string };
export type CarolSeason = {
  id: string; name: string; from: string; to: string;
  /** When the team sets out each night, HH:MM church time. */
  startTime: string;
  minutesPerHouse: number; travelMinutes: number; housesPerNight: number;
  /** Weekdays the team stays home (0 = Sunday). */
  offDays: number[];
  /** Offerings taken at the door are recorded as cash gifts to this fund. */
  fundId: string | null;
  /** What households read when asked to pick a night. */
  message: string;
  createdAt: string;
};
export type CarolRequest = { id: string; seasonId: string; familyKey: string; familyName: string; personId: string; preferredDates: string[]; note: string; createdAt: string };
export type CarolSeasonView = CarolSeason & {
  fundName: string | null;
  dates: string[];
  nights: CarolNightView[];
  requests: (CarolRequest & { placed: boolean })[];
  waiting: { familyKey: string; familyName: string; address: string | null; zoneName: string | null; preferredDates: string[] }[];
  totals: { nights: number; homes: number; visited: number; offering: number; requests: number };
};
export type CalendarFeedKind = 'church' | 'team' | 'person';
/** A subscribe link's secret; the feed is rebuilt from the data each time it is fetched. */
export type CalendarFeed = { id: string; kind: CalendarFeedKind; refId: string; token: string; createdAt: string };
export type CalendarFeedLink = { id: string; kind: CalendarFeedKind; name: string; url: string; webcal: string; google: string };
export type MyCarols = {
  season: { id: string; name: string; from: string; to: string; message: string } | null;
  visit: { date: string; eta: string; teamName: string; status: CarolStopStatus } | null;
  request: CarolRequest | null;
  dates: string[];
};
export type NotificationRule = { email: boolean; push: boolean; whatsapp: boolean };
export type NotificationCatalogEntry = { kind: NotificationKind; label: string; description: string; audience: string; rule: NotificationRule; sentCount: number };
export type NotificationsView = { rules: NotificationCatalogEntry[]; devices: { member: number; team: number }; emailFrom: string | null };

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
  /** Code behind the QR on the certificate; anyone with it can confirm the entry at /verify/:code. Set when the first certificate is issued. */
  verifyCode?: string | null;
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
  /** Public page that confirms the entry; printed as a QR on the certificate. */
  verifyUrl: string;
};
/** What anyone scanning a certificate's QR sees: enough to confirm it, nothing more. */
export type CertificateCheck = { ok: boolean; title: string; number: string; name: string; date: string; place: string; officiant: string; church: { name: string; city: string; logoUrl: string | null }; status: 'recorded' | 'void'; voidReason: string | null; copies: number; recordedAt: string };

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
  /** What the pastor said into the phone after the visit, kept as spoken. */
  voiceNote?: string | null;
  /** Action items pulled out of the notes, ticked off as they are done. */
  actions?: VisitAction[];
  createdAt: string;
  createdBy: string;
};
export type VisitAction = { text: string; done: boolean; due: string | null };
export type VisitActionItem = VisitAction & { visitId: string; index: number; familyKey: string; familyName: string; visitedOn: string | null; visitors: string[] };
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
  integrations: ChitthiConfig | RazorpayConfig | RazorpaySetup | ChitthiSetup | WaBotConfig | EmailAccountConfig | ZoomConfig | GcsConfig | CanvaConfig | SongLicenceConfig;
  media: MediaItem;
  canvaDesigns: CanvaDesign;
  calendarFeeds: CalendarFeed;
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
  verseGames: VerseGame;
  elections: Election;
  recaps: Recap;
  videoGreetings: VideoGreeting;
  greetingLinks: GreetingLink;
  annualReturns: AnnualReturn;
  missedCalls: MissedCall;
  qrCodes: OfferingQr;
  bankStatements: BankStatement;
  bankLines: BankLine;
  safeguarding: SafeguardRecord;
  courses: Course;
  courseEnrollments: CourseEnrollment;
  vigils: Vigil;
  vigilSignups: VigilSignup;
  mentorships: Mentorship;
  mentorMeetings: MentorMeeting;
  libraryBooks: LibraryBook;
  libraryLoans: LibraryLoan;
  occasions: Occasion;
  skillProfiles: SkillProfile;
  boardPosts: BoardPost;
  camps: Camp;
  campSignups: CampSignup;
  captions: CaptionsLog;
  ballots: Ballot;
  ballotStubs: BallotStub;
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
  roles: CustomRole;
  hubChannels: HubChannel;
  hubPosts: HubPost;
  carolSeasons: CarolSeason;
  carolNights: CarolNight;
  carolRequests: CarolRequest;
  rideRequests: RideRequest;
  rideOffers: RideOffer;
  aidRequests: AidRequest;
  assets: Asset;
  readingPlans: ReadingPlan;
  readingProgress: ReadingProgress;
  feasts: Feast;
  rentalOffers: RentalOffer;
  rentals: Rental;
  practices: Practice;
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
  teamLogins: TeamLogin;
  devices: Device;
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

// ----- getting started checklist on the dashboard -----
export type GettingStartedStep = { id: string; title: string; body: string; done: boolean; link: string; perm: Permission };
export type GettingStarted = { steps: GettingStartedStep[]; done: number; total: number; dismissed: boolean; trialDaysLeft: number | null; plan: string };

// ----- export everything (Settings › Privacy) -----
export type ExportFile = { name: string; rows: number; csv: string };
export type ExportSummary = { people: number; gifts: number; attendance: number; files: number; counts: Record<string, number> };
export type ExportBundle = { generatedAt: string; church: string; readme: string; files: ExportFile[] };
export const KINDS = [
  'settings', 'automations', 'people', 'campuses', 'events', 'rsvps', 'groups', 'groupMembers', 'joinRequests', 'groupMeetings',
  'funds', 'donations', 'pledges', 'plans', 'announcements', 'staff', 'rooms', 'checkins', 'teams', 'assignments', 'blockouts',
  'songs', 'messages', 'templates', 'care', 'prayer', 'audit', 'otps', 'refreshTokens', 'attendanceHistory', 'meta',
  'forms', 'formResponses', 'resources', 'bookings', 'customFields', 'smartLists', 'workflows', 'workflowCards', 'live', 'headcounts',
  'batches', 'groupPosts', 'groupResources', 'sermons', 'greetings', 'presentations', 'integrations', 'apiKeys', 'roles', 'hubChannels', 'hubPosts', 'carolSeasons', 'carolNights', 'carolRequests', 'rideRequests', 'rideOffers', 'aidRequests', 'assets', 'readingPlans', 'readingProgress', 'feasts', 'rentalOffers', 'rentals', 'practices',
  'registers', 'zones', 'visits', 'accountHeads', 'expenses', 'kycFiles', 'recurring', 'botMessages', 'campaigns', 'envelopes', 'inKind', 'auctionLots', 'consentLog', 'dataRequests', 'parentPages', 'bulletins',
  'ssClasses', 'ssLessons', 'ssAttendance', 'ssExams', 'ssMarks', 'verseGames', 'elections', 'ballots', 'ballotStubs', 'recaps', 'videoGreetings', 'greetingLinks', 'annualReturns', 'missedCalls', 'captions', 'qrCodes', 'bankStatements', 'bankLines', 'safeguarding', 'courses', 'courseEnrollments', 'vigils', 'vigilSignups', 'mentorships', 'mentorMeetings', 'libraryBooks', 'libraryLoans', 'occasions', 'skillProfiles', 'boardPosts', 'camps', 'campSignups',
  'missionaries', 'missionSupport', 'missionReports', 'missionPayouts',
  'streams', 'streamViews', 'teamLogins', 'devices', 'media', 'canvaDesigns', 'calendarFeeds',
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
export type BotIntent = 'menu' | 'services' | 'events' | 'prayer_ask' | 'prayer' | 'prayed' | 'chain_join' | 'chain_leave' | 'checkin_ok' | 'checkin_away' | 'checkin_call' | 'give' | 'sermon' | 'new' | 'talk' | 'stop' | 'start' | 'unknown';
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

// ---------- kids' memory verse game ----------

export type VerseLevel = 'read' | 'blanks' | 'recite';
/** One child's play on one week's memory verse. id is `${personId}:${lessonId}`. */
export type VerseGame = {
  id: string;
  personId: string;
  classId: string;
  lessonId: string;
  /** The Sunday the verse was taught; the leaderboard week. */
  week: string;
  verse: string;
  reference: string;
  /** When each step was passed. */
  done: Record<VerseLevel, string | null>;
  scores: Record<VerseLevel, number>;
  attempts: number;
  /** Best recite accuracy in percent. */
  bestAccuracy: number | null;
  updatedAt: string;
};
/** The fill-the-blanks round: words with null where a word is missing, and the chips to pick from. */
export type VersePuzzle = { words: (string | null)[]; options: string[] };
export type VerseGameView = {
  id: string;
  lessonId: string;
  week: string;
  title: string;
  verse: string;
  reference: string;
  done: Record<VerseLevel, string | null>;
  scores: Record<VerseLevel, number>;
  /** Teacher ticked "said the verse" in the register (40 points). */
  recitedInClass: boolean;
  points: number;
  stars: number;
  nextLevel: VerseLevel | null;
  puzzle: VersePuzzle;
  bestAccuracy: number | null;
};
export type VerseBoardRow = { id: string; name: string; points: number; stars: number; levels: VerseLevel[]; recitedInClass: boolean; mine: boolean };
export type VerseBoard = { classId: string; className: string; week: string; verse: string; reference: string; players: number; of: number; rows: VerseBoardRow[] };
export type MemberVerses = {
  children: { id: string; name: string; classId: string; className: string; game: VerseGameView | null; rank: number | null; totalStars: number; weeksPlayed: number }[];
  boards: VerseBoard[];
};
export type VerseAnswerResult = { ok: boolean; accuracy: number; earned: number; message: string; game: VerseGameView };
export type SsVerseBoards = { week: string; weeks: string[]; boards: VerseBoard[]; stars: { id: string; name: string; className: string; stars: number; weeks: number }[] };

// ---------- AGM and committee elections with secret ballots ----------

export type ElectionStatus = 'draft' | 'open' | 'closed';
/** A committee election picks `seats` people; a resolution is For / Against / Abstain on one motion. */
export type ElectionKind = 'election' | 'resolution';
export type ElectionEligibility = 'members' | 'members_18' | 'everyone_18';
export type Candidate = { id: string; personId: string | null; name: string; note: string };
export type Election = {
  id: string;
  title: string;
  kind: ElectionKind;
  description: string;
  seats: number;
  candidates: Candidate[];
  eligibility: ElectionEligibility;
  status: ElectionStatus;
  /** The AGM itself, shown on the ballot. */
  meetingAt: string | null;
  venue: string;
  opensAt: string | null;
  closesAt: string | null;
  closedAt: string | null;
  /** Hall ballots counted by the returning officer, per candidate id. */
  paperVotes: Record<string, number>;
  paperInvalid: number;
  returningOfficer: string;
  resultsPublished: boolean;
  createdAt: string;
  createdBy: string;
};
/** One anonymous ballot: no person, the hour it was cast, and a receipt only the voter has. */
export type Ballot = { id: string; electionId: string; choices: string[]; receipt: string; castHour: string; via: 'app' };
/** Who has voted, kept apart from the ballots. id is `${electionId}:${personId}`. */
export type BallotStub = { id: string; electionId: string; personId: string; castAt: string; via: 'app' | 'paper'; markedBy: string | null };
export type ElectionResultRow = { candidateId: string; name: string; note: string; app: number; paper: number; votes: number; percent: number; elected: boolean };
export type ElectionResults = { rows: ElectionResultRow[]; ballots: number; invalid: number; tie: boolean; passed: boolean | null };
export type ElectionTurnout = { eligible: number; app: number; paper: number; voted: number; percent: number };
export type ElectionView = Election & { turnout: ElectionTurnout; results: ElectionResults | null };

// ---------- Denomination annual return, auto-filled from the church's own records ----------

export type ReturnTemplateId = 'csi' | 'cni' | 'ag' | 'methodist' | 'baptist' | 'pentecostal' | 'marthoma' | 'lutheran' | 'generic';
export type ReturnLineKind = 'number' | 'money' | 'text';
/** One line of the form: filled from the data (`auto`) or typed by the office (`manual`). */
export type ReturnLine = { key: string; label: string; kind: ReturnLineKind; source: 'auto' | 'manual'; hint?: string };
export type ReturnSection = { id: string; title: string; lines: ReturnLine[] };
export type ReturnTemplate = { id: ReturnTemplateId; name: string; body: string; /** What the body calls the local unit: Pastorate, Local church, Assembly… */ unit: string; /** What it calls the level above: Diocese, District, Section… */ above: string; sections: ReturnSection[] };
/** The form's header: who is filing. Kept with the return and reused next year. */
export type ReturnHeader = { body: string; above: string; unit: string; code: string; minister: string; preparedBy: string };
export type AnnualReturn = {
  /** `${templateId}:${year}` */
  id: string;
  templateId: ReturnTemplateId;
  /** Start year of the period (financial year in India). */
  year: number;
  header: ReturnHeader;
  /** The office's own figures, by line key; a line without one shows the figure from the data. */
  values: Record<string, number | string>;
  notes: string;
  status: 'draft' | 'submitted';
  /** Every line's final figure, frozen when submitted. */
  snapshot: Record<string, number | string | null> | null;
  submittedAt: string | null;
  submittedBy: string;
  updatedAt: string;
};
export type ReturnLineView = ReturnLine & { /** From the data, null for a manual line. */ auto: number | string | null; /** What the form shows: the office's figure, else the data's. */ value: number | string | null; overridden: boolean };
export type ReturnSectionView = { id: string; title: string; lines: ReturnLineView[] };
export type AnnualReturnView = {
  template: Pick<ReturnTemplate, 'id' | 'name' | 'body' | 'unit' | 'above'>;
  year: number;
  label: string;
  from: string;
  to: string;
  currency: Currency;
  church: { name: string; address: string; phone: string; email: string; city: string };
  header: ReturnHeader;
  sections: ReturnSectionView[];
  return: AnnualReturn | null;
  /** Other years with a saved return. */
  years: { year: number; label: string; status: AnnualReturn['status'] }[];
};

// ---------- Pastor's video greeting: recorded once, sent personalised on every birthday ----------

export type VideoGreetingKind = 'birthday' | 'child' | 'anniversary';
/** One recording per kind. The link each person gets wraps it with their own name and a reply box. */
export type VideoGreeting = {
  id: VideoGreetingKind;
  enabled: boolean;
  /** A file in the media library, a YouTube link, or any video URL. */
  videoUrl: string;
  mediaId: string | null;
  posterUrl: string | null;
  /** "Pastor Samuel Raj" */
  fromName: string;
  /** A line under the video. {{firstName}} is filled in. */
  message: string;
  recordedAt: string | null;
  updatedBy: string;
};
/** One person's personalised greeting link. The token is the id, so it is not guessable. */
export type GreetingLink = {
  id: string;
  personId: string;
  kind: CelebrationKind;
  videoKind: VideoGreetingKind;
  year: number;
  /** Who was told: the person, or the parents of a child. */
  sentTo: string[];
  createdAt: string;
  views: number;
  watchedAt: string | null;
  reply: string | null;
  repliedAt: string | null;
  test: boolean;
};
export type GreetingLinkView = GreetingLink & { name: string; url: string };
export type VideoGreetingView = VideoGreeting & { sentThisYear: number; watched: number; replies: number; /** Celebrations of this kind in the next 7 days. */ upcoming: number };
export type VideoGreetingsHub = { greetings: VideoGreetingView[]; recent: GreetingLinkView[]; /** Whether recordings can be stored (Google Cloud Storage connected). */ storage: boolean; webUrl: string };
/** What the greeting page shows. No contact details, no other people. */
export type PublicGreeting = {
  firstName: string;
  kind: CelebrationKind;
  years: number | null;
  videoUrl: string;
  posterUrl: string | null;
  fromName: string;
  message: string;
  reply: string | null;
  church: { name: string; logoUrl: string | null; brand: BrandKit | null };
};

// ---------- "Sunday in 60 seconds": AI recap card and reel ----------

/** What a Sunday recap is written from. Nothing here is guessed: check-ins, the service plan, the sermon and the week's records. */
export type RecapFacts = {
  eventId: string;
  eventTitle: string;
  /** The Sunday, as a local date. */
  date: string;
  attendance: number | null;
  children: number | null;
  /** First names of people whose first Sunday it was. */
  firstTimers: string[];
  sermon: { title: string; speaker: string; scripture: string; oneLiner: string } | null;
  songs: string[];
  /** Birthdays, anniversaries and baptism days in the coming week. */
  celebrations: { kind: CelebrationKind; name: string }[];
  prayers: { requests: number; prayed: number };
  /** Gifts in the week ending that Sunday, in minor units; null unless the office chose to include it. */
  giving: number | null;
  nextEvents: { title: string; startsAt: string; location: string }[];
};
export type RecapSlide = { title: string; text: string; /** One big number or short phrase for the slide, or null. */ stat: string | null };
export type RecapStatus = 'draft' | 'published';
/** The numbers the card shows; safe for members (no money). */
export type RecapStats = { attendance: number | null; children: number | null; firstTimers: number; prayed: number; songs: number };
export type Recap = {
  id: string;
  eventId: string;
  eventTitle: string;
  date: string;
  language: LanguageCode;
  headline: string;
  /** The WhatsApp status caption. */
  caption: string;
  slides: RecapSlide[];
  stats: RecapStats;
  facts: RecapFacts;
  status: RecapStatus;
  createdAt: string;
  createdBy: string;
  publishedAt: string | null;
  /** People told when it was published. */
  notified: number;
};
export type AiRecap = { headline: string; caption: string; slides: RecapSlide[] };
/** A past Sunday service the office can write a recap for. */
export type RecapSunday = { eventId: string; title: string; date: string; startsAt: string; attendance: number | null; recapId: string | null };
/** A published recap as members and the public share page see it: no money, no facts beyond the card's numbers. */
export type MemberRecap = Pick<Recap, 'id' | 'eventTitle' | 'date' | 'language' | 'headline' | 'caption' | 'slides' | 'stats' | 'publishedAt'> & { church: { name: string; logoUrl: string | null; brand: BrandKit | null } };
export type ElectionRoll = { election: { id: string; title: string }; people: { id: string; name: string; phone: string | null; voted: 'app' | 'paper' | null; castAt: string | null }[] };
export type MemberElection = {
  id: string;
  title: string;
  kind: ElectionKind;
  description: string;
  seats: number;
  candidates: { id: string; name: string; note: string }[];
  status: ElectionStatus;
  meetingAt: string | null;
  venue: string;
  closesAt: string | null;
  eligible: boolean;
  reason: string | null;
  voted: boolean;
  results: ElectionResults | null;
  turnout: ElectionTurnout | null;
};
export type VoteReceipt = { receipt: string; choices: string[]; message: string };
export type ReceiptCheck = { counted: boolean; election: string; choices: string[] };

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
/** The door QR a leader shows on their phone; members scan it to be marked present. */
export type DoorQr = { token: string; path: string; rotatesInSeconds: number; present: number; scanned: number; recent: { name: string; at: string }[] };

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

// ---------- shared song database ----------

/** Languages the song database is organised by (ISO 639-1). */
export type SongLanguage = 'en' | 'hi' | 'te' | 'ta' | 'ml' | 'kn' | 'mr' | 'bn' | 'pa' | 'gu' | 'or' | 'ur';
export const SONG_LANGUAGES: { id: SongLanguage; label: string }[] = [
  { id: 'en', label: 'English' }, { id: 'hi', label: 'Hindi' }, { id: 'te', label: 'Telugu' }, { id: 'ta', label: 'Tamil' }, { id: 'ml', label: 'Malayalam' }, { id: 'kn', label: 'Kannada' },
  { id: 'mr', label: 'Marathi' }, { id: 'bn', label: 'Bengali' }, { id: 'pa', label: 'Punjabi' }, { id: 'gu', label: 'Gujarati' }, { id: 'or', label: 'Odia' }, { id: 'ur', label: 'Urdu' },
];
/**
 * A song in the shared Flockwise song database. Public-domain songs carry their words; copyrighted
 * songs carry credits only, and their words come from a licensed lyrics service when one is set up.
 */
export type CatalogSong = {
  id: string;
  title: string;
  /** Other titles people search by: a first line, an English or transliterated title. */
  aka?: string[];
  language: SongLanguage;
  /** Who wrote (or translated) the words, as credited. */
  writers: string;
  /** Who wrote the music. */
  music?: string;
  /** Year written or first published. */
  year?: number;
  rights: 'public-domain' | 'copyrighted';
  /** Copyright line to print with the words. */
  copyright: string;
  /** CCLI song number, for reporting. */
  ccli?: string;
  defaultKey: string;
  bpm: number | null;
  /** Hymn tune name, e.g. NEW BRITAIN. */
  tune?: string;
  /** Themes and seasons: Grace, Easter, Christmas, Communion... */
  themes: string[];
  lyrics?: string;
  chordChart?: string;
  arrangement?: string[];
  /** Where the words came from, e.g. "Open Hymnal Project" or a hymnbook and edition. */
  source?: string;
  links?: { name: string; url: string }[];
};
/** A row in the database list: no words, plus whether this church already has the song. */
export type CatalogSongRow = Omit<CatalogSong, 'lyrics' | 'chordChart'> & { hasLyrics: boolean; hasChords: boolean; inLibrary: string | null; licensedAvailable: boolean };
export type CatalogSongDetail = CatalogSong & { inLibrary: string | null; licensedAvailable: boolean };
export type CatalogList = { songs: CatalogSongRow[]; total: number; languages: { id: SongLanguage; label: string; songs: number }[] };

/** The church's song licences: CCLI numbers for reports and projected credits. */
export type SongLicenceConfig = {
  id: 'songLicence';
  /** CCLI Church Copyright Licence number. */
  ccliLicence: string;
  /** CCLI Streaming Licence number, for online services. */
  streamingLicence: string;
  /** Other licence holders, e.g. an Indian publisher or OneLicense. */
  otherLicences: string;
  updatedAt: string;
};
/** A licensed lyrics service Flockwise has an agreement with (SongSelect, a publisher, a label). */
export type LyricsFeedInfo = { id: string; name: string; /** 'ccli': asked only about songs with a CCLI number. */ covers: 'all' | 'ccli' };
export type SongLicenceStatus = {
  licence: SongLicenceConfig | null;
  /** Licensed lyrics services this server is connected to. */
  feeds: LyricsFeedInfo[];
};
/** Words for a copyrighted song from a licensed lyrics service. */
export type LicensedLyrics = { lyrics: string; chordChart?: string; copyright?: string; defaultKey?: string; feedId: string; feedName: string };

// ---------- Sunday transport matcher ----------

/** A household that needs a lift to the Sunday service: one row per Sunday, or weekly from `date` on. */
export type RideRequest = { id: string; date: string; weekly: boolean; personId: string; familyKey: string; familyName: string; phone: string | null; address: string | null; zoneId: string | null; people: number; note: string; offerId: string | null; status: 'waiting' | 'matched' | 'cancelled'; createdAt: string; createdBy: string };
/** A member who can drive that Sunday (or every Sunday) with the seats they have spare. */
export type RideOffer = { id: string; date: string; weekly: boolean; personId: string; driverName: string; phone: string | null; address: string | null; zoneId: string | null; seats: number; note: string; status: 'open' | 'cancelled'; createdAt: string; createdBy: string };
export type RideRequestView = RideRequest & { zoneName: string | null; driver: { id: string; name: string; phone: string | null; address: string | null } | null };
export type RideOfferView = RideOffer & { zoneName: string | null; seatsLeft: number; riders: { id: string; familyName: string; people: number; phone: string | null; address: string | null; zoneName: string | null; note: string }[] };
export type RidesHub = { sunday: string; sundays: string[]; serviceTime: string | null; requests: RideRequestView[]; offers: RideOfferView[]; zones: { id: string; name: string }[]; waiting: number; matched: number; seatsLeft: number };
export type MyRides = { sunday: string; sundays: string[]; serviceTime: string | null; request: RideRequestView | null; offer: RideOfferView | null };

// ---------- benevolence fund ----------

export type AidKind = 'medical' | 'education' | 'rent' | 'food' | 'funeral' | 'other';
export type AidStatus = 'requested' | 'reviewing' | 'approved' | 'declined' | 'paid' | 'withdrawn';
export type AidNote = { at: string; by: string; text: string };
/** A quiet request for help from the church, seen only by staff with the care permission. */
export type AidRequest = {
  id: string; personId: string; personName: string; phone: string | null; kind: AidKind;
  /** Asked for, in minor units. */
  amount: number;
  /** Approved (and, once paid, actually paid), in minor units. */
  approved: number | null;
  currency: Currency; reason: string; status: AidStatus; requestedAt: string; requestedBy: string; source: 'member' | 'office';
  decidedBy: string | null; decidedAt: string | null; decisionNote: string;
  paidAt: string | null; paidBy: string | null; paidVia: ExpenseMethod | null; paidRef: string | null;
  /** The payment voucher in Accounts. */
  expenseId: string | null;
  notes: AidNote[];
};
export type AidSummary = { fundId: string | null; fundName: string | null; received: number; paid: number; balance: number; open: number; approvedUnpaid: number };
export type BenevolenceHub = { summary: AidSummary; requests: AidRequest[]; funds: { id: string; name: string }[]; kinds: AidKind[] };
export type MyAid = { requests: Pick<AidRequest, 'id' | 'kind' | 'amount' | 'approved' | 'currency' | 'reason' | 'status' | 'requestedAt' | 'decisionNote' | 'paidAt'>[]; kinds: AidKind[] };

// ---------- asset register ----------

export type AssetCategory = 'furniture' | 'sound' | 'av' | 'instrument' | 'electrical' | 'vehicle' | 'kitchen' | 'building' | 'it' | 'other';
export type AssetCondition = 'good' | 'needs_repair' | 'retired';
export type AssetLogEntry = { at: string; on: string; by: string; kind: 'service' | 'repair' | 'note' | 'moved' | 'retired'; text: string; cost: number | null };
/** Something the church owns: where it is, who keeps it, what it cost, and when it is next due a service. */
export type Asset = {
  id: string;
  /** Short code on the sticker, A-0001 unless the office types its own. */
  tag: string;
  name: string; category: AssetCategory; quantity: number; location: string; serial: string; vendor: string;
  purchasedOn: string | null;
  /** Per unit, in minor units. */
  cost: number | null;
  warrantyUntil: string | null;
  /** Annual maintenance contract, if any. */
  amc: { vendor: string; phone: string; until: string | null; note: string } | null;
  serviceEveryMonths: number | null; lastServicedOn: string | null;
  condition: AssetCondition; custodianId: string | null; custodianName: string; notes: string; photoUrl: string | null;
  status: 'active' | 'retired'; createdAt: string; createdBy: string; log: AssetLogEntry[];
};
export type AssetView = Asset & { nextServiceOn: string | null; serviceDueInDays: number | null; amcDueInDays: number | null; warrantyDueInDays: number | null };
export type AssetsHub = { assets: AssetView[]; summary: { count: number; value: number; serviceDue: number; amcExpiring: number; needsRepair: number }; categories: AssetCategory[] };

// ---- Bible reading plan ----
export type ReadingTemplate = 'bible365' | 'nt90' | 'gospels30' | 'psalms31' | 'custom';
export type ReadingPlan = {
  id: string; name: string; description: string; template: ReadingTemplate;
  /** First day of the plan, YYYY-MM-DD in church time. */
  startsOn: string;
  /** One entry per day, English references like "Genesis 1-3; Psalms 1". Shown to each member in their language. */
  readings: string[];
  status: 'active' | 'archived'; createdAt: string; createdBy: string;
};
export type ReadingProgress = { id: string; planId: string; personId: string; joinedAt: string; done: number[]; lastDoneAt: string | null };
export type ReadingPlanView = ReadingPlan & { totalDays: number; endsOn: string; today: number | null; participants: number; readToday: number; percent: number };
export type ReadingHub = { plans: ReadingPlanView[]; templates: { id: ReadingTemplate; name: string; days: number; description: string }[] };
export type ReadingReader = { personId: string; name: string; joinedAt: string; doneCount: number; streak: number; todayDone: boolean };
export type MyReadingPlan = {
  id: string; name: string; description: string; startsOn: string; endsOn: string; totalDays: number; today: number | null;
  readings: { day: number; on: string; ref: string; local: string }[];
  joined: boolean; done: number[]; doneCount: number; streak: number; todayDone: boolean;
  church: { participants: number; readToday: number; percent: number };
};
export type MyReading = { plans: MyReadingPlan[] };

// ---- Love-feast and kitchen planner ----
export type FeastUnit = 'kg' | 'g' | 'l' | 'ml' | 'pcs' | 'bunch' | 'packet';
export type FeastSplit = 'church' | 'per_head' | 'per_family';
/** Quantity per head; cost per unit in minor units (null = not priced). */
export type FeastIngredient = { name: string; perHead: number; unit: FeastUnit; costPerUnit: number | null };
export type FeastDish = { id: string; name: string; ingredients: FeastIngredient[]; cookId: string | null; cookName: string };
export type Feast = {
  id: string; eventId: string; name: string; template: string; menu: FeastDish[];
  /** Guests beyond the RSVPs (visitors, children not on the app). */
  extraHeads: number;
  /** When set, cooks for this many regardless of RSVPs. */
  headsOverride: number | null;
  split: FeastSplit; notes: string; createdAt: string; createdBy: string;
};
export type ShoppingItem = { name: string; unit: FeastUnit; qty: number; costPerUnit: number | null; cost: number | null; dishes: string[] };
export type FeastView = Feast & {
  event: { id: string; title: string; startsAt: string; location: string } | null;
  rsvps: number; families: number; heads: number; shopping: ShoppingItem[]; estimatedCost: number; perHead: number; perFamily: number;
};
export type FeastTemplate = { id: string; name: string; description: string; dishes: Omit<FeastDish, 'id' | 'cookId' | 'cookName'>[] };
export type FeastsHub = { feasts: FeastView[]; templates: FeastTemplate[]; units: FeastUnit[]; events: { id: string; title: string; startsAt: string; going: number }[] };

// ---- Hall and ground rental ----
/** Rental terms for a resource, keyed by the resource id. */
export type RentalOffer = { id: string; enabled: boolean; ratePerHour: number; minHours: number; deposit: number; blurb: string; terms: string; photoUrl: string | null };
export type RentalStatus = 'requested' | 'awaiting_payment' | 'paid' | 'declined' | 'cancelled' | 'refunded';
export type Rental = {
  id: string;
  /** Unguessable key in the renter's link. */
  token: string;
  resourceId: string; resourceName: string;
  renterName: string; renterPhone: string; renterEmail: string; organisation: string; purpose: string; guests: number;
  startsAt: string; endsAt: string; hours: number; ratePerHour: number;
  /** Hire charge and refundable deposit, in minor units. */
  amount: number; deposit: number; currency: Currency;
  status: RentalStatus; bookingId: string | null; donationId: string | null; notes: string; source: 'public' | 'office';
  createdAt: string; decidedBy: string | null; decidedAt: string | null; paidAt: string | null;
};
export type RentalView = Rental & { total: number; payUrl: string; bookingStatus: BookingStatus | null; conflicts: BookingConflict[] };
export type RentalsHub = {
  rentals: RentalView[];
  spaces: { resource: Resource; offer: RentalOffer }[];
  summary: { open: number; awaitingPayment: number; paidThisYear: number; depositsHeld: number };
  publicUrl: string;
};
export type PublicRentalSpace = { id: string; name: string; kind: ResourceKind; capacity: number | null; description: string; blurb: string; terms: string; photoUrl: string | null; ratePerHour: number; minHours: number; deposit: number; currency: Currency };
export type PublicRentals = { church: { name: string; phone: string; email: string }; spaces: PublicRentalSpace[] };
export type PublicRental = { id: string; token: string; church: { name: string; phone: string; email: string }; resourceName: string; renterName: string; purpose: string; startsAt: string; endsAt: string; hours: number; amount: number; deposit: number; total: number; currency: Currency; status: RentalStatus; paidAt: string | null };

// ---------- choir practice ----------

export type SongPartName = 'soprano' | 'alto' | 'tenor' | 'bass' | 'melody' | 'harmony' | 'instrumental' | 'full';
/** One recording of a song: a voice part on its own, or the whole thing. A link, or a file from the media library. */
export type SongPart = { id: string; part: SongPartName; name: string; url: string; mediaId: string | null; addedBy: string; addedAt: string };
export type PracticeSong = { id: string; title: string; author: string; key: string; parts: SongPart[] };
/** One rehearsal of a team: who came and what was practised. */
export type Practice = { id: string; teamId: string; at: string; minutes: number; eventId: string | null; songIds: string[]; presentIds: string[]; notes: string; recordedBy: string; createdAt: string; updatedAt: string };
export type PracticeView = Practice & { teamName: string; eventTitle: string | null; songs: PracticeSong[]; present: number; roster: number };
export type PracticeMember = { personId: string; name: string; positions: string[]; present: number; total: number; missedInARow: number; lastAt: string | null };
export type Rehearsal = { eventId: string; eventTitle: string; at: string; notes: string; songs: PracticeSong[] };
export type PracticesHub = {
  teams: { id: string; name: string; color: string; roster: number }[];
  teamId: string | null;
  practices: PracticeView[];
  /** The chosen team's roster with attendance over the practices shown. */
  members: PracticeMember[];
  nextRehearsal: Rehearsal | null;
  parts: SongPartName[];
  /** Songs in the library that have any part recording. */
  songsWithParts: PracticeSong[];
};
export type MyPractice = {
  teams: { id: string; name: string; myParts: string[]; isLeader: boolean; roster: { personId: string; name: string }[] }[];
  nextRehearsal: Rehearsal | null;
  /** Songs with part recordings, the next service's first. */
  songs: PracticeSong[];
  attendance: { present: number; total: number; lastAt: string | null };
  recent: { id: string; at: string; teamName: string; wasPresent: boolean; songs: string[]; presentIds: string[] }[];
  parts: SongPartName[];
};
