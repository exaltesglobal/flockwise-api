# Flockwise API

Backend for the Flockwise web and mobile apps. **v0.1 covers giving with Razorpay**: one-time
gifts (Payment Links: UPI, cards, netbanking, wallets), monthly gifts (Subscriptions: UPI AutoPay
or e-mandate), webhook confirmation, FCRA routing, and the donation lists for members and the
church office. Built with Hono on Node, MySQL on Hostinger.

The rest of the contract ([docs/API.md](../flockwise-web/docs/API.md), [docs/API-ADMIN.md](../flockwise-web/docs/API-ADMIN.md)), including real
OTP sign-in, is still to be built. `DEV_AUTH=true` provides a stand-in sign-in (code `123456`) for testing only.

## How a gift flows

1. App calls `POST /v1/giving/intents` → API creates a `pending` donation and a Razorpay Payment Link (one-time) or Subscription (monthly) on the church's account → returns `checkoutUrl`.
2. Donor pays on Razorpay's hosted page. Flockwise never sees card or UPI details.
3. Razorpay calls `POST /v1/webhooks/razorpay` (signature checked) → donation becomes `succeeded`. Each monthly charge adds a new donation row. Retries are harmless.
4. Razorpay sends the donor back to `/v1/giving/return`, which redirects to the web app's Give page with a thank-you.

FCRA: if the church is in India and the donor says they are not an Indian citizen, the gift is
created on the separate FCRA Razorpay account (`RAZORPAY_FCRA_*`), or refused if none is set.

Without Razorpay keys the API serves a **test checkout page** instead, so the full flow can be tried right away.

## Run locally

```bash
npm install
cp .env.example .env     # leave DB_HOST and RAZORPAY_KEY_ID empty to start
DEV_AUTH=true npm run dev
npm test                 # 9 tests, including Razorpay's documented signature example
```

## Set up Razorpay

1. Sign up at razorpay.com with the church's details and bank account, and complete KYC (registration certificate, PAN, bank proof). Use **Test Mode** while setting up.
2. **Account & Settings → API Keys** → generate keys → set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
3. Enable **Payment Links** and **Subscriptions** (Subscriptions may need a request to Razorpay support; it is what powers UPI AutoPay).
4. **Account & Settings → Webhooks → Add**: URL `https://api.flockwise.church/v1/webhooks/razorpay`, a strong secret (put it in `RAZORPAY_WEBHOOK_SECRET`), events: `payment_link.paid`, `payment_link.expired`, `payment_link.cancelled`, `subscription.activated`, `subscription.charged`, `subscription.halted`, `subscription.cancelled`, `payment.failed`.
5. FCRA (optional): a second Razorpay account settled to the church's FCRA account at SBI New Delhi Main Branch, with its own keys and webhook → `RAZORPAY_FCRA_*`. Confirm the arrangement with your CA/lawyer.
6. Test with Razorpay's test UPI/cards, then switch to Live keys.

Today this is one church's Razorpay account. For many churches on Flockwise, each church will connect
its own account through Razorpay's Partner (OAuth) program so money never passes through Flockwise.

## Deploy on Hostinger

1. **Database**: hPanel → Databases → MySQL → create database + user. Open phpMyAdmin → Import `schema.sql` (edit `ch_1` if you change `CHURCH_ID`).
2. **App**: hPanel → Websites → Add website → **Node.js app** (Express/Hono). Connect the repo or upload the zip. Node 22. Build `npm run build`, start `npm start`.
3. **Environment variables**: everything in `.env.example`. Use `DB_HOST=127.0.0.1` (not the srvNNNN.hstgr.io host), `NODE_ENV=production`, `DEV_AUTH=false`, a long random `JWT_SECRET`.
4. **Domain**: `api.flockwise.church`. Check `https://api.flockwise.church/v1/health`.
5. Point the web app (`VITE_API_URL`) and mobile app (`EXPO_PUBLIC_API_URL`) at `https://api.flockwise.church/v1`.

Never commit `.env` or paste keys into chat; set them only in Hostinger's environment variables.
