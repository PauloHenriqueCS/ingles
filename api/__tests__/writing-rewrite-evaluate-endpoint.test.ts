/**
 * Endpoint-level tests for api/writing-rewrite-evaluate.ts.
 *
 * Complements api/__tests__/writing-rewrite-evaluate-gateway.test.ts (which
 * drives the real orchestrator down to the AI Gateway) by proving the HTTP
 * layer itself: auth, ownership, entitlements gate, request validation, and
 * — the core requirement — that exactly one call to evaluateWritingRewrite
 * (and therefore exactly one AI Gateway call, under featureKey
 * 'writing.evaluate_rewrite') happens per submission, with idempotent reuse
 * of the same attempt id for a retried/double-clicked/resent identical
 * request. writingRewriteRepository and writingRewriteOrchestrator are
 * mocked here so each scenario can control attempt state precisely without
 * re-simulating every Supabase query shape — that DB-level fidelity is what
 * writing-rewrite-evaluate-gateway.test.ts already covers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockRequireAuth,
  mockApplyRateLimit,
  mockGetCurrentUserPlanEntitlements,
  mockIsRewriteV2Enabled,
  mockSingle,
  mockGetLatestRewriteAttempt,
  mockGetNextRewriteSequence,
  mockCreateRewriteAttempt,
  mockUpdateRewriteText,
  mockUpdateRewriteAttemptStatus,
  mockEvaluateWritingRewrite,
  mockGetEvaluationForAttempt,
} = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockApplyRateLimit: vi.fn(),
  mockGetCurrentUserPlanEntitlements: vi.fn(),
  mockIsRewriteV2Enabled: vi.fn(),
  mockSingle: vi.fn(),
  mockGetLatestRewriteAttempt: vi.fn(),
  mockGetNextRewriteSequence: vi.fn(),
  mockCreateRewriteAttempt: vi.fn(),
  mockUpdateRewriteText: vi.fn(),
  mockUpdateRewriteAttemptStatus: vi.fn(),
  mockEvaluateWritingRewrite: vi.fn(),
  mockGetEvaluationForAttempt: vi.fn(),
}));

vi.mock('../_auth', () => ({ requireAuth: mockRequireAuth }));
vi.mock('../_rateLimit', () => ({ applyRateLimit: mockApplyRateLimit }));
vi.mock('../_entitlements/plan-entitlements-service', () => ({
  getCurrentUserPlanEntitlements: mockGetCurrentUserPlanEntitlements,
}));
vi.mock('../../src/lib/writingRewriteFeatureFlags', () => ({
  isRewriteV2Enabled: mockIsRewriteV2Enabled,
}));
vi.mock('../_ai-gateway/index', () => ({
  getSharedServiceClient: () => ({
    from: (table: string) => {
      if (table !== 'english_reviews') throw new Error(`unexpected table: ${table}`);
      return {
        select: () => ({ eq: () => ({ single: mockSingle }) }),
      };
    },
  }),
}));
vi.mock('../../src/lib/writingRewriteRepository', () => ({
  getLatestRewriteAttempt: mockGetLatestRewriteAttempt,
  getNextRewriteSequence: mockGetNextRewriteSequence,
  createRewriteAttempt: mockCreateRewriteAttempt,
  updateRewriteText: mockUpdateRewriteText,
  updateRewriteAttemptStatus: mockUpdateRewriteAttemptStatus,
}));
vi.mock('../../src/lib/writingRewriteOrchestrator', () => ({
  evaluateWritingRewrite: mockEvaluateWritingRewrite,
}));
vi.mock('../../src/lib/writingRewriteEvaluationRepository', () => ({
  getEvaluationForAttempt: mockGetEvaluationForAttempt,
}));

import handler from '../writing-rewrite-evaluate';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const OTHER_USER_ID = 'aaaaaaaa-0000-0000-0000-000000000099';
const REVIEW_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const ATTEMPT_ID = 'cccccccc-0000-0000-0000-000000000003';
const REWRITE_TEXT = 'Yesterday I went to the store and bought some bread.';

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
    body: { reviewId: REVIEW_ID, rewriteText: REWRITE_TEXT },
    ...overrides,
  };
}

function makeRes() {
  let _status = 200;
  let _body: unknown;
  const res = {
    _status: () => _status,
    _body: () => _body,
    status(s: number) { _status = s; return res; },
    json(b: unknown) { _body = b; return res; },
  };
  return res;
}

function permissiveLimit(period: 'day' | 'month' = 'day') {
  return { enabled: true, unlimited: true, limit: 0, consumed: 0, remaining: Infinity, period, state: 'unlimited', canStart: true };
}

function permissiveEntitlements() {
  return {
    planId: 'plan-1', planCode: 'free', planName: 'Gratuito', planVersionId: 'version-1', suspended: false,
    writing: { enabled: true, themeGenerations: permissiveLimit(), reviews: permissiveLimit(), maxCharactersPerText: 0, maxCharactersUnlimited: true },
    listening: { enabled: true, stories: permissiveLimit() },
    pronunciation: { enabled: true, evaluations: permissiveLimit(), maxRecordingSeconds: 0, maxRecordingUnlimited: true },
    conversation: { enabled: true, monthlyTime: permissiveLimit('month'), maxRecordingSeconds: 0, maxRecordingUnlimited: true, extraPurchaseEnabled: false, extraSecondsAvailable: 0 },
    monthlyRenewsAt: null,
    resolvedAt: new Date().toISOString(),
  };
}

function attemptFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: ATTEMPT_ID,
    userId: USER_ID,
    missionId: undefined,
    reviewId: REVIEW_ID,
    rewriteSequence: 1,
    status: 'submitted',
    authorType: 'learner',
    submissionType: 'rewrite_v2',
    rewriteText: REWRITE_TEXT,
    originalTextSnapshot: 'Yesterday I goed to the store.',
    correctedTextHash: 'hash123',
    reviewVersion: 1,
    createdAt: '2026-07-21T00:00:00.000Z',
    submittedAt: '2026-07-21T00:00:01.000Z',
    ...overrides,
  };
}

const EVALUATED_DTO = {
  rewriteSubmissionId: ATTEMPT_ID,
  status: 'evaluated',
  originalText: 'Yesterday I goed to the store.',
  correctedText: 'Yesterday I went to the store.',
  rewriteText: REWRITE_TEXT,
  evaluation: {
    overallImprovementScore: 80,
    correctionResolutionScore: 100,
    newErrorAvoidanceScore: 100,
    meaningPreservationScore: 90,
    clarityImprovementScore: 70,
    cohesionImprovementScore: 60,
    independenceScore: 80,
    independenceAssessment: 'independent',
    summaryPtBR: 'Bom trabalho.',
    correctionOutcomes: [],
    newIssues: [],
  },
  createdAt: '2026-07-21T00:00:00.000Z',
  submittedAt: '2026-07-21T00:00:01.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAuth.mockResolvedValue({ userId: USER_ID, supabase: {} });
  mockApplyRateLimit.mockResolvedValue(true);
  mockGetCurrentUserPlanEntitlements.mockResolvedValue(permissiveEntitlements());
  mockIsRewriteV2Enabled.mockReturnValue(true);
  mockSingle.mockResolvedValue({
    data: { id: REVIEW_ID, user_id: USER_ID, original_text: 'Yesterday I goed to the store.', corrected_text: 'Yesterday I went to the store.' },
    error: null,
  });
  mockGetLatestRewriteAttempt.mockResolvedValue(null);
  mockGetNextRewriteSequence.mockResolvedValue(1);
  mockCreateRewriteAttempt.mockImplementation(async (_supabase: unknown, input: Record<string, unknown>) =>
    attemptFixture({ status: 'draft', rewriteText: null, rewriteSequence: input.rewriteSequence }));
  mockUpdateRewriteText.mockImplementation(async (_supabase: unknown, id: string, text: string) =>
    attemptFixture({ id, status: 'draft', rewriteText: text }));
  mockUpdateRewriteAttemptStatus.mockImplementation(async (_supabase: unknown, id: string, status: string) =>
    attemptFixture({ id, status }));
  mockEvaluateWritingRewrite.mockResolvedValue(EVALUATED_DTO);
  mockGetEvaluationForAttempt.mockResolvedValue({
    id: 'eval-1',
    userId: USER_ID,
    originalSubmissionId: REVIEW_ID,
    rewriteSubmissionId: ATTEMPT_ID,
    reviewId: REVIEW_ID,
    evaluationVersion: 1,
    status: 'completed',
    scores: {
      correctionResolutionScore: 100, newErrorAvoidanceScore: 100, meaningPreservationScore: 90,
      clarityImprovementScore: 70, cohesionImprovementScore: 60, independenceScore: 80, overallImprovementScore: 80,
    },
    independenceAssessment: 'independent',
    summaryPtBR: 'Bom trabalho.',
    correctionOutcomes: [],
    newIssues: [],
    scoringVersion: 'v1',
    schemaVersion: 'v1',
    createdAt: '2026-07-21T00:00:02.000Z',
  });
});

// ── 1. Auth is mandatory ─────────────────────────────────────────────────────

describe('authentication', () => {
  it('an unauthenticated request never reaches the orchestrator', async () => {
    mockRequireAuth.mockResolvedValue(null);
    await handler(makeReq(), makeRes());
    expect(mockEvaluateWritingRewrite).not.toHaveBeenCalled();
    expect(mockGetLatestRewriteAttempt).not.toHaveBeenCalled();
  });

  it('userId used for every downstream call comes from auth, never the request body', async () => {
    await handler(makeReq({ body: { reviewId: REVIEW_ID, rewriteText: REWRITE_TEXT, userId: 'injected-evil' } }), makeRes());
    expect(mockGetLatestRewriteAttempt).toHaveBeenCalledWith(expect.anything(), REVIEW_ID, USER_ID);
    expect(mockEvaluateWritingRewrite).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ authenticatedUserId: USER_ID }));
  });
});

// ── 2. Ownership ──────────────────────────────────────────────────────────────

describe('ownership validation', () => {
  it('a review owned by a different user is rejected with 403, never reaches the orchestrator', async () => {
    mockSingle.mockResolvedValue({ data: { id: REVIEW_ID, user_id: OTHER_USER_ID, original_text: 'x', corrected_text: 'y' }, error: null });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(403);
    expect(mockEvaluateWritingRewrite).not.toHaveBeenCalled();
  });

  it('a nonexistent review returns 404, never reaches the orchestrator', async () => {
    mockSingle.mockResolvedValue({ data: null, error: { message: 'not found' } });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(404);
    expect(mockEvaluateWritingRewrite).not.toHaveBeenCalled();
  });
});

// ── 3. Plan gates ─────────────────────────────────────────────────────────────

describe('plan gates', () => {
  it('writing.enabled=false blocks with FEATURE_DISABLED before any DB/orchestrator call', async () => {
    const entitlements = permissiveEntitlements();
    entitlements.writing.enabled = false;
    mockGetCurrentUserPlanEntitlements.mockResolvedValue(entitlements);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(403);
    expect(mockEvaluateWritingRewrite).not.toHaveBeenCalled();
  });

  it('REWRITE_V2 disabled (rollback) blocks with 503 before any DB/orchestrator call', async () => {
    mockIsRewriteV2Enabled.mockReturnValue(false);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(503);
    expect(mockEvaluateWritingRewrite).not.toHaveBeenCalled();
  });

  it('rate-limited request never reaches the orchestrator', async () => {
    mockApplyRateLimit.mockResolvedValue(false);
    await handler(makeReq(), makeRes());
    expect(mockEvaluateWritingRewrite).not.toHaveBeenCalled();
  });
});

// ── 4. Exactly one evaluation call per submission, correct DTO used ─────────

describe('exactly one AI Gateway evaluation call per submission', () => {
  it('a fresh submission creates one draft, submits it, and calls the orchestrator exactly once', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect(mockCreateRewriteAttempt).toHaveBeenCalledTimes(1);
    expect(mockUpdateRewriteAttemptStatus).toHaveBeenCalledWith(expect.anything(), ATTEMPT_ID, 'submitted', expect.any(String));
    expect(mockEvaluateWritingRewrite).toHaveBeenCalledTimes(1);
    expect(mockEvaluateWritingRewrite).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ rewriteSubmissionId: ATTEMPT_ID }));
    expect(res._status()).toBe(200);
    expect((res._body() as any).result).toEqual(EVALUATED_DTO);
  });

  it('the response the frontend receives is exactly what evaluateWritingRewrite returned — no second transformation call', async () => {
    const res = makeRes();
    await handler(makeReq(), res);
    expect((res._body() as any).result).toBe(EVALUATED_DTO);
  });
});

// ── 5. Idempotency — retry, double-click, resend ─────────────────────────────

describe('idempotency', () => {
  it('a same-content resend while status=evaluation_pending reuses the SAME attempt id, never creates a new attempt', async () => {
    mockGetLatestRewriteAttempt.mockResolvedValue(attemptFixture({ status: 'evaluation_pending', rewriteText: REWRITE_TEXT }));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(mockCreateRewriteAttempt).not.toHaveBeenCalled();
    expect(mockUpdateRewriteText).not.toHaveBeenCalled();
    expect(mockUpdateRewriteAttemptStatus).not.toHaveBeenCalled();
    expect(mockEvaluateWritingRewrite).toHaveBeenCalledTimes(1);
    expect(mockEvaluateWritingRewrite).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ rewriteSubmissionId: ATTEMPT_ID }));
    expect(res._status()).toBe(200);
  });

  it('a same-content resend after a prior evaluation_failed reuses the SAME attempt id (legitimate retry)', async () => {
    mockGetLatestRewriteAttempt.mockResolvedValue(attemptFixture({ status: 'evaluation_failed', rewriteText: REWRITE_TEXT }));
    await handler(makeReq(), makeRes());
    expect(mockCreateRewriteAttempt).not.toHaveBeenCalled();
    expect(mockEvaluateWritingRewrite).toHaveBeenCalledTimes(1);
    expect(mockEvaluateWritingRewrite).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ rewriteSubmissionId: ATTEMPT_ID }));
  });

  it('a same-content resend AFTER the attempt is already evaluated returns the cached result and never calls the orchestrator again', async () => {
    mockGetLatestRewriteAttempt.mockResolvedValue(attemptFixture({ status: 'evaluated', rewriteText: REWRITE_TEXT }));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(mockEvaluateWritingRewrite).not.toHaveBeenCalled();
    expect(mockGetEvaluationForAttempt).toHaveBeenCalledWith(expect.anything(), ATTEMPT_ID, 1);
    expect(mockCreateRewriteAttempt).not.toHaveBeenCalled();
    expect(res._status()).toBe(200);
    expect((res._body() as any).result.rewriteSubmissionId).toBe(ATTEMPT_ID);
  });

  it('a DIFFERENT rewrite text after a completed evaluation creates a genuinely new attempt (not wrongly deduped)', async () => {
    mockGetLatestRewriteAttempt.mockResolvedValue(attemptFixture({ status: 'evaluated', rewriteText: 'a completely different rewrite' }));
    mockGetNextRewriteSequence.mockResolvedValue(2);
    const res = makeRes();
    await handler(makeReq(), res); // makeReq() sends REWRITE_TEXT, which differs from the fixture's stored text
    expect(mockCreateRewriteAttempt).toHaveBeenCalledTimes(1);
    expect(mockCreateRewriteAttempt).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ rewriteSequence: 2 }));
    expect(mockEvaluateWritingRewrite).toHaveBeenCalledTimes(1);
    expect(res._status()).toBe(200);
  });

  it('double-click race: two concurrent requests for the same fresh submission each independently create/reuse and call the orchestrator once per call — no crash, no unhandled rejection', async () => {
    const results = await Promise.all([
      handler(makeReq(), makeRes()),
      handler(makeReq(), makeRes()),
    ]);
    expect(results).toHaveLength(2);
    // Both calls succeeded from the handler's perspective (mocks don't model
    // the DB unique-constraint race itself — that's covered by the real
    // constraint in production and documented in the endpoint's comments;
    // this test proves the handler itself never throws/hangs under concurrent
    // invocation).
    expect(mockEvaluateWritingRewrite).toHaveBeenCalledTimes(2);
  });
});

// ── 6. Failures are never silent ─────────────────────────────────────────────

describe('failures are surfaced, never swallowed', () => {
  it('an orchestrator rejection returns a 500 error response, not a silent 200', async () => {
    mockEvaluateWritingRewrite.mockRejectedValue(new Error('model evaluator failed'));
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(500);
    expect((res._body() as any).code).toBe('EVALUATION_FAILED');
  });

  it('a Supabase error fetching the review returns 404, not a silent success', async () => {
    mockSingle.mockResolvedValue({ data: null, error: { message: 'db down' } });
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res._status()).toBe(404);
  });
});

// ── 7. Request validation ─────────────────────────────────────────────────────

describe('request validation', () => {
  it('missing reviewId is rejected with 400', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { rewriteText: REWRITE_TEXT } }), res);
    expect(res._status()).toBe(400);
    expect(mockEvaluateWritingRewrite).not.toHaveBeenCalled();
  });

  it('missing rewriteText is rejected with 400', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { reviewId: REVIEW_ID } }), res);
    expect(res._status()).toBe(400);
    expect(mockEvaluateWritingRewrite).not.toHaveBeenCalled();
  });
});

// ── 8. Content-quality gate — rejects gibberish before any DB/AI work ────────

describe('content-quality validation (invalid rewrite text)', () => {
  it('the exact reported bug input ("5eysvduduud") is rejected with 400 INVALID_REWRITE_TEXT, no DB or orchestrator call', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { reviewId: REVIEW_ID, rewriteText: '5eysvduduud' } }), res);
    expect(res._status()).toBe(400);
    expect((res._body() as any).code).toBe('INVALID_REWRITE_TEXT');
    expect(mockSingle).not.toHaveBeenCalled();
    expect(mockGetLatestRewriteAttempt).not.toHaveBeenCalled();
    expect(mockCreateRewriteAttempt).not.toHaveBeenCalled();
    expect(mockEvaluateWritingRewrite).not.toHaveBeenCalled();
  });

  it('multi-token keyboard-mash gibberish is rejected with 400 INVALID_REWRITE_TEXT', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { reviewId: REVIEW_ID, rewriteText: 'xkcd qzwe mnbv zxqw' } }), res);
    expect(res._status()).toBe(400);
    expect((res._body() as any).code).toBe('INVALID_REWRITE_TEXT');
    expect(mockEvaluateWritingRewrite).not.toHaveBeenCalled();
  });

  it('a short but legitimate sentence is NOT rejected by the content gate (reaches the orchestrator)', async () => {
    const res = makeRes();
    await handler(makeReq({ body: { reviewId: REVIEW_ID, rewriteText: 'I like cats.' } }), res);
    expect(res._status()).toBe(200);
    expect(mockEvaluateWritingRewrite).toHaveBeenCalledTimes(1);
  });
});
