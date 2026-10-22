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
