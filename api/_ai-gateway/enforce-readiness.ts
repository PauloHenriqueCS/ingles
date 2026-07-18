/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Pure enforce-readiness computation (Etapa 11, Fase 16 — operational
 * correction), extracted from scripts/ai-gateway-enforce-preflight.ts so it
 * is unit-testable without a live database or filesystem access — the CLI
 * script fetches live facts (price coverage, infra probe, concurrency
 * record) and passes them into computeFeatureReadiness, which does no I/O
 * of its own.
 *
 * See scripts/ai-gateway-enforce-preflight.ts's own module doc comment for
 * the full field-by-field semantics (codeReady, unitEnforcementCodeReady,
 * estimatorReady, pricingReady, costEnforcementCodeReady, infraDeployed,
 * concurrencyValidated, realtimeHardControlReady, enforceReadyUnit/Cost) —
 * not repeated here.
 */

import { createHash } from 'crypto';
import { FEATURE_METADATA, type AiFeatureKey } from './feature-catalog';

// Points at the LATEST Etapa 11 migration whose deployment state this
// module checks readiness against — advances whenever a later migration in
// this lineage changes the enforcement function bodies, so a concurrency
// validation recorded against a stale version can never silently count
// (the live script-hash pin already guarantees this too, since
// 20260718020000 and 20260718030000 each rewrote the validation SQL's
// execution model; this constant keeps the human-facing "which migration
// am I validating" question equally unambiguous).
export const MIGRATION_VERSION = '20260718030000_ai_gateway_enforcement_budget_conflict_ambiguity_fix';

export const FEATURE_PROVIDER_MODEL: Record<AiFeatureKey, { provider: 'openai' | 'azure'; model: string | null }> = {
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
  'tts.synthesize':                        { provider: 'azure',  model: null },
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

export const WIRED_ESTIMATOR_FEATURES = new Set<AiFeatureKey>([
  'writing.correct', 'writing.correct_review', 'writing.compare_rewrite', 'writing.correct_v2_text',
  'writing.generate_topic', 'writing.explain_grammar',
  'pronunciation.generate_text',
  'listening.story_session_generate', 'listening.two_part_generate', 'listening.episode_generate_story',
  'listening.episode_generate_questions', 'listening.episode_translate_synopsis', 'listening.episode_translate_subtitles',
  'conversation.preview_tts', 'tts.synthesize', 'listening.story_session_tts', 'listening.two_part_tts',
  'listening.episode_synthesize_audio', 'pronunciation.assess_text',
]);

export const ACCOUNTING_CHILD_PARENT: Partial<Record<AiFeatureKey, AiFeatureKey>> = {
  'conversation.realtime_usage': 'conversation.webrtc_connect',
};

export const DEAD_UNREACHABLE_FEATURES = new Set<AiFeatureKey>(['writing.evaluate_rewrite']);

export const REALTIME_SESSION_FEATURES = new Set<AiFeatureKey>([
  'conversation.create_session', 'conversation.webrtc_connect', 'conversation.realtime_usage',
]);

export function hasWiredEstimator(featureKey: AiFeatureKey): boolean {
  return !FEATURE_METADATA[featureKey].isBillable || WIRED_ESTIMATOR_FEATURES.has(featureKey);
}

export interface FeatureReadinessInput {
  featureKey: AiFeatureKey;
  hasPriceCoverage: boolean | 'not_applicable';
  infraDeployed: boolean;
  concurrencyValidated: boolean;
  realtimeHardControlLiveTested: boolean;
  // Live fact from _gateway_audit_database_privileges_v1() (see
  // 20260718010000_ai_gateway_enforcement_security_fix.sql): true when
  // anon/authenticated still hold any DML privilege on the 8 Etapa 11
  // tables or EXECUTE on any of its 18 functions. The CLI already folds
  // this into its own infraDeployed (infra can never be "deployed safely"
  // while the raw grants are wrong), but it is surfaced as its own
  // blocker — distinct from infra_not_deployed — so a report never hides
  // *which* half of infra is the problem (missing RPCs vs. wrong grants).
  unsafeDatabasePrivileges: boolean;
}

export interface FeatureReadiness {
  featureKey: AiFeatureKey;
  isDead: boolean;
  isAccountingChild: boolean;
  accountingParent: AiFeatureKey | null;
  hasEstimator: boolean;
  isRealtimeSessionFeature: boolean;

  codeReady: boolean;
  unitEnforcementCodeReady: boolean;
  estimatorReady: boolean;
  pricingReady: boolean;
  costEnforcementCodeReady: boolean;
  realtimeHardControlReady: boolean;
  enforceReadyUnit: boolean;
  enforceReadyCost: boolean;

  blockersUnit: string[];
  blockersCost: string[];
}

/**
 * Pure: no I/O. Every live fact (price coverage, infra deployment,
 * concurrency validation) is an input, not fetched here — this is what
 * makes unit-readiness-never-depends-on-price and
 * infraDeployed/concurrencyValidated-are-inputs-not-constants trivially
 * testable without a database.
 */
export function computeFeatureReadiness(input: FeatureReadinessInput): FeatureReadiness {
  const {
    featureKey, hasPriceCoverage, infraDeployed, concurrencyValidated, realtimeHardControlLiveTested,
    unsafeDatabasePrivileges,
  } = input;

  const isDead = DEAD_UNREACHABLE_FEATURES.has(featureKey);
  const accountingParent = ACCOUNTING_CHILD_PARENT[featureKey] ?? null;
  const isAccountingChild = accountingParent !== null;
  const hasEstimator = hasWiredEstimator(featureKey);
  const estimatorReady = !isDead && (hasEstimator || isAccountingChild);
  const isRealtimeSessionFeature = REALTIME_SESSION_FEATURES.has(featureKey);
  const realtimeHardControlReady = isRealtimeSessionFeature ? realtimeHardControlLiveTested : true;

  // codeReady/unitEnforcementCodeReady/costEnforcementCodeReady share one
  // gate: the generic reservation code (reserve_gateway_usage_v1 +
  // enforcement.ts) is feature-agnostic — the only per-feature variable is
  // whether a valid estimate (or accounting inheritance) exists.
  // costEnforcementCodeReady is deliberately NOT additionally gated by
  // pricingReady: the $ budget-scope mechanism runs (and correctly no-ops
  // without a confirmed price) regardless of whether a price happens to be
  // registered.
  const codeReady = estimatorReady;
  const unitEnforcementCodeReady = codeReady;
  const costEnforcementCodeReady = codeReady;
  const pricingReady = hasPriceCoverage !== false;

  const blockersUnit: string[] = [];
  const blockersCost: string[] = [];
  if (isDead) { blockersUnit.push('dead_unreachable'); blockersCost.push('dead_unreachable'); }
  if (!estimatorReady && !isDead) { blockersUnit.push('missing_estimator'); blockersCost.push('missing_estimator'); }
  if (!pricingReady) blockersCost.push('missing_price');
  if (isRealtimeSessionFeature) { blockersUnit.push('hard_control_not_live_tested'); blockersCost.push('hard_control_not_live_tested'); }
  if (!infraDeployed) { blockersUnit.push('infra_not_deployed'); blockersCost.push('infra_not_deployed'); }
  if (unsafeDatabasePrivileges) { blockersUnit.push('unsafe_database_privileges'); blockersCost.push('unsafe_database_privileges'); }
  if (!concurrencyValidated) { blockersUnit.push('concurrency_not_validated'); blockersCost.push('concurrency_not_validated'); }

  // unsafeDatabasePrivileges gates enforceReady* directly, not just via
  // infraDeployed — the caller (the CLI) already folds it into infraDeployed
  // before calling this function, but this function must never trust that:
  // a blockers list containing 'unsafe_database_privileges' can never
  // coexist with enforceReadyUnit/Cost=true, regardless of what infraDeployed
  // was passed as.
  const enforceReadyUnit = unitEnforcementCodeReady && realtimeHardControlReady && infraDeployed && !unsafeDatabasePrivileges && concurrencyValidated;
  const enforceReadyCost = costEnforcementCodeReady && pricingReady && realtimeHardControlReady && infraDeployed && !unsafeDatabasePrivileges && concurrencyValidated;

  return {
    featureKey, isDead, isAccountingChild, accountingParent, hasEstimator, isRealtimeSessionFeature,
    codeReady, unitEnforcementCodeReady, estimatorReady, pricingReady, costEnforcementCodeReady,
    realtimeHardControlReady, enforceReadyUnit, enforceReadyCost, blockersUnit, blockersCost,
  };
}

/** SHA-256 hex digest of the manual-validation SQL file's exact content. Pure — takes content, not a path, so it's testable without filesystem access. */
export function hashValidationScript(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
