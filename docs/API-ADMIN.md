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

Songs take an optional `copyright` line, and songs added from the song database keep `catalogId` (and `licensedFrom` when the words came from a licensed lyrics feed).

### Song database (shared by every church)

Public-domain hymns any church can search and copy into its library. See [SONG-CATALOG.md](SONG-CATALOG.md).

| Method | Path | Needs |
|---|---|---|
| GET | `/admin/song-catalog?q=&lang=&theme=&limit=&offset=` | `services` or `volunteers`. Searches titles, other titles, tunes, writers, themes, then lines of the words. Rows leave the words out and say `inLibrary` (the church's song id) |
| GET | `/admin/song-catalog/:id` | `services` or `volunteers`. The full song with words |
| POST | `/admin/song-catalog/:id/add` | `services`. Copies it into the library, once: `{ song, created, licensed }` |
| GET | `/admin/song-catalog/licence` | `services` or `settings`. The church's CCLI licence numbers and the licensed lyrics feeds on this server |
| PUT | `/admin/song-catalog/licence` | `settings`. `{ ccliLicence, streamingLicence, otherLicences }`, digits only for CCLI numbers |

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

## Digital bulletin

A weekly bulletin built from the next service's plan, recent notices, the coming week's events, birthdays and anniversaries, today's serving teams and the giving link with live special offerings. Permission: `comms`.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/admin/bulletins` | All bulletins, newest Sunday first. |
| POST | `/admin/bulletins` | `{eventId?}`. Drafts one for that service (default: the next service). Sections copy from the last published bulletin. Returns a `BulletinView`. |
| GET | `/admin/bulletins/:id` | `BulletinView`: the bulletin plus `church`, `service`, `order`, `announcements`, `events`, `celebrations`, `serving`, `giving` and `shareUrl`. |
| PATCH | `/admin/bulletins/:id` | Any of `title`, `intro`, `verse`, `date`, `eventId`, `sections` (`order`, `announcements`, `events`, `celebrations`, `serving`, `giving`) and `status` (`draft` or `published`). |
| DELETE | `/admin/bulletins/:id` | |

Members: `GET /bulletins` (last 12 published, `{id, title, date}`), `GET /bulletins/latest` (or `null`), `GET /bulletins/:id`.

Public: `GET /public/bulletins/:id?k=<shareKey>` for the WhatsApp link. Only published bulletins open. Birthdays and serving names are never on the public link, and celebrations only include adults who allow the directory.

## Sunday school

Classes by age, the weekly register, lessons, exams and the annual day prize list. Permission: `checkin`. Plan: Grow.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/admin/sunday-school` | `SsOverview`: classes with attendance, children, teachers, registers taken for the last Sunday, children not in a class, next lesson. |
| POST | `/admin/sunday-school/setup` | Creates Beginners 3–5, Primary 6–8, Junior 9–11, Intermediate 12–14 and Senior 15–17, and places children by age. 409 when classes exist. |
| POST | `/admin/sunday-school/enroll` | Places children who are not in a class into the class for their age. `{placed}` |
| POST | `/admin/sunday-school/promote` | New year: every child moves to the class for their age; children older than the senior class finish. `{moved, graduated}` |
| POST | `/admin/sunday-school/classes` | `{name, minAge, maxAge, roomId?, teacherIds?, studentIds?}`. A child is in one class at a time. |
| GET/PATCH/DELETE | `/admin/sunday-school/classes/:id` | `SsClassDetail` with roster stats (attendance, verses, weeks in a row) over the last 13 registers. |
| GET | `/admin/sunday-school/classes/:id/register?date=` | Defaults to the last Sunday. Before it is saved, children checked in that day are ticked. |
| PUT | `/admin/sunday-school/classes/:id/register` | `{date, present[], verse[], visitors, offering}` (offering in paise). Future dates are refused. |
| GET/POST | `/admin/sunday-school/lessons` | `{date, classId|null, title, scripture, memoryVerse, notes}`. null classId means every class. |
| PATCH/DELETE | `/admin/sunday-school/lessons/:id` | |
| GET/POST | `/admin/sunday-school/exams` | `{name, date, maxMarks, classIds?}` (default: every class). |
| GET/PATCH/DELETE | `/admin/sunday-school/exams/:id` | Results with grade (A+ 90, A 75, B 60, C 45, D) and rank (ties share a rank). PATCH `status: 'published'` shows results to parents. |
| PUT | `/admin/sunday-school/exams/:id/marks` | `{classId, marks: {personId: number | null | ''}}`. null is absent; '' clears. |
| POST | `/admin/sunday-school/exams/:id/send` | Published exams only. Each marked child's result goes to the adults in their household on WhatsApp (SMS when only SMS is set up). `{channel, sent, failed, noParent}` |
| GET | `/admin/sunday-school/prizes?from=&to=` | Per class: top 3 in each published exam, best attendance (at least 75% of Sundays) and most memory verses. Defaults to this calendar year. |

Members: `GET /me/sunday-school` lists the children in the member's household who are in a class, with attendance, memory verses, this week's lesson and published results.

## Missions

Missionaries the church supports, monthly commitments, money received and sent on, and field reports. Read: `giving.view`. Write: `giving.edit` (reports also `comms`). Plan: Grow.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/admin/missions` | `MissionsOverview`: each missionary with committed, gap, received and sent this financial year, balance; totals; supporters who are behind. |
| POST | `/admin/missions` | `{name, field?, organisation?, work?, prayerPoints?, monthlyNeed?, since?, email?, phone?, photoUrl?, showPublic?, fundId?}`. Without `fundId`, makes a fund "Missions · name". |
| GET/PATCH/DELETE | `/admin/missions/:id` | `MissionaryDetail` with support, reports, payouts and 12 months of money in and out. PATCH `status: 'ended'` closes the fund it made. DELETE only when nothing was received or sent (409 otherwise). |
| POST | `/admin/missions/:id/support` | `{personId? or name, amount (monthly, paise), kind?: 'member'|'church', startedOn?}`. One active commitment per person. |
| PATCH/DELETE | `/admin/missions/:id/support/:sid` | PATCH `{amount?, endedOn?, name?}`. `endedOn` is the day it stopped. |
| POST/DELETE | `/admin/missions/:id/payouts[/:pid]` | `{amount, date, method: bank_transfer|upi|cheque|cash, reference?, note?}`. No future dates. |
| POST | `/admin/missions/:id/reports` | `{title, body, prayerPoints, date?, published, send}`. `send` emails supporters who allow email and WhatsApps (or SMSes) the rest; returns `delivery: {sent, failed, unreachable}`. |
| PATCH/DELETE | `/admin/missions/:id/reports/:rid` | |
| POST | `/admin/missions/:id/reports/:rid/send` | Sends (again) to active supporters. |

Support status: `autopay` (an active AutoPay to the fund), `on_track` (gifts to the fund over the last three full months are at least 90% of the commitment), `behind`, `church`, `ended`.

Members: `GET /missions` (active missionaries shown to members, with published news and `mine`), `PUT /missions/:id/support {amount}` to commit or change, `DELETE /missions/:id/support` to stop. Give to a missionary with `/app/give?fund=<fundId>&amount=<rupees>&monthly=1`.

## Offline check-in

A check-in desk keeps working when the church's internet drops. Perm: `checkin`.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/admin/checkin/:eventId/offline` | `OfflinePack`: the event, everyone active (name, household, age, child flag, room, allergies, QR code, last 4 mobile digits), who is already checked in, and who is serving. The web desk refreshes it every 5 minutes and keeps it in localStorage. |
| POST | `/admin/checkin/:eventId/sync` | `{items: OfflineItem[]}` (max 500), each `{clientId, personIds, method, at, code}`. Returns `{results: OfflineSyncResult[]}`. Safe to repeat: an item already synced returns its check-ins unchanged. People checked in meanwhile by another desk come back in `skipped`. The desk's security code is kept so printed labels still match. `at` is used if it is not in the future and not more than a day before the event. Room capacity and "check-in turned off" are not enforced, because the people are already in the building. |

The search, check-in and label logic the desk runs offline is shared with the server in `src/core/offline-checkin.ts` (`offlineSearch`, `offlineCheckIn`, `labelsFor`). Pickups, paging and reprints need the internet.

## Livestream

The church's YouTube live service, embedded on the public church page (`/live`) and in the member app (`/app/live`), with online attendance. Read: `services`, `events` or `comms`. Write: `services` or `events`. Plan: Grow.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/admin/livestream` | `LiveOverview`: settings, the live stream, upcoming and the last 30 past streams with viewers, attended, members, average minutes and peak. Streams nobody ended close themselves 4 hours after they start. |
| PUT | `/admin/livestream/settings` | `{channelId?, countAfterMinutes? (1-60, default 5), publicWatch? (default true)}`. `channelId` takes the UC… id or a youtube.com/channel/UC… link; @handles are refused. |
| POST | `/admin/livestream/streams` | `{url, title?, eventId?, startsAt?}`. Any YouTube link (watch, youtu.be, /live/, /embed/, /shorts/). Title and start time default to the event's. |
| GET/PATCH/DELETE | `/admin/livestream/streams/:id` | `LiveStreamDetail` adds a per-minute viewer timeline and the members who watched. DELETE removes the viewer records too; a headcount already written stays. |
| POST | `/admin/livestream/streams/:id/start` | Marks it live now. A scheduled stream is also live from its start time without this. |
| POST | `/admin/livestream/streams/:id/end` | Counts viewers who watched at least `countAfterMinutes`, writes that as the "Online" headcount of the linked event (replacing an earlier one) and updates the event's attendance. Members who attended get their last-attended date updated. |

Viewers (no staff permission):

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/public/live` | `LiveNow`: the live stream, else the next one within 7 days, plus the channel id. Signed-in members always see it; guests only when `publicWatch` is on. |
| POST | `/public/live/:id/ping` | `{viewer}`: sent once a minute while the video is on screen. Signed-in members are counted by person; guests by the random `viewer` id their browser keeps (8 to 64 letters, digits, `-`, `_`). Returns `{ok, status, watching}`; `ok` is false when the stream is not live. |

## Family accounts

One adult's login looks after the household (everyone with the same household name). Children (under the church's child age limit) cannot use these routes.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/me/family` | `FamilyView`: the household with ages, kids' church room, allergies and medical notes. `editable` is true for children and adults without their own email. |
| POST | `/me/family/members` | `{firstName, lastName?, birthDate, gender?, allergies?, medicalNotes?}` adds a child to the household (surname defaults to the parent's). A family of one becomes "<surname> family". Tagged `added-by-family`. |
| PATCH | `/me/family/members/:id` | Same fields (adults without a login also `phone`). 403 for adults who sign in themselves. |
| GET | `/me/family/checkin` | Services with check-in on that start within a day, at the family's campus: who is in, their codes, and whether phone check-in is `open` (an hour before the start until the end). |
| POST | `/me/family/checkin/:eventId` | `{personIds}` (household only). Checks in with method `app`; children share a new security code, or the code they already have is returned. `{securityCode, checkedIn, event}`. The desk prints labels with `POST /admin/checkin/:eventId/reprint {securityCode}`. |
| GET/PUT | `/admin/checkin-settings` | `{phoneCheckin}` (perm `checkin`, default true). When off, families check in at the desk. |

## Church networks and dioceses

A diocese, denomination or network office signs in at `/network` and sees combined totals for its churches. Each church joins with the network's code and chooses whether to share giving totals. Only totals cross over: never names, contact details or individual gifts. Records live in the platform directory.

Network office (`/v1/networks/*`, its own 14-day session token from `auth/verify`, sent as `Authorization: Bearer`):

| Method | Path | Notes |
|---|---|---|
| POST | `/networks/auth/request` | `{email}` sends a 6-digit code. Returns `{requestId}`. |
| POST | `/networks/auth/verify` | `{requestId, code}` returns `{token, email, expiresAt}`. |
| POST | `/networks/auth/sign-out` | Ends the session. 204. |
| GET | `/networks/mine` | Networks you lead: `{id, name, kind, churches}[]`. |
| POST | `/networks/new` | `{name, kind?}` (`network`, `diocese`, `denomination`, `association`). You become its first leader. |
| GET | `/networks/:id` | Overview: `network` (with `code`, `admins`), `churches[]` (people, members, households, newPeople90, groups, inGroups, serving, baptismsThisYear, lastSunday, avgAttendance, attendanceChange, attendance, giving12m/givingByMonth or null when not shared, onlineLastStream), `totals`, weekly `attendance` (a latest week that fewer churches have recorded is left out) and `giving` in the most common currency. 404 unless you lead it. |
| PATCH | `/networks/:id` | `{name?, kind?, admins?}`. The admins list must keep you. |
| DELETE | `/networks/:id` | Deletes the network and all memberships. 204. |
| POST | `/networks/:id/code` | New join code; the old one stops working. Returns the overview. |
| DELETE | `/networks/:id/churches/:churchId` | Removes a church. Returns the overview. |

Church office (perm `settings`, audited):

| Method | Path | Notes |
|---|---|---|
| GET | `/admin/networks` | `{available, networks: {id, name, kind, joinedAt, shareGiving, churches}[]}`. `available` is false on a server without the directory. |
| GET | `/admin/networks/preview?code=` | `{id, name, kind, churches}` or 404 for a wrong code. Codes are not case-sensitive. |
| POST | `/admin/networks/join` | `{code, shareGiving}`. Joining again keeps the first join date. |
| PATCH | `/admin/networks/:id` | `{shareGiving}`. |
| DELETE | `/admin/networks/:id` | Leaves the network. 204. |

## Team app logins (volunteers' mobile app)

The mobile app is for team members only: no church members or guests sign in there. The church office creates each login; the person gets a 12-character temporary password by email and must choose their own at first sign-in. At sign-in they pick the team they are on, and the app shows only that person's own assignments for that team. Passwords are stored with scrypt (salted, slow). Tokens have the `member` scope, so the office stays closed to them.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/team/teams` | Public, honours `X-Church`. `[{id, name, color}]` for the team picker. |
| POST | `/auth/team/sign-in` | `{email, password, teamId}` → `Session & {team: {id, name}, mustChangePassword}`. 401 `invalid_credentials` (same for unknown email and wrong password), 403 `not_on_team`, 403 `login_disabled`, 429 `too_many_attempts` after 5 wrong passwords in 15 minutes. |
| POST | `/auth/team/password` | Signed in. `{currentPassword, newPassword}` (8+ characters) → 204. |
| POST | `/auth/team/forgot` | `{email}` → `{sent: true}` always; emails a 6-digit code (15 minutes) when a login exists. Demo code 123456. |
| POST | `/auth/team/reset` | `{email, code, newPassword, teamId}` → a Session as for sign-in. 422 `invalid_code`, 429 after 5 wrong codes. |
| GET | `/me/serving?teamId=` | As before, filtered to that team when given. |
| GET | `/admin/team-logins` | Perm `volunteers` or `staff`. `[{personId, name, email, teams, mustChangePassword, disabled, createdAt, lastSignInAt}]`. |
| POST | `/admin/team-logins` | `{personId}`. The person needs an email and a team. Emails the temporary password. 409 when a login already exists. |
| POST | `/admin/team-logins/:personId/reset` | Emails a new temporary password and re-enables the login. |
| DELETE | `/admin/team-logins/:personId` | Switches the login off and revokes the person's app sessions. |

Demo: the demo member (`priya@example.com`) has a login with password `demo1234` and no forced change.

## Door QR attendance

A leader opens the door code on their phone at the entrance (Check-in › Door QR). Members scan it with their camera; the link opens the Flockwise app at `/app/door?e=<eventId>&t=<token>`, which marks them (and any family members they tick) present. The code changes every minute and is tied to the event; it is accepted for three minutes after it was shown. Each scan is a normal check-in with method `qr`.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/admin/checkin/:eventId/door` | Perm `checkin`. `{token, path, rotatesInSeconds, present, scanned, recent: [{name, at}]}`. Poll it to keep the QR fresh. |
| GET | `/door/:eventId?t=` | Signed in (member scope, so the team app works too). The family check-in view for this event. 410 `door_expired` for an old or wrong code, 422 `not_open` outside three hours before to one hour after the event. |
| POST | `/door/:eventId` | `{token, personIds?}` (defaults to the signed-in person) → `FamilyCheckinResult`. Scanning twice does not double count. |

## Plans (22 Oct 2026)

Priced at half of Elvanto for the same number of people, with no setup fee. Seed free up to 50 people; Grow ₹7,999 / $99 (500 people); Thrive ₹13,999 / $169 (2,500); Cathedral ₹16,999 / $199 (unlimited). Yearly is ten months. Source of truth: `src/core/plans.ts`.

## The church's own mailbox

Settings › Integrations › Email. The office connects a mailbox (Gmail or Google Workspace with an app password, Outlook, Hostinger mail, or any SMTP server). From then on every email for that church, sign-in codes included, leaves from that address. The password is sealed and never returned. Connecting sends one test email to the person connecting it, and fails if the mailbox refuses.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/admin/integrations` | Now also returns `email: {connected, host, port, user, from, fromName, connectedAt, lastError, lastSentAt}`. |
| POST | `/admin/integrations/email` | `{host, port (465 or 587), user, password, from, fromName?}`. 422 `smtp_failed` when the test send fails. Omit `password` to keep the saved one. |
| POST | `/admin/integrations/email/test` | `{to?}` → `{ok: true}`. |
| DELETE | `/admin/integrations/email` | Back to the server's shared sender. |

## Automatic notifications and push

Settings › Notifications. For each kind the office picks email, push (the member and team apps) and WhatsApp (through Chitthi). Kinds: `rota.assigned` (the volunteer), `event.changed` (people who RSVPed or are serving, only when the time or place changes), `announcement.published` (everyone, push only by default), `prayer.new` and `visitor.new` (pastors and care team), `care.assigned` (the assigned team member), `door.scanned` (other adults in the household). The person whose action caused it is not told. Failures never break the action.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/admin/notifications` | Perm `settings`. `{rules: [{kind, label, description, audience, rule: {email, push, whatsapp}, sentCount}], devices: {member, team}, emailFrom}`. |
| PUT | `/admin/notifications/:kind` | `{email, push, whatsapp}` → the same view. |
| POST | `/me/devices` | From the apps: `{token, platform: 'android'|'ios'|'web', app: 'member'|'team'}`. A token belongs to one person; registering again refreshes it. |
| DELETE | `/me/devices?token=` | On sign-out. Without `token`, all of the person's phones. |

Push goes through Expo (`https://exp.host/--/api/v2/push/send`; `EXPO_ACCESS_TOKEN` env is optional). A `DeviceNotRegistered` answer removes the phone. Each message carries `data: {kind, link?}` for deep links.

## Brand kit

The church's logo always appears beside its name: in the church office sidebar, the member app header, the public page, bulletins, certificates, the projector's logo screen, invitations and on every email (a letterhead in the brand colour is wrapped around the plain text automatically; callers only write the text).

- `Church.logoUrl` (in every session and `GET /public/church`) is the logo; `Church.brand` is the kit: `{ primary: '#rrggbb', accent: '#rrggbb', font: 'modern' | 'classic' | 'rounded' | 'elegant', logoDarkUrl: string | null, tagline: string }`. Apps use `primary` for buttons and headers, `accent` for highlights, `logoDarkUrl` on dark backgrounds.
- `PATCH /admin/settings` (perm `settings`) takes `logoUrl` (a URL or a data URL under about 300 KB; the web app shrinks uploads to 512 px) and `brand` (partial; missing fields keep their saved values; `brand: null` removes the kit). Colours must be 6-digit hex.
- `Outgoing.html`: the engine fills it for email from the church settings (`brandedHtml` in `core/mail.ts`); hosts send `text` and `html` together.

## Connections: Zoom, Google Cloud Storage, Canva

`GET /admin/integrations` now also returns `zoom`, `gcs` and `canva` statuses (`ConnectionsStatus`). Credentials are sealed; the demo has stand-ins (anything containing "bad" fails).

**Zoom** (a Server-to-Server OAuth app in the church's Zoom account, scopes `user:read:user:admin` and `meeting:write:meeting:admin`):
- `POST /admin/integrations/zoom` `{accountId, clientId, clientSecret}` (perm `settings`): fetches a token and the account user to prove the details; `DELETE` disconnects.
- `POST /admin/events/:id/zoom` (perm `events`): creates a scheduled meeting (join before host, no waiting room) and sets `event.meetingUrl` plus `event.zoom {meetingId, joinUrl, startUrl, passcode}` (office only). `DELETE /admin/events/:id/zoom` deletes the meeting and clears the link. Any link (Google Meet, YouTube) can also be typed into `meetingUrl` through `PATCH /admin/events/:id`; members see `meetingUrl` on `ChurchEvent`.

**Google Cloud Storage** (the church's own bucket; a service account with Storage Object Admin on it):
- `POST /admin/integrations/gcs` `{bucket, serviceAccount}` (the JSON key file as a string): checks the key and the bucket, records whether `allUsers` can read (`publicRead`); otherwise links are V4-signed for a week. `DELETE` disconnects (files stay).
- Media library (perm `comms`): `GET /admin/media?folder=` → `{data: MediaItem[], gcs}`; `POST /admin/media/uploads` `{name, contentType, size, folder}` → `{item, uploadUrl, headers}`: the browser `PUT`s the file to `uploadUrl` with those headers (15-minute signed URL), then `POST /admin/media/:id/complete`. `DELETE /admin/media/:id` removes the object too. Folders: general, sermons, events, kids, brand. Objects are stored as `<churchId>/<folder>/<yyyy-mm>/<id>-<name>`.
- Server side: `src/google.ts` (RS256 JWT for tokens, V4 signed URLs). Env hooks `http`, `google`.

**Canva** (needs `CANVA_CLIENT_ID` and `CANVA_CLIENT_SECRET` from a Canva Connect app whose redirect URL is `<API_PUBLIC_URL>/v1/integrations/canva/callback`, scopes asset:read/write, design:content:read/write, design:meta:read, profile:read):
- `GET /admin/integrations/canva/connect` → `{url, state}`: send the browser there (PKCE). Canva returns to the host route, which calls the church's public `POST /integrations/canva/callback` and redirects to `/admin/settings?canva=connected#integrations` (or `canva=error&reason=`). Tokens are refreshed automatically. `DELETE /admin/integrations/canva` disconnects.
- `POST /admin/canva/designs` `{kind: invitation|social|story|poster|bulletin|slide, title, imageDataUrl?}` (perm `comms`): uploads the picture as a Canva asset (when given) and creates a design of that size starting from it; returns `CanvaDesign {id, title, editUrl, viewUrl, thumbnailUrl, kind, createdAt}`. `GET /admin/canva/designs` lists the ones opened from Flockwise.

## Prayer chain and the "we miss you" check-in

**Prayer chain.** Members opt in from Prayer in the app (`PATCH /me/preferences { prayerChain: true }`), by replying `JOIN PRAYER CHAIN` on WhatsApp, or the office ticks "On the prayer chain" on the person. `GET /admin/prayer/chain` lists them. `POST /admin/prayer/:id/chain` (care permission) sends the request to everyone on the chain through the `prayer.chain` notification rule (push + WhatsApp by default, email optional) and records `chainSentAt` / `chainCount` on the request. Pastors-only requests go out with the first name only. A WhatsApp reply of `PRAYED`, `Amen` or 🙏 within a week counts on that request (`prayedBy`), the same as "I prayed" in the app; `LEAVE PRAYER CHAIN` opts out.

**We miss you (two-way).** The `missing` automation gained `askReply` (default on, WhatsApp only) and `assignLeader` (default on). With `askReply` the message ends "Reply 1 if all is well, 2 if you are travelling, or 3 if you would like someone to call you", and the assistant turns the reply into a note on the person's open care case: 1 closes it, 2 pushes the due date out three weeks, 3 marks it urgent and notifies the assignee (or the pastors). With `assignLeader` the case is assigned to the first of the person's zone leaders who has an active office login, who is notified through `care.assigned`.

## Musician view and the OBS scene plan

**Musician view** `/present/:eventId/band` (also with `?key=<screenKey>`, no sign-in): the whole chart of the current item on a phone or tablet, in the key the plan says, with the page turning as the presenter moves the slides. The presentation view now carries `charts: BandItem[]` (one per plan item: chart text, song key, plan key, bpm, arrangement, `hasChords`). Each player's transpose, capo, chords/words/numbers and text size stay on their device (`localStorage` `fw.band.v1`, per-item extra transpose in `fw.band.steps.<eventId>`). Tap any section to read ahead; "Back to live" rejoins the leader. Arrow keys / PageUp / PageDown move items, L rejoins.

**OBS scene plan** (`GET/PUT /admin/presentation-obs`, perms `services` or `settings`): `ObsSettings = { scenes: { [moment]: sceneName }, autoSwitch, lyricsOnSongs }` where a moment is a plan-item kind, `countdown` or `blank` (`OBS_MOMENTS` in types). Stored in church settings `obs`, returned in the presentation view as `obs`. The presenter's browser (obs-websocket v5, `src/present/obs.ts`) switches to the planned scene whenever the moment changes or OBS connects, if the scene exists in OBS; a manual pick stays until the next moment, and the desk can untick "Scenes follow the plan" for the service. `lyricsOnSongs` turns the overlay lyrics bar on when a song comes up and off after, without needing the WebSocket connection. Settings › Integrations › OBS Studio holds the plan and the setup steps (Browser Source overlay link, WebSocket server, scene names).

## Custom roles and scoped access

A church can make its own roles (Settings › Team › "Roles this church made"): `CustomRole = { name, description, permissions: Permission[], scope: 'church' | 'zone' | 'group' | 'team' }`. Routes `GET /admin/roles` (perm staff or people.view; each row carries `holders`), `POST /admin/roles`, `PATCH /admin/roles/:id`, `DELETE /admin/roles/:id` (409 `in_use` while someone holds it). `PERMISSION_INFO` and `ROLE_SCOPES` in types list the labels and hints the UI shows.

A staff login is either a built-in role (`role`) or `role: 'custom'` with `roleId` and `scopeIds` (the zones, groups or teams it covers; required unless the role reaches the whole church). `POST /admin/staff` and `PATCH /admin/staff/:id` take `{ role }` or `{ roleId, scopeIds }`; `GET /admin/staff` returns `StaffView` with `roleName`, `scopeKind`, `scopeNames`, `permissions`. From a person's record: `GET /admin/people/:id/access` and `PUT /admin/people/:id/access` with `{ role }`, `{ roleId, scopeIds }` or `{ role: null }` to take access away (needs the person's email; the invite email goes there).

Permissions come from `permsOf(db, staff)` (built-in table or the custom role; a deleted role gives nothing). Scope comes from `scopeOf(db, staff)` → `ctx.scope` and `ctx.inScope(personId)`. A scoped login sees only its people in `/admin/people` (403 on a person outside), care cases, celebrations, and only its own zones (plus their units), groups or teams in those lists. Giving, settings and team access are church-wide when granted. Sessions carry `staff.roleName` and `staff.scope`. Test: `test/roles.test.ts`.

## Plans page, feature matrix and add-ons

`GET /admin/billing` now also returns `addons`: `ai` (`credits` per pack, `price` in the church's currency, `extraThisMonth`, `packsThisMonth`, `online`) and `razorpaySetup` (`price`, `status`, `available` = INR churches). `FEATURES` in `core/plans.ts` is the full feature matrix (group → items with the lowest plan `from`); the web plans page renders it as a table with the current plan highlighted, and shows all four plans to every church, founding churches included (their buttons are replaced by "included in your founding plan"). Moving down is allowed from the same page; features above the new plan lock at once, nothing is deleted.

**AI credit pack** (`POST /admin/billing/ai-pack`, perm settings): `AI_PACK` = 500 credits for ₹499 / $9, valid for the current month. Demo adds them at once; online it creates a one-time Razorpay payment link with `notes.kind = 'ai_pack'`, and `/webhooks/billing` `payment_link.paid` calls `markAiPackPaid` which adds the credits to meta `ai-extra:<month>`. `GET /admin/ai/status` and the meters count plan credits + extra.

## Team hub: notices, threads and tasks

The office and the serving teams share one hub. Every serving team has a channel (`hub_team_<teamId>`, made the first time anyone looks), the office has `hub_staff`, and anyone can start a smaller custom thread, optionally tagged to a team so it also shows in that team's app. People are addressed by a **hub key**: `p:<personId>` for anyone with a person record (volunteers, and office logins linked to a person) or `s:<staffId>` for office logins without one.

Post kinds: `message` (chat; `@First` or `@First Last` mentions tell that person), `notice` (pinned on top, everyone in the channel is told), `task` (`task: { assigneeKey, dueAt }`; the assignee is told and sees it under their tasks). Volunteers can post notices only on threads they started or if they lead the team; otherwise a `notice` is saved as a `message`.

Office (staff token):

- `GET /admin/team-hub` → `HubView { me, channels: HubChannelView[], tasks: MyTask[], people: HubMember[] }`. `unread` counts posts since the person last opened the channel.
- `POST /admin/team-hub/channels { name, memberKeys: HubKey[], teamId? }` → custom thread. `PATCH /admin/team-hub/channels/:id { name?, memberKeys?, archived? }` (custom threads only).
- `GET /admin/team-hub/channels/:id?cursor=` → `HubChannelDetail { channel, pinned: HubPost[], posts: HubPost[] (newest first, 50 a page), nextCursor }`; opening marks it read.
- `POST /admin/team-hub/channels/:id/posts { kind, text, pinned?, task? }` → `HubPost`.
- `PATCH /admin/team-hub/posts/:id { text?, pinned?, done? }` (text by the writer or owner/admin/pastor; `done` by the assignee, the writer or the office). `DELETE /admin/team-hub/posts/:id`.

Team app (member token; every route checks the person is on that team, else 403):

- `GET /team/:teamId/notices` → `HubPost[]` (notices and pinned posts, newest first).
- `GET /team/:teamId/threads` → `HubChannelView[]`: the team channel first, then custom threads on that team the person is in. `POST /team/:teamId/threads { name, memberKeys }` starts one with team mates.
- `GET /team/:teamId/threads/:id/messages?cursor=` → `HubChannelDetail`. `POST /team/:teamId/threads/:id/messages { kind?, text, task? }` → `HubPost`.
- `GET /me/tasks` → `MyTask[]` (open first, then by due date; each carries `channelName` and `teamId`). `PATCH /me/tasks/:id { done }` ticks the person's own task.

Push kinds and the link they carry (`data.link`): `team.notice` and `team.message` → `/app/team/<teamId>/threads/<channelId>` (or `/app/team/threads/<channelId>` for a thread with no team); `task.assigned` → `/app/tasks/<postId>`. Email goes out for notices and tasks by default; rules are editable in Settings › Notifications. Office logins without a person record are emailed directly.

## Indian-script lyrics in English letters (transliteration)

`src/core/transliterate.ts` turns Telugu, Hindi/Marathi (Devanagari), Tamil, Kannada, Malayalam, Bengali, Punjabi (Gurmukhi), Gujarati and Odia text into plain English letters the way Indian song sheets write them ("Yesu nannu preminchenu", "Sthuthi sthuthi yesayyaa", "Prem karo ek doosare se"). It is deterministic and offline: one table over the shared Brahmic Unicode layout, with per-script rules (Hindi-family words drop the final "a", southern "ta" is "th", Tamil softens k/ch/t/p between vowels, anusvara is "m" before lip sounds and at the end of southern words). Exports: `transliterate(text)` (keeps `[Section]` headings and blank lines), `transliterateLine`, `transliterateLines`, `hasIndic`, `scriptOf`.

- `PresentationTheme.transliterate` (default off; `PUT /admin/presentation-theme { transliterate: true }`). When on, every lyrics or text `Slide` carries `roman: string[]` (one entry per line, empty when the lines are already Latin). The projector shows each romanised line under its line, the stage display and the livestream lyrics bar show them joined with " / ".
- Song form: when the projector lyrics are in an Indian script, a button fills the second-language lyrics with the English-letter version so the office can tidy it by hand.
- Demo songs sg_4 (Yesu Raja, Telugu) and sg_7 (Mahima Ho, Hindi) have short original lyrics for trying it. Tests: `test/transliterate.test.ts`.

## WhatsApp by Chitthi on the plan (bundle)

`CHITTHI_ADDON` in `core/plans.ts`: ₹999 / $12 a month (ten months when yearly), included from Cathedral (`chitthiIncluded(plan)`). `Subscription.chitthi` marks it on the subscription; `priceFor(plan, currency, interval, chitthi)` adds it, so one Razorpay subscription carries plan + add-on (`BillingCheckout.addons = ['chitthi']` → Razorpay plan name `Flockwise grow+chitthi (monthly)`, notes `chitthi: '1'`; the webhook passes it to `applyBillingEvent`, which also cancels the previous provider subscription when a new one replaces it).

- `GET /admin/billing` → `addons.chitthi { price, includedFrom, included, on, setup: ChitthiSetup | null, connected }`.
- `POST /admin/billing/chitthi { on: true, phone, businessName }` records the request (`integrations/chitthiSetup`, status `requested`) and, unless the plan includes it or the church is founding, re-checks out the current plan with the add-on (demo: at once). Seed gets 409. `{ on: false }` cancels the request and removes the add-on (online: a checkout without it). `POST /admin/billing/checkout { plan, interval, chitthi? }` carries the add-on on a plan change.
- Flockwise team (`/platform/chitthi-setups`, page /platform/whatsapp): `GET` lists every church's request with plan, number, business name and whether Chitthi is connected; `PATCH /platform/chitthi-setups/:churchId { status?, teamNote?, apiKey? }`. An `apiKey` is checked with Chitthi and stored sealed through `connectChitthi()` (shared with the office's own connect route), which marks the setup `ready`; the church then sends WhatsApp through its own workspace with nothing else to do. Overview shows `chitthiSetupsOpen`.
- Code: `core/modules/chitthi-setup.ts`, `billing.ts`, `platform.ts`; web `admin/pages/billing.tsx` card + modal, `platform/team.tsx` ChitthiSetups. Tests: `test/chitthi-bundle.test.ts`.

## Christmas carol rounds: houses, routes, teams, timing

`core/modules/carols.ts`. One season a year (`CarolSeason`: dates, `startTime`, `minutesPerHouse`, `travelMinutes`, `housesPerNight`, `offDays` (0 = Sunday), `fundId`, `message`). Homes are households (`familyKey` from zones: `h:<household>` or `solo:<personId>`); each night is one team's route with an arrival time per house worked out from the pace, and a Google Maps directions link over the addresses. Offerings taken at the door are recorded as cash gifts to the season's fund with a receipt number (a correction records the difference), so the giving ledger matches the stops. The night before a visit, every adult in the household gets `carol.visit` (email, push and WhatsApp by default; link `/app/carols`) from the daily jobs.

- Office (`perm: care` to change, `people.view`/`care`/`services` to read): `GET /admin/carols` → `{ season: CarolSeasonView | null, seasons, zones[{id,name,homes}], teams, funds, currency }`; `GET /admin/carols/seasons/:id`; `POST /admin/carols/seasons { from, to, name?, startTime?, minutesPerHouse?, travelMinutes?, housesPerNight?, offDays?, fundId?, message? }`; `PATCH`/`DELETE /admin/carols/seasons/:id` (a new pace moves every arrival time; delete removes nights and requests).
- `POST /admin/carols/seasons/:id/plan { zoneIds, teamIds, onlyRequests? }` builds the routes: every home in the zones plus every home that asked (requesters first, then by address), `housesPerNight` to a night, teams round-robin, dates round-robin over the season's nights. Nights that already have a visited, not-home or skipped stop are kept; the rest are rebuilt.
- Nights by hand: `POST /admin/carols/seasons/:id/nights { date, teamId?, startTime?, area? }`; `PATCH /admin/carols/nights/:id { date?, startTime?, teamId?, area?, notes?, order?: familyKey[] }` (reorder = new ETAs); `DELETE /admin/carols/nights/:id`; `POST /admin/carols/nights/:id/stops { personId | familyKey }`; `DELETE /admin/carols/nights/:id/stops/:key`; `PATCH /admin/carols/nights/:id/stops/:key { status?: planned|visited|not_home|skipped, offering?: minor|null, note? }` → `CarolNightView` (`total`, `visited`, `offering`, `mapsUrl`).
- Member app: `GET /me/carols` → `MyCarols { season | null, visit { date, eta, teamName, status } | null, request | null, dates }` (`dates` are the nights a household may pick); `POST /me/carols/request { preferredDates (≤5, off days dropped), note }`; `DELETE /me/carols/request`.
- Team app (any member of the team): `GET /team/:teamId/carols` → `{ season, nights: CarolNightView[] }` for that team only; `PATCH /team/:teamId/carols/:nightId/stops/:key { status?, offering?, note? }` marks the door from the phone. Other teams get 403.
- Web: `/admin/carols` (season card, waiting list, Plan routes modal, night cards with ETA, status buttons, offering in rupees, move up/down, add a home by search, route map); member `/app/carols` with a home quick link. Tests: `test/carols.test.ts`.
