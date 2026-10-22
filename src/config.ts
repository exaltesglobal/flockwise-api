// All settings come from environment variables (Hostinger: Websites > your app > Environment variables).
const env = process.env;

function bool(v: string | undefined) {
  return v === 'true' || v === '1';
}

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
  },
  /** The first church office login. Sign in at /admin with this email. */
  owner: { email: env.OWNER_EMAIL ?? '', name: env.OWNER_NAME ?? '' },
  db: env.DB_HOST
    ? { host: env.DB_HOST, port: Number(env.DB_PORT) || 3306, user: env.DB_USER ?? '', password: env.DB_PASSWORD ?? '', database: env.DB_NAME ?? '' }
    : null,
  /** Without a database, keep data in this JSON file (local development). */
  dataFile: env.DATA_FILE ?? '',
  razorpay: {
    main: account(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET, env.RAZORPAY_WEBHOOK_SECRET),
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
  if (!config.jwtSecret) config.jwtSecret = 'dev-only-secret-change-me-dev-only-secret';
  if (problems.length) {
    console.error(`Configuration problems:\n - ${problems.join('\n - ')}`);
    if (config.production) process.exit(1);
  }
}
