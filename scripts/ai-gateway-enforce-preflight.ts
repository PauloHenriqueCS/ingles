#!/usr/bin/env tsx
/**
 * CLI: Enforce-readiness preflight (Etapa 11, Fase 16 — operational correction).
 *
 * Server-only, READ-ONLY — never writes to any table, and never changes
 * gateway_mode/runtime_status for any scope. This script exists to answer,
 * honestly and per feature: "which enforcement dimensions could actually
 * work today, and which are still blocked, and why?"
 *
 * Nothing in this file is a hardcoded readiness boolean. Every field is
 * either:
 *   - a real code fact (does a wired estimator/accounting-parent exist —
 *     grep-verifiable against the call sites listed below), or
 *   - a live database fact (does the table/RPC exist; is there a matching
 *     row in ai_gateway_concurrency_validations for the CURRENT migration
 *     version AND the CURRENT live hash of the manual-validation SQL file).
 * infraDeployed and concurrencyValidated in particular can never be
 * satisfied by any code change alone — they require the migration to
 * actually be applied and the 7 manual SQL scenarios to actually have been
 * run and recorded, respectively.
 *
 * Nine fields per feature (never conflated):
 *   codeReady                — the implementation this feature needs exists
 *                               (estimator/accounting-parent resolved, not dead).
 *   unitEnforcementCodeReady — quota/rate/dedupe/reservation-by-unit code path
 *                               implemented. NEVER depends on price.
 *   estimatorReady           — a wired estimator OR a valid accounting-parent
 *                               relationship (see ACCOUNTING_CHILD_FEATURES).
 *   pricingReady             — provider_pricing coverage confirmed, or the
 *                               feature is non-billable (price not needed).
 *   costEnforcementCodeReady — the $ budget-reservation code path exists.
 *                               Also never depends on whether a price is
 *                               actually registered — only on whether the
 *                               generic budget-scope mechanism is reachable
 *                               for this feature (same gate as codeReady).
 *   infraDeployed             — GLOBAL. Live-probed: do the Fase 14
 *                               tables/RPCs actually exist in this database,
 *                               AND (security fix 20260718010000) are
 *                               anon/authenticated actually stripped of
 *                               every privilege on them — "deployed" can
 *                               never mean "deployed but publicly writable."
 *                               A privilege gap alone also surfaces as its
 *                               own distinct blocker, unsafe_database_privileges,
 *                               never silently folded into infra_not_deployed.
 *   concurrencyValidated      — GLOBAL. Live-queried: is there a 'passed'
 *                               row in ai_gateway_concurrency_validations
 *                               whose migration_version and
 *                               validation_script_sha256 match right now.
 *   realtimeHardControlReady — true only once real-time session termination
 *                               has been implemented AND live-verified
 *                               against production OpenAI (never true today).
 *   enforceReadyUnit/Cost     — the only fields meaning "safe to enforce this
 *                               dimension right now." A TTS feature with no
 *                               price can be enforceReadyUnit=true (character
 *                               quota) while enforceReadyCost=false (no $
 *                               budget) — reported separately, never
 *                               collapsed into one boolean that hides which
 *                               half is actually safe.
 *
 * conversation.realtime_usage is classified accounting_child: it is not an
 * independent user-initiated action, it is the billing record of an
 * already-reserved session (its physical events are relayed post-hoc via
 * /session-usage, keyed to the SAME ai_provider_sessions row
 * conversation.webrtc_connect's own reservation would cover — see
 * api/conversation/[...slug].ts). Requiring it to have its own independent
 * pre-call estimator would mean reserving twice for the same session, which
 * Fase 5 explicitly forbids. Its estimatorReady is inherited from its
 * accounting parent instead.
 *
 * Usage:
 *   npx tsx scripts/ai-gateway-enforce-preflight.ts [--json]
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';
import {
  AI_FEATURE_KEYS,
  FEATURE_METADATA,
  GatewayPolicyResolver,
  CAPABILITY_KEY_BY_METRIC,
  getSharedServiceClient,
  type AiFeatureKey,
} from '../api/_ai-gateway/index';
// Pure readiness computation lives in api/_ai-gateway/enforce-readiness.ts —
// shared verbatim with its unit tests (api/__tests__/enforce-readiness.test.ts)
// so this CLI and its test suite can never drift into two different notions
// of "ready." This script only supplies the live facts (DB probes, policy
// resolution) that module doesn't fetch itself.
import {
  MIGRATION_VERSION,
  FEATURE_PROVIDER_MODEL,
  computeFeatureReadiness,
  hashValidationScript,
  type FeatureReadiness as PureFeatureReadiness,
} from '../api/_ai-gateway/enforce-readiness';

if (!process.env.VITE_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  process.exit(1);
}

const JSON_OUTPUT = process.argv.includes('--json');

const VALIDATION_SCRIPT_PATH = resolvePath(__dirname, '..', 'supabase', 'manual-validation', 'ai-gateway-enforcement-concurrency.sql');

// Implemented (call_id capture + backend hangup — see
// api/conversation/[...slug].ts) but not live-verified against production
// OpenAI in this environment. Flip to true only after a real smoke test
// confirms hangup actually terminates a live session with a real call_id.
const REALTIME_HARD_CONTROL_LIVE_TESTED = false;

// ── Fase 14 infra probe (infraDeployed) ───────────────────────────────────────

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

// ── unsafeDatabasePrivileges probe (Etapa 11 security fix) ─────────────────
// Live-queried via _gateway_audit_database_privileges_v1() — introduced by
// 20260718010000_ai_gateway_enforcement_security_fix.sql specifically for
// this check. That function itself only calls has_table_privilege/
// has_function_privilege (no I/O, no side effect); it is REVOKEd from
// anon/authenticated same as every other Etapa 11 function, reachable only
// via this script's service-role connection. If the function itself is
// missing (security-fix migration not yet applied), this fails closed:
// unsafeDatabasePrivileges = true, exactly like every other infra probe in
// this file when its target doesn't exist yet.
const PRIVILEGE_AUDIT_RPC = '_gateway_audit_database_privileges_v1';

async function probeUnsafeDatabasePrivileges(
  supabase: ReturnType<typeof getSharedServiceClient>,
): Promise<{ unsafe: boolean; unsafeTables: string[]; unsafeFunctions: string[] }> {
  const { data, error } = await supabase.rpc(PRIVILEGE_AUDIT_RPC);
  if (error || !data) {
    return { unsafe: true, unsafeTables: [], unsafeFunctions: [] };
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    { unsafe_tables: string[] | null; unsafe_functions: string[] | null } | undefined;
  const unsafeTables = row?.unsafe_tables ?? [];
  const unsafeFunctions = row?.unsafe_functions ?? [];
  return { unsafe: unsafeTables.length > 0 || unsafeFunctions.length > 0, unsafeTables, unsafeFunctions };
}

async function probeInfra(supabase: ReturnType<typeof getSharedServiceClient>) {
  const [rateLimit, dedupe, reservation, breaker, concurrencyLog] = await Promise.all([
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
    // breaker RPC pair.
    probeRpcExists(supabase, 'get_gateway_breaker_state_v1', {
      p_provider: 'preflight-probe-provider', p_model: null, p_feature_key: 'preflight-probe-feature',
    }),
    // record_gateway_concurrency_validation_v1 itself — malformed hash
    // forces a CHECK-constraint-triggered exception inside the function
    // body (not a cast error at the call boundary like the others, since
    // every argument here is TEXT), which still proves the function exists
    // without ever inserting a row: RAISE EXCEPTION aborts before INSERT.
    probeRpcExists(supabase, 'record_gateway_concurrency_validation_v1', {
      p_migration_version: 'preflight:probe', p_validation_script_path: 'preflight:probe',
      p_validation_script_sha256: 'not-a-valid-hash', p_status: 'passed', p_executed_by: 'preflight-probe', p_notes: null,
    }),
  ]);
  return { rateLimit, dedupe, reservation, breaker, concurrencyLog };
}

// ── concurrencyValidated (live, never hardcoded) ─────────────────────────────

function computeValidationScriptHash(): string | null {
  try {
    const content = readFileSync(VALIDATION_SCRIPT_PATH, 'utf8');
    return hashValidationScript(content);
  } catch {
    return null; // file unreadable — concurrencyValidated must fail closed, never assume
  }
}

async function checkConcurrencyValidated(
  supabase: ReturnType<typeof getSharedServiceClient>,
): Promise<{ validated: boolean; scriptHash: string | null; matchedRecord: { executedAt: string; executedBy: string } | null }> {
  const scriptHash = computeValidationScriptHash();
  if (!scriptHash) return { validated: false, scriptHash: null, matchedRecord: null };

  const { data, error } = await supabase
    .from('ai_gateway_concurrency_validations')
    .select('executed_at, executed_by')
    .eq('migration_version', MIGRATION_VERSION)
    .eq('validation_script_sha256', scriptHash)
    .eq('status', 'passed')
    .order('executed_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return { validated: false, scriptHash, matchedRecord: null };
  const row = data as { executed_at: string; executed_by: string };
  return { validated: true, scriptHash, matchedRecord: { executedAt: row.executed_at, executedBy: row.executed_by } };
}

// ── Assessment ─────────────────────────────────────────────────────────────
// All readiness-field computation itself (codeReady, estimatorReady,
// pricingReady, enforceReadyUnit/Cost, blockers, ...) lives in the pure,
// unit-tested computeFeatureReadiness() — this function's only job is to
// gather the live facts that function needs (current policy, entitlement
// mapping presence, real price-table coverage) and merge them with its
// output for display.

type FeatureReadiness = PureFeatureReadiness & {
  currentGatewayMode: string;
  currentRuntimeStatus: string;
  provider: string;
  isBillable: boolean;
  hasEntitlementMapping: boolean;
  hasPriceCoverage: boolean | 'not_applicable';
};

async function assessFeature(
  featureKey: AiFeatureKey,
  policyResolver: GatewayPolicyResolver,
  supabase: ReturnType<typeof getSharedServiceClient>,
  infraDeployed: boolean,
  concurrencyValidated: boolean,
  unsafeDatabasePrivileges: boolean,
): Promise<FeatureReadiness> {
  const meta = FEATURE_METADATA[featureKey];
  const { provider, model } = FEATURE_PROVIDER_MODEL[featureKey];

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

  const readiness = computeFeatureReadiness({
    featureKey,
    hasPriceCoverage,
    infraDeployed,
    concurrencyValidated,
    realtimeHardControlLiveTested: REALTIME_HARD_CONTROL_LIVE_TESTED,
    unsafeDatabasePrivileges,
  });

  return {
    ...readiness,
    currentGatewayMode: policy.gatewayMode,
    currentRuntimeStatus: policy.runtimeStatus,
    provider,
    isBillable: meta.isBillable,
    hasEntitlementMapping,
    hasPriceCoverage,
  };
}

async function main() {
  const supabase = getSharedServiceClient();
  const policyResolver = new GatewayPolicyResolver(supabase, 0); // ttlMs=0 — always fresh, this is a one-shot audit

  const infra = await probeInfra(supabase);
  const privileges = await probeUnsafeDatabasePrivileges(supabase);
  const infraDeployed = infra.rateLimit && infra.dedupe && infra.reservation && infra.breaker && infra.concurrencyLog && !privileges.unsafe;

  const concurrency = await checkConcurrencyValidated(supabase);

  const results: FeatureReadiness[] = [];
  for (const featureKey of AI_FEATURE_KEYS) {
    results.push(await assessFeature(featureKey, policyResolver, supabase, infraDeployed, concurrency.validated, privileges.unsafe));
  }

  const unitCodeReadyCount = results.filter((r) => r.unitEnforcementCodeReady).length;
  const costCodeReadyCount = results.filter((r) => r.costEnforcementCodeReady).length;
  const pricingReadyCount = results.filter((r) => r.pricingReady).length;
  const enforceReadyUnitCount = results.filter((r) => r.enforceReadyUnit).length;
  const enforceReadyCostCount = results.filter((r) => r.enforceReadyCost).length;

  if (JSON_OUTPUT) {
    console.log(JSON.stringify({
      migrationVersion: MIGRATION_VERSION,
      infra, privileges, infraDeployed,
      concurrencyValidated: concurrency.validated, concurrencyScriptHash: concurrency.scriptHash, concurrencyRecord: concurrency.matchedRecord,
      features: results,
      summary: { unitCodeReadyCount, costCodeReadyCount, pricingReadyCount, enforceReadyUnitCount, enforceReadyCostCount, totalFeatures: results.length },
    }, null, 2));
    return;
  }

  console.log('AI Gateway — enforce-readiness preflight (Etapa 11, Fase 16 — operational correction)');
  console.log('Read-only. Never changes gateway_mode or runtime_status.\n');
  console.log(`Migration version under assessment: ${MIGRATION_VERSION}\n`);

  console.log('Fase 14 infra (rate limit / dedupe / reservation / breaker / concurrency-log RPCs) — DATABASE deployment state:');
  console.log(`  rate_limit:      ${infra.rateLimit ? 'present' : 'MISSING'}`);
  console.log(`  dedupe:          ${infra.dedupe ? 'present' : 'MISSING'}`);
  console.log(`  reservation:     ${infra.reservation ? 'present' : 'MISSING'}`);
  console.log(`  breaker:         ${infra.breaker ? 'present' : 'MISSING'}`);
  console.log(`  concurrency_log: ${infra.concurrencyLog ? 'present' : 'MISSING'}`);
  console.log('Database privileges (anon/authenticated must hold ZERO of them — 20260718010000 security fix):');
  console.log(`  unsafe:          ${privileges.unsafe ? 'YES — anon/authenticated still have access' : 'no'}`);
  if (privileges.unsafeTables.length > 0) console.log(`    tables:    ${privileges.unsafeTables.join(', ')}`);
  if (privileges.unsafeFunctions.length > 0) console.log(`    functions: ${privileges.unsafeFunctions.join(', ')}`);
  console.log(`  → infraDeployed=${infraDeployed} (live-detected, never hardcoded).\n`);

  console.log('Concurrency validation (ai_gateway_concurrency_validations, live query):');
  console.log(`  validation script hash (live, right now): ${concurrency.scriptHash ?? '(file unreadable)'}`);
  console.log(`  concurrencyValidated=${concurrency.validated}${concurrency.matchedRecord ? ` (matched record: executed_by=${concurrency.matchedRecord.executedBy} at ${concurrency.matchedRecord.executedAt})` : ' (no matching passed record for this exact migration_version + script hash)'}\n`);

  for (const r of results) {
    console.log(`${r.featureKey}${r.isAccountingChild ? `  [accounting_child of ${r.accountingParent}]` : ''}`);
    console.log(`  current: gatewayMode=${r.currentGatewayMode} runtimeStatus=${r.currentRuntimeStatus}`);
    console.log(`  provider=${r.provider} billable=${r.isBillable} entitlementMapping=${r.hasEntitlementMapping} priceCoverage=${r.hasPriceCoverage} estimator=${r.hasEstimator}`);
    console.log(`  codeReady=${r.codeReady}  estimatorReady=${r.estimatorReady}  pricingReady=${r.pricingReady}`);
    console.log(`  unitEnforcementCodeReady=${r.unitEnforcementCodeReady}  costEnforcementCodeReady=${r.costEnforcementCodeReady}${r.isRealtimeSessionFeature ? `  realtimeHardControlReady=${r.realtimeHardControlReady}` : ''}`);
    console.log(`  enforceReadyUnit=${r.enforceReadyUnit}  enforceReadyCost=${r.enforceReadyCost}`);
    console.log(`  blockersUnit: ${r.blockersUnit.length > 0 ? r.blockersUnit.join(', ') : '(none)'}`);
    console.log(`  blockersCost: ${r.blockersCost.length > 0 ? r.blockersCost.join(', ') : '(none)'}`);
    console.log('');
  }

  console.log('Summary (code-level):');
  console.log(`  unit code-ready:    ${unitCodeReadyCount}/${results.length}`);
  console.log(`  cost code-ready:    ${costCodeReadyCount}/${results.length}`);
  console.log(`  pricing ready:      ${pricingReadyCount}/${results.length}`);
  console.log('Summary (global gates — none satisfiable by per-feature code alone):');
  console.log(`  infraDeployed:        ${infraDeployed}`);
  console.log(`  concurrencyValidated: ${concurrency.validated}`);
  console.log(`\n  enforceReadyUnit (safe to enforce quota/rate/dedupe/breaker right now): ${enforceReadyUnitCount}/${results.length}`);
  console.log(`  enforceReadyCost (safe to enforce USD budget right now):                ${enforceReadyCostCount}/${results.length}`);
  console.log('\nNo enforce activation is permitted for a dimension with a non-empty blockers list for that dimension.');
}

// Guarded so this module can be required/imported (e.g. by
// api/__tests__/enforce-readiness.test.ts, indirectly, or any future test)
// without a live Supabase connection firing as an import side effect — tsx
// and this repo's CommonJS Gateway build (tsconfig.gateway.json) both give
// every script its own require.main, so this is a real, not cosmetic, guard.
if (require.main === module) {
  main().catch((err) => {
    console.error('Preflight failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
