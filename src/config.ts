// All settings come from environment variables (Hostinger: Websites > your app > Environment variables).
import type { LyricsFeed } from './core/engine.js';
const env = process.env;

function bool(v: string | undefined) {
  return v === 'true' || v === '1';
}

const billingAccount = env.BILLING_RAZORPAY_KEY_ID
  ? account(env.BILLING_RAZORPAY_KEY_ID, env.BILLING_RAZORPAY_KEY_SECRET, env.BILLING_RAZORPAY_WEBHOOK_SECRET)
  : account(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET, env.RAZORPAY_WEBHOOK_SECRET);

export const config = {
  port: Number(env.PORT) || 3000,
  apiPublicUrl: (env.API_PUBLIC_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  webUrl: (env.WEB_URL ?? 'http://localhost:5173').replace(/\/+$/, ''),
  /** Extra origins allowed by CORS, comma separated (e.g. a staging web app). */
  extraOrigins: (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  jwtSecret: env.JWT_SECRET ?? '',
  production: env.NODE_ENV === 'production',
  /** Fill an empty database with the sample church (for trying things out, never in production). */
  seedDemo: bool(env.SEED_DEMO),
  church: {
    id: env.CHURCH_ID ?? 'ch_1',
    name: env.CHURCH_NAME ?? 'Flockwise Church',
    country: env.CHURCH_COUNTRY ?? 'IN',
    currency: env.CHURCH_CURRENCY ?? 'INR',
    city: env.CHURCH_CITY ?? '',
    /** The church's web address on Flockwise (app.flockwise.church/c/<slug>). */
    slug: env.CHURCH_SLUG ?? '',
  },
  /** Flockwise team emails that can sign in to the team panel at /platform, comma separated. */
  platformAdmins: (env.PLATFORM_ADMINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  /**
   * Flockwise's own Razorpay account: churches paying for their plan and for assisted Razorpay setup.
   * BILLING_RAZORPAY_* if set, else RAZORPAY_*. Gifts never go here: every church connects its own account in Settings.
   */
  billing: billingAccount,
  /** Our Razorpay partner sign-up link, used by assisted setup so we can do the church's KYC. */
  razorpayPartnerUrl: env.RAZORPAY_PARTNER_URL ?? 'https://rzp.io/rzp/WOtsRAWp',
  /** The first church office login. Sign in at /admin with this email. */
  owner: { email: env.OWNER_EMAIL ?? '', name: env.OWNER_NAME ?? '' },
  db: env.DB_HOST
    ? { host: env.DB_HOST, port: Number(env.DB_PORT) || 3306, user: env.DB_USER ?? '', password: env.DB_PASSWORD ?? '', database: env.DB_NAME ?? '' }
    : null,
  /** Without a database, keep data in this JSON file (local development). */
  dataFile: env.DATA_FILE ?? '',
  /** Gift keys for the server's own church, only when RAZORPAY_* is not already Flockwise's billing account. */
  razorpay: {
    main: env.BILLING_RAZORPAY_KEY_ID ? account(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET, env.RAZORPAY_WEBHOOK_SECRET) : null,
    fcra: account(env.RAZORPAY_FCRA_KEY_ID, env.RAZORPAY_FCRA_KEY_SECRET, env.RAZORPAY_FCRA_WEBHOOK_SECRET),
  },
  email: {
    from: env.EMAIL_FROM ?? '',
    // Option A: SMTP (Hostinger email: smtp.hostinger.com, port 465)
    smtp: env.SMTP_HOST ? { host: env.SMTP_HOST, port: Number(env.SMTP_PORT) || 465, user: env.SMTP_USER ?? '', pass: env.SMTP_PASSWORD ?? '' } : null,
    // Option B: Resend API
    resendKey: env.RESEND_API_KEY ?? '',
  },
  sms: {
    provider: (env.SMS_PROVIDER ?? '') as '' | 'msg91' | 'twilio',
    msg91: { authKey: env.MSG91_AUTH_KEY ?? '', templateId: env.MSG91_TEMPLATE_ID ?? '' },
    twilio: { sid: env.TWILIO_ACCOUNT_SID ?? '', token: env.TWILIO_AUTH_TOKEN ?? '', from: env.TWILIO_FROM ?? '' },
  },
  whatsapp: {
    token: env.WHATSAPP_TOKEN ?? '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? '',
    /** Approved template with one body variable, used outside WhatsApp's 24-hour reply window. */
    template: env.WHATSAPP_TEMPLATE ?? '',
    templateLang: env.WHATSAPP_TEMPLATE_LANG ?? 'en',
  },
  /** Claude for the AI features. Without a key the AI screens stay hidden. */
  anthropic: { apiKey: env.ANTHROPIC_API_KEY ?? '', model: env.ANTHROPIC_MODEL ?? 'claude-opus-5-5' },
  /** Flockwise's Canva app (canva.com/developers): churches connect their own Canva through it. */
  canva: env.CANVA_CLIENT_ID && env.CANVA_CLIENT_SECRET ? { clientId: env.CANVA_CLIENT_ID, clientSecret: env.CANVA_CLIENT_SECRET } : null,
  /**
   * Licensed lyrics services Flockwise has an agreement with (SongSelect partner API, a publisher,
   * an Indian label), as a JSON list: [{"id":"…","name":"…","url":"https://…","key":"…","covers":"all"|"ccli"}].
   * Each answers the lyrics-feed contract in docs/SONG-CATALOG.md.
   */
  lyricsFeeds: parseFeeds(env.LYRICS_FEEDS),
  /** Chitthi (Agape Labs' WhatsApp platform). Each church connects its own workspace key in Settings. */
  chitthiUrl: (env.CHITTHI_URL ?? 'https://app.chitthi.live').replace(/\/$/, ''),
};

export type RazorpayAccount = { keyId: string; keySecret: string; webhookSecret: string };

function account(keyId?: string, keySecret?: string, webhookSecret?: string): RazorpayAccount | null {
  return keyId && keySecret ? { keyId, keySecret, webhookSecret: webhookSecret ?? '' } : null;
}

export function emailConfigured() {
  return !!(config.email.from && (config.email.smtp || config.email.resendKey));
}

export function assertConfig() {
  const problems: string[] = [];
  if (config.production && (!config.jwtSecret || config.jwtSecret === 'change-me' || config.jwtSecret.length < 32)) problems.push('JWT_SECRET must be set to a long random value');
  if (config.production && !config.db) problems.push('DB_HOST must be set in production');
  if (config.production && config.seedDemo) problems.push('SEED_DEMO must be false in production');
  if (config.production && !emailConfigured()) problems.push('Email must be configured (EMAIL_FROM plus SMTP_* or RESEND_API_KEY): sign-in codes are sent by email');
  if (config.razorpay.main && !config.razorpay.main.webhookSecret) problems.push('RAZORPAY_WEBHOOK_SECRET is needed to confirm payments');
  if (config.billing && !config.billing.webhookSecret) problems.push('The Razorpay webhook secret (BILLING_RAZORPAY_WEBHOOK_SECRET or RAZORPAY_WEBHOOK_SECRET) is needed to confirm plan payments');
  if (!config.jwtSecret) config.jwtSecret = 'dev-only-secret-change-me-dev-only-secret';
  if (problems.length) {
    console.error(`Configuration problems:\n - ${problems.join('\n - ')}`);
    if (config.production) process.exit(1);
  }
}

function parseFeeds(raw: string | undefined): LyricsFeed[] {
  if (!raw?.trim()) return [];
  try {
    const list = JSON.parse(raw) as Partial<LyricsFeed>[];
    return (Array.isArray(list) ? list : [])
      .filter((f) => f && typeof f.url === 'string' && f.url.startsWith('https://') && typeof f.key === 'string')
      .map((f, i) => ({ id: String(f.id || `feed${i + 1}`), name: String(f.name || f.id || 'Lyrics service'), url: f.url!, key: f.key!, covers: f.covers === 'ccli' ? 'ccli' : 'all' }));
  } catch {
    console.error('LYRICS_FEEDS is not valid JSON; licensed lyrics are switched off.');
    return [];
  }
}
