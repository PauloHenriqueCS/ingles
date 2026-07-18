/**
 * Unit tests for the smaller Etapa 11 enforcement primitives:
 *   - kill-switch.ts (pure function)
 *   - estimators.ts (pure functions)
 *   - decisions.ts (repository wrapper + fail-open helper)
 *   - entitlements.ts (SupabaseEntitlementResolver's resolution logic,
 *     mocked Supabase client — no real Postgres)
 *
 * All unreachable in production this stage (no feature is in 'enforce'),
 * but must be correct — see enforcement.test.ts's module doc comment for
 * the same rationale, not repeated here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluateKillSwitch } from '../_ai-gateway/kill-switch';
import {
  estimateTtsCharacters, estimateAudioSecondsCeiling, estimateRealtimeSessionSeconds,
  estimateTextTokens, estimateProviderRequests,
} from '../_ai-gateway/estimators';
import { recordDecisionSafely, SupabaseDecisionsRepository } from '../_ai-gateway/decisions';
import { SupabaseEntitlementResolver } from '../_ai-gateway/entitlements';
import type { RuntimeStatus, GatewayDecisionRecord } from '../_ai-gateway/types';

// ── kill-switch.ts ────────────────────────────────────────────────────────

describe('evaluateKillSwitch', () => {
  it('enabled never blocks', () => {
    expect(evaluateKillSwitch('enabled')).toEqual({ blocked: false });
  });

  it.each<[RuntimeStatus, string]>([
    ['disabled', 'FEATURE_DISABLED'],
    ['cache_only', 'FEATURE_DISABLED'],
    ['maintenance', 'FEATURE_DISABLED'],
  ])('%s blocks with reasonCode %s', (status, expectedCode) => {
    expect(evaluateKillSwitch(status)).toEqual({ blocked: true, reasonCode: expectedCode });
  });

  it.each<[RuntimeStatus, string]>([
    ['circuit_open', 'CIRCUIT_OPEN'],
    ['paused_automatically', 'CIRCUIT_OPEN'],
  ])('%s blocks with reasonCode %s', (status, expectedCode) => {
    expect(evaluateKillSwitch(status)).toEqual({ blocked: true, reasonCode: expectedCode });
  });
});

// ── estimators.ts ─────────────────────────────────────────────────────────

describe('estimators', () => {
  it('estimateTtsCharacters counts plain text and SSML differently', () => {
    const plain = estimateTtsCharacters('Hello world', false);
    expect(plain).toEqual({ metricKey: 'tts_characters', quantity: 11 });

    const ssml = estimateTtsCharacters('<speak>Hi</speak>', true);
    expect(ssml.metricKey).toBe('tts_characters');
    expect(ssml.quantity).toBeGreaterThan(0);
  });

  it('estimateAudioSecondsCeiling never goes negative', () => {
    expect(estimateAudioSecondsCeiling(30)).toEqual({ metricKey: 'audio_seconds', quantity: 30 });
    expect(estimateAudioSecondsCeiling(-5)).toEqual({ metricKey: 'audio_seconds', quantity: 0 });
  });

  it('estimateRealtimeSessionSeconds never goes negative', () => {
    expect(estimateRealtimeSessionSeconds(1800)).toEqual({ metricKey: 'session_seconds', quantity: 1800 });
    expect(estimateRealtimeSessionSeconds(-1)).toEqual({ metricKey: 'session_seconds', quantity: 0 });
  });

  it('estimateTextTokens returns both input (character-derived) and output (configured ceiling) estimates', () => {
    const result = estimateTextTokens(400, 500);
    expect(result).toEqual([
      { metricKey: 'input_text_tokens', quantity: 100 }, // 400 chars / 4
      { metricKey: 'output_text_tokens', quantity: 500 },
    ]);
  });

  it('estimateTextTokens never produces a negative estimate for negative/zero input', () => {
    const result = estimateTextTokens(-10, -5);
    expect(result[0].quantity).toBe(0);
    expect(result[1].quantity).toBe(0);
  });

  it('estimateProviderRequests floors at 1 physical attempt', () => {
    expect(estimateProviderRequests(3)).toEqual({ metricKey: 'provider_requests', quantity: 3 });
    expect(estimateProviderRequests(0)).toEqual({ metricKey: 'provider_requests', quantity: 1 });
    expect(estimateProviderRequests(-2)).toEqual({ metricKey: 'provider_requests', quantity: 1 });
  });
});

// ── decisions.ts ──────────────────────────────────────────────────────────

function baseDecision(overrides: Partial<GatewayDecisionRecord> = {}): GatewayDecisionRecord {
  return {
    outcome: 'blocked', reasonCode: 'FEATURE_DISABLED', featureKey: 'writing.correct',
    actorType: 'user', gatewayMode: 'observe', ...overrides,
  };
}

describe('recordDecisionSafely', () => {
  it('is a no-op when no repository is configured', async () => {
    const logger = vi.fn();
    await expect(recordDecisionSafely(undefined, baseDecision(), logger)).resolves.toBeUndefined();
    expect(logger).not.toHaveBeenCalled();
  });

  it('calls repo.record with the decision', async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const logger = vi.fn();
    await recordDecisionSafely({ record }, baseDecision(), logger);
    expect(record).toHaveBeenCalledWith(baseDecision());
  });

  it('never throws when repo.record fails — logs instead (fail-open)', async () => {
    const record = vi.fn().mockRejectedValue(new Error('db down'));
    const logger = vi.fn();
    await expect(recordDecisionSafely({ record }, baseDecision(), logger)).resolves.toBeUndefined();
    expect(logger).toHaveBeenCalledWith('gateway.decision.recordFailed', expect.objectContaining({ message: 'db down' }));
  });
});

describe('SupabaseDecisionsRepository.record', () => {
  it('inserts a row with sanitized metadata and null-coalesced optional fields', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const supabase = { from: vi.fn().mockReturnValue({ insert }) } as any;
    const repo = new SupabaseDecisionsRepository(supabase);

    await repo.record(baseDecision({ provider: 'openai', userId: 'user-1', correlationId: 'corr-1', metadata: { latencyMs: 5, prompt: 'never persist this' } }));

    expect(supabase.from).toHaveBeenCalledWith('ai_gateway_decisions');
    const insertedRow = insert.mock.calls[0][0];
    expect(insertedRow.outcome).toBe('blocked');
    expect(insertedRow.provider).toBe('openai');
    expect(insertedRow.user_id).toBe('user-1');
    expect(insertedRow.metadata).not.toHaveProperty('prompt'); // sanitizeMetadata strips content-like keys
    expect(insertedRow.metadata.latencyMs).toBe(5);
  });

  it('throws a descriptive error when the insert fails', async () => {
    const insert = vi.fn().mockResolvedValue({ error: { message: 'constraint violation' } });
    const supabase = { from: vi.fn().mockReturnValue({ insert }) } as any;
    const repo = new SupabaseDecisionsRepository(supabase);

    await expect(repo.record(baseDecision())).rejects.toThrow('decisions.record failed: constraint violation');
  });
});

// ── entitlements.ts ───────────────────────────────────────────────────────

function makeSupabaseMock() {
  const rpc = vi.fn();
  const capabilityChain: any = {};
  for (const m of ['from', 'select', 'eq', 'lte', 'or', 'order', 'limit']) capabilityChain[m] = vi.fn().mockReturnValue(capabilityChain);
  const supabase = { rpc, from: vi.fn() } as any;
  return { supabase, rpc };
}

describe('SupabaseEntitlementResolver', () => {
  let clock: number;
  beforeEach(() => { clock = 1_700_000_000_000; });

  it('bypasses plan resolution entirely for actorType=system (no rpc call, unlimited)', async () => {
    const { supabase, rpc } = makeSupabaseMock();
    const resolver = new SupabaseEntitlementResolver(supabase, 5000, () => clock);

    const result = await resolver.resolve(undefined, 'system', 'listening.episode_generate_story', ['output_text_tokens']);

    expect(rpc).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      allowed: true, userId: null, source: 'system_actor',
      limits: [{ metricKey: 'output_text_tokens', limit: null, period: 'none', resetAt: null }],
    }));
  });

  it('returns allowed=false when the plan RPC reports access_allowed=false (suspended user)', async () => {
    const { supabase, rpc } = makeSupabaseMock();
    rpc.mockResolvedValue({
      data: [{ user_id: 'u1', access_allowed: false, plan_id: 'plan-1', plan_version_id: 'v1', version_number: 1 }],
      error: null,
    });
    const resolver = new SupabaseEntitlementResolver(supabase, 5000, () => clock);

    const result = await resolver.resolve('u1', 'user', 'writing.correct', []);

    expect(result.allowed).toBe(false);
    expect(result.source).toBe('plan');
  });

  it('returns source=no_plan_configured when the RPC finds no plan at all', async () => {
    const { supabase, rpc } = makeSupabaseMock();
    rpc.mockResolvedValue({ data: [], error: null });
    const resolver = new SupabaseEntitlementResolver(supabase, 5000, () => clock);

    const result = await resolver.resolve('u1', 'user', 'writing.correct', ['output_text_tokens']);

    expect(result.allowed).toBe(true);
    expect(result.source).toBe('no_plan_configured');
    expect(result.limits).toEqual([{ metricKey: 'output_text_tokens', limit: null, period: 'none', resetAt: null }]);
  });

  it('fails open with source=fallback_error when the plan RPC itself errors and there is no cached value', async () => {
    const { supabase, rpc } = makeSupabaseMock();
    rpc.mockResolvedValue({ data: null, error: { message: 'rpc missing' } });
    const resolver = new SupabaseEntitlementResolver(supabase, 5000, () => clock);

    const result = await resolver.resolve('u1', 'user', 'writing.correct', []);

    expect(result.allowed).toBe(true); // fail-open for legacy/observe; enforcement.ts treats this source as POLICY_UNAVAILABLE
    expect(result.source).toBe('fallback_error');
  });

  it('caches a resolution for ttlMs and does not re-call the RPC within the window', async () => {
    const { supabase, rpc } = makeSupabaseMock();
    rpc.mockResolvedValue({ data: [], error: null });
    const resolver = new SupabaseEntitlementResolver(supabase, 5000, () => clock);

    await resolver.resolve('u1', 'user', 'writing.correct', []);
    await resolver.resolve('u1', 'user', 'writing.correct', []);

    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('re-resolves after the cache ttl expires', async () => {
    const { supabase, rpc } = makeSupabaseMock();
    rpc.mockResolvedValue({ data: [], error: null });
    const resolver = new SupabaseEntitlementResolver(supabase, 5000, () => clock);

    await resolver.resolve('u1', 'user', 'writing.correct', []);
    clock += 6000;
    await resolver.resolve('u1', 'user', 'writing.correct', []);

    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
