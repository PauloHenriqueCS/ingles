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
 *     pronunciation_assessments, user_listening_shared_progress,
 *     conversation_session_authorizations) as the source of truth for
 *     consumption — no parallel counter table.
 *
 *   Conversation is the one exception to "read straight off a single
 *   column": conversationSecondsThisMonth below is computed from
 *   conversation_session_authorizations (server-authored, never a client
 *   INSERT — see 20260721010000_conversation_session_server_authoritative.sql)
 *   rather than a flat SUM, because an 'authorized'-but-not-yet-'completed'
 *   row must still count its own elapsed time toward the monthly balance in
 *   real time. That is what stops (a) an abandoned/never-closed call from
 *   costing nothing forever, and (b) concurrent calls (multiple tabs) from
 *   each starting fresh against the same balance.
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
import { recordServerTiming } from '../_debug-log';
import { AUTHORIZATION_HEARTBEAT_STALE_SECONDS } from '../_realtime-constants';
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
  // Etapa 2A — already returned by admin_resolve_effective_plan_v1 (used
  // elsewhere by api/_ai-gateway/entitlements.ts), now also read here so the
  // trial's lifetime window can be resolved without a second RPC round-trip.
  // assignment_id/starts_at/ends_at are null when this plan came from the
  // default-plan fallback (origin='default'), never from a real assignment.
  assignment_id: string | null;
  starts_at: string | null;
  ends_at: string | null;
}

function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function utcDayRange(now: Date): { startIso: string; endIso: string } {
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
    pronunciation: { enabled: false, evaluations: zeroLimit, training: zeroLimit, maxRecordingSeconds: 0, maxRecordingUnlimited: false },
    conversation: { enabled: false, monthlyTime: zeroLimit, maxRecordingSeconds: 0, maxRecordingUnlimited: false, extraPurchaseEnabled: false, extraSecondsAvailable: 0 },
    trialAssignment: null,
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

// ── Short-lived in-process cache ──────────────────────────────────────────────
// This resolver is DB-dominated (admin_resolve_effective_plan_v1 + per-activity
// counters) and is called by NEARLY EVERY /api route — so a single screen load
// fires it many times for the same user within a second or two, each hitting the
// database. On the small (CPU-burstable) Postgres instance that pile-up is what
// tipped latency to 8-13s ("spinner em várias telas"). A tiny per-lambda TTL
// cache collapses that burst to one DB read without meaningful staleness: the
// snapshot is display/gating hint only — the AUTHORITATIVE checks are the server
// RPCs (reserve_pronunciation_assessment, register_word_practice_attempt, the
// conversation authorizers), which are never cached. Bypassed whenever a caller
// injects deps (tests / special callers).
const ENT_CACHE_TTL_MS = 5_000;
const ENT_CACHE_MAX_ENTRIES = 2_000;
interface CachedEntitlements { snapshot: PlanEntitlementsSnapshot; expiresAt: number; }
const _entitlementsCache = new Map<string, CachedEntitlements>();

/** Drops a user's cached snapshot so the next read is fresh (e.g. right after a
 *  plan change). Safe to call anytime; no-op if absent. */
export function invalidatePlanEntitlementsCache(userId?: string): void {
  if (userId) _entitlementsCache.delete(userId);
  else _entitlementsCache.clear();
}

export async function getCurrentUserPlanEntitlements(
  userId: string,
  deps?: { supabase?: SupabaseClient; now?: Date },
): Promise<PlanEntitlementsSnapshot> {
  // Only the default path (no injected deps) is cacheable.
  const cacheable = deps === undefined;
  if (cacheable) {
    const hit = _entitlementsCache.get(userId);
    if (hit && hit.expiresAt > Date.now()) return hit.snapshot;
  }

  // Self-timing (fire-and-forget, no-op unless the dashboard log level is on)
  // now runs ONLY on a cache miss — so debug_request_logs also shows how much
  // the cache cut the DB load.
  const t0 = Date.now();
  let snapshot: PlanEntitlementsSnapshot;
  try {
    snapshot = await getCurrentUserPlanEntitlementsImpl(userId, deps);
  } finally {
    const dt = Date.now() - t0;
    void recordServerTiming({
      endpoint: 'service:plan-entitlements',
      stage: 'db:resolve_entitlements',
      userId,
      durationMs: dt,
      dbMs: dt,
      provider: 'supabase',
    });
  }

  if (cacheable) {
    // Cheap unbounded-growth guard for a long-lived warm lambda.
    if (_entitlementsCache.size >= ENT_CACHE_MAX_ENTRIES) _entitlementsCache.clear();
    _entitlementsCache.set(userId, { snapshot, expiresAt: Date.now() + ENT_CACHE_TTL_MS });
  }
  return snapshot;
}

async function getCurrentUserPlanEntitlementsImpl(
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

  // access_allowed only reflects admin suspension — it says nothing about
  // subscription validity. admin_resolve_effective_plan_v1 falls back to
  // plans.is_default (a safety-net plan, never meant as a commercial grant —
  // see 20260727230500_grant_signup_trial.sql) whenever there is no genuine
  // user_plan_assignments row covering `now`: trial expired, a canceled or
  // billing_issue subscription past its paid ends_at, or no assignment ever
  // granted. That fallback is the ONLY case where assignment_id/starts_at
  // come back null (a real assignment lookup always populates both — see
  // the RPC's IF FOUND branch). The four activities must fail closed here,
  // before any capability_values are even read, regardless of what the
  // fallback plan's own configuration happens to allow — this is what
  // actually enforces "sem trial/assinatura válida, sem acesso às quatro
  // atividades" (subscription-status-service.ts's 'expired' derivation
  // mirrors this exact same genuine-assignment test).
  const hasGenuineAssignment = plan != null && plan.assignment_id != null && plan.starts_at != null;
  if (!plan || !plan.access_allowed || !hasGenuineAssignment) {
    const snapshot = lockedSnapshot(now);
    snapshot.suspended = Boolean(plan?.is_suspended);
    return snapshot;
  }

  const { startIso: todayStartIso, endIso: todayEndIso } = utcDayRange(now);
  const { startDate: monthStartDate, endDate: monthEndDate, resetAtIso } = utcMonthRange(now);
  // Listening (História) is scoped to the São Paulo calendar day, matching how
  // the feature actually writes its rows: listening_shared_stories.practice_date
  // and the daily story key are both resolved in America/Sao_Paulo (see
  // src/services/listening/daily/resolve-listening-activity-date.ts). Counting
  // it against a UTC day (like the other counters here) miscounts 21:00–24:00
  // SP, so it gets its own SP date. Same en-CA + America/Sao_Paulo formatter as
  // getTodaySP()/resolveListeningActivityDate — kept inline to avoid importing
  // browser-side src/lib into the server bundle.
  const todaySpDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);

  // Etapa 2A — the internal 'trial' plan's Conversation completeness is
  // satisfied by conversation.realtime.seconds.trial_total instead of the
  // monthly pair (see publish_plan_version's trial-code branch). Its
  // consumption is bounded by the trial's OWN assignment window
  // (starts_at..ends_at), never the calendar month, and never resets on a
  // month change. Only a GENUINE assignment counts — the default-plan
  // fallback (assignment_id/starts_at both null) never does, matching "só
  // considere trial uma atribuição efetiva coerente com o plano trial".
  //
  // DECISÃO EXPLÍCITA sobre user_plan_assignments.origin (Etapa 2A —
  // revisão de segurança): origin NUNCA é consultado aqui, por design, e
  // isso é deliberado, não um esquecimento. Auditoria do RPC que cria
  // atribuições no ingles-dashboad (admin_assign_plan_v1) confirma que
  // origin é um rótulo em texto livre, escolhido pelo administrador que faz
  // a chamada, e INDEPENDENTE do plan_id assignado — um admin pode atribuir
  // o plano 'trial' com origin='manual' (ex.: suporte concedendo o trial
  // manualmente), ou teoricamente qualquer outro plano com origin='trial'.
  // origin portanto não é um sinal confiável de "isto é realmente um
  // trial" — só o CÓDIGO do plano efetivamente resolvido (plan.plan_code)
  // determina quais capabilities/limites se aplicam, nunca a origem
  // administrativa de como o usuário chegou a esse plano. Consequência
  // intencional: uma atribuição MANUAL do plano trial (origin='manual')
  // recebe exatamente a mesma semântica lifetime que uma atribuição
  // origin='trial' — ambas resolvem para o MESMO plan_version publicado,
  // com as MESMAS capabilities, então tratá-las diferente só por causa do
  // rótulo origin seria uma inconsistência, não uma proteção. A regra
  // mínima que É de fato aplicada (ver trialWindow abaixo): o plano
  // padrão/fallback com code='trial' mas SEM uma atribuição real
  // (assignment_id/starts_at ausentes) nunca recebe saldo lifetime,
  // independente de origin.
  const isTrial = plan.plan_code === 'trial';
  const trialWindow = isTrial && plan.assignment_id && plan.starts_at
    ? { startIso: plan.starts_at, endIso: plan.ends_at }
    : null;
  // A trial-coded plan resolved WITHOUT a real assignment window is a
  // dashboard misconfiguration this service cannot safely bound — never
  // silently treated as unlimited or as "no trial" (see unwrapLimit's
  // config_error path below, forced on for the conversation feature).
  const trialWindowMissing = isTrial && !trialWindow;

  const [
    planValuesResult,
    overridesResult,
    creditsResult,
    themeCountResult,
    reviewCountResult,
    pronunciationCountResult,
    listeningConsumedResult,
    conversationSecondsResult,
    pronunciationTrainingCountResult,
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
    // writing_review_reservations, not english_reviews.entry_date: entry_date
    // is which diary day a review is ABOUT (can be any day the user
    // navigates to), not when the review was actually consumed — the single
    // source of truth for "reviews used today" is the same atomic
    // reserve/complete ledger api/review-text.ts writes to, counted by
    // created_at like every other daily counter here (themeCountResult,
    // pronunciationCountResult). 'reserved' counts too — a reservation holds
    // its slot the instant it is taken, before the AI call even starts.
    supabase.from('writing_review_reservations').select('id', { count: 'exact', head: true }).eq('user_id', userId).in('status', ['reserved', 'completed']).gte('created_at', todayStartIso).lt('created_at', todayEndIso),
    supabase.from('pronunciation_assessments').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'completed').gte('completed_at', todayStartIso).lt('completed_at', todayEndIso),
    // História = the live shared-story listening flow. Quota is consumed only
    // when the user actually PRACTICES a story (completed=true), NEVER when it
    // is merely prepared/opened. Preparing inserts a user_listening_shared_progress
    // row with completed=false (PENDING) — that must not count. Practicing flips
    // it to completed=true atomically (see consume_listening_pending_story). So
    // we count only completed=true rows whose shared story belongs to TODAY (SP),
    // via the FK to listening_shared_stories.practice_date (already an SP date).
    //
    // Historical safety: every pre-existing row is completed=false (the flag was
    // never written before this change), so this correctly treats past "opens"
    // as NOT consumed — no retroactive quota is charged to anyone.
    supabase
      .from('user_listening_shared_progress')
      .select('id, listening_shared_stories!inner(practice_date)', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('completed', true)
      .eq('listening_shared_stories.practice_date', todaySpDate),
    (() => {
      let q = supabase.from('conversation_session_authorizations').select('status, authorized_at, authorized_max_seconds, duration_seconds, last_seen_at').eq('user_id', userId);
      if (trialWindow) {
        // Filtered on authorized_at (a precise timestamp), not session_date
        // (a calendar date) — required so a session started just before the
        // trial began, or the instant it ends, is bounded exactly, not by a
        // day-level approximation. Matches "uso anterior ao início do trial
        // não é contado" / "uso posterior ao encerramento não é contado".
        q = q.gte('authorized_at', trialWindow.startIso);
        if (trialWindow.endIso) q = q.lt('authorized_at', trialWindow.endIso);
        return q;
      }
      if (isTrial) {
        // trialWindowMissing — no safe window to bound consumption by.
        // Never falls back to the calendar month for a trial-coded plan.
        return Promise.resolve({ data: [], error: null });
      }
      return q.gte('session_date', monthStartDate).lt('session_date', monthEndDate);
    })(),
    // Standalone "Treinar pronúncia" (Surface #2) — counted from its OWN table
    // by the São Paulo practice_date, EXACTLY as the training endpoints' daily
    // gate does (api/pronunciation-training: completed rows per practice_date).
    // This is what the Home "Treinar pronúncia" card must reflect — never the
    // diary's pronunciation_assessments count.
    supabase
      .from('pronunciation_training_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 'completed')
      .eq('practice_date', todaySpDate),
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
  const listeningStoriesToday = listeningConsumedResult.count ?? 0;

  // Never trusts a stored duration_seconds for a row still 'authorized' —
  // that state means session-complete hasn't (yet, or ever) closed it, so
  // its contribution is derived live from authorized_at instead. See the
  // module doc comment above for why this can't be a flat SUM.
  interface ConversationAuthorizationRow {
    status: 'authorized' | 'completed';
    authorized_at: string;
    authorized_max_seconds: number;
    duration_seconds: number | null;
    last_seen_at: string | null;
  }
  // Named generically: this window is the calendar month for a commercial
  // plan, but the trial's own [assignment.starts_at, assignment.ends_at)
  // window when isTrial (see conversationSecondsResult's query above) — the
  // reduction itself (live-elapsed-clamped vs completed) is identical either way.
  //
  // For a still-'authorized' (open) row the live elapsed is CLAMPED to the last
  // client heartbeat + the stale window when a heartbeat exists: the moment the
  // user leaves the screen / backgrounds / crashes, the pings stop and this
  // stops climbing (bounded to at most one stale window past their real
  // presence) instead of running up to authorized_max_seconds. A row with NO
  // heartbeat (created before the feature) keeps the previous unclamped behavior
  // — a heartbeat is EVIDENCE that lets us clamp; without it we never refund.
  const nowMs = now.getTime();
  const conversationSecondsConsumed = ((conversationSecondsResult.data ?? []) as ConversationAuthorizationRow[]).reduce(
    (sum, r) => {
      if (r.status === 'completed') return sum + (r.duration_seconds ?? 0);
      const authorizedAtMs = new Date(r.authorized_at).getTime();
      const effectiveEndMs = r.last_seen_at
        ? Math.min(nowMs, new Date(r.last_seen_at).getTime() + AUTHORIZATION_HEARTBEAT_STALE_SECONDS * 1000)
        : nowMs;
      const elapsedSeconds = (effectiveEndMs - authorizedAtMs) / 1000;
      return sum + Math.max(0, Math.min(elapsedSeconds, r.authorized_max_seconds));
    },
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

  const pronunciationTrainingToday = pronunciationTrainingCountResult.count ?? 0;
  const pronunciation: PronunciationEntitlements = {
    enabled: pronunciationEnabled,
    evaluations: pronunciationConfigError ? configErrorLimit('day') : computeFeatureState({
      enabled: pronunciationEnabled, unlimited: evaluationsR.unlimited, limit: evaluationsR.limit,
      consumed: pronunciationEvaluationsToday, period: 'day',
    }),
    // Same daily limit capability as evaluations, but consumed by the standalone
    // training surface (pronunciation_training_sessions), so the Home "Treinar
    // pronúncia" card matches that surface's gate instead of the diary's count.
    training: pronunciationConfigError ? configErrorLimit('day') : computeFeatureState({
      enabled: pronunciationEnabled, unlimited: evaluationsR.unlimited, limit: evaluationsR.limit,
      consumed: pronunciationTrainingToday, period: 'day',
    }),
    maxRecordingSeconds: pronunciationConfigError ? 0 : pronunciationMaxRecordingR.limit,
    maxRecordingUnlimited: pronunciationConfigError ? false : pronunciationMaxRecordingR.unlimited,
  };

  // ── Conversation ──────────────────────────────────────────────────────────
  const conversationEnabledR = enabledR(CAPABILITY_KEYS.conversationEnabled);
  // Etapa 2A — trial reads trial_total/trial_total.unlimited INSTEAD OF the
  // monthly pair; every other plan (including invisible/zero-price/internal
  // ones that aren't 'trial') keeps reading monthly exactly as before. This
  // key choice is the only thing isTrial changes about resolveNumericLimit —
  // never a fallback from one pair to the other for the same plan.
  const conversationTimeR = isTrial
    ? limitR(CAPABILITY_KEYS.conversationTrialTotalSeconds, CAPABILITY_KEYS.conversationTrialTotalSecondsUnlimited)
    : limitR(CAPABILITY_KEYS.conversationIncludedSecondsPerMonth, CAPABILITY_KEYS.conversationIncludedSecondsPerMonthUnlimited);
  const conversationMaxRecordingR = limitR(CAPABILITY_KEYS.conversationMaxRecordingSeconds, CAPABILITY_KEYS.conversationMaxRecordingSecondsUnlimited);
  const extraPurchaseR = enabledR(CAPABILITY_KEYS.conversationExtraPurchaseEnabled);
  // trialWindowMissing forces config_error even if trial_total itself is
  // configured: without a real assignment window there is no safe way to
  // bound "consumed", and this must never silently degrade to unlimited or
  // to the monthly window (see the comment above trialWindowMissing).
  const conversationConfigError = conversationEnabledR.configError || conversationTimeR.configError
    || conversationMaxRecordingR.configError || extraPurchaseR.configError || trialWindowMissing;
  const conversationEnabled = conversationConfigError ? false : conversationEnabledR.enabled;
  // 'lifetime' — never resets on a period boundary; computeFeatureState maps
  // its exhaustion to 'trial_balance_exhausted', never 'monthly_limit_reached'.
  const conversationTimePeriod: LimitPeriod = isTrial ? 'lifetime' : 'month';

  const conversation: ConversationEntitlements = {
    enabled: conversationEnabled,
    monthlyTime: conversationConfigError ? configErrorLimit(conversationTimePeriod) : computeFeatureState({
      enabled: conversationEnabled, unlimited: conversationTimeR.unlimited, limit: conversationTimeR.limit,
      consumed: conversationSecondsConsumed, period: conversationTimePeriod, extraAvailable: extraSecondsAvailable,
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
    trialAssignment: trialWindow
      ? { id: plan.assignment_id as string, startsAt: trialWindow.startIso, endsAt: trialWindow.endIso }
      : null,
    // The trial's lifetime total never renews — always null, regardless of
    // conversationConfigError/unlimited, unlike the monthly reset date below.
    monthlyRenewsAt: (isTrial || conversationConfigError || conversationTimeR.unlimited) ? null : resetAtIso,
    resolvedAt: now.toISOString(),
  };
}
