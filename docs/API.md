# Flockwise member API (v1)

What the member apps (Android/iOS and the web member portal at `/app`) call. The backend in
`flockwise-api` implements all of it; the same engine (`src/core`) also runs in the browser as the
demo backend, so demo and production behave the same. Shapes are in `src/core/types.ts`.

Church office endpoints are in [API-ADMIN.md](API-ADMIN.md).

## Conventions

- **Base URL**: `https://api.flockwise.church/v1`. Apps only need this one setting (`VITE_API_URL`, `EXPO_PUBLIC_API_URL`).
- **Format**: JSON in and out.
- **Auth**: `Authorization: Bearer <accessToken>` on everything except `/auth/*`. Access tokens last 1 hour; refresh tokens rotate on every use.
- **Tenancy**: the church comes from the token. Apps never send a church id.
- **Money**: integers in minor units (paise) plus ISO 4217 `currency`.
- **Time**: ISO 8601 UTC. Dates without time (`from`, `to`, `endDate`) are `YYYY-MM-DD`.
- **Lists**: `{ "data": [...], "nextCursor": "20" | null }`. Pass `?cursor=` for the next page.
- **Errors**: non-2xx with `{ "error": { "code", "message", "fields"? } }`. `message` is safe to show. On `401`, call `/auth/refresh` once, then sign out if that fails.

## Sign-in (email only)

Codes are sent **by email only**, never SMS or WhatsApp.

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/auth/otp/request` | `{ email, audience? }` | `{ requestId, channel: "email", expiresInSeconds }` |
| POST | `/auth/otp/verify` | `{ requestId, code }` | `Session` |
| POST | `/auth/refresh` | `{ refreshToken }` | `Session` |
| POST | `/auth/sign-out` | `{ refreshToken }` | `204` |

- `audience` is `"member"` (default) or `"admin"` (church office; the email must belong to an invited staff member, else `404 not_staff`).
- A value that is not an email returns `422 email_required` with `fields.email`. The legacy field name `identifier` is still accepted.
- Codes are 6 digits, valid 10 minutes, 5 attempts. Requests are limited per email per hour (`429 too_many_codes`); 5 wrong codes gives `429 too_many_attempts`.
- A member email that is not on the church's list creates a **visitor** record, so newcomers can sign in.
- `Session` = `{ accessToken, refreshToken, expiresAt, member: Member, church: Church }`.
- Demo mode: any email, code `123456`.

## Me

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/me` | | `Member` |
| PATCH | `/me` | `{ firstName?, lastName?, email?, phone?, language? }` | `Member` |
| GET | `/me/preferences` | | `{ consent: { email, sms, whatsapp, directory }, checkinCode, campusId }` |
| PATCH | `/me/preferences` | `{ consent?: Partial<Consent>, campusId? }` | same |
| GET | `/me/checkin-code` | | `{ code, qr, name }`. Render `qr` (e.g. `FW1:PRIYA7K2`) as a QR code; the welcome desk and kiosk scan it. |
| POST | `/me/devices` | `{ token, platform: "ios"\|"android" }` | `204`. Expo push token (accepted now, push sending comes later). |
| GET | `/campuses` | | `Campus[]` |

`language` is one of `en, hi, ta, te, ml, kn`.

## Home and events

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/home` | | `{ nextService, announcements, upcomingEvents }` |
| GET | `/events` | `?cursor` | `Paginated<ChurchEvent>` |
| GET | `/events/:id` | | `ChurchEvent` |
| PUT | `/events/:id/rsvp` | `{ status: "going"\|"not_going" }` | `ChurchEvent`. Paid events return `402 payment_required`; use the ticket endpoint. |
| POST | `/events/:id/ticket` | | `{ donationId, checkoutUrl }`. Open `checkoutUrl` (Razorpay). A paid ticket counts as an RSVP. `409 already_paid` if bought. |
| POST | `/events/:id/check-in` | | `ChurchEvent` with `checkedIn: true`. Allowed from 1 hour before start until the end (`422 not_open`). Children are checked in at the kids' desk (`422 child`). |

`ChurchEvent` adds `price` (paise, null/0 = free), `campusName`, `checkedIn`.

## Groups

| Method | Path | Returns |
|---|---|---|
| GET | `/groups` | `Paginated<Group>` with `membership: "member"\|"requested"\|"none"` |
| POST | `/groups/:id/join-requests` | `Group` |

## Giving (Razorpay)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/giving/funds` | | `Fund[]` |
| POST | `/giving/intents` | `{ fundId, amount, currency, frequency: "once"\|"monthly", donorCitizenship: "IN"\|"OTHER", pan? }` | `{ donationId, checkoutUrl }` |
| GET | `/giving/donations` | `?cursor` | `Paginated<Donation>` |
| GET | `/giving/statement` | `?financialYear=2026-27` | `GivingStatement` (gifts, `total`, `eligible80g`, church PAN and 80G number) |
| GET | `/giving/pledges` | | `PledgeView[]` (`amount`, `given`, `endDate`) |
| POST | `/giving/pledges` | `{ fundId, amount, endDate, startDate? }` | `PledgeView` |
| DELETE | `/giving/pledges/:id` | | `204` |

Open `checkoutUrl` in the browser. After paying, Razorpay returns the donor to the web Give page
(`?payment=success|cancelled`); the webhook marks the donation succeeded. Foreign donors
(`donorCitizenship: "OTHER"`) are routed to the FCRA account, or refused with `422 fcra_not_registered`.
80G: cash above ₹2,000, FCRA gifts and non-deductible funds are not eligible.

## Serving

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/me/serving` | | `{ assignments: [...{ event, teamName, positionName, status, plan: PlanItem[] }], teams, blockouts }` |
| POST | `/me/serving/:id/respond` | `{ status: "accepted"\|"declined", note? }` | `Assignment` |
| POST | `/me/blockouts` | `{ from, to, reason? }` | `Blockout` |
| DELETE | `/me/blockouts/:id` | | `204` |

`status` of an assignment is `pending`, `accepted` or `declined`. `plan` is the order of service once the worship leader has planned it.

## Prayer wall

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/prayer` | | `Paginated<PrayerView>`: church-wide requests plus your own private ones |
| POST | `/prayer` | `{ text, visibility: "church"\|"pastors" }` | `PrayerView` |
| POST | `/prayer/:id/pray` | | `PrayerView` (`iPrayed: true`, `prayedCount` +1) |
| PATCH | `/prayer/:id` | `{ status: "open"\|"answered", answeredNote? }` | `PrayerView` (own requests only) |

## Directory

| Method | Path | Returns |
|---|---|---|
| GET | `/directory?q=` | `Paginated<DirectoryEntry>` grouped by household. Only people who opted in are listed. Returns `403 directory_opt_in` until the caller turns on `consent.directory`. |

## Error codes the apps should expect

`invalid`, `email_required`, `not_staff`, `too_many_codes`, `too_many_attempts`, `invalid_code`, `code_expired`,
`unauthorized`, `forbidden`, `not_found`, `payment_required`, `already_paid`, `ticket_paid`, `fcra_not_registered`,
`directory_opt_in`, `not_open`, `child`, `full`.
