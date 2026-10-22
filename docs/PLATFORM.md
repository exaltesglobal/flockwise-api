# Many churches, sign-up, plans and the team panel

One API server hosts every church. Each church has its own records (rows in `records` with its
`church_id`), loaded into memory at start-up. The directory of churches, team sign-in codes and team
actions are stored the same way under the church id `_platform`.

## Which church a request is for

1. A signed-in request: the church in the access token (tokens are issued per church).
2. An API key: keys look like `fw_live_<church id>.<secret>`. Older keys without a church belong to
   the first church.
3. Otherwise the `X-Church` header (or `?church=`), with the church's address (slug) or id.
4. Nothing: the server's first church (`CHURCH_ID`), so existing apps keep working.

The web app keeps the church in the browser. A link like `app.flockwise.church/c/grace/app/events`
selects the church `grace` and opens `/app/events`. Links in emails from a church use this form.

## Public endpoints

| | |
|---|---|
| `GET /v1/churches/:slug` | Name, city and logo for the sign-in screen |
| `POST /v1/churches/find` `{email}` | Emails the churches that use this address (always answers `{sent:true}`) |
| `GET /v1/signup/slug?slug=&name=&city=` | Is the address free, and a suggestion |
| `POST /v1/signup/start` `{email}` | Emails a 6-digit code |
| `POST /v1/signup/complete` `{requestId, code, churchName, ownerName, city, country, slug, phone?}` | Creates the church with a 30-day trial and returns `{church, session}` (the owner is signed in) |

## Plans (`src/core/plans.ts`)

Seed (free), Grow, Thrive and Cathedral, with prices, limits (people, office logins, campuses, AI
credits) and the part of the church office each plan opens. The engine answers `402 plan_required`
or `402 plan_limit` with the plan needed. A church with no subscription record is a founding church
with everything open.

| | |
|---|---|
| `GET /v1/admin/billing` | Plan, trial days left, usage against limits, the plans with prices in the church's currency |
| `POST /v1/admin/billing/checkout` `{plan, interval}` | Returns `checkoutUrl` (Razorpay subscription on Flockwise's account) |
| `POST /v1/admin/billing/cancel` | Cancels at the end of the paid period |
| `GET/POST/DELETE /v1/admin/settings/payments(/razorpay)` | The church's own Razorpay keys for gifts |

`POST /v1/webhooks/billing` applies Razorpay subscription events (notes carry `church_id`, `plan`,
`interval`).

## Flockwise team panel (`/v1/platform/*`)

Team members are listed in `PLATFORM_ADMINS` and sign in with an email code
(`POST /platform/auth/request`, `/platform/auth/verify` returns a 12-hour token sent as `Bearer`).

| | |
|---|---|
| `GET /platform/overview` | Churches, active, trials, paying, MRR/ARR by currency, plans, sign-ups by week, trials ending, failed renewals, AI and message usage |
| `GET /platform/churches?q=&plan=&status=` | All churches with plan, people, logins, last active, MRR |
| `GET /platform/churches/:id` | Detail, office team, recent church activity, team notes and log |
| `PATCH /platform/churches/:id` `{status, notes, name, slug}` | Pause (`suspended`) or restore, notes |
| `POST /platform/churches/:id/subscription` `{plan, status, trialDays, peopleLimit, founding, periodEnd}` | Change plan, extend a trial, custom limits |
| `POST /platform/churches/:id/open` `{reason}` | Support access: a church office session as the owner. Written to the church's own activity log |
| `GET /platform/audit` | Every team action |
