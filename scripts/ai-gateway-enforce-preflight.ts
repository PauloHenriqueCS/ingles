#!/usr/bin/env tsx
/**
 * CLI: Enforce-readiness preflight (Etapa 11, Fase 16).
 *
 * Server-only, READ-ONLY — never writes to any table, and never changes
 * gateway_mode/runtime_status for any scope. This script exists to answer
 * one question honestly, per feature: "if we flipped this feature's
 * gateway_mode to 'enforce' right now, would the pipeline actually protect
 * anything, or would it silently no-op / fail closed for the wrong reason?"
 *
 * No enforce activation is permitted while a feature's `blockers` is
 * non-empty. This script does not enforce that rule itself (it has no way
 * to block a manual dashboard/SQL change) — it is a manual/CI audit step to
 * run BEFORE making that change, and its output belongs in the review that
 * approves it.
 *
 * Checks performed, all live against the real database (never fabricated):
 *   1. Runtime control  — GatewayPolicyResolver resolves a real policy for
 *      the feature (proves ai_runtime_controls doesn't error/misresolve).
 *   2. Entitlement mapping — whether entitlements.ts's
 *      CAPABILITY_KEY_BY_METRIC has an entry for this feature's natural
 *      quota metric. Missing != broken: entitlement resolution itself still
 *      works (source='no_plan_configured', unlimited) — it just means no
 *      quota can be enforced yet for that feature specifically.
 *   3. Price coverage — an exact (provider, model) match against
 *      provider_pricing for billable features. Coarse in one sense (does
 *      not verify every individual metric_key the feature emits — see
 *      cost-calculator.ts's own allBillableMetricsPriced for the
 *      authoritative per-event signal) but real: no fabricated data, a
 *      live count(*) against the actual pricing table.
 *   4. Estimator wiring — NOT "does an estimator function exist in
 *      estimators.ts" (they all do, as a pure library) but "does any real
 *      call site actually populate GatewayCallContext.estimatedMetrics for
 *      this feature" (grep-verified: none do, as of this stage — see the
 *      HAS_WIRED_ESTIMATOR table below and its comment). A billable feature
 *      with no wired estimator has no real reservation sizing beyond the
 *      trivial provider_requests-count default, so it cannot honestly claim
 *      quota/budget protection in enforce mode yet.
 *   5. Hard session control — true only for a feature with a proven,
 *      unconditional server-side termination mechanism. None qualify today
 *      (see api/conversation/[...slug].ts's handleSessionControl doc
 *      comment for the full audit of OpenAI's Realtime hangup endpoint and
 *      why this app's ephemeral-token architecture can't reach it without a
 *      larger proxy redesign).
 *   6. Fase 14 infra (rate limit / dedupe / reservation / breaker RPCs) —
 *      probed live via a deliberately-malformed typed argument (e.g. an
 *      invalid UUID) that forces Postgres to fail the argument cast BEFORE
 *      the function body ever runs. This distinguishes "function does not
 *      exist" (PostgREST error code PGRST202) from "function exists" (any
 *      other error) without ever executing a real write, regardless of
 *      whether the migration has been applied. get_gateway_breaker_state_v1
 *      is a genuine read-only getter, so it alone is called normally as the
 *      proxy for breaker-infra readiness.
 *
 * Usage:
 *   npx tsx scripts/ai-gateway-enforce-preflight.ts [--json]
 */

import 'dotenv/config';
import {
  AI_FEATURE_KEYS,
  FEATURE_METADATA,
  GatewayPolicyResolver,
  CAPABILITY_KEY_BY_METRIC,
  getSharedServiceClient,
  type AiFeatureKey,
} from '../api/_ai-gateway/index';

if (!process.env.VITE_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  process.exit(1);
}

const JSON_OUTPUT = process.argv.includes('--json');

// ── Feature → (provider, model) hint table ──────────────────────────────────
// Derived by reading each handler's real provider/model constants (Etapa 11
// Fase 0/13 audit) — not guessed. Used only for the price-coverage check
// below. null model = non-billable (provider_requests only) or an Azure
// Speech feature (provider_pricing has zero azure rows at all today, so an
// exact model match would add no signal beyond "provider has zero rows").
const FEATURE_PROVIDER_MODEL: Record<AiFeatureKey, { provider: 'openai' | 'azure'; model: string | null }> = {
  'conversation.preview_tts':              { provider: 'openai', model: 'tts-1' },
  'conversation.create_session':           { provider: 'openai', model: 'gpt-realtime-2.1-mini' },
  'conversation.webrtc_connect':           { provider: 'openai', model: 'gpt-realtime-2.1-mini' },
  'conversation.realtime_usage':           { provider: 'openai', model: 'gpt-realtime-2.1-mini' },
  'writing.correct':                       { provider: 'openai', model: 'gpt-4o-mini' },
  'writing.correct_review':                { provider: 'openai', model: 'gpt-4o-mini' },
  'writing.compare_rewrite':               { provider: 'openai', model: 'gpt-4o-mini' },
  'writing.correct_v2_text':               { provider: 'openai', model: 'gpt-4o-mini' },
  'writing.generate_topic':                { provider: 'openai', model: 'gpt-4o-mini' },
  'writing.explain_grammar':               { provider: 'openai', model: 'gpt-4o-mini' },
  'writing.evaluate_rewrite':              { provider: 'openai', model: 'gpt-4o-mini' },
  'pronunciation.generate_text':           { provider: 'openai', model: 'gpt-4o-mini' },
  'pronunciation.get_azure_token':         { provider: 'azure',  model: null },
  'pronunciation.start_assessment':        { provider: 'azure',  model: null },
  'pronunciation.assess_text':             { provider: 'azure',  model: null },
  'tts.synthesize':                        { provider: 'openai', model: 'tts-1' },
  'listening.story_session_generate':      { provider: 'openai', model: 'gpt-4o-mini' },
  'listening.story_session_tts':           { provider: 'azure',  model: null },
  'listening.two_part_generate':           { provider: 'openai', model: 'gpt-4o-mini' },
  'listening.two_part_tts':                { provider: 'azure',  model: null },
  'listening.episode_generate_story':      { provider: 'openai', model: 'gpt-4o' },
  'listening.episode_generate_questions':  { provider: 'openai', model: 'gpt-4o-mini' },
  'listening.episode_translate_synopsis':  { provider: 'openai', model: 'gpt-4o-mini' },
  'listening.episode_translate_subtitles': { provider: 'openai', model: 'gpt-4o-mini' },
  'listening.episode_synthesize_audio':    { provider: 'azure',  model: null },
};

// ── Estimator wiring ─────────────────────────────────────────────────────────
// grep-verified against every handler in api/** and src/services/listening/**
// as of this stage: no call site sets GatewayCallContext.estimatedMetrics.
// Non-billable features (provider_requests-only) are the one exception that
// counts as "wired" — enforcement.ts's own default
// (`context.estimatedMetrics ?? [{metricKey:'provider_requests', quantity:
// context.maxPhysicalAttempts ?? 1}]`) already gives them a real, always-
// available reservation dimension with nothing further to wire.
function hasWiredEstimator(featureKey: AiFeatureKey): boolean {
  return !FEATURE_METADATA[featureKey].isBillable;
}

// ── Dead/unreachable features ────────────────────────────────────────────────
// grep-verified: no call site anywhere in api/** or src/** references this
// featureKey outside the catalog itself and its own tests.
const DEAD_UNREACHABLE_FEATURES = new Set<AiFeatureKey>(['writing.evaluate_rewrite']);

// ── Fase 14 infra probe ──────────────────────────────────────────────────────

const PGRST_FUNCTION_NOT_FOUND = 'PGRST202';
const DUMMY_UUID_INVALID = 'not-a-uuid'; // deliberately malformed — forces a type-cast error before the function body runs, never a real write, regardless of whether the function exists

async function probeRpcExists(
  supabase: ReturnType<typeof getSharedServiceClient>,
  name: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  const { error } = await supabase.rpc(name, args);
  if (!error) return true;
  return (error as { code?: string }).code !== PGRST_FUNCTION_NOT_FOUND;
}

async function probeInfra(supabase: ReturnType<typeof getSharedServiceClient>) {
  const [rateLimit, dedupe, reservation, breaker] = await Promise.all([
    probeRpcExists(supabase, 'check_and_increment_rate_limit', {
      p_user_id: DUMMY_UUID_INVALID, p_route_key: 'preflight:probe', p_window_seconds: 60, p_max_requests: 1,
    }),
    probeRpcExists(supabase, 'begin_gateway_idempotent_op_v1', {
      p_scope: 'preflight:probe', p_idempotency_key: 'preflight:probe', p_lease_seconds: 'not-a-number',
    }),
    probeRpcExists(supabase, 'reserve_gateway_usage_v1', {
      p_idempotency_key: 'preflight:probe', p_user_id: DUMMY_UUID_INVALID, p_initiated_by_user_id: null,
      p_feature_key: 'preflight:probe', p_provider: 'openai', p_model: null, p_metrics: [], p_estimated_cost_usd: null,
      p_expires_in_seconds: 1,
    }),
    // get_gateway_breaker_state_v1 is a genuine read-only getter — called
    // normally (no malformed-arg trick needed) as the proxy for the whole
    // breaker RPC pair (it and record_gateway_breaker_outcome_v1 are always
    // added together in the same migration).
    probeRpcExists(supabase, 'get_gateway_breaker_state_v1', {
      p_provider: 'preflight-probe-provider', p_model: null, p_feature_key: 'preflight-probe-feature',
    }),
  ]);
  return { rateLimit, dedupe, reservation, breaker };
}

// ── Classification ────────────────────────────────────────────────────────

type Classification =
  | 'legacy_ready' | 'observe_ready' | 'enforce_ready'
  | 'blocked_missing_price' | 'blocked_missing_estimator'
  | 'blocked_no_hard_session_control' | 'dead_unreachable';

interface FeatureReadiness {
  featureKey: AiFeatureKey;
  currentGatewayMode: string;
  currentRuntimeStatus: string;
  provider: string;
  isBillable: boolean;
  hasEntitlementMapping: boolean;
  hasPriceCoverage: boolean | 'not_applicable';
  hasEstimator: boolean;
  hasHardSessionControl: boolean;
  classification: Classification;
  blockers: string[];
}

const REALTIME_SESSION_FEATURES = new Set<AiFeatureKey>(['conversation.webrtc_connect', 'conversation.realtime_usage']);

async function assessFeature(
  featureKey: AiFeatureKey,
  policyResolver: GatewayPolicyResolver,
  supabase: ReturnType<typeof getSharedServiceClient>,
): Promise<FeatureReadiness> {
  const meta = FEATURE_METADATA[featureKey];
  const { provider, model } = FEATURE_PROVIDER_MODEL[featureKey];
  const blockers: string[] = [];

  const policy = await policyResolver.resolvePolicy({
    featureKey, provider, actorType: 'user', executionLocation: meta.executionLocation,
  });

  const hasEntitlementMapping = Object.keys(CAPABILITY_KEY_BY_METRIC).some((k) => k.startsWith(`${featureKey}:`));

  let hasPriceCoverage: boolean | 'not_applicable' = 'not_applicable';
  if (meta.isBillable) {
    let query = supabase.from('provider_pricing').select('id', { count: 'exact', head: true })
      .eq('provider', provider).eq('is_active', true);
    query = model != null ? query.eq('model', model) : query.is('model', null);
    const { count } = await query;
    hasPriceCoverage = (count ?? 0) > 0;
    if (!hasPriceCoverage) blockers.push('missing_price');
  }

  const hasEstimator = hasWiredEstimator(featureKey);
  if (!hasEstimator) blockers.push('missing_estimator');

  const hasHardSessionControl = false; // true for no feature today — see module doc comment
  if (REALTIME_SESSION_FEATURES.has(featureKey)) blockers.push('no_hard_session_control');

  const isDead = DEAD_UNREACHABLE_FEATURES.has(featureKey);
  if (isDead) blockers.push('dead_unreachable');

  let classification: Classification;
  if (isDead) classification = 'dead_unreachable';
  else if (REALTIME_SESSION_FEATURES.has(featureKey)) classification = 'blocked_no_hard_session_control';
  else if (hasPriceCoverage === false) classification = 'blocked_missing_price';
  else if (!hasEstimator) classification = 'blocked_missing_estimator';
  else classification = 'enforce_ready';

  return {
    featureKey,
    currentGatewayMode: policy.gatewayMode,
    currentRuntimeStatus: policy.runtimeStatus,
    provider,
    isBillable: meta.isBillable,
    hasEntitlementMapping,
    hasPriceCoverage,
    hasEstimator,
    hasHardSessionControl,
    classification,
    blockers,
  };
}

async function main() {
  const supabase = getSharedServiceClient();
  const policyResolver = new GatewayPolicyResolver(supabase, 0); // ttlMs=0 — always fresh, this is a one-shot audit

  const infra = await probeInfra(supabase);
  const infraBlockers = Object.entries(infra).filter(([, ok]) => !ok).map(([name]) => `infra_missing:${name}`);

  const results: FeatureReadiness[] = [];
  for (const featureKey of AI_FEATURE_KEYS) {
    const r = await assessFeature(featureKey, policyResolver, supabase);
    // Infra readiness is a global gate layered on top of the per-feature
    // structural classification computed above — kept separate rather than
    // folded into the fixed Fase-13 classification vocabulary, so the report
    // still shows what WOULD block a feature once infra is deployed.
    if (infraBlockers.length > 0 && r.classification === 'enforce_ready') {
      r.blockers.push(...infraBlockers);
    }
    results.push(r);
  }

  const enforceReadyCount = results.filter((r) => r.classification === 'enforce_ready' && r.blockers.length === 0).length;

  if (JSON_OUTPUT) {
    console.log(JSON.stringify({ infra, infraBlockers, features: results, enforceReadyCount }, null, 2));
    return;
  }

  console.log('AI Gateway — enforce-readiness preflight (Etapa 11, Fase 16)');
  console.log('Read-only. Never changes gateway_mode or runtime_status.\n');

  console.log('Fase 14 infra (rate limit / dedupe / reservation / breaker RPCs):');
  console.log(`  rate_limit:  ${infra.rateLimit ? 'present' : 'MISSING'}`);
  console.log(`  dedupe:      ${infra.dedupe ? 'present' : 'MISSING'}`);
  console.log(`  reservation: ${infra.reservation ? 'present' : 'MISSING'}`);
  console.log(`  breaker:     ${infra.breaker ? 'present' : 'MISSING'}`);
  if (infraBlockers.length > 0) {
    console.log('  → migration not yet applied: no feature can safely enter enforce until this is deployed.\n');
  } else {
    console.log('');
  }

  for (const r of results) {
    console.log(`${r.featureKey}`);
    console.log(`  current: gatewayMode=${r.currentGatewayMode} runtimeStatus=${r.currentRuntimeStatus}`);
    console.log(`  provider=${r.provider} billable=${r.isBillable} entitlementMapping=${r.hasEntitlementMapping} priceCoverage=${r.hasPriceCoverage} estimator=${r.hasEstimator}`);
    console.log(`  classification: ${r.classification}`);
    console.log(`  blockers: ${r.blockers.length > 0 ? r.blockers.join(', ') : '(none)'}`);
    console.log('');
  }

  console.log(`Summary: ${enforceReadyCount}/${results.length} features have zero blockers (infra deployment pending: ${infraBlockers.length > 0}).`);
  console.log('No enforce activation is permitted for any feature with a non-empty blockers list.');
}

main().catch((err) => {
  console.error('Preflight failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
