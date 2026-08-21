/**
 * SERVER-ONLY: the one place "is this event sandbox, and are we allowed to
 * apply it here" is decided — shared by the subscription sync and minute-credit
 * services, and therefore (through syncSubscriptionFromEvent /
 * creditMinutePackagePurchase) by BOTH the RevenueCat webhook and
 * POST /api/subscription/sync, so the rule can never drift between them.
 */

import { getRevenueCatSandboxTestUserIds } from '../_env';

export function isSandboxEnvironment(environment: string): boolean {
  return environment.trim().toUpperCase() === 'SANDBOX';
}

/** Vercel's own built-in env var — never a new one to invent/misconfigure.
 *  Undefined in every non-Vercel-production context (including this task's
 *  homologation deploys), so this only ever actually blocks something once
 *  this code runs in the real production project. */
export function isProductionDeployment(): boolean {
  return process.env.VERCEL_ENV === 'production';
}

/** Supabase UUIDs explicitly authorized to exercise SANDBOX (test) purchases
 *  against the PRODUCTION backend — Google Play Internal Testing / license
 *  testers, whose purchases are always is_sandbox=true even though the app
 *  talks to the production deployment. The allowlist is server-only
 *  (REVENUECAT_SANDBOX_TEST_USER_IDS — never a VITE_ var, see _env.ts), empty
 *  when unset. Matching is case-insensitive (UUIDs). */
export function isSandboxTestUser(appUserId: string | null | undefined): boolean {
  if (!appUserId) return false;
  return getRevenueCatSandboxTestUserIds().has(appUserId.trim().toLowerCase());
}

/** Canonical store/platform behind a RevenueCat event or subscriber snapshot.
 *  MUST be derived ONLY from trusted server-side data — the HMAC/authorization-
 *  verified webhook payload, or the REST subscriber response WE fetch with the
 *  secret key — NEVER from a value the client puts in a request body. `store`
 *  decides whether a sandbox purchase is honored in production, so the client
 *  can never be its authority. */
export type RevenueCatStore =
  | 'app_store'
  | 'mac_app_store'
  | 'play_store'
  | 'stripe'
  | 'amazon'
  | 'promotional'
  | 'unknown';

/** Normalize RevenueCat's store label to a canonical value. The webhook sends
 *  it UPPER_CASE (e.g. 'APP_STORE'); the REST subscriber sends it lower_case
 *  (e.g. 'app_store'). Anything unrecognized or absent collapses to 'unknown',
 *  which the gate treats as NOT Apple — fail-closed: an unknown store can never
 *  unblock a sandbox purchase in production. */
export function normalizeRevenueCatStore(raw: string | null | undefined): RevenueCatStore {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'app_store': return 'app_store';
    case 'mac_app_store': return 'mac_app_store';
    case 'play_store': return 'play_store';
    case 'stripe': return 'stripe';
    case 'amazon': return 'amazon';
    case 'promotional': return 'promotional';
    default: return 'unknown';
  }
}

/** Apple's stores. A SANDBOX purchase on Apple against the PRODUCTION backend
 *  can only originate from TestFlight or App Review — a real App Store customer
 *  is always environment=PRODUCTION. Honoring it is therefore safe AND required:
 *  Apple's reviewers must be able to complete a purchase, and their app_user_id
 *  cannot be allowlisted in advance. Google Play sandbox stays gated. */
function isAppleStore(store: RevenueCatStore): boolean {
  return store === 'app_store' || store === 'mac_app_store';
}

/** "evento sandbox nunca pode alterar produção" — EXCETO:
 *   (a) uma compra sandbox da APP STORE (iOS) — TestFlight/App Review — que é
 *       sempre honrada em produção (o revisor da Apple precisa conseguir
 *       comprar; `store` vem só de fonte server-side confiável, ver
 *       normalizeRevenueCatStore); ou
 *   (b) um tester interno explicitamente allowlisted (isSandboxTestUser) — o
 *       caminho do Google Play, cujo sandbox continua protegido.
 *  Decided by THIS deployment's own environment + store + allowlist, never by
 *  trusting a client-supplied value. Non-production deployments (e.g.
 *  homologation) never block, so sandbox testing there is unchanged. */
export function isSandboxBlockedHere(
  environment: string,
  appUserId: string | null | undefined,
  store: RevenueCatStore,
): boolean {
  if (!(isProductionDeployment() && isSandboxEnvironment(environment))) return false;
  // (a) Apple sandbox in production (TestFlight / App Review) is always honored.
  if (isAppleStore(store)) return false;
  // (b) Google Play — and any non-Apple / unknown store (fail-closed) — remains
  // gated by the internal-tester allowlist.
  return !isSandboxTestUser(appUserId);
}
