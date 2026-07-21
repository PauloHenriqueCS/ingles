/**
 * Unit tests for api/_ai-gateway/enforce-readiness.ts (Etapa 11, Fase 16 —
 * operational correction). Pure logic, no database/filesystem access —
 * every live fact (price coverage, infra deployment, concurrency
 * validation) is passed in as a parameter, which is exactly what these
 * tests exploit to prove the readiness computation never depends on a
 * hardcoded boolean: the same feature produces different results depending
 * only on the inputs given, never on a module-level constant.
 */

import { describe, it, expect } from 'vitest';
import {
  computeFeatureReadiness,
  hashValidationScript,
  hasWiredEstimator,
  DEAD_UNREACHABLE_FEATURES,
  ACCOUNTING_CHILD_PARENT,
} from '../_ai-gateway/enforce-readiness';

function baseInput(overrides: Partial<Parameters<typeof computeFeatureReadiness>[0]> = {}) {
  return {
    featureKey: 'tts.synthesize' as const,
    hasPriceCoverage: true as const,
    infraDeployed: true,
    concurrencyValidated: true,
    realtimeHardControlLiveTested: false,
    unsafeDatabasePrivileges: false,
    ...overrides,
  };
}

describe('computeFeatureReadiness — unit readiness never depends on price', () => {
  it('unitEnforcementCodeReady/codeReady/estimatorReady are identical whether hasPriceCoverage is true or false', () => {
    const withPrice = computeFeatureReadiness(baseInput({ hasPriceCoverage: true }));
    const withoutPrice = computeFeatureReadiness(baseInput({ hasPriceCoverage: false }));
    expect(withoutPrice.codeReady).toBe(withPrice.codeReady);
    expect(withoutPrice.unitEnforcementCodeReady).toBe(withPrice.unitEnforcementCodeReady);
    expect(withoutPrice.estimatorReady).toBe(withPrice.estimatorReady);
    expect(withoutPrice.costEnforcementCodeReady).toBe(withPrice.costEnforcementCodeReady);
  });

  it('a missing price still allows enforceReadyUnit=true (character/unit quota enforceable without a $ price)', () => {
    const r = computeFeatureReadiness(baseInput({ hasPriceCoverage: false }));
    expect(r.pricingReady).toBe(false);
    expect(r.enforceReadyUnit).toBe(true);
    expect(r.enforceReadyCost).toBe(false);
  });
});

describe('computeFeatureReadiness — pricingReady reported as its own independent field', () => {
  it('pricingReady is false only when hasPriceCoverage is exactly false, never inferred from other fields', () => {
    expect(computeFeatureReadiness(baseInput({ hasPriceCoverage: false })).pricingReady).toBe(false);
    expect(computeFeatureReadiness(baseInput({ hasPriceCoverage: true })).pricingReady).toBe(true);
    // 'not_applicable' (non-billable feature) must never read as "missing" — pricingReady stays true.
    expect(computeFeatureReadiness(baseInput({ hasPriceCoverage: 'not_applicable' })).pricingReady).toBe(true);
  });

  it('blockersCost contains missing_price only when pricingReady is false, and never leaks into blockersUnit', () => {
    const r = computeFeatureReadiness(baseInput({ hasPriceCoverage: false }));
    expect(r.blockersCost).toContain('missing_price');
    expect(r.blockersUnit).not.toContain('missing_price');
  });
});

describe('computeFeatureReadiness — infraDeployed/concurrencyValidated are parameters, never hardcoded constants', () => {
  it('the same feature flips enforceReadyUnit/Cost purely based on the infraDeployed argument passed in', () => {
    const deployed = computeFeatureReadiness(baseInput({ infraDeployed: true, concurrencyValidated: true }));
    const notDeployed = computeFeatureReadiness(baseInput({ infraDeployed: false, concurrencyValidated: true }));
    expect(deployed.enforceReadyUnit).toBe(true);
    expect(notDeployed.enforceReadyUnit).toBe(false);
    expect(notDeployed.blockersUnit).toContain('infra_not_deployed');
  });

  it('the same feature flips enforceReadyUnit/Cost purely based on the concurrencyValidated argument passed in', () => {
    const validated = computeFeatureReadiness(baseInput({ infraDeployed: true, concurrencyValidated: true }));
    const notValidated = computeFeatureReadiness(baseInput({ infraDeployed: true, concurrencyValidated: false }));
    expect(validated.enforceReadyCost).toBe(true);
    expect(notValidated.enforceReadyCost).toBe(false);
    expect(notValidated.blockersCost).toContain('concurrency_not_validated');
  });

  it('calling with all four boolean combinations of infraDeployed/concurrencyValidated for the same feature produces four independently-derived results — proves there is no module-level shortcut', () => {
    const combos = [
      { infraDeployed: true, concurrencyValidated: true },
      { infraDeployed: true, concurrencyValidated: false },
      { infraDeployed: false, concurrencyValidated: true },
      { infraDeployed: false, concurrencyValidated: false },
    ];
    const results = combos.map((c) => computeFeatureReadiness(baseInput(c)));
    expect(results[0].enforceReadyUnit).toBe(true);
    expect(results[1].enforceReadyUnit).toBe(false);
    expect(results[2].enforceReadyUnit).toBe(false);
    expect(results[3].enforceReadyUnit).toBe(false);
  });
});

describe('computeFeatureReadiness — unsafeDatabasePrivileges is a parameter, never a hardcoded constant', () => {
  it('reports its own distinct blocker, separate from infra_not_deployed, and blocks both enforceReadyUnit/Cost even when infraDeployed is otherwise true', () => {
    const safe = computeFeatureReadiness(baseInput({ infraDeployed: true, unsafeDatabasePrivileges: false }));
    const unsafe = computeFeatureReadiness(baseInput({ infraDeployed: true, unsafeDatabasePrivileges: true }));
    expect(safe.blockersUnit).not.toContain('unsafe_database_privileges');
    expect(unsafe.blockersUnit).toContain('unsafe_database_privileges');
    expect(unsafe.blockersCost).toContain('unsafe_database_privileges');
    // infraDeployed=true was passed explicitly here — proves this is a
    // genuinely separate signal from infra_not_deployed, not a duplicate
    // path to the same blocker.
    expect(unsafe.blockersUnit).not.toContain('infra_not_deployed');
    expect(unsafe.enforceReadyUnit).toBe(false);
    expect(unsafe.enforceReadyCost).toBe(false);
  });

  it('when the CLI folds unsafeDatabasePrivileges into infraDeployed=false, both blockers can legitimately co-occur', () => {
    const r = computeFeatureReadiness(baseInput({ infraDeployed: false, unsafeDatabasePrivileges: true }));
    expect(r.blockersUnit).toContain('infra_not_deployed');
    expect(r.blockersUnit).toContain('unsafe_database_privileges');
  });
});

describe('computeFeatureReadiness — accounting_child (conversation.realtime_usage) never gets its own reservation requirement', () => {
  it('is classified isAccountingChild with the documented parent, and estimatorReady is true without needing hasWiredEstimator to be true', () => {
    expect(ACCOUNTING_CHILD_PARENT['conversation.realtime_usage']).toBe('conversation.webrtc_connect');
    expect(hasWiredEstimator('conversation.realtime_usage')).toBe(false);
    const r = computeFeatureReadiness(baseInput({ featureKey: 'conversation.realtime_usage' }));
    expect(r.isAccountingChild).toBe(true);
    expect(r.accountingParent).toBe('conversation.webrtc_connect');
    expect(r.hasEstimator).toBe(false);
    expect(r.estimatorReady).toBe(true); // inherited from accounting-parent relationship, not from its own estimator
    expect(r.blockersUnit).not.toContain('missing_estimator');
  });
});

describe('computeFeatureReadiness — no dead/unreachable features remain (Etapa 11 completion invariant)', () => {
  it('DEAD_UNREACHABLE_FEATURES is empty — every one of the 25 catalog features has a real, reachable call site', () => {
    expect(DEAD_UNREACHABLE_FEATURES.size).toBe(0);
  });

  it('writing.evaluate_rewrite is no longer dead: estimatorReady/codeReady are true given favorable inputs, same as any other wired feature', () => {
    // Regression guard for the previous bug: its real implementation
    // (writingRewriteOrchestrator.ts's callModelEvaluator invocation) called
    // OpenAI directly via fetch(), bypassing the Gateway, and had zero HTTP
    // endpoint reaching it — see api/writing-rewrite-evaluate.ts and the
    // Gateway-wrapped call site now in writingRewriteOrchestrator.ts.
    expect(DEAD_UNREACHABLE_FEATURES.has('writing.evaluate_rewrite')).toBe(false);
    expect(hasWiredEstimator('writing.evaluate_rewrite')).toBe(true);
    const r = computeFeatureReadiness(baseInput({
      featureKey: 'writing.evaluate_rewrite',
      hasPriceCoverage: true,
      infraDeployed: true,
      concurrencyValidated: true,
    }));
    expect(r.isDead).toBe(false);
    expect(r.estimatorReady).toBe(true);
    expect(r.codeReady).toBe(true);
    expect(r.enforceReadyUnit).toBe(true);
    expect(r.enforceReadyCost).toBe(true);
    expect(r.blockersUnit).not.toContain('dead_unreachable');
    expect(r.blockersCost).not.toContain('dead_unreachable');
  });
});

describe('computeFeatureReadiness — realtimeHardControlReady only gates realtime session features', () => {
  it('a non-realtime feature reports realtimeHardControlReady=true even when realtimeHardControlLiveTested is false', () => {
    const r = computeFeatureReadiness(baseInput({ featureKey: 'tts.synthesize', realtimeHardControlLiveTested: false }));
    expect(r.isRealtimeSessionFeature).toBe(false);
    expect(r.realtimeHardControlReady).toBe(true);
  });

  it('conversation.webrtc_connect is blocked on realtimeHardControlReady when realtimeHardControlLiveTested is false, and unblocked when true', () => {
    const notTested = computeFeatureReadiness(baseInput({ featureKey: 'conversation.webrtc_connect', hasPriceCoverage: 'not_applicable', realtimeHardControlLiveTested: false }));
    const tested = computeFeatureReadiness(baseInput({ featureKey: 'conversation.webrtc_connect', hasPriceCoverage: 'not_applicable', realtimeHardControlLiveTested: true }));
    expect(notTested.enforceReadyUnit).toBe(false);
    expect(notTested.blockersUnit).toContain('hard_control_not_live_tested');
    expect(tested.enforceReadyUnit).toBe(true);
  });
});

describe('hashValidationScript — hash invalidation mechanism', () => {
  it('is deterministic: the same content always produces the same hash', () => {
    const content = '-- SCENARIO 4\nSELECT 1;\n';
    expect(hashValidationScript(content)).toBe(hashValidationScript(content));
  });

  it('any change to the file content — even a single character — produces a different hash, invalidating a prior approval keyed to the old hash', () => {
    const original = '-- SCENARIO 4\nSELECT 1;\n';
    const edited = '-- SCENARIO 4\nSELECT 2;\n';
    expect(hashValidationScript(original)).not.toBe(hashValidationScript(edited));
  });

  it('produces a 64-character lowercase hex digest (matches the migration column CHECK constraint)', () => {
    const hash = hashValidationScript('anything');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
