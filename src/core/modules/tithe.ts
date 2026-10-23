// Salary-day tithe reminder: a member picks the day their salary lands, and that morning the app
// nudges them to give (push, and WhatsApp when the office allows it). Nothing is charged; it is a
// reminder, and it stays quiet while a monthly gift is already running.
import type { Ctx } from '../engine.js';
import { money, settings } from '../util.js';
import { notify } from './notify.js';

/** Whether `day` (1–31) falls today; 29–31 also fire on the last day of a shorter month. */
export function titheDayIsToday(day: number, today: string): boolean {
  const [y, m, d] = today.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d === Math.min(day, last);
}

/** Called from the daily tick. */
export async function titheReminders(ctx: Ctx, today: string) {
  const church = settings(ctx).name;
  const autopay = new Set(ctx.db.all('recurring').filter((r) => r.status === 'active' && r.donorId).map((r) => r.donorId!));
  for (const p of ctx.db.all('people')) {
    if (!p.titheDay || p.status === 'inactive' || autopay.has(p.id)) continue;
    if (!titheDayIsToday(p.titheDay, today)) continue;
    const amount = p.titheAmount ? ` (${money(ctx, p.titheAmount)})` : '';
    await notify(ctx, 'tithe.reminder', {
      personIds: [p.id],
      title: `${church}: your tithe day`,
      body: `Hi ${p.firstName}, today is the day you set aside for your tithe${amount}. It takes a minute in the app, and your receipt comes straight back.`,
      link: '/app/give',
    });
  }
}
