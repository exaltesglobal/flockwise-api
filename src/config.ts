// All settings come from environment variables (Hostinger: Websites > your app > Environment variables).
const env = process.env;

function bool(v: string | undefined) {
  return v === 'true' || v === '1';
}

export const config = {
  port: Number(env.PORT) || 3000,
  apiPublicUrl: (env.API_PUBLIC_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  webUrl: (env.WEB_URL ?? 'http://localhost:5173').replace(/\/+$/, ''),
  jwtSecret: env.JWT_SECRET ?? '',
  devAuth: bool(env.DEV_AUTH),
  production: env.NODE_ENV === 'production',
  church: {
    id: env.CHURCH_ID ?? 'ch_1',
    name: env.CHURCH_NAME ?? 'Flockwise Church',
    country: env.CHURCH_COUNTRY ?? 'IN',
    currency: env.CHURCH_CURRENCY ?? 'INR',
  },
  db: env.DB_HOST
    ? { host: env.DB_HOST, port: Number(env.DB_PORT) || 3306, user: env.DB_USER ?? '', password: env.DB_PASSWORD ?? '', database: env.DB_NAME ?? '' }
    : null,
  razorpay: {
    main: account(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET, env.RAZORPAY_WEBHOOK_SECRET),
    fcra: account(env.RAZORPAY_FCRA_KEY_ID, env.RAZORPAY_FCRA_KEY_SECRET, env.RAZORPAY_FCRA_WEBHOOK_SECRET),
  },
};

export type RazorpayAccount = { keyId: string; keySecret: string; webhookSecret: string };

function account(keyId?: string, keySecret?: string, webhookSecret?: string): RazorpayAccount | null {
  return keyId && keySecret ? { keyId, keySecret, webhookSecret: webhookSecret ?? '' } : null;
}

export function assertConfig() {
  const problems: string[] = [];
  if (config.production && (!config.jwtSecret || config.jwtSecret === 'change-me')) problems.push('JWT_SECRET must be set');
  if (config.production && config.devAuth) problems.push('DEV_AUTH must be false in production');
  if (config.production && !config.db) problems.push('DB_HOST must be set in production');
  if (config.razorpay.main && !config.razorpay.main.webhookSecret) problems.push('RAZORPAY_WEBHOOK_SECRET is needed to confirm payments');
  if (problems.length) {
    console.error(`Configuration problems:\n - ${problems.join('\n - ')}`);
    if (config.production) process.exit(1);
  }
}
