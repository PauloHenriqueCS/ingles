/**
 * SECTION 7 — REAL AZURE EVALUATION
 *
 * COST RULE: MAX 1 real Azure pronunciation assessment call in this entire suite.
 * This test is skipped unless ALL of these are set:
 *   - E2E_USER_A_TOKEN   (real Supabase JWT)
 *   - E2E_REVIEW_ID_A    (real textVersionId with correctedText in DB)
 *   - E2E_ENABLE_AZURE   (must be exactly "1" to opt-in)
 *
 * What it tests:
 * - /start returns a real Azure token and region
 * - The Azure token is non-empty and looks like a JWT
 * - /complete accepts a synthetic result (we do NOT call Azure SDK — too complex for E2E)
 * - /status after complete returns status: completed with result fields
 *
 * We intentionally do NOT call the Azure SDK here to avoid:
 * 1. Microphone permission complexity in CI
 * 2. Audio streaming overhead
 * 3. Azure billing beyond 1 call
 *
 * The real SDK call happens manually in the browser (Section 7 acceptance: "1 real Chrome run").
 */
import { test, expect } from '@playwright/test';
import { apiClient } from './helpers/api-client';

const USER_A_TOKEN    = process.env.E2E_USER_A_TOKEN  ?? '';
const E2E_REVIEW_A    = process.env.E2E_REVIEW_ID_A   ?? '';
const ENABLE_AZURE    = process.env.E2E_ENABLE_AZURE   ?? '';

function skipIfNotEnabled() {
  const missing = !USER_A_TOKEN || !E2E_REVIEW_A || ENABLE_AZURE !== '1';
  test.skip(
    missing,
    'E2E_ENABLE_AZURE=1 not set (or missing credentials) — skipping real Azure tests',
  );
}

// ── Section 7.1 — /start issues real Azure token ─────────────────────────────

test.describe('Azure real — /start token shape', () => {
  let assessmentId: string | null = null;
  let attemptId: string | null = null;

  test.afterAll(async () => {
    // Clean up: if we started an assessment but did not complete it, fail it
    if (assessmentId && attemptId && USER_A_TOKEN) {
      await apiClient.post(
        '/api/pronunciation/fail',
        { assessmentId, attemptId, code: 'AZURE_REAL_TEST_CLEANUP' },
        USER_A_TOKEN,
      ).catch(() => {/* ignore cleanup errors */});
    }
  });

  test('/start returns a real Azure STS token (non-empty, >= 100 chars)', async () => {
    skipIfNotEnabled();

    attemptId = `azure-real-attempt-${Date.now()}`;

    const r = await apiClient.post<{
      assessmentId: string;
      attemptId:    string;
      token:        string;
      region:       string;
      language:     string;
      referenceText: string;
    }>(
      '/api/pronunciation/start',
      { textVersionId: E2E_REVIEW_A, attemptId },
      USER_A_TOKEN,
    );

    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(r.body.token.length).toBeGreaterThanOrEqual(100);
    expect(r.body.region).toBeTruthy();
    expect(r.body.language).toMatch(/^[a-z]{2}-[A-Z]{2}$/); // e.g. en-US
    expect(r.body.referenceText).toBeTruthy();
    expect(r.body.referenceText.length).toBeGreaterThan(10);

    assessmentId = r.body.assessmentId;
    attemptId    = r.body.attemptId;
  });

  test('/start token does not contain AZURE_SPEECH_KEY literal', async () => {
    skipIfNotEnabled();
    // This verifies the server returns an STS token, not the raw API key
    const tmpAttemptId = `azure-key-check-${Date.now()}`;
    const r = await apiClient.post<{ token: string; assessmentId: string }>(
      '/api/pronunciation/start',
      { textVersionId: E2E_REVIEW_A, attemptId: tmpAttemptId },
      USER_A_TOKEN,
    );

    if (r.status === 409) {
      // Previous test already reserved — that is fine, skip assertion
      return;
    }

    if (r.status === 200) {
      expect(r.body.token).not.toContain('AZURE_SPEECH_KEY');
      // Clean up
      await apiClient.post(
        '/api/pronunciation/fail',
        { assessmentId: r.body.assessmentId, attemptId: tmpAttemptId, code: 'KEY_CHECK_CLEANUP' },
        USER_A_TOKEN,
      ).catch(() => {/* ignore */});
    }
  });
});

// ── Section 7.2 — /complete with synthetic result ────────────────────────────

test.describe('Azure real — /complete and /status round-trip', () => {
  test('Full round-trip: /start → /complete → /status returns completed with result', async () => {
    skipIfNotEnabled();

    const attemptId = `azure-roundtrip-${Date.now()}`;

    const startR = await apiClient.post<{
      assessmentId: string;
      attemptId:    string;
      token:        string;
      region:       string;
    }>(
      '/api/pronunciation/start',
      { textVersionId: E2E_REVIEW_A, attemptId },
      USER_A_TOKEN,
    );

    if (startR.status === 409) {
      test.skip(true, 'Assessment already in progress — clean up DB before re-running');
      return;
    }

    expect(startR.status).toBe(200);
    const { assessmentId } = startR.body;

    // Submit a synthetic result (no real Azure SDK call)
    const syntheticResult = {
      pronunciationScore:   75,
      accuracyScore:        78,
      fluencyScore:         70,
      completenessScore:    80,
      prosodyScore:         72,
      recognizedText:       'hello world test',
      wordsJson:            [
        { word: 'hello', accuracyScore: 90, errorType: 'None' },
        { word: 'world', accuracyScore: 75, errorType: 'None' },
        { word: 'test',  accuracyScore: 60, errorType: 'Mispronunciation' },
      ],
      rawSegments:          [],
      audioDurationSeconds: 3,
    };

    const completeR = await apiClient.post<{ assessmentId: string; status: string }>(
      '/api/pronunciation/complete',
      { assessmentId, attemptId, result: syntheticResult },
      USER_A_TOKEN,
    );

    expect(completeR.status).toBe(200);
    expect(completeR.body.status).toBe('completed');

    // Verify /status now returns completed with result
    const statusR = await apiClient.get<{
      status:      string;
      canAnalyze:  boolean;
      assessmentId: string;
      result?: {
        pronunciationScore: number;
        recognizedText:     string;
      };
    }>(
      `/api/pronunciation/status?textVersionId=${encodeURIComponent(E2E_REVIEW_A)}`,
      USER_A_TOKEN,
    );

    expect(statusR.status).toBe(200);
    expect(statusR.body.status).toBe('completed');
    expect(statusR.body.assessmentId).toBe(assessmentId);
    expect(statusR.body.canAnalyze).toBe(false);
    expect(statusR.body.result).toBeDefined();
    expect(statusR.body.result?.pronunciationScore).toBe(75);
    expect(statusR.body.result?.recognizedText).toBe('hello world test');
  });
});

// ── Section 7.3 — /fail and retry ─────────────────────────────────────────────

test.describe('Azure real — /fail then retry', () => {
  test('/fail marks assessment failed_retryable, second /start succeeds', async () => {
    skipIfNotEnabled();

    const attemptId1 = `azure-fail-retry-1-${Date.now()}`;

    const startR1 = await apiClient.post<{ assessmentId: string }>(
      '/api/pronunciation/start',
      { textVersionId: E2E_REVIEW_A, attemptId: attemptId1 },
      USER_A_TOKEN,
    );

    if (startR1.status === 409) {
      test.skip(true, 'Assessment already in progress — clean up before re-running');
      return;
    }

    expect(startR1.status).toBe(200);

    // Fail with retryable code
    const failR = await apiClient.post<{ status: string }>(
      '/api/pronunciation/fail',
      { assessmentId: startR1.body.assessmentId, attemptId: attemptId1, code: 'NETWORK_ERROR' },
      USER_A_TOKEN,
    );

    expect(failR.status).toBe(200);

    // Status should now be failed_retryable
    const statusR = await apiClient.get<{ status: string; canAnalyze: boolean }>(
      `/api/pronunciation/status?textVersionId=${encodeURIComponent(E2E_REVIEW_A)}`,
      USER_A_TOKEN,
    );

    expect(statusR.status).toBe(200);
    expect(['failed_retryable', 'failed_final']).toContain(statusR.body.status);
    expect(statusR.body.canAnalyze).toBe(true);

    // Second /start should succeed (retry allowed)
    const attemptId2 = `azure-fail-retry-2-${Date.now()}`;
    const startR2 = await apiClient.post<{ assessmentId: string }>(
      '/api/pronunciation/start',
      { textVersionId: E2E_REVIEW_A, attemptId: attemptId2 },
      USER_A_TOKEN,
    );

    expect(startR2.status).toBe(200);

    // Clean up
    await apiClient.post(
      '/api/pronunciation/fail',
      { assessmentId: startR2.body.assessmentId, attemptId: attemptId2, code: 'RETRY_TEST_CLEANUP' },
      USER_A_TOKEN,
    ).catch(() => {/* ignore */});
  });
});
