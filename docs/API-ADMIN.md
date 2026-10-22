# Flockwise church office API (v1)

Endpoints behind the church office dashboard (`/admin` in the web app). Same conventions and
sign-in as the member API in [API.md](API.md). Shapes are in `src/core/types.ts`; the route code is
in `src/core/modules/*.ts` (the "Needs" column below is generated from it).

## Staff sign-in and roles

Staff sign in with the same email code flow, sending `audience: "admin"`. Only emails invited under
**Settings → Team & roles** get a code. The session's `staff` carries `role` and `permissions`, and
every `/admin/*` route checks the permission on the server.

| Role | Permissions |
|---|---|
| Owner, Admin | everything |
| Pastor | people.view, people.edit, events, groups, comms, care, checkin, volunteers, services, insights (no individual giving) |
| Finance | people.view, giving.view, giving.edit, insights |
| Group leader | people.view, groups, care, checkin, volunteers, services |
| Volunteer coordinator | people.view, volunteers, services, checkin, events |
| Check-in desk | checkin |

`GET /admin/me` returns the signed-in staff member with `role`, `label` and `permissions`.
Every change is written to the activity log (`GET /admin/audit?q=&cursor=`).

## Notes on the main flows

- **People**: list filters `?q=&status=&tag=&campusId=&cursor=`. `GET /admin/people/:id/timeline` merges attendance, gifts, groups, serving, care and messages. `GET /admin/people-duplicates` finds likely duplicates by email, phone and name; `POST /admin/people/merge { keepId, mergeId }` moves everything onto one record. Import takes `{ rows: [...], dedupeBy?: "phone"|"email", source? }` from CSV.
- **Kids check-in**: `POST /admin/checkin/:eventId { personIds, method?: "staff"|"kiosk" }` returns labels; children get a 4-character security code shared by the family. `scan { code }` accepts the member QR (`FW1:<code>`). Checkout takes `{ securityCode }`, or `{ override: true }` which is written to the activity log. Labels are sized for 62×29 mm label printers.
- **Volunteers**: `available` lists people with conflicts (away dates, double booking) so the scheduler can warn; `assign { force: true }` overrides. `autofill` fills open slots fairly (least recently served first). `notify` sends the rota to everyone pending.
- **Service planning**: `PUT /admin/services/:eventId` saves the whole plan (`theme`, `notes`, `items[]`). `copy { fromEventId }` starts from a past service.
- **Messages**: audiences are `everyone, status, group, team, tag, campus, event, people` with `ids`. `POST /admin/messages/audience` previews reach (respecting each person's consent per channel). Merge fields: `{{firstName}} {{lastName}} {{fullName}} {{church}} {{appLink}}`. `send: false` saves a draft; `scheduledAt` schedules. When a channel has no provider configured, messages are logged with `simulated: true`.
- **Automations**: birthday, anniversary, welcome (optional follow-up case), "we miss you" after N weeks (optional follow-up case), volunteer reminders N days before. The server checks for due automations and scheduled messages every minute.
- **Giving**: manual entries for cash, cheque and bank transfer; refunds; `receipts-80g?financialYear=` for Form 10BD; per-donor statements; pledges with progress.
- **Care**: cases with notes, assignee, due date, priority and a confidential flag (only pastors, admins and the assignee see notes). `at-risk` lists members and regulars away 3+ weeks.

## Endpoints

### Pastoral care

| Method | Path | Needs |
|---|---|---|
| GET | `/admin/care` | `care` |
| GET | `/admin/care/at-risk` | `care` |
| GET | `/admin/care/assignees` | `care` |
| POST | `/admin/care` | `care` |
| PATCH | `/admin/care/:id` | `care` |
| POST | `/admin/care/:id/notes` | `care` |
| DELETE | `/admin/care/:id` | `care` |

### Prayer moderation

| Method | Path | Needs |
|---|---|---|
| GET | `/admin/prayer` | `care` |
| PATCH | `/admin/prayer/:id` | `care` |
| DELETE | `/admin/prayer/:id` | `care` |

### Dashboard

| Method | Path | Needs |
|---|---|---|
| GET | `/admin/dashboard` | any staff |

### Insights

| Method | Path | Needs |
|---|---|---|
| GET | `/admin/insights` | `insights` |

### Kids & event check-in

| Method | Path | Needs |
|---|---|---|
| GET | `/admin/checkin/events` | `checkin` |
| GET | `/admin/checkin/rooms` | `checkin` |
| POST | `/admin/checkin/rooms` | `checkin` |
| PATCH | `/admin/checkin/rooms/:id` | `checkin` |
| DELETE | `/admin/checkin/rooms/:id` | `checkin` |
| GET | `/admin/checkin/:eventId` | `checkin` |
| GET | `/admin/checkin/:eventId/search` | `checkin` |
| POST | `/admin/checkin/:eventId` | `checkin` |
| POST | `/admin/checkin/:eventId/scan` | `checkin` |
| POST | `/admin/checkin/checkins/:id/checkout` | `checkin` |
| DELETE | `/admin/checkin/checkins/:id` | `checkin` |
| POST | `/admin/checkin/:eventId/reprint` | `checkin` |

### Events

| Method | Path | Needs |
|---|---|---|
| GET | `/admin/events` | `events` or `checkin` or `volunteers` or `services` |
| POST | `/admin/events` | `events` |
| PATCH | `/admin/events/:id` | `events` |
| DELETE | `/admin/events/:id` | `events` |
| PUT | `/admin/events/:id/attendance` | `events` or `checkin` |
| GET | `/admin/events/:id/attendees` | `events` or `checkin` |

### Groups

| Method | Path | Needs |
|---|---|---|
| GET | `/admin/groups/join-requests` | `groups` |
| POST | `/admin/groups/join-requests/:id/:decision` | `groups` |
| GET | `/admin/groups` | `groups` or `people.view` |
| POST | `/admin/groups` | `groups` |
| GET | `/admin/groups/:id` | `groups` or `people.view` |
| PATCH | `/admin/groups/:id` | `groups` |
| DELETE | `/admin/groups/:id` | `groups` |
| POST | `/admin/groups/:id/members` | `groups` |
| DELETE | `/admin/groups/:id/members/:personId` | `groups` |
| POST | `/admin/groups/:id/meetings` | `groups` |

### Announcements

| Method | Path | Needs |
|---|---|---|
| GET | `/admin/announcements` | `comms` |
| POST | `/admin/announcements` | `comms` |
| PATCH | `/admin/announcements/:id` | `comms` |
| DELETE | `/admin/announcements/:id` | `comms` |

### Settings

| Method | Path | Needs |
|---|---|---|
| GET | `/admin/settings` | any staff (read) |
| PATCH | `/admin/settings` | `settings` |
| POST | `/admin/settings/payments/connect` | `settings` |

### Staff profile

| Method | Path | Needs |
|---|---|---|
| GET | `/admin/me` | any staff |

### Staff and roles

| Method | Path | Needs |
|---|---|---|
| GET | `/admin/staff` | `staff` |
| POST | `/admin/staff` | `staff` |
| PATCH | `/admin/staff/:id` | `staff` |
| DELETE | `/admin/staff/:id` | `staff` |

### Activity log

| Method | Path | Needs |
|---|---|---|
| GET | `/admin/audit` | `settings` |

### Messages

| Method | Path | Needs |
|---|---|---|
| GET | `/admin/messages` | `comms` |
| GET | `/admin/messages/channels` | `comms` |
| POST | `/admin/messages/audience` | `comms` |
| POST | `/admin/messages` | `comms` |
| PATCH | `/admin/messages/:id` | `comms` |
| DELETE | `/admin/messages/:id` | `comms` |
| GET | `/admin/messages/templates` | `comms` |
| POST | `/admin/messages/templates` | `comms` |
| PATCH | `/admin/messages/templates/:id` | `comms` |
| DELETE | `/admin/messages/templates/:id` | `comms` |
| GET | `/admin/messages/automations` | `comms` |
| PUT | `/admin/messages/automations` | `comms` |

### Giving

| Method | Path | Needs |
|---|---|---|
| GET | `/admin/giving/donations` | `giving.view` |
| POST | `/admin/giving/donations` | `giving.edit` |
| POST | `/admin/giving/donations/:id/refund` | `giving.edit` |
| GET | `/admin/giving/funds` | `giving.view` |
| POST | `/admin/giving/funds` | `giving.edit` |
| PATCH | `/admin/giving/funds/:id` | `giving.edit` |
| GET | `/admin/giving/receipts-80g` | `giving.view` |
| GET | `/admin/giving/statements/:personId` | `giving.view` |
| GET | `/admin/giving/pledges` | `giving.view` |
| POST | `/admin/giving/pledges` | `giving.edit` |
| DELETE | `/admin/giving/pledges/:id` | `giving.edit` |

### People

| Method | Path | Needs |
|---|---|---|
| GET | `/admin/people` | `people.view` |
| GET | `/admin/people/tags` | `people.view` |
| POST | `/admin/people` | `people.edit` |
| POST | `/admin/people/import` | `people.edit` |
| GET | `/admin/people/:id` | `people.view` |
| GET | `/admin/people/:id/timeline` | `people.view` |
| PATCH | `/admin/people/:id` | `people.edit` |
| POST | `/admin/people/merge` | `people.edit` |
| GET | `/admin/people-duplicates` | `people.view` |
| DELETE | `/admin/people/:id` | `people.edit` |

### Campuses

| Method | Path | Needs |
|---|---|---|
| GET | `/admin/campuses` | `people.view` |
| POST | `/admin/campuses` | `settings` |
| PATCH | `/admin/campuses/:id` | `settings` |
| DELETE | `/admin/campuses/:id` | `settings` |

### Volunteers

| Method | Path | Needs |
|---|---|---|
| GET | `/admin/volunteers/teams` | `volunteers` or `services` |
| POST | `/admin/volunteers/teams` | `volunteers` |
| PATCH | `/admin/volunteers/teams/:id` | `volunteers` |
| PUT | `/admin/volunteers/teams/:id/members` | `volunteers` |
| DELETE | `/admin/volunteers/teams/:id` | `volunteers` |
| GET | `/admin/volunteers/overview` | `volunteers` or `services` |
| GET | `/admin/volunteers/schedule/:eventId` | `volunteers` or `services` |
| GET | `/admin/volunteers/schedule/:eventId/available` | `volunteers` |
| POST | `/admin/volunteers/assignments` | `volunteers` |
| PATCH | `/admin/volunteers/assignments/:id` | `volunteers` |
| DELETE | `/admin/volunteers/assignments/:id` | `volunteers` |
| POST | `/admin/volunteers/autofill/:eventId` | `volunteers` |
| POST | `/admin/volunteers/notify/:eventId` | `volunteers` |
| GET | `/admin/volunteers/blockouts` | `volunteers` |

### Service planning

| Method | Path | Needs |
|---|---|---|
| GET | `/admin/services` | `services` or `volunteers` |
| GET | `/admin/services/:eventId` | `services` or `volunteers` |
| PUT | `/admin/services/:eventId` | `services` |
| POST | `/admin/services/:eventId/copy` | `services` |

### Song library

| Method | Path | Needs |
|---|---|---|
| GET | `/admin/songs` | `services` or `volunteers` |
| POST | `/admin/songs` | `services` |
| PATCH | `/admin/songs/:id` | `services` |
| DELETE | `/admin/songs/:id` | `services` |

### Forms and registrations

Forms can sell ticket types (prices in minor units), apply discount codes, cap places and keep a waitlist. A paid registration is a pending payment to the hidden "Event registrations" fund with `formResponseId` set; the payment webhook confirms it. Free forms promote the waitlist automatically when someone cancels.

| Method | Path | Needs |
|---|---|---|
| GET | `/admin/forms` | `events` or `people.edit` |
| POST | `/admin/forms` | `events` |
| GET | `/admin/forms/:id` | `events` or `people.edit` |
| PATCH | `/admin/forms/:id` | `events` |
| POST | `/admin/forms/:id/duplicate` | `events` |
| DELETE | `/admin/forms/:id` | `events` (refused when there are paid registrations) |
| GET | `/admin/forms/:id/responses?status=` | `events` or `people.edit` |
| PATCH | `/admin/forms/:id/responses/:rid` `{ status: 'cancelled' \| 'confirmed' }` or `{ answers }` | `events` |
| POST | `/admin/forms/:id/responses/:rid/promote` | `events` (paid forms email a payment link) |

### Calendar and bookings

| Method | Path | Needs |
|---|---|---|
| GET | `/admin/calendar?from=&to=` | any staff (events and bookings together) |
| GET | `/admin/resources` | any staff |
| POST, PATCH, DELETE | `/admin/resources[/:id]` | `settings` |
| GET | `/admin/bookings?status=&when=past` | any staff |
| POST | `/admin/bookings/check` `{ resourceIds, startsAt, endsAt, setupMinutes }` | any staff, returns clashes |
| POST | `/admin/bookings` `{ title, resourceIds, startsAt, endsAt, setupMinutes?, repeatWeeks?, eventId?, force? }` | any staff; 409 `conflict` on a clash with an approved booking |
| PATCH | `/admin/bookings/:id` | requester or approver |
| POST | `/admin/bookings/:id/approve \| decline \| cancel` | approvers (owners, admins, or the resource's approvers); requester may cancel |

### Custom fields, smart lists, workflows

People accept `custom: { [fieldId]: value }` on create and update. Smart lists can be message audiences (`{ type: 'list', ids: [listId] }`). Rule fields: `status, tag, campus, gender, age, joinedDays, lastAttendedDays, group, team, gaveDays, birthdayMonth, hasEmail, hasPhone, formResponse, workflow, custom`; ops: `is, is_not, gt, lt, within, not_within, contains, empty, not_empty`.

| Method | Path | Needs |
|---|---|---|
| GET | `/admin/people-fields` | `people.view` |
| POST, PATCH, DELETE | `/admin/people-fields[/:id]` | `settings` |
| GET, POST | `/admin/lists` | `people.view` |
| POST | `/admin/lists/preview` `{ rules, match }` | `people.view` |
| PATCH, DELETE | `/admin/lists/:id` | `people.view` |
| GET | `/admin/lists/:id/people` | `people.view` |
| GET | `/admin/workflows` | `people.view` or `care` |
| POST, PATCH, DELETE | `/admin/workflows[/:id]` | `people.edit` |
| GET | `/admin/workflows/:id?status=active\|done\|removed\|all` | `people.view` or `care` |
| POST | `/admin/workflows/:id/cards` `{ personIds?, listId?, note? }` | `people.edit` or `care` |
| GET | `/admin/workflow-cards?mine=true` or `?personId=` | `people.view` or `care` |
| PATCH | `/admin/workflow-cards/:id` `{ action: advance\|back\|done\|remove\|snooze\|assign\|note, note?, days?, assignedTo? }` | `people.edit` or `care` |

Workflow triggers: `manual`, `new_visitor` (a visitor is added), `form` (a registration for `triggerId` is confirmed), `list` (anyone newly matching smart list `triggerId`, checked by the scheduler).

### Services: live and CCLI

| Method | Path | Needs |
|---|---|---|
| GET | `/admin/services/:eventId/live` | `services`, `volunteers` or `checkin` |
| POST | `/admin/services/:eventId/live` `{ action: start\|next\|prev\|goto\|stop\|reset, index? }` | `services` |
| GET | `/admin/songs/ccli-report?from=&to=` | `services` or `volunteers` |

Songs also take `chordChart` (ChordPro text) and `attachments: [{ name, url, kind }]`.
Songs also take `lyricsAlt` (the same song in a second language, with matching section headings) and `arrangement` (section order, e.g. `["Verse 1","Chorus","Verse 2","Chorus"]`). Plan items take `arrangement` (overrides the song's for that service) and `text` (reading or announcement words shown on the projector). Plans take `rehearsalAt` and `rehearsalNotes`.

### Presentation and song stats

| Method | Path | Needs |
|---|---|---|
| GET | `/admin/services/:eventId/presentation` | any office login |
| POST | `/admin/services/:eventId/presentation` `{ action: next\|prev\|goto\|item\|blank\|logo\|live\|message, index?, message? }` | `services` or `checkin` |
| GET | `/admin/presentation-theme` | any office login |
| PUT | `/admin/presentation-theme` `{ background, textColor, imageUrl, fontScale, linesPerSlide, showAlt, titleSlides, uppercase }` | `services` or `settings` |
| GET | `/admin/songs/stats` | `services` |
| GET | `/screens/:eventId?key=` | none (the church's screen key) |
| POST | `/admin/presentation-key/reset` | `services` or `settings` |

The presentation view returns `{ event, churchName, logoUrl, slides[], state { index, mode, message }, theme, timer }`. Lyrics are split into slides by section headings (`Verse 1`, `[Chorus]`, `Bridge:`, ChordPro `{soc}`) and `linesPerSlide`. Screens poll the GET about once a second to stay in step with the operator.

Media team actions on the presentation POST: `countdown { until? }` (mode `countdown`, defaults to the service start), `lower { lowerThird: { title, subtitle } }`, `lowerClear`, `queue { lowerThirds: [...] }`, `overlay { on }` (lyrics bar on the OBS overlay). The view adds `announcements` (for the countdown loop), `suggestedLowerThirds` (from the plan) and, for office logins, `screenKey`. Projector, stage display and the OBS Browser Source overlay can open `/present/:eventId/{screen|stage|overlay}?key=<screenKey>` without signing in; resetting the key breaks old links.

### Check-in: headcounts and volunteers

`GET /admin/checkin/:eventId` now includes `headcounts`, `headcountTotal` and `volunteers { scheduled, checkedIn, missing[] }`. Scheduled volunteers who check in get a `volunteer` label.

| Method | Path | Needs |
|---|---|---|
| POST | `/admin/checkin/:eventId/headcounts` `{ area, count }` (a recount of the same area replaces it; event attendance becomes the total) | `checkin` |
| DELETE | `/admin/checkin/headcounts/:id` | `checkin` |

### Giving: deposit batches

`POST /admin/giving/donations` accepts `batchId`. Committed batches can't take new gifts or refunds until reopened.

| Method | Path | Needs |
|---|---|---|
| GET, POST | `/admin/giving/batches` | `giving.view` / `giving.edit` |
| GET, PATCH, DELETE | `/admin/giving/batches/:id` | `giving.view` / `giving.edit` |
| POST | `/admin/giving/batches/:id/commit` `{ force? }` | `giving.edit` (409 `mismatch` when the total differs from `expectedTotal`) |
| POST | `/admin/giving/batches/:id/reopen` | `giving.edit` |

### Groups, sermons and the public page

| Method | Path | Needs |
|---|---|---|
| GET | `/admin/groups/:id/posts` | `groups` |
| DELETE | `/admin/groups/posts/:postId` | `groups` |
| GET, POST | `/admin/sermons` | `comms` or `services` |
| PATCH, DELETE | `/admin/sermons/:id` | `comms` or `services` |
| GET, PUT | `/admin/public-page` | `settings` |

## Celebrations

- `GET /admin/celebrations?days=30&kind=birthday|anniversary|baptism` (people.view) → `Celebration[]`, soonest first, with `years`, `isChild`, `greeted` (office greeting sent this year) and `wishes` (member wishes).
- `POST /admin/celebrations/greet` (comms) `{ personId, kind, channel, subject?, body }` → sends the greeting and records it.
- Automation `staffDigest: { enabled, daysAhead }` in `/admin/messages/automations`: emails staff with the `care` permission each morning someone celebrates, and a full list on Mondays.

## Registers (Grow plan)

Baptism, confirmation, marriage and burial registers, plus membership transfer letters. Field definitions per register are `REGISTER_FIELDS` in `src/core/modules/registers.ts`.

- `GET /admin/registers/summary` (people.view) → `{ kinds: RegisterSummary[], fields, labels }`.
- `GET /admin/registers?kind=&q=&year=&status=void|all&cursor=` (people.view) → page of `RegisterEntry`, newest first. Void entries are hidden unless asked for.
- `GET /admin/registers/:id`, `GET /admin/people/:id/registers` (people.view).
- `POST /admin/registers` (people.edit) `{ kind, date, name?, personId?, spouseId?, place?, officiant?, details, remarks?, markInactive? }` → numbers the entry `BAP|CNF|MAR|BUR|TRF/<year>/<nnnn>` (per register and year, never reused). Linked people are updated where empty: baptism date, wedding anniversary for both spouses; a burial marks the person inactive and tags them Deceased; a transfer with `markInactive` tags them Transferred.
- `PATCH /admin/registers/:id` (people.edit) `{ ...fields, reason? }` → each changed value is written as a dated marginal note with the staff name.
- `POST /admin/registers/:id/notes` (people.edit) `{ text }`.
- `POST /admin/registers/:id/void` (owner, admin or pastor) `{ reason }`: entries are never deleted.
- `POST /admin/registers/:id/certificate` (people.view) → `Certificate` (rows to print, or the letter text for a transfer) and counts the copy.

## Zones and home visits (Grow plan)

Zones are areas, prayer cells or family units (the church picks its own word in `settings.zoneLabel`). Households (people sharing `householdName`) belong to a zone through each person's `zoneId`; a zone can sit inside a larger area (`parentId`) and its counts include its units.

- `GET /admin/zones` (people.view) → `ZoneView[]` with leaders, families, people, `visitedThisYear` and `lastVisitAt`.
- `GET /admin/zones/:id` (people.view) → `ZoneDetail`: the zone, its families (last visit, visits this year, next planned), recent visits and units.
- `POST /admin/zones`, `PATCH /admin/zones/:id` (people.edit) `{ name, parentId?, leaderIds?, meetingDay?, area?, notes?, active? }`.
- `DELETE /admin/zones/:id` (people.edit): people and units move up to the parent area.
- `POST /admin/zones/:id/members` (people.edit) `{ personIds }`: brings each person's whole household. `DELETE /admin/zones/:id/families/:key` removes a household.
- `GET /admin/zones/report?since=YYYY-MM-DD` (people.view) → families visited per zone since 1 January (or `since`).
- `GET /admin/visits?status=planned|done|cancelled&zoneId=&mine=1&familyKey=` (people.view) → `VisitView[]`. Confidential notes are hidden except from owners, admins, pastors and the visitors.
- `GET /admin/visits/due?since=&zoneId=` (people.view) → member and regular families with no visit since 1 January (or `since`).
- `POST /admin/visits` (care) `{ personId | familyKey, date, status?: 'done', purpose, visitorIds?, visitorNames?, notes?, prayerPoints?, followUp?, confidential? }` plans or logs a visit for the person's household.
- `PATCH /admin/visits/:id` (care) marks done or cancelled, moves the date, edits notes. `DELETE /admin/visits/:id` (care) removes a planned visit; visits that happened stay on record.

## Church accounts and Tally (Grow plan)

- `GET /admin/accounts/heads` (any staff) → `AccountHead[]`; a church gets twelve common heads the first time. `POST`, `PATCH /admin/accounts/heads/:id` (giving.edit) `{ name, tallyName?, tallyGroup?, budget?, fy?, active? }`; `budget` in rupees for the financial year `fy` (default the current one).
- `GET /admin/accounts/summary?fy=2026` (giving.view) → `AccountsSummary`: income per fund, budget, spent (paid) and committed (approved) per head, month by month.
- `GET /admin/expenses?status=&headId=&mine=1` (any staff; people without giving.view see only their own requests).
- `POST /admin/expenses` (any staff) `{ headId, amount, payee, description, date?, method?, reference?, fcra?, billUrl?, paid? }`: a request. With `paid: true` and giving.edit it is recorded as paid straight away and gets a voucher number.
- `POST /admin/expenses/:id/decide` (owner, admin or finance; never your own request) `{ approve, note? }`; a note is required to turn one down.
- `POST /admin/expenses/:id/pay` (giving.edit) `{ method, date?, reference?, fcra? }` → numbers the payment voucher `PV/<financial year>/<nnnn>`.
- `DELETE /admin/expenses/:id` withdraws an unpaid request (the person who asked or the treasurer).
- `GET`, `PATCH /admin/accounts/tally` (giving.view / giving.edit): company name, bank, cash and FCRA bank ledger names, ledger name per fund, income group.
- `GET /admin/accounts/tally-export?from=&to=&gifts=0|1&expenses=0|1&ledgers=0|1&daily=0|1` (giving.view) → `{ filename, xml, receipts, payments, incomeTotal, expenseTotal }`. Tally Prime import file: a Receipt voucher per gift (or per day, fund and account with `daily=1`; cash gifts to the cash ledger, FCRA gifts to the FCRA bank) and a Payment voucher per paid expense, with ledger masters for the funds and heads used.

## Assisted Razorpay setup

A one-time ₹1,999 service, paid to Flockwise (Agape Labs) on the platform's Razorpay account. Our team opens the church's Razorpay account through our partner link and does the KYC. All routes need the `settings` permission.

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/settings/payments/setup` | `{price, currency, online, partnerUrl, setup, missing}`. Checks Razorpay if a payment is still pending. |
| POST | `/admin/settings/payments/setup` | Starts the fee payment: `{checkoutUrl}`. Razorpay returns the payer to `/admin/razorpay-setup`. 409 once paid. |
| PATCH | `/admin/settings/payments/setup` | `{orgType?: 'trust'\|'society'\|'section8'\|'parent', contactPhone?}` |
| POST | `/admin/settings/payments/setup/docs` | `{kind, fileName, data}` with base64 `data`. PDF, JPG or PNG, up to 3 MB, 12 files at most. Open after payment until done. |
| DELETE | `/admin/settings/payments/setup/docs/:id` | |
| POST | `/admin/settings/payments/setup/submit` | Needs `orgType` and the required documents (PAN, registration, bank proof, signatory ID, plus the parent body's letter for `parent`). |

The Flockwise team works the queue at `/platform/razorpay-setups` (list), `GET /platform/razorpay-setups/:churchId/docs/:docId` (file, logged) and `PATCH /platform/razorpay-setups/:churchId` `{status, teamNote}`. Marking a setup `done` or `refunded` deletes the stored files. The fee is confirmed by the `payment_link.paid` event on `/v1/webhooks/billing`.

## Monthly gifts (UPI AutoPay)

A monthly gift (`frequency: 'monthly'` on `POST /giving/intents`) is a Razorpay subscription on the church's account. The giver approves it once with UPI AutoPay, a card or a bank e-mandate. Flockwise keeps one `recurring` record for each subscription and updates it from the church's webhook. Add these events to it: `subscription.activated`, `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.paused`, `subscription.resumed`, `subscription.cancelled` and `subscription.completed`.

| Method | Path | Notes |
|---|---|---|
| GET | `/giving/recurring` | The member's own monthly gifts (status, amount, `nextChargeAt`, `chargedCount`, `totalGiven`). |
| POST | `/giving/recurring/:id/pause` · `/resume` · `/cancel` | Changes the subscription at Razorpay first. A cancel takes effect at once. |
| POST | `/giving/pledges` with `autopay: true` | Creates the pledge, then a subscription of `ceil(amount / months)` for the months up to `endDate`. Returns `checkoutUrl`, `monthly` and `months`. A pledge with an AutoPay running cannot be deleted until the AutoPay is cancelled. |
| GET | `/admin/giving/recurring?status=active\|attention\|paused\|pending\|cancelled` | `{summary: {active, monthly, failing, pending}, rows}` (giving.view). |
| POST | `/admin/giving/recurring/:id/cancel` | giving.edit. |

The statuses are `pending` (not approved yet), `active`, `failing` (a charge failed and Razorpay is retrying), `paused`, `halted` (retries ran out), `cancelled` and `completed`.

## WhatsApp assistant (Grow plan, needs Chitthi)

People message the church's WhatsApp number (run on Chitthi) and get an answer at once. The menu is 1 service times, 2 events this week, 3 prayer request, 4 give online, 5 latest sermon, 6 "I'm new here" and 7 talk to someone. Common words also work in English and Hindi, such as "hi", "namaste", "prayer", "tithe" and "time". STOP and START change the person's WhatsApp consent.

- A prayer request is saved for pastors only. "I'm new" adds a visitor tagged `WhatsApp` with a follow-up care case. "Talk" opens a care case.
- `GET /admin/integrations/whatsapp-bot` returns the status (`WaBotStatus`): on or off, the welcome line, counts for the last 30 days and the latest 50 messages.
- `POST /admin/integrations/whatsapp-bot` with `{ welcome? }` turns the assistant on, or saves the welcome line. The first time, it subscribes a Chitthi webhook (`message.received`) to `POST /v1/webhooks/chitthi/<churchId>`. Chitthi's Growth plan is needed for webhooks, and without it the call answers 402 `chitthi_plan`.
- `DELETE /admin/integrations/whatsapp-bot` turns it off and removes the Chitthi webhook.
- `POST /admin/integrations/whatsapp-bot/try` with `{ text }` returns `{ intent, reply }` without sending anything or saving anything.
- The webhook checks the `Chitthi-Signature` header (`t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`, 5 minutes tolerance) with the secret Chitthi returned when the hook was made. It answers 410 when the church is unknown or the assistant is off, so Chitthi stops sending. Replies go out through Chitthi `POST /api/v1/messages` as free text. Customers who message first are inside WhatsApp's 24-hour window, so no template is needed.

## Special offerings (Grow plan)

A campaign (harvest festival, building fund, thanksgiving, mission appeal or other special offering) adds up everything given for it: gifts to its fund between its dates (online or recorded at the counter), numbered family envelopes, in-kind offerings and the auction. Envelope and auction money is recorded as an ordinary gift (`provider: 'offline'`) to the campaign's fund, so it gets an 80G receipt and appears in Giving and Accounts.

- `GET /admin/offerings` lists campaigns with `progress` (`raised`, `gifts`, `envelopes`, `auction`, `inKind`, `givers`, `goal`, `percent`, `auctionUnpaid`). `POST` starts one with `{ name, kind, goal?, startsOn?, endsOn?, description?, showPublic?, fundId? }`. Without `fundId`, a new fund named after the campaign is made.
- `GET|PATCH|DELETE /admin/offerings/:id`. `PATCH { status: 'closed' }` closes it, and nothing more can be recorded. A campaign with money recorded can only be closed, not deleted.
- `POST /admin/offerings/:id/envelopes` numbers one envelope for every family (people grouped by household) that has none yet, or `{ blank: n }` adds blank ones. `POST .../envelopes/:envId/receive { amount, method }` records what came back.
- `POST /admin/offerings/:id/in-kind { donorId? | donorName, item, quantity?, value?, forAuction? }` records produce, gold or livestock. Its value counts in the total until it is sold.
- `POST /admin/offerings/:id/lots { inKindId? | title, bidderId? | bidderName, amount, paidNow?, method? }` records a winning bid. `POST .../lots/:lotId/pay { method }` records the payment.
- Members: `GET /giving/campaigns` returns live public campaigns with progress and the family's envelope. `GET /public/church` includes `campaigns`.

## Privacy and the DPDP Act (every plan)

India's Digital Personal Data Protection Act, 2023 gives people the right to know what the church holds, to correct it, to withdraw consent and to have it erased.

- Every consent change (email, SMS, WhatsApp, directory) is recorded in `consentLog` with who made it: the member, the office, or a STOP/START reply on WhatsApp. `GET /admin/people/:id/consent` lists one person's history.
- Members: `GET /me/privacy` returns their consent, history, requests, the church's notice and its grievance officer. `GET /me/privacy/export` returns everything held about them as JSON (confidential pastoral notes stay out). `POST /me/privacy/requests { kind: 'access' | 'correction' | 'erasure' | 'grievance', details }` opens a request due in 30 days.
- Office: `GET /admin/privacy` returns the settings, requests, counts of people who said no to each channel, people inactive for longer than `reviewAfterMonths`, and children under 18 with their own phone or email. `PUT /admin/privacy/settings { officerName, officerEmail, officerPhone, notice, reviewAfterMonths }`. `POST /admin/privacy/requests` records a request made by phone or letter. `PATCH /admin/privacy/requests/:id { status, response }`; declining needs a reason. `GET /admin/people/:id/export` downloads a person's data.
- `POST /admin/privacy/requests/:id/erase` (owner or admin) erases the person: profile, attendance, RSVPs, serving, groups, prayer requests, form answers, WhatsApp messages and consent history. Gift records stay with the donor's name and PAN only, as the Income Tax Act requires (section 8(7) of the DPDP Act allows this). Church registers stay as permanent records.

## Parent pager (Grow plan, with check-in)

The kids' team can ask a checked-in child's parents to come during the service. The message goes to the adults in the child's household who have a phone number, on WhatsApp (through Chitthi when connected) or SMS when WhatsApp is not set up. It says the child is fine, names the room and asks them to show the pickup code.

- `GET /admin/checkin/checkins/:id/parents` lists who would get it.
- `POST /admin/checkin/checkins/:id/page { reason: 'come' | 'pickup' | 'feeding' | 'custom', note? }` sends it and returns the page with who it reached (`sentTo[].ok`).
- `GET /admin/checkin/:eventId/pages` lists the event's pages. `POST /admin/checkin/pages/:id/resolve` marks that the parent came.
