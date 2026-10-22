// Entry point for the shared church engine.
import { Db, type Dump } from './db.js';
import { createEngine, makeCtx, type Env } from './engine.js';
import { registerAuth } from './modules/auth.js';
import { registerCare } from './modules/care.js';
import { registerCheckin } from './modules/checkin.js';
import { registerChurch } from './modules/church.js';
import { registerComms, runDue } from './modules/comms.js';
import { registerGiving } from './modules/giving.js';
import { registerPeople } from './modules/people.js';
import { registerServing } from './modules/serving.js';
import { registerSongCatalog } from './modules/song-catalog.js';
import { registerTeamAuth } from './modules/team-auth.js';
import { registerDoor } from './modules/door.js';
import { registerNotify } from './modules/notify.js';
import { registerConnections } from './modules/connections.js';
import { registerCalendar } from './modules/calendar.js';
import { registerForms } from './modules/forms.js';
import { registerCelebrations } from './modules/celebrations.js';
import { registerMinistry } from './modules/ministry.js';
import { registerPresent } from './modules/present.js';
import { registerWorkflows } from './modules/workflows.js';
import { registerIntegrations, registerPayments } from './modules/integrations.js';
import { createMcp } from './mcp.js';
import { bindAiHandle, registerAi } from './modules/ai.js';
import { registerBilling } from './modules/billing.js';
import { registerRegisters } from './modules/registers.js';
import { registerZones } from './modules/zones.js';
import { registerAccounts } from './modules/accounts.js';
import { registerRazorpaySetup } from './modules/razorpay-setup.js';
import { registerCarols } from './modules/carols.js';
import { registerTeamHub } from './modules/team-hub.js';
import { registerRecurring } from './modules/recurring.js';
import { registerWhatsAppBot } from './modules/whatsapp-bot.js';
import { registerOfferings } from './modules/offerings.js';
import { registerPrivacy } from './modules/privacy.js';
import { registerPager } from './modules/pager.js';
import { registerBulletin } from './modules/bulletin.js';
import { registerSundaySchool } from './modules/sunday-school.js';
import { registerMissions } from './modules/missions.js';
import { registerLivestream } from './modules/livestream.js';
import { registerFamily } from './modules/family.js';
import { registerNetworkLink } from './modules/network-link.js';
import { ApiError } from './errors.js';
import { atLeast, effectivePlan, getSubscription } from './plans.js';

export const MODULES = [registerAuth, registerPeople, registerChurch, registerGiving, registerCheckin, registerServing, registerSongCatalog, registerComms, registerCare, registerForms, registerCalendar, registerWorkflows, registerMinistry, registerCelebrations, registerPresent, registerIntegrations, registerAi, registerBilling, registerPayments, registerRegisters, registerZones, registerAccounts, registerRazorpaySetup, registerRecurring, registerWhatsAppBot, registerOfferings, registerPrivacy, registerPager, registerBulletin, registerSundaySchool, registerMissions, registerLivestream, registerFamily, registerNetworkLink, registerTeamAuth, registerDoor, registerNotify, registerConnections, registerTeamHub, registerCarols];

export function createChurchEngine(db: Db, env: Env) {
  const engine = createEngine(db, env, MODULES);
  const mcp = createMcp(engine.handle, (key) => {
    const auth = engine.verifyKey(key);
    if (!atLeast(effectivePlan(getSubscription(db), env.now()), 'cathedral')) throw new ApiError(402, 'plan_required', 'Connecting AI assistants is part of the Cathedral plan.');
    return auth;
  });
  bindAiHandle(db, engine.handle);
  return {
    ...engine,
    /** The MCP server: one JSON-RPC message in, the reply out (null for notifications). */
    mcp: (body: unknown, apiKey: string | null | undefined) => mcp(body, apiKey, db.get('settings', 'church')?.name ?? 'the church'),
    /** Runs scheduled messages and daily automations. Safe to call often. */
    tick: () => runDue(makeCtx(db, env, { auth: null })),
    /** A system context, for adapters (e.g. the payment webhook). */
    systemCtx: () => makeCtx(db, env, { auth: null }),
  };
}

export { Db, type Dump, type Env };
export { ApiError };
export * from './plans.js';
export { REGISTER_FIELDS, REGISTER_KINDS, REGISTER_LABELS } from './modules/registers.js';
export { VISIT_PURPOSES } from './modules/zones.js';
export type { AiBlock, AiMessage, AiRequest, AiResponse, AuthClaims, DeliveryResult, GoogleKey, HttpRequest, HttpResponse, LyricsFeed, Outgoing, PushMessage, PushResult, SmtpAccount, Request } from './engine.js';
export { onDonationSucceeded } from './modules/giving.js';
export { DEMO_CODE } from './modules/auth.js';
export { PERMISSIONS, ROLE_LABELS } from './perms.js';
export { bootstrapChurch } from './bootstrap.js';
export { applyBillingEvent, billingView, markAiPackPaid } from './modules/billing.js';
export { applyRecurringEvent } from './modules/recurring.js';
export { botConfig, handleBotMessage } from './modules/whatsapp-bot.js';
export { DOC_KINDS, markSetupPaid, ORG_TYPES, SETUP_FEE, SETUP_KIND } from './modules/razorpay-setup.js';
export { createPlatform, slugify, type ChurchEntry, type Platform, type TenantHost } from './platform.js';
export { razorpayConfig } from './modules/integrations.js';
