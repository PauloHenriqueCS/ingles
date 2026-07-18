/**
 * SERVER-ONLY: resolves the authenticated user's effective plan and
 * entitlements for the four student-facing activities. Never import from
 * src/ or trust a plan/version id from the client — the plan is always
 * resolved here from the authenticated userId only.
 *
 * Reuses existing infrastructure end-to-end:
 *   - admin_resolve_effective_plan_v1 RPC (the project's own fallback rule:
 *     active assignment -> else the default active plan -> else none) —
 *     see api/_ai-gateway/entitlements.ts for the same call.
 *   - the shared service-role client (api/_ai-gateway/usage-repository.ts).
 *   - plan_capability_values / capability_definitions / user_capability_overrides
 *     (the generic entitlements tables from the plans migration).
 *   - user_conversation_credits (the extra-minutes ledger).
 *   - the existing domain tables (generated_themes, english_reviews,
 *     pronunciation_assessments, user_listening_assignments,
 *     conversation_sessions) as the source of truth for consumption —
 *     no parallel counter table.
 *
 * Missing-capability handling (never a blanket fail-open):
 *   - A plan version with NO entitlements configured at all (a genuine
 *     legacy plan/version) stays permissive for compatibility, but every
 *     such fallback is logged as a structured 'entitlements.legacy_fallback'
 *     event with plan_id/plan_version_id/capability_key.
 *   - A plan version that DOES have some configuration but is missing a
 *     specific required key is a configuration bug: the whole feature is
 *     blocked (state 'config_error'), a structured
 *     'entitlements.config_error' alert is logged, and the AI provider is
 *     never reached for it (enforced by requireFeatureAccess).
 *   - 'unlimited' only ever comes from an explicit plan value or override —
 *     never inferred from the mere absence of a key.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSharedServiceClient } from '../_ai-gateway/usage-repository';
import { computeFeatureState } from '../../src/domain/entitlements/compute-feature-state';
import type {
  ConversationEntitlements,
  FeatureLimit,
  LimitPeriod,
  ListeningEntitlements,
  PlanEntitlementsSnapshot,
  PronunciationEntitlements,
  WritingEntitlements,
} from '../../src/domain/entitlements/entitlement-types';
import { ALL_CAPABILITY_KEYS, CAPABILITY_KEYS } from './capability-keys';
import {
  resolveEnabledFlag,
  resolveNumericLimit,
  type CapabilityOverrideRow,
  type CapabilityValueRow,
  type EnabledFlagResolution,
  type NumericLimitResolution,
} from './resolve-capability-values';

interface EffectivePlanRow {
  user_id: string;
  access_allowed: boolean;
  plan_id: string | null;
  plan_code: string | null;
  plan_name: string | null;
  plan_version_id: string | null;
  version_number: number | null;
  is_suspended: boolean;
}

function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utcDayRange(now: Date): { startIso: string; endIso: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function utcMonthRange(now: Date): { startDate: string; endDate: string; resetAtIso: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { startDate: utcDateString(start), endDate: utcDateString(end), resetAtIso: end.toISOString() };
}

/** An empty, fully-locked-down snapshot used when the user has no resolvable plan or is suspended. */
function lockedSnapshot(now: Date): PlanEntitlementsSnapshot {
  const zeroLimit = { enabled: false, unlimited: false, limit: 0, consumed: 0, remaining: 0, period: 'none' as const, state: 'disabled_by_plan' as const, canStart: false };
  return {
    planId: null,
    planCode: null,
    planName: null,
    planVersionId: null,
    suspended: false,
    writing: { enabled: false, themeGenerations: zeroLimit, reviews: zeroLimit, maxCharactersPerText: 0, maxCharactersUnlimited: false },
    listening: { enabled: false, stories: zeroLimit },
    pronunciation: { enabled: false, evaluations: zeroLimit, maxRecordingSeconds: 0, maxRecordingUnlimited: false },
    conversation: { enabled: false, monthlyTime: zeroLimit, maxRecordingSeconds: 0, maxRecordingUnlimited: false, extraPurchaseEnabled: false, extraSecondsAvailable: 0 },
    monthlyRenewsAt: null,
    resolvedAt: now.toISOString(),
  };
}

function configErrorLimit(period: LimitPeriod): FeatureLimit {
  return { enabled: false, unlimited: false, limit: 0, consumed: 0, remaining: 0, period, state: 'config_error', canStart: false };
}

interface LogContext {
  planId: string | null;
  planVersionId: string | null;
}

/** Structured, alert-friendly log — never includes user content, only identifiers. */
function logLegacyFallback(ctx: LogContext, capabilityKey: string): void {
  console.warn(JSON.stringify({
    event: 'entitlements.legacy_fallback',
    plan_id: ctx.planId,
    plan_version_id: ctx.planVersionId,
    capability_key: capabilityKey,
  }));
}

function logConfigError(ctx: LogContext, capabilityKey: string): void {
  console.error(JSON.stringify({
    event: 'entitlements.config_error',
    plan_id: ctx.planId,
    plan_version_id: ctx.planVersionId,
    capability_key: capabilityKey,
  }));
}

function unwrapEnabled(resolution: EnabledFlagResolution, ctx: LogContext, capabilityKey: string): { enabled: boolean; configError: boolean } {
  if (resolution.source === 'config_error') {
    logConfigError(ctx, capabilityKey);
    return { enabled: false, configError: true };
  }
  if (resolution.source === 'legacy_fallback') {
    logLegacyFallback(ctx, capabilityKey);
  }
  return { enabled: resolution.enabled, configError: false };
}

function unwrapLimit(resolution: NumericLimitResolution, ctx: LogContext, capabilityKey: string): { limit: number; unlimited: boolean; configError: boolean } {
  if (resolution.source === 'config_error') {
    logConfigError(ctx, capabilityKey);
    return { limit: 0, unlimited: false, configError: true };
  }
  if (resolution.source === 'legacy_fallback') {
    logLegacyFallback(ctx, capabilityKey);
  }
  return { limit: resolution.limit, unlimited: resolution.unlimited, configError: false };
}

export async function getCurrentUserPlanEntitlements(
  userId: string,
  deps?: { supabase?: SupabaseClient; now?: Date },
): Promise<PlanEntitlementsSnapshot> {
  const supabase = deps?.supabase ?? getSharedServiceClient();
  const now = deps?.now ?? new Date();

  const { data: planRowsRaw, error: planErr } = await supabase.rpc('admin_resolve_effective_plan_v1', {
    p_user_id: userId,
    p_at: now.toISOString(),
  });
  if (planErr) throw new Error(`admin_resolve_effective_plan_v1 failed: ${planErr.message}`);

  const plan = (Array.isArray(planRowsRaw) ? planRowsRaw[0] : planRowsRaw) as EffectivePlanRow | undefined;

  if (!plan || !plan.access_allowed) {
    const snapshot = lockedSnapshot(now);
    snapshot.suspended = Boolean(plan?.is_suspended);
    return snapshot;
  }

  const { startIso: todayStartIso, endIso: todayEndIso } = utcDayRange(now);
  const todayDate = utcDateString(now);
  const { startDate: monthStartDate, endDate: monthEndDate, resetAtIso } = utcMonthRange(now);

  const [
    planValuesResult,
    overridesResult,
    creditsResult,
    themeCountResult,
    reviewCountResult,
    pronunciationCountResult,
    listeningAssignedResult,
    conversationSecondsResult,
  ] = await Promise.all([
    plan.plan_version_id
      ? supabase.from('plan_capability_values').select('capability_key, value').eq('plan_version_id', plan.plan_version_id).in('capability_key', ALL_CAPABILITY_KEYS)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from('user_capability_overrides')
      .select('capability_key, operation, value, created_at')
      .eq('user_id', userId)
      .eq('status', 'active')
      .in('capability_key', ALL_CAPABILITY_KEYS)
      .lte('starts_at', now.toISOString())
      .or(`ends_at.is.null,ends_at.gt.${now.toISOString()}`)
      .order('created_at', { ascending: false }),
    supabase
      .from('user_conversation_credits')
      .select('remaining_seconds')
      .eq('user_id', userId)
      .gt('remaining_seconds', 0)
      .or(`expires_at.is.null,expires_at.gt.${now.toISOString()}`),
    supabase.from('generated_themes').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', todayStartIso).lt('created_at', todayEndIso),
    supabase.from('english_reviews').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('entry_date', todayDate),
    supabase.from('pronunciation_assessments').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'completed').gte('completed_at', todayStartIso).lt('completed_at', todayEndIso),
    supabase.from('user_listening_assignments').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('activity_date', todayDate).not('episode_id', 'is', null),
    supabase.from('conversation_sessions').select('duration_sec').eq('user_id', userId).gte('session_date', monthStartDate).lt('session_date', monthEndDate),
  ]);

  const planRows = (planValuesResult.data ?? []) as CapabilityValueRow[];
  const hasAnyPlanConfiguration = planRows.length > 0;
  const logCtx: LogContext = { planId: plan.plan_id, planVersionId: plan.plan_version_id };

  // Only the most recent active override per key applies.
  const overrideRowsRaw = (overridesResult.data ?? []) as (CapabilityOverrideRow & { created_at: string })[];
  const overrideByKey = new Map<string, CapabilityOverrideRow>();
  for (const row of overrideRowsRaw) {
    if (!overrideByKey.has(row.capability_key)) overrideByKey.set(row.capability_key, row);
  }
  const overrideRows = [...overrideByKey.values()];

  const extraSecondsAvailable = ((creditsResult.data ?? []) as { remaining_seconds: number }[]).reduce(
    (sum, r) => sum + (r.remaining_seconds ?? 0),
    0,
  );

  const themeGenerationsToday = themeCountResult.count ?? 0;
  const reviewsToday = reviewCountResult.count ?? 0;
  const pronunciationEvaluationsToday = pronunciationCountResult.count ?? 0;
  const listeningStoriesToday = listeningAssignedResult.count ?? 0;
  const conversationSecondsThisMonth = ((conversationSecondsResult.data ?? []) as { duration_sec: number }[]).reduce(
    (sum, r) => sum + (r.duration_sec ?? 0),
    0,
  );

  const enabledR = (key: string) => unwrapEnabled(resolveEnabledFlag(key, planRows, overrideRows, hasAnyPlanConfiguration), logCtx, key);
  const limitR = (baseKey: string, unlimitedKey: string) => unwrapLimit(resolveNumericLimit(baseKey, unlimitedKey, planRows, overrideRows, hasAnyPlanConfiguration), logCtx, baseKey);

  // ── Writing ───────────────────────────────────────────────────────────────
  const writingEnabledR = enabledR(CAPABILITY_KEYS.writingEnabled);
  const themeGenerationsR = limitR(CAPABILITY_KEYS.writingThemeGenerationsPerDay, CAPABILITY_KEYS.writingThemeGenerationsPerDayUnlimited);
  const writingReviewsR = limitR(CAPABILITY_KEYS.writingReviewsPerDay, CAPABILITY_KEYS.writingReviewsPerDayUnlimited);
  const maxCharsR = limitR(CAPABILITY_KEYS.writingMaxCharactersPerText, CAPABILITY_KEYS.writingMaxCharactersPerTextUnlimited);
  const writingConfigError = writingEnabledR.configError || themeGenerationsR.configError || writingReviewsR.configError || maxCharsR.configError;
  const writingEnabled = writingConfigError ? false : writingEnabledR.enabled;

  const writing: WritingEntitlements = {
    enabled: writingEnabled,
    themeGenerations: writingConfigError ? configErrorLimit('day') : computeFeatureState({
      enabled: writingEnabled, unlimited: themeGenerationsR.unlimited, limit: themeGenerationsR.limit,
      consumed: themeGenerationsToday, period: 'day',
    }),
    reviews: writingConfigError ? configErrorLimit('day') : computeFeatureState({
      enabled: writingEnabled, unlimited: writingReviewsR.unlimited, limit: writingReviewsR.limit,
      consumed: reviewsToday, period: 'day',
    }),
    maxCharactersPerText: writingConfigError ? 0 : maxCharsR.limit,
    maxCharactersUnlimited: writingConfigError ? false : maxCharsR.unlimited,
  };

  // ── Listening ─────────────────────────────────────────────────────────────
  const listeningEnabledR = enabledR(CAPABILITY_KEYS.listeningEnabled);
  const storiesR = limitR(CAPABILITY_KEYS.listeningStoriesPerDay, CAPABILITY_KEYS.listeningStoriesPerDayUnlimited);
  const listeningConfigError = listeningEnabledR.configError || storiesR.configError;
  const listeningEnabled = listeningConfigError ? false : listeningEnabledR.enabled;

  const listening: ListeningEntitlements = {
    enabled: listeningEnabled,
    stories: listeningConfigError ? configErrorLimit('day') : computeFeatureState({
      enabled: listeningEnabled, unlimited: storiesR.unlimited, limit: storiesR.limit,
      consumed: listeningStoriesToday, period: 'day',
    }),
  };

  // ── Pronunciation ─────────────────────────────────────────────────────────
  const pronunciationEnabledR = enabledR(CAPABILITY_KEYS.pronunciationEnabled);
  const evaluationsR = limitR(CAPABILITY_KEYS.pronunciationEvaluationsPerDay, CAPABILITY_KEYS.pronunciationEvaluationsPerDayUnlimited);
  const pronunciationMaxRecordingR = limitR(CAPABILITY_KEYS.pronunciationMaxRecordingSeconds, CAPABILITY_KEYS.pronunciationMaxRecordingSecondsUnlimited);
  const pronunciationConfigError = pronunciationEnabledR.configError || evaluationsR.configError || pronunciationMaxRecordingR.configError;
  const pronunciationEnabled = pronunciationConfigError ? false : pronunciationEnabledR.enabled;

  const pronunciation: PronunciationEntitlements = {
    enabled: pronunciationEnabled,
    evaluations: pronunciationConfigError ? configErrorLimit('day') : computeFeatureState({
      enabled: pronunciationEnabled, unlimited: evaluationsR.unlimited, limit: evaluationsR.limit,
      consumed: pronunciationEvaluationsToday, period: 'day',
    }),
    maxRecordingSeconds: pronunciationConfigError ? 0 : pronunciationMaxRecordingR.limit,
    maxRecordingUnlimited: pronunciationConfigError ? false : pronunciationMaxRecordingR.unlimited,
  };

  // ── Conversation ──────────────────────────────────────────────────────────
  const conversationEnabledR = enabledR(CAPABILITY_KEYS.conversationEnabled);
  const monthlySecondsR = limitR(CAPABILITY_KEYS.conversationIncludedSecondsPerMonth, CAPABILITY_KEYS.conversationIncludedSecondsPerMonthUnlimited);
  const conversationMaxRecordingR = limitR(CAPABILITY_KEYS.conversationMaxRecordingSeconds, CAPABILITY_KEYS.conversationMaxRecordingSecondsUnlimited);
  const extraPurchaseR = enabledR(CAPABILITY_KEYS.conversationExtraPurchaseEnabled);
  const conversationConfigError = conversationEnabledR.configError || monthlySecondsR.configError || conversationMaxRecordingR.configError || extraPurchaseR.configError;
  const conversationEnabled = conversationConfigError ? false : conversationEnabledR.enabled;

  const conversation: ConversationEntitlements = {
    enabled: conversationEnabled,
    monthlyTime: conversationConfigError ? configErrorLimit('month') : computeFeatureState({
      enabled: conversationEnabled, unlimited: monthlySecondsR.unlimited, limit: monthlySecondsR.limit,
      consumed: conversationSecondsThisMonth, period: 'month', extraAvailable: extraSecondsAvailable,
    }),
    maxRecordingSeconds: conversationConfigError ? 0 : conversationMaxRecordingR.limit,
    maxRecordingUnlimited: conversationConfigError ? false : conversationMaxRecordingR.unlimited,
    extraPurchaseEnabled: conversationConfigError ? false : extraPurchaseR.enabled,
    extraSecondsAvailable,
  };

  return {
    planId: plan.plan_id,
    planCode: plan.plan_code,
    planName: plan.plan_name,
    planVersionId: plan.plan_version_id,
    suspended: false,
    writing,
    listening,
    pronunciation,
    conversation,
    monthlyRenewsAt: (conversationConfigError || monthlySecondsR.unlimited) ? null : resetAtIso,
    resolvedAt: now.toISOString(),
  };
}
