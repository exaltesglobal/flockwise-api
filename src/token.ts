// Mints a member or staff token for testing until OTP sign-in ships.
// Usage: JWT_SECRET=... npx tsx src/token.ts "Priya Thomas" priya@example.com +919876543210 [staffRole]
import { signToken } from './auth.js';
import { config } from './config.js';

const [name = 'Test Member', email = null, phone = null, staffRole = null] = process.argv.slice(2);
console.log(signToken({ sub: `p_${Buffer.from(email ?? name).toString('hex').slice(0, 12)}`, church: config.church.id, name, email, phone, staffRole: staffRole as never }, 7 * 86400));
