# Flockwise API

The backend for the Flockwise web app (church office and member portal) and the Android/iOS apps.
Hono on Node 22, MySQL on Hostinger, Razorpay for giving.

All business logic lives in `src/core` (no Node APIs), which is also copied into the web app and runs
there as the demo backend. So what you click in the demo is exactly what the server does.
`npm run sync` is not needed here; the web app pulls this folder with `node scripts/sync-core.mjs`.

**Contracts**: [docs/API.md](docs/API.md) (member apps) and [docs/API-ADMIN.md](docs/API-ADMIN.md) (church office).

## What it does

- **Sign-in**: email one-time codes only (members and staff), JWT access tokens, rotating refresh tokens.
- **Roles**: owner, admin, pastor, finance, group leader, volunteer coordinator, check-in desk. Every office route checks permissions on the server, and every change goes to the activity log.
- **People**: households, campuses, tags, consent per channel (DPDP), CSV import, duplicate finder and merge, full activity timeline.
- **Events and services**: recurring events, RSVPs, paid tickets, attendance, self check-in.
- **Kids check-in**: desk and kiosk, family security codes, member QR codes, label printing, checkout with code.
- **Volunteers**: teams and positions, conflict-aware scheduling, auto-fill, accept/decline from the app, away dates, reminders.
- **Service planning**: order of service with timings, song library with keys, copy from past services.
- **Groups**: types, zones, leaders, join requests, meeting attendance.
- **Giving**: one-time and monthly (UPI AutoPay) via Razorpay, FCRA routing, 80G receipts and statements, Form 10BD export, pledges, refunds, cash and cheque entry.
- **Messages**: email, SMS (MSG91 or Twilio) and WhatsApp Cloud API to any audience, templates, scheduling, automations (birthdays, anniversaries, welcome, "we miss you", serving reminders).
- **Care**: case board, notes, assignments, confidential cases, people drifting away, prayer wall moderation.
- **Insights**: discipleship pathway, attendance, check-ins, giving by fund, giver segments, engagement, visitor retention.

## Run locally

```bash
npm install
SEED_DEMO=true DATA_FILE=./data.json npm run dev   # sample church, data kept in data.json
npm test                                            # 21 tests
```

Without email settings, sign-in codes are printed to the console. Without Razorpay keys, gifts open a
built-in test checkout page. Without SMS or WhatsApp keys, messages are logged and marked "simulated".

## Deploy on Hostinger

1. **Database**: hPanel → Databases → MySQL → create a database and user. Nothing to import; the API creates its `records` table on first start (`schema.sql` shows it).
2. **App**: hPanel → Websites → Add website → **Node.js app**. Connect the GitHub repo or upload the zip. Node 22, build `npm run build`, start `npm start`.
3. **Environment variables**: everything in `.env.example`. Use `DB_HOST=127.0.0.1`, `NODE_ENV=production`, a long random `JWT_SECRET`, your email as `OWNER_EMAIL`, and email settings (Hostinger SMTP `smtp.hostinger.com:465` with a mailbox on flockwise.church works). The server refuses to start in production if any of these are missing.
4. **Domain**: `api.flockwise.church`. Check `https://api.flockwise.church/v1/health`.
5. Point the web app (`VITE_API_URL`) and the mobile app (`EXPO_PUBLIC_API_URL`) at `https://api.flockwise.church/v1`.
6. Sign in at `https://app.flockwise.church/admin` with `OWNER_EMAIL`, then invite the team under Settings → Team & roles.

Never commit `.env` or paste keys into chat; set them only in Hostinger's environment variables.

## Set up Razorpay

1. Sign up at razorpay.com with the church's details and bank account and complete KYC. Use **Test Mode** first.
2. **Account & Settings → API Keys** → `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`.
3. Enable **Payment Links** and **Subscriptions** (Subscriptions powers UPI AutoPay; it may need a request to Razorpay support).
4. **Webhooks → Add**: `https://api.flockwise.church/v1/webhooks/razorpay`, a strong secret in `RAZORPAY_WEBHOOK_SECRET`, events `payment_link.paid`, `payment_link.expired`, `payment_link.cancelled`, `subscription.activated`, `subscription.charged`, `subscription.halted`, `subscription.cancelled`, `payment.failed`.
5. FCRA (optional): a second Razorpay account settled to the church's FCRA account at SBI New Delhi Main Branch → `RAZORPAY_FCRA_*`. Confirm with your CA.
6. Test with Razorpay's test UPI and cards, then switch to Live keys.

## How a gift flows

1. The app calls `POST /v1/giving/intents`; the API creates a pending donation and a Razorpay Payment Link (one-time) or Subscription (monthly) and returns `checkoutUrl`.
2. The donor pays on Razorpay's page. Flockwise never sees card or UPI details.
3. Razorpay calls the webhook (signature checked) and the donation becomes `succeeded`, with an 80G receipt number when eligible. Each monthly charge adds a new donation.
4. Razorpay sends the donor back to the web Give page with a thank-you.
