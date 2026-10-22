# Flockwise: API keys and environment variables

Every setting the three apps read, where each value comes from, and where to type it.
**Never paste secret values into chat, email, GitHub or a committed file.** Type them
straight into hPanel (or EAS) yourself.

Status column is as of 22 Oct 2026 (Hostinger shows values masked, so "set" means the key exists).

## Where to type them

- **API and web app (Hostinger):** hPanel > Websites > pick the site (`api.flockwise.church`
  or `app.flockwise.church`) > Node.js / Deployments > **Environment variables**. Add or edit
  a key, Save, then click **Redeploy**.
  - API: the server reads them at start, so a restart/redeploy is enough.
  - Web app: `VITE_*` values are baked in at build time, so it must be **rebuilt** (Redeploy) after any change.
- **Mobile app (Expo/EAS):** nothing secret. Values live in `eas.json` per build profile. If you
  ever need an override, use expo.dev > project > Environment variables, or `eas env:create`.

---

## 1. API (`api.flockwise.church`)

### Required to start (production refuses to start without these)

| Variable | Status | Value / where to get it |
|---|---|---|
| `NODE_ENV` | set | `production` |
| `PORT` | not set (fine) | Hostinger provides it; leave unset |
| `API_PUBLIC_URL` | set | `https://api.flockwise.church` |
| `WEB_URL` | set | `https://app.flockwise.church` (only origin allowed by CORS) |
| `CORS_ORIGINS` | set | Extra web origins, comma separated. Empty is fine |
| `JWT_SECRET` | set | Long random value (48+ chars). Already generated. Changing it signs everyone out |
| `DB_HOST` / `DB_PORT` | set | `127.0.0.1` / `3306` (never the srvNNNN.hstgr.io host) |
| `DB_NAME` / `DB_USER` / `DB_PASSWORD` | set | hPanel > Databases > MySQL: `u784417870_flockwise` |
| `SEED_DEMO` | set | `false` (must be false in production) |
| `EMAIL_FROM` | set | e.g. `Flockwise <hello@flockwise.church>` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` | set | `smtp.hostinger.com` / `465` / `hello@flockwise.church` |
| **`SMTP_PASSWORD`** | **key exists, value to confirm** | The mailbox password for hello@flockwise.church. hPanel > Emails > hello@flockwise.church > Change password if you don't know it. Type it in yourself. |

Sign-in codes are sent by email only, so email must work before anyone can log in.

### Church and first login

| Variable | Status | Value |
|---|---|---|
| `CHURCH_ID` | set | `ch_1` (don't change once data exists) |
| `CHURCH_NAME` / `CHURCH_CITY` | set | Check these are the real first church, not the sample "Grace Community Church" |
| `CHURCH_COUNTRY` / `CHURCH_CURRENCY` | set | `IN` / `INR` |
| `OWNER_EMAIL` / `OWNER_NAME` | set | The first office login. Sign in at app.flockwise.church/admin with this email |
| `CHURCH_SLUG` | optional | The first church's address, e.g. `grace` gives app.flockwise.church/c/grace. Leave unset to make one from the name |

### Many churches, plans and the Flockwise team panel

One server hosts every church. New churches sign up themselves at app.flockwise.church/start and
get a 30-day trial of every feature. The first church (above) is a founding church with every
feature and no limits.

| Variable | Status | Value |
|---|---|---|
| `PLATFORM_ADMINS` | needed for /platform | Comma-separated Flockwise team emails, e.g. `admin@flockwise.church`. They sign in at app.flockwise.church/platform with an email code |
| `BILLING_RAZORPAY_KEY_ID` / `BILLING_RAZORPAY_KEY_SECRET` | needed to sell plans | Agape Labs' own Razorpay account (Exaltes Global), not a church's. Until set, churches cannot pay for a plan online and are asked to write to hello@flockwise.church |
| `BILLING_RAZORPAY_WEBHOOK_SECRET` | with the keys | In that Razorpay account: Settings > Webhooks > add `https://api.flockwise.church/v1/webhooks/billing` with events `subscription.activated`, `subscription.charged`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`, and the secret you choose |

Each new church connects its own Razorpay account for gifts in Settings > Giving (keys are stored
encrypted with `JWT_SECRET`, so never change it once churches have connected). Its webhook URL is
shown there: `https://api.flockwise.church/v1/webhooks/razorpay/<church id>`. The `RAZORPAY_*`
variables below are for the first church only. The server's SMS and WhatsApp accounts also serve the
first church only; other churches send WhatsApp through their own Chitthi workspace.

### Email alternative: Resend (optional)

Only if Hostinger SMTP is unreliable or you want delivery stats. resend.com > Domains > add
`flockwise.church`, add the DNS records it shows (hPanel > DNS), then API Keys > Create
(sending access). Set `RESEND_API_KEY` and **remove `SMTP_HOST`** (SMTP wins when both exist).

### Razorpay giving (optional until the church wants online giving)

With no keys the API shows a built-in **test checkout** page, so giving can be demoed without an account.

| Variable | Where to get it |
|---|---|
| `RAZORPAY_KEY_ID` | Razorpay Dashboard > Account & Settings > API Keys > Generate. Starts `rzp_test_` (Test mode) or `rzp_live_` (after KYC) |
| `RAZORPAY_KEY_SECRET` | Shown once next to the key id. Copy it straight into hPanel |
| `RAZORPAY_WEBHOOK_SECRET` | You invent it (a long random string from a password manager). Type the same value in both places: Razorpay > Webhooks and hPanel |

Webhook setup (Razorpay > Account & Settings > Webhooks > Add new webhook):
- URL: `https://api.flockwise.church/v1/webhooks/razorpay`
- Secret: same as `RAZORPAY_WEBHOOK_SECRET`
- Events: `payment_link.paid`, `payment_link.expired`, `payment_link.cancelled`,
  `subscription.charged`, `subscription.halted`, `subscription.cancelled`, `payment.failed`
- Enable **Subscriptions** (monthly gifts / UPI AutoPay) on the account; Razorpay may need to approve it.
- Monthly-gift plans are created automatically; no plan ids to configure.

Test and live keys are separate, and so are their webhooks: set up the webhook again in Live mode.

**FCRA account (optional):** gifts from foreign citizens / OCI must go to the church's FCRA
account (SBI New Delhi Main Branch). That needs a **second** Razorpay account settled to it.
Same three values with `RAZORPAY_FCRA_` prefix, and its own webhook pointing at the same URL.

### SMS (optional, church messages only, not sign-in)

Pick one and set `SMS_PROVIDER` to `msg91` or `twilio`.

- **MSG91 (recommended for India).** Indian SMS requires DLT registration first (on a
  telecom DLT portal such as Jio TrueConnect or Vilpower: register the entity, a 6-letter sender
  header, and a template). Then in MSG91: create a Flow template using the DLT template with a
  `##message##` variable.
  - `MSG91_AUTH_KEY`: MSG91 > API > Auth key
  - `MSG91_TEMPLATE_ID`: the Flow template id
- **Twilio (outside India).** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (Twilio Console home),
  `TWILIO_FROM` (a Twilio number, `+1...`).

### WhatsApp Cloud API (optional, church messages only)

developers.facebook.com > create a Business app > add WhatsApp. Needs a Meta Business account
and a phone number not already on the WhatsApp app.
- `WHATSAPP_PHONE_NUMBER_ID`: WhatsApp > API Setup > Phone number ID (not the phone number)
- `WHATSAPP_TOKEN`: a **permanent** token: Business Settings > System users > add an admin system
  user > Generate token with `whatsapp_business_messaging`. The temporary token on API Setup expires in 24 h.
- `WHATSAPP_TEMPLATE`: name of an approved message template with one body variable `{{1}}`
  (WhatsApp Manager > Message templates). Needed to message people who haven't written in the last 24 hours.
- `WHATSAPP_TEMPLATE_LANG`: the template's language code, e.g. `en`.

Churches that use **Chitthi** don't need these: each church connects its own Chitthi workspace
in Settings › Integrations, and WhatsApp goes through Chitthi. `CHITTHI_URL` is only for pointing
at a Chitthi test server (default `https://app.chitthi.live`).

### AI features (optional)

- `ANTHROPIC_API_KEY`: from console.anthropic.com > API keys. While it is unset, the Assistant and
  every "Write with AI" button stay hidden.
- `ANTHROPIC_MODEL`: leave unset to use `claude-opus-5-5`.

Each church gets 300 AI requests a month by default (church setting `aiMonthlyLimit`).

### Not used in production

`DATA_FILE` (local JSON storage without MySQL). Leave unset on Hostinger.

### Check it worked

Open `https://api.flockwise.church/v1/health`. It shows `database`, `payments`
(`razorpay` or `test-checkout`), `fcra` and which message channels are live. If the server
refuses to start, the Hostinger runtime log lists each missing setting by name.

---

## 2. Web app (`app.flockwise.church`)

No secrets. All three are set. Rebuild after changing any of them.

| Variable | Status | Value |
|---|---|---|
| `VITE_API_URL` | set | `https://api.flockwise.church/v1` |
| `VITE_USE_MOCKS` | set | `false` (true = built-in demo, no server) |
| `VITE_APP_ENV` | set | `production` (hides the server switcher) |

The landing page (`flockwise.church`) needs no variables.

---

## 3. Mobile app (Expo / EAS)

No secrets: anything in an `EXPO_PUBLIC_*` variable ships inside the app, so never put keys there.
Values come from `eas.json` per build profile:

| Profile | `EXPO_PUBLIC_USE_MOCKS` | `EXPO_PUBLIC_API_URL` |
|---|---|---|
| development | `true` | `https://staging-api.flockwise.church/v1` |
| preview (test APK) | `true` | `https://staging-api.flockwise.church/v1` |
| production (stores) | `false` | `https://api.flockwise.church/v1` |

`staging-api.flockwise.church` doesn't exist yet. Until it does, test builds run on demo data, and
testers can point a test build at the live API in Me > Server.

Store accounts needed later (entered in EAS / the stores, not env vars): Expo account,
Google Play Console (one-time $25) and Apple Developer Program ($99/year) for publishing.
Push notifications would add Firebase (Android) and an APNs key (iOS) in EAS credentials.
