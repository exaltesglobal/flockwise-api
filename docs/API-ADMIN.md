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
