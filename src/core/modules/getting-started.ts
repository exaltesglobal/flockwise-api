// Getting started: the dashboard checklist for a new church, worked out from its records (not
// ticked by hand), so the office sees what is left to set up and where to do it.
import type { Ctx, Router } from '../engine.js';
import { getSubscription } from '../plans.js';
import type { GettingStarted, GettingStartedStep } from '../types.js';
import { settings } from '../util.js';
import { channelStatus, paymentsStatus } from './integrations.js';

const DISMISSED = 'gettingStarted:dismissed';

export function gettingStarted(ctx: Ctx): GettingStarted {
  const s = settings(ctx);
  const now = ctx.now.toISOString();
  const channels = channelStatus(ctx);
  const sub = getSubscription(ctx.db);
  const steps: GettingStartedStep[] = [
    { id: 'profile', title: 'Add your church profile and logo', body: 'Address, phone, email and the logo that goes on receipts, cards and the member app.', done: !!s.logoUrl && !!(s.address || s.phone), link: '/admin/settings#church', perm: 'settings' },
    { id: 'people', title: 'Bring your people in', body: 'Import from Excel, Google Sheets, Planning Center or Elvanto, or add families one by one.', done: ctx.db.count('people') >= 10, link: '/admin/import', perm: 'people.edit' },
    { id: 'service', title: 'Put your Sunday service on the calendar', body: 'A repeating service is what check-in, rotas, attendance and the projector hang off.', done: ctx.db.all('events').some((e) => e.kind === 'service' && e.startsAt >= now), link: '/admin/events', perm: 'events' },
    { id: 'office', title: 'Invite someone else to the office', body: 'A second pair of hands: the secretary, treasurer or a pastor, each with the right role.', done: ctx.db.count('staff') >= 2, link: '/admin/settings#team', perm: 'staff' },
    { id: 'giving', title: 'Connect Razorpay for online giving', body: 'UPI, cards and net banking straight to the church account, with 80G receipts sent for you.', done: paymentsStatus(ctx).connected, link: '/admin/settings#giving', perm: 'settings' },
    { id: 'messages', title: 'Switch on WhatsApp or SMS', body: 'Email works out of the box; WhatsApp by Chitthi or an SMS gateway reaches the ones who never open email.', done: channels.whatsapp.configured || channels.sms.configured, link: '/admin/settings#integrations', perm: 'settings' },
    { id: 'team', title: 'Send your team the Flockwise Team app', body: 'Worship, ushers and Sunday school see their rota, tasks and team chat on their phones.', done: ctx.db.all('teamLogins').some((l) => !l.disabled), link: '/admin/volunteers?tab=teams', perm: 'volunteers' },
    { id: 'members', title: 'Tell members about the app', body: 'Post the first announcement; it goes out with the link to app.flockwise.church where members sign in with their mobile number.', done: ctx.db.count('announcements') > 0, link: '/admin/announcements', perm: 'comms' },
  ];
  const trialDaysLeft = sub.status === 'trial' && sub.trialEndsAt ? Math.max(0, Math.ceil((Date.parse(sub.trialEndsAt) - ctx.now.getTime()) / 86_400_000)) : null;
  return { steps, done: steps.filter((x) => x.done).length, total: steps.length, dismissed: ctx.db.get('meta', DISMISSED)?.value === '1', trialDaysLeft, plan: sub.plan };
}

export function registerGettingStarted(r: Router) {
  r.get('/admin/getting-started', { staff: true }, (ctx) => gettingStarted(ctx));
  r.post('/admin/getting-started/dismiss', { staff: true }, (ctx) => {
    ctx.db.put('meta', { id: DISMISSED, value: ctx.body.undo ? '0' : '1' });
    return gettingStarted(ctx);
  });
}
