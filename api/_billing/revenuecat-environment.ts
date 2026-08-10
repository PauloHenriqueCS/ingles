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

/** "evento sandbox nunca pode alterar produção" — EXCETO para um tester interno
 *  explicitamente allowlisted (isSandboxTestUser). Decided by THIS deployment's
 *  own environment plus the allowlist, never by trusting the event alone.
 *  Non-production deployments (e.g. homologation) never block, so sandbox
 *  testing there is unchanged. */
export function isSandboxBlockedHere(environment: string, appUserId: string | null | undefined): boolean {
  if (!(isProductionDeployment() && isSandboxEnvironment(environment))) return false;
  return !isSandboxTestUser(appUserId);
}
