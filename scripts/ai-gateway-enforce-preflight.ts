#!/usr/bin/env tsx
/**
 * CLI: Enforce-readiness preflight (Etapa 11, Fase 16 — corrected).
 *
 * Server-only, READ-ONLY — never writes to any table, and never changes
 * gateway_mode/runtime_status for any scope. This script exists to answer,
 * honestly and per feature: "if we flipped this feature's gateway_mode to
 * 'enforce' right now, would the pipeline actually protect anything?"
 *
 * Correction to the first version of this script: "missing price" no
 * longer collapses an entire feature into one "blocked" label. Quota
 * (characters/seconds/requests/tokens), rate limiting, dedupe, kill-switch,
 * and breaker protection never need a price at all — only USD BUDGET
 * enforcement does. So this script reports two independent dimensions per
 * feature instead of one blended classification:
 *
 *   unitEnforcementReady  — quota/rate/dedupe/breaker/kill-switch could all
 *                            work today (estimator wired, not dead).
 *   costEnforcementReady  — USD budget enforcement specifically could work
 *                            (price coverage confirmed, or the feature is
 *                            non-billable so no price is even needed).
 *
 * Both are also reported as `codeReady` (would this be true once the Fase
 * 14 migration is deployed) vs. the migration's actual live deployment
 * state — so this script never collapses to "0/25 ready" just because the
 * migration hasn't been applied remotely yet; it says exactly that instead.
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
 *      accumulated quota can be enforced yet for that feature specifically
 *      (the atomic reservation still protects a per-call ceiling regardless).
 *   3. Price coverage — an exact (provider, model) match against
 *      provider_pricing for billable features. Coarse in one sense (does
 *      not verify every individual metric_key the feature emits — see
 *      cost-calculator.ts's own allBillableMetricsPriced for the
 *      authoritative per-event signal) but real: no fabricated data, a
 *      live count(*) against the actual pricing table.
 *   4. Estimator wiring — NOT "does an estimator function exist in
 *      estimators.ts" (they all do, as a pure library) but "does any real
 *      call site actually populate GatewayCallContext.estimatedMetrics for
 *      this feature" — see WIRED_ESTIMATOR_FEATURES below, kept in sync
 *      with the actual call sites (grep-verifiable; drift would be a bug).
 *   5. Hard session control — realtimeHardControlReady is true only once a
 *      server-side termination path is both implemented AND live-verified
 *      against production OpenAI. As of this correction, call_id capture +
 *      backend hangup ARE implemented (see api/conversation/[...slug].ts's
 *      handleSessionControl / hangupRealtimeCall) but have NOT been
 *      live-tested against a real OpenAI Realtime session in this
 *      environment (no way to make a real, billed connection from here) —
 *      so this still reports false, with a distinct blocker
 *      (`hard_control_not_live_tested`) rather than the old, less accurate
 *      "no_hard_session_control" (which implied nothing exists at all).
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
// Kept in sync with real call sites (grep for `estimatedMetrics:` under
// api/** and src/services/listening/**  — drift here is a bug, not a design
// choice). Non-billable features count as wired unconditionally:
// enforcement.ts's own default (`context.estimatedMetrics ??
// [{metricKey:'provider_requests', quantity: context.maxPhysicalAttempts ??
// 1}]`) already gives them a real, always-available reservation dimension.
// Realtime features (webrtc_connect/realtime_usage/create_session) are
// wired via estimateRealtimeSessionSeconds/estimateProviderRequests at
// their own call sites (api/conversation/[...slug].ts).
const WIRED_ESTIMATOR_FEATURES = new Set<AiFeatureKey>([
  'writing.correct', 'writing.correct_review', 'writing.compare_rewrite', 'writing.correct_v2_text',
  'writing.generate_topic', 'writing.explain_grammar',
  'pronunciation.generate_text',
  'listening.story_session_generate', 'listening.two_part_generate', 'listening.episode_generate_story',
  'listening.episode_generate_questions', 'listening.episode_translate_synopsis', 'listening.episode_translate_subtitles',
]);

function hasWiredEstimator(featureKey: AiFeatureKey): boolean {
  return !FEATURE_METADATA[featureKey].isBillable || WIRED_ESTIMATOR_FEATURES.has(featureKey);
}

// ── Dead/unreachable features ────────────────────────────────────────────────
// grep-verified: no call site anywhere in api/** or src/** references this
// featureKey outside the catalog itself and its own tests.
const DEAD_UNREACHABLE_FEATURES = new Set<AiFeatureKey>(['writing.evaluate_rewrite']);

// ── Realtime hard session control ────────────────────────────────────────────
// Includes conversation.create_session: it is what authorizes the
// ai_provider_sessions row hangupRealtimeCall later acts on, so its
// enforce-readiness is coupled to the same unproven termination path —
// explicitly required to stay false alongside webrtc_connect/realtime_usage
// until a real smoke test proves it.
const REALTIME_SESSION_FEATURES = new Set<AiFeatureKey>([
  'conversation.create_session', 'conversation.webrtc_connect', 'conversation.realtime_usage',
]);
// Implemented (call_id capture + backend hangup — see
// api/conversation/[...slug].ts) but not live-verified against production
// OpenAI in this environment. Flip to true only after a real smoke test
// (see the Etapa 11 correction's test list, item "smoke real obrigatório")
// confirms hangup actually terminates a live session.
const REALTIME_HARD_CONTROL_LIVE_TESTED = false;

// ── Global gates that no per-feature code change can satisfy ─────────────────
// enforceReady can NEVER be true while either of these is false, regardless
// of any single feature's own code readiness. Both are hardcoded false in
// this delivery — flip only after actually doing the thing named, never
// speculatively:
//   MIGRATION_APPLIED_REMOTELY — 20260718000000_ai_gateway_enforcement.sql
//     has not been applied to any environment by this delivery (confirmed
//     live: ai_gateway_quota_buckets does not exist remotely).
//   CONCURRENCY_VALIDATED — supabase/manual-validation/ai-gateway-
//     enforcement-concurrency.sql's 7 scenarios have not been executed
//     against a real Postgres (no local instance available in this
//     environment). Atomicity is reasoned-through, not proven.
const MIGRATION_APPLIED_REMOTELY = false;
const CONCURRENCY_VALIDATED = false;

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
      p_feature_key: 'preflight:probe', p_provider: 'openai', p_model: null, p_metrics: [], p_budget_scopes: [],
      p_estimated_cost_usd: null, p_expires_in_seconds: 1,
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

// ── Assessment ─────────────────────────────────────────────────────────────

interface FeatureReadiness {
  featureKey: AiFeatureKey;
  currentGatewayMode: string;
  currentRuntimeStatus: string;
  provider: string;
  isBillable: boolean;
  isDead: boolean;
  hasEntitlementMapping: boolean;
  hasPriceCoverage: boolean | 'not_applicable';
  hasEstimator: boolean;
  isRealtimeSessionFeature: boolean;
  // codeReady* = would be true if the Fase 14 migration were deployed —
  // never conflated with whether it actually is (see infraDeployed below).
  unitEnforcementCodeReady: boolean;
  costEnforcementCodeReady: boolean;
  realtimeHardControlReady: boolean;
  // codeReady = every code-level dimension satisfied (unit + cost + hard
  // control where applicable), independent of infra/concurrency.
  codeReady: boolean;
  // enforceReady = the ONLY field that means "safe to flip gateway_mode to
  // enforce right now." False whenever codeReady is false, OR infra isn't
  // deployed, OR concurrency hasn't been validated — no per-feature code
  // change can ever make this true on its own while either global gate is
  // false. As of this delivery this is false for all 25 features.
  enforceReady: boolean;
  blockers: string[];
}

async function assessFeature(
  featureKey: AiFeatureKey,
  policyResolver: GatewayPolicyResolver,
  supabase: ReturnType<typeof getSharedServiceClient>,
  infraDeployed: boolean,
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
  }

  const hasEstimator = hasWiredEstimator(featureKey);
  const isDead = DEAD_UNREACHABLE_FEATURES.has(featureKey);
  const isRealtimeSessionFeature = REALTIME_SESSION_FEATURES.has(featureKey);

  if (isDead) blockers.push('dead_unreachable');
  if (!hasEstimator) blockers.push('missing_estimator');
  if (hasPriceCoverage === false) blockers.push('missing_price');
  if (isRealtimeSessionFeature) blockers.push('hard_control_not_live_tested');
  if (!infraDeployed) blockers.push('infra_not_deployed');
  if (!CONCURRENCY_VALIDATED) blockers.push('concurrency_not_validated');
  if (!MIGRATION_APPLIED_REMOTELY) blockers.push('migration_not_applied');

  const unitEnforcementCodeReady = !isDead && hasEstimator;
  const costEnforcementCodeReady = !isDead && hasPriceCoverage !== false; // true|'not_applicable' both count as ready
  const realtimeHardControlReady = isRealtimeSessionFeature ? REALTIME_HARD_CONTROL_LIVE_TESTED : true; // n/a features trivially "ready" on this dimension
  const codeReady = unitEnforcementCodeReady && costEnforcementCodeReady && realtimeHardControlReady;
  const enforceReady = codeReady && infraDeployed && CONCURRENCY_VALIDATED && MIGRATION_APPLIED_REMOTELY;

  return {
    featureKey,
    currentGatewayMode: policy.gatewayMode,
    currentRuntimeStatus: policy.runtimeStatus,
    provider,
    isBillable: meta.isBillable,
    isDead,
    hasEntitlementMapping,
    hasPriceCoverage,
    hasEstimator,
    isRealtimeSessionFeature,
    unitEnforcementCodeReady,
    costEnforcementCodeReady,
    realtimeHardControlReady,
    codeReady,
    enforceReady,
    blockers,
  };
}

async function main() {
  const supabase = getSharedServiceClient();
  const policyResolver = new GatewayPolicyResolver(supabase, 0); // ttlMs=0 — always fresh, this is a one-shot audit

  const infra = await probeInfra(supabase);
  const infraDeployed = infra.rateLimit && infra.dedupe && infra.reservation && infra.breaker;

  const results: FeatureReadiness[] = [];
  for (const featureKey of AI_FEATURE_KEYS) {
    results.push(await assessFeature(featureKey, policyResolver, supabase, infraDeployed));
  }

  const unitCodeReadyCount = results.filter((r) => r.unitEnforcementCodeReady).length;
  const costCodeReadyCount = results.filter((r) => r.costEnforcementCodeReady).length;
  const codeReadyCount = results.filter((r) => r.codeReady).length;
  const enforceReadyCount = results.filter((r) => r.enforceReady).length;

  if (JSON_OUTPUT) {
    console.log(JSON.stringify({
      infra, infraDeployed, concurrencyValidated: CONCURRENCY_VALIDATED, migrationAppliedRemotely: MIGRATION_APPLIED_REMOTELY,
      features: results,
      summary: { unitCodeReadyCount, costCodeReadyCount, codeReadyCount, enforceReadyCount, totalFeatures: results.length },
    }, null, 2));
    return;
  }

  console.log('AI Gateway — enforce-readiness preflight (Etapa 11, Fase 16 — corrected)');
  console.log('Read-only. Never changes gateway_mode or runtime_status.\n');

  console.log('Fase 14 infra (rate limit / dedupe / reservation / breaker RPCs) — DATABASE deployment state:');
  console.log(`  rate_limit:  ${infra.rateLimit ? 'present' : 'MISSING'}`);
  console.log(`  dedupe:      ${infra.dedupe ? 'present' : 'MISSING'}`);
  console.log(`  reservation: ${infra.reservation ? 'present' : 'MISSING'}`);
  console.log(`  breaker:     ${infra.breaker ? 'present' : 'MISSING'}`);
  console.log(`  → infraDeployed=${infraDeployed}. This is independent of each feature's CODE readiness below.\n`);

  for (const r of results) {
    console.log(`${r.featureKey}`);
    console.log(`  current: gatewayMode=${r.currentGatewayMode} runtimeStatus=${r.currentRuntimeStatus}`);
    console.log(`  provider=${r.provider} billable=${r.isBillable} entitlementMapping=${r.hasEntitlementMapping} priceCoverage=${r.hasPriceCoverage} estimator=${r.hasEstimator}`);
    console.log(`  unitEnforcementCodeReady=${r.unitEnforcementCodeReady}  costEnforcementCodeReady=${r.costEnforcementCodeReady}${r.isRealtimeSessionFeature ? `  realtimeHardControlReady=${r.realtimeHardControlReady}` : ''}`);
    console.log(`  codeReady=${r.codeReady}  enforceReady=${r.enforceReady}`);
    console.log(`  blockers: ${r.blockers.length > 0 ? r.blockers.join(', ') : '(none)'}`);
    console.log('');
  }

  console.log('Summary (code-level, i.e. "would this work once the migration is deployed"):');
  console.log(`  unit (quota/rate/dedupe/breaker/kill-switch) code-ready: ${unitCodeReadyCount}/${results.length}`);
  console.log(`  cost (USD budget) code-ready:                           ${costCodeReadyCount}/${results.length}`);
  console.log(`  fully codeReady (unit + cost + hard-control where applicable): ${codeReadyCount}/${results.length}`);
  console.log('Summary (global gates — none of these can be satisfied by any per-feature code change):');
  console.log(`  infra deployed:        ${infraDeployed}`);
  console.log(`  concurrency validated: ${CONCURRENCY_VALIDATED}  (see supabase/manual-validation/ai-gateway-enforcement-concurrency.sql)`);
  console.log(`  migration applied:     ${MIGRATION_APPLIED_REMOTELY}`);
  console.log(`\n  enforceReady (the ONLY field meaning "safe to flip gateway_mode to enforce"): ${enforceReadyCount}/${results.length}`);
  console.log('\nNo enforce activation is permitted for any feature with a non-empty blockers list, and enforceReady is false for every feature until infra is deployed, concurrency is validated, AND the migration is applied.');
}

main().catch((err) => {
  console.error('Preflight failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
