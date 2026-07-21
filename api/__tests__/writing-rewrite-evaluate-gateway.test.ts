/**
 * Integration test proving writing.evaluate_rewrite is genuinely reachable.
 *
 * Regression guard for a previously dead/unreachable AI Gateway feature: its
 * real implementation (src/lib/writingRewriteOrchestrator.ts's model-evaluation
 * step) used to call OpenAI directly via fetch(), bypassing the Gateway
 * entirely, and had zero HTTP endpoint invoking it at all. This test drives
 * the orchestrator (evaluateWritingRewrite) end-to-end — real deterministic
 * comparison, real score calculation, real persistence calls — with only the
 * Supabase client and the outbound OpenAI fetch() faked, so the actual
 * production code path (not a stand-in) is what reaches the Gateway.
 *
 * Uses the real executeAiGatewayCall with injected mock deps, exactly like
 * api/__tests__/compare-rewrite-gateway.test.ts, so the full policy +
 * telemetry path is exercised without a real DB or OpenAI call.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { evaluateWritingRewrite } from '../../src/lib/writingRewriteOrchestrator';

// ── Hoisted values — available inside vi.mock factories ───────────────────────

const {
  mockStartEvent,
  mockCompleteEvent,
  mockFailEvent,
  mockInsertMetrics,
  mockPolicyResolvePolicy,
  mockDeps,
} = vi.hoisted(() => {
  const mockStartEvent = vi.fn();
  const mockCompleteEvent = vi.fn();
  const mockFailEvent = vi.fn();
  const mockInsertMetrics = vi.fn();
  const mockPolicyResolvePolicy = vi.fn();

  const mockDeps = {
    policyResolver: { resolvePolicy: mockPolicyResolvePolicy, invalidate: vi.fn() },
    usageRepository: {
      startEvent: mockStartEvent,
      completeEvent: mockCompleteEvent,
      failEvent: mockFailEvent,
      cancelEvent: vi.fn(),
      insertMetrics: mockInsertMetrics,
      createProviderSession: vi.fn(),
      activateSession: vi.fn(),
      completeSession: vi.fn(),
      failSession: vi.fn(),
      expireSession: vi.fn(),
      getEventForCosting: vi.fn().mockResolvedValue(null),
      getMetricsForEvent: vi.fn().mockResolvedValue([]),
      updateMetricCost: vi.fn().mockResolvedValue(undefined),
      updateEventCost: vi.fn().mockResolvedValue(undefined),
    },
    pricingRepository: { findActivePrice: vi.fn().mockResolvedValue(null) },
    dailyRollupRepository: {
      rebuildBucketForEvent: vi.fn().mockResolvedValue('daily-bucket-1'),
      rebuildBucket: vi.fn().mockResolvedValue('daily-bucket-1'),
      listBucketsForDate: vi.fn().mockResolvedValue([]),
    },
    clock: vi.fn(() => 1000),
    uuidGen: vi.fn(() => 'test-uuid'),
    logger: vi.fn(),
  };

  return { mockStartEvent, mockCompleteEvent, mockFailEvent, mockInsertMetrics, mockPolicyResolvePolicy, mockDeps };
});

// Real executeAiGatewayCall is used; only getProductionDeps is replaced —
// same technique as compare-rewrite-gateway.test.ts.
vi.mock('../_ai-gateway/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../_ai-gateway/index')>();
  return { ...actual, getProductionDeps: () => mockDeps };
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const REVIEW_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const ATTEMPT_ID = 'cccccccc-0000-0000-0000-000000000003';

const VALID_MODEL_RESPONSE = JSON.stringify({
  correctionOutcomes: [
    { correctionId: '0', status: 'corrected', explanationPtBR: 'Corrigido corretamente.', confidence: 0.9, shouldAffectRewriteScore: true },
  ],
  newIssues: [],
  meaningPreservationScore: 90,
  clarityImprovementScore: 70,
  cohesionImprovementScore: 60,
  summaryPtBR: 'Bom trabalho.',
  schemaVersion: 'v1',
});

function openaiFetchResponse(content: string, usage?: { prompt_tokens: number; completion_tokens: number }) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: usage ?? { prompt_tokens: 400, completion_tokens: 150, total_tokens: 550 },
    }),
  };
}

/** Minimal fake Supabase client — only the exact calls this orchestrator run makes. */
function makeFakeSupabase(attemptStatus: 'submitted' | 'evaluation_failed' = 'submitted') {
  const attemptRow: Record<string, unknown> = {
    id: ATTEMPT_ID,
    user_id: USER_ID,
    mission_id: null,
    review_id: REVIEW_ID,
    rewrite_sequence: 1,
    status: attemptStatus,
    author_type: 'learner',
    submission_type: 'rewrite_v2',
    rewrite_text: 'Yesterday I went to the store and bought some bread.',
    original_text_snapshot: 'Yesterday I goed to the store.',
    corrected_text_hash: 'hash123',
    review_version: 1,
    support_usage_snapshot: null,
    created_at: '2026-07-21T00:00:00.000Z',
    submitted_at: '2026-07-21T00:00:01.000Z',
  };

  const reviewRow = {
    id: REVIEW_ID,
    user_id: USER_ID,
    original_text: 'Yesterday I goed to the store.',
    corrected_text: 'Yesterday I went to the store.',
    level: 'A2',
    main_mistakes: [{ mistake: 'goed', correct: 'went', explanation: 'irregular verb' }],
  };

  let evaluationExists = false;
  const evaluationRow: Record<string, unknown> = {
    id: 'eval-1',
    user_id: USER_ID,
    mission_id: null,
    original_submission_id: REVIEW_ID,
    rewrite_submission_id: ATTEMPT_ID,
    review_id: REVIEW_ID,
    evaluation_version: 1,
    status: 'pending',
    correction_resolution_score: 100,
    new_error_avoidance_score: 100,
    meaning_preservation_score: 90,
    clarity_improvement_score: 70,
    cohesion_improvement_score: 60,
    independence_score: 80,
    overall_improvement_score: 80,
    independence_assessment: 'independent',
    summary_pt_br: 'Bom trabalho.',
    new_issues_json: [],
    scoring_version: 'v1',
    schema_version: 'v1',
    prompt_version: 'v1',
    model_provider: 'openai',
    model_name: 'gpt-4o',
    created_at: '2026-07-21T00:00:02.000Z',
    completed_at: null,
  };

  /**
   * `getResult` is called lazily, at `.single()`/`.maybeSingle()`/`.then()`
   * time — never precomputed — so a preceding `.update()`/`.insert()` on the
   * SAME chain (which mutates the underlying row synchronously, before the
   * chain is awaited) is reflected in what's returned, exactly like a real
   * Postgres `UPDATE ... RETURNING *`.
   */
  function chain(getResult: () => { data: unknown; error: unknown }) {
    const c: any = {
      select: () => c,
      eq: () => c,
      order: () => c,
      limit: () => c,
      insert: (_row: unknown) => c,
      update: (patch: Record<string, unknown>) => c._applyUpdate(patch),
      upsert: () => c,
      single: async () => getResult(),
      maybeSingle: async () => getResult(),
      then: (resolve: (r: unknown) => unknown) => resolve(getResult()),
    };
    return c;
  }

  return {
    from(table: string) {
      switch (table) {
        case 'writing_rewrite_attempts': {
          const c = chain(() => ({ data: { ...attemptRow }, error: null }));
          c._applyUpdate = (patch: Record<string, unknown>) => { Object.assign(attemptRow, patch); return c; };
          return c;
        }
        case 'english_reviews':
          return chain(() => ({ data: reviewRow, error: null }));
        case 'writing_rewrite_evaluations': {
          const c = chain(() => {
            // getEvaluationForAttempt (idempotency pre-check, before any
            // insert has happened on this fake client): no prior evaluation.
            if (!evaluationExists) return { data: null, error: null };
            return { data: { ...evaluationRow }, error: null };
          });
          c._applyUpdate = (patch: Record<string, unknown>) => { Object.assign(evaluationRow, patch); return c; };
          c.insert = (_row: unknown) => { evaluationExists = true; return c; };
          return c;
        }
        case 'writing_rewrite_correction_outcomes':
          return chain(() => ({ data: [], error: null }));
        case 'writing_rewrite_evidence_candidates':
          return chain(() => ({ data: [{ id: 'evidence-1' }], error: null }));
        default:
          throw new Error(`Unexpected table in fake Supabase client: ${table}`);
      }
    },
  } as any;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let uuidCounter = 0;

beforeEach(() => {
  vi.clearAllMocks();
  mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'observe', runtimeStatus: 'enabled' });
  mockStartEvent.mockImplementation(() => Promise.resolve(`event-${++uuidCounter}`));
  mockCompleteEvent.mockResolvedValue(undefined);
  mockFailEvent.mockResolvedValue(undefined);
  mockInsertMetrics.mockResolvedValue(undefined);
  (mockDeps.clock as ReturnType<typeof vi.fn>).mockReturnValue(1000);
  (mockDeps.uuidGen as ReturnType<typeof vi.fn>).mockImplementation(() => `test-uuid-${++uuidCounter}`);

  process.env.OPENAI_API_KEY = 'test-key';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(openaiFetchResponse(VALID_MODEL_RESPONSE)));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── 1. The call really reaches the Gateway under the right identity ──────────

describe('evaluateWritingRewrite routes its model call through the AI Gateway', () => {
  it('calls the Gateway with featureKey writing.evaluate_rewrite, provider openai, model gpt-4o', async () => {
    const supabase = makeFakeSupabase();
    await evaluateWritingRewrite(supabase, {
      authenticatedUserId: USER_ID,
      rewriteSubmissionId: ATTEMPT_ID,
      clientRequestId: 'req-1',
    });

    expect(mockStartEvent).toHaveBeenCalledTimes(1);
    const call = mockStartEvent.mock.calls[0][0] as any;
    expect(call.featureKey).toBe('writing.evaluate_rewrite');
    expect(call.provider).toBe('openai');
    expect(call.model).toBe('gpt-4o');
    expect(call.service).toBe('chat.completions');
  });

  it('userId comes from the authenticated caller, not any client-suppliable field', async () => {
    const supabase = makeFakeSupabase();
    await evaluateWritingRewrite(supabase, {
      authenticatedUserId: USER_ID,
      rewriteSubmissionId: ATTEMPT_ID,
      clientRequestId: 'req-1',
    });
    const call = mockStartEvent.mock.calls[0][0] as any;
    expect(call.userId).toBe(USER_ID);
    expect(call.initiatedByUserId).toBe(USER_ID);
  });

  it('exactly one physical OpenAI call is made — no second/duplicate AI query for this evaluation', async () => {
    const supabase = makeFakeSupabase();
    await evaluateWritingRewrite(supabase, {
      authenticatedUserId: USER_ID,
      rewriteSubmissionId: ATTEMPT_ID,
      clientRequestId: 'req-1',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mockStartEvent).toHaveBeenCalledTimes(1);
  });

  it('records real provider-reported token usage, never an estimate, as the actual metrics', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      openaiFetchResponse(VALID_MODEL_RESPONSE, { prompt_tokens: 777, completion_tokens: 222 }),
    ));
    const supabase = makeFakeSupabase();
    await evaluateWritingRewrite(supabase, {
      authenticatedUserId: USER_ID,
      rewriteSubmissionId: ATTEMPT_ID,
      clientRequestId: 'req-1',
    });

    expect(mockInsertMetrics).toHaveBeenCalledTimes(1);
    const [, metrics] = mockInsertMetrics.mock.calls[0];
    expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'input_text_tokens', quantity: 777 }));
    expect(metrics).toContainEqual(expect.objectContaining({ metricKey: 'output_text_tokens', quantity: 222 }));
  });

  it('completes the event and returns a public DTO with the evaluation on success', async () => {
    const supabase = makeFakeSupabase();
    const dto = await evaluateWritingRewrite(supabase, {
      authenticatedUserId: USER_ID,
      rewriteSubmissionId: ATTEMPT_ID,
      clientRequestId: 'req-1',
    });
    expect(mockCompleteEvent).toHaveBeenCalledTimes(1);
    expect(mockFailEvent).not.toHaveBeenCalled();
    expect(dto.status).toBe('evaluated');
    expect(dto.evaluation).not.toBeNull();
  });
});

// ── 2. Provider failure still routes through the Gateway (failure is recorded, not silently bypassed) ──

describe('provider failure is recorded by the Gateway, not swallowed before reaching it', () => {
  it('a fetch rejection fails the Gateway event and the orchestrator throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const supabase = makeFakeSupabase();

    await expect(evaluateWritingRewrite(supabase, {
      authenticatedUserId: USER_ID,
      rewriteSubmissionId: ATTEMPT_ID,
      clientRequestId: 'req-1',
    })).rejects.toThrow();

    expect(mockStartEvent).toHaveBeenCalledTimes(1);
    expect(mockFailEvent).toHaveBeenCalledTimes(1);
    expect(mockCompleteEvent).not.toHaveBeenCalled();
  });
});

// ── 3. LEGACY mode — Gateway wrapper is transparent, behavior unchanged ──────

describe('LEGACY mode — no telemetry, same functional result', () => {
  it('produces the same evaluated DTO with zero Gateway telemetry writes', async () => {
    mockPolicyResolvePolicy.mockResolvedValue({ gatewayMode: 'legacy', runtimeStatus: 'enabled' });
    const supabase = makeFakeSupabase();
    const dto = await evaluateWritingRewrite(supabase, {
      authenticatedUserId: USER_ID,
      rewriteSubmissionId: ATTEMPT_ID,
      clientRequestId: 'req-1',
    });
    expect(dto.status).toBe('evaluated');
    expect(mockStartEvent).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
