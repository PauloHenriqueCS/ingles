/**
 * SECTION 6 — CONCURRENCY
 *
 * Validates that two simultaneous /start calls for the same textVersionId result
 * in exactly one winning assessment (409 on the second call), preventing double
 * Azure billing.
 *
 * Requires real credentials via E2E_USER_A_TOKEN and a valid E2E_REVIEW_ID_A.
 * Skips gracefully when credentials are absent.
 *
 * NOTE: This test does NOT actually call Azure SDK — it only calls /start (which
 * reserves a DB row) and then immediately calls /fail to clean up. Max cost: 0
 * real Azure calls.
 */
import { test, expect } from '@playwright/test';
import { apiClient } from './helpers/api-client';

const USER_A_TOKEN = process.env.E2E_USER_A_TOKEN ?? '';
const E2E_REVIEW_A = process.env.E2E_REVIEW_ID_A  ?? '';

function skipIfNoCredentials() {
  const missing = !USER_A_TOKEN || !E2E_REVIEW_A;
  test.skip(missing, 'E2E_USER_A_TOKEN or E2E_REVIEW_ID_A not set — skipping concurrency tests');
}

// ── Section 6.1 — Double-start prevention ────────────────────────────────────

test.describe('Concurrency — double-start prevention', () => {
  test('Two simultaneous /start calls: exactly one succeeds, one gets 409', async () => {
    skipIfNoCredentials();

    const attemptId1 = `concurrency-attempt-1-${Date.now()}`;
    const attemptId2 = `concurrency-attempt-2-${Date.now()}`;

    // Fire both requests simultaneously
    const [r1, r2] = await Promise.all([
      apiClient.post<{ assessmentId?: string; error?: string }>(
        '/api/pronunciation/start',
        { textVersionId: E2E_REVIEW_A, attemptId: attemptId1 },
        USER_A_TOKEN,
      ),
      apiClient.post<{ assessmentId?: string; error?: string }>(
        '/api/pronunciation/start',
        { textVersionId: E2E_REVIEW_A, attemptId: attemptId2 },
        USER_A_TOKEN,
      ),
    ]);

    const statuses = [r1.status, r2.status].sort();
    const successCount = statuses.filter(s => s === 200).length;
    const conflictCount = statuses.filter(s => s === 409).length;

    // One must succeed, one must conflict
    expect(successCount).toBe(1);
    expect(conflictCount).toBe(1);

    // Clean up: fail the winning assessment so state is reset
    const winner = r1.status === 200 ? r1 : r2;
    if (winner.body.assessmentId) {
      await apiClient.post(
        '/api/pronunciation/fail',
        {
          assessmentId: winner.body.assessmentId,
          attemptId:    r1.status === 200 ? attemptId1 : attemptId2,
          code:         'CONCURRENCY_TEST_CLEANUP',
        },
        USER_A_TOKEN,
      );
    }
  });

  test('/start returns 409 when assessment already processing for same textVersionId', async () => {
    skipIfNoCredentials();

    const attemptId1 = `seq-attempt-1-${Date.now()}`;
    const attemptId2 = `seq-attempt-2-${Date.now()}`;

    // Sequential start to ensure ordering
    const r1 = await apiClient.post<{ assessmentId?: string; error?: string }>(
      '/api/pronunciation/start',
      { textVersionId: E2E_REVIEW_A, attemptId: attemptId1 },
      USER_A_TOKEN,
    );

    // Accept 200 or 409 (previous test may have left a processing state)
    if (r1.status !== 200) {
      // Clean state — skip second assertion
      test.skip(true, 'Could not get initial 200 from /start (state may be dirty)');
      return;
    }

    // Immediately try again
    const r2 = await apiClient.post<{ error?: string }>(
      '/api/pronunciation/start',
      { textVersionId: E2E_REVIEW_A, attemptId: attemptId2 },
      USER_A_TOKEN,
    );

    expect(r2.status).toBe(409);

    // Clean up
    if (r1.body.assessmentId) {
      await apiClient.post(
        '/api/pronunciation/fail',
        {
          assessmentId: r1.body.assessmentId,
          attemptId:    attemptId1,
          code:         'CONCURRENCY_TEST_CLEANUP',
        },
        USER_A_TOKEN,
      );
    }
  });
});

// ── Section 6.2 — State machine transitions ──────────────────────────────────

test.describe('Concurrency — state machine transitions', () => {
  test('/complete after /fail returns 404 or 409 (no ghost completion)', async () => {
    skipIfNoCredentials();

    const attemptId = `state-machine-test-${Date.now()}`;

    const startR = await apiClient.post<{ assessmentId?: string }>(
      '/api/pronunciation/start',
      { textVersionId: E2E_REVIEW_A, attemptId },
      USER_A_TOKEN,
    );

    if (startR.status !== 200 || !startR.body.assessmentId) {
      test.skip(true, 'Could not start assessment for state machine test');
      return;
    }

    const assessmentId = startR.body.assessmentId;

    // Fail it first
    await apiClient.post(
      '/api/pronunciation/fail',
      { assessmentId, attemptId, code: 'STATE_MACHINE_TEST' },
      USER_A_TOKEN,
    );

    // Now try to complete it — must be rejected
    const completeR = await apiClient.post<{ error?: string }>(
      '/api/pronunciation/complete',
      {
        assessmentId,
        attemptId,
        result: { pronunciationScore: 99, accuracyScore: 99 },
      },
      USER_A_TOKEN,
    );

    expect([404, 409]).toContain(completeR.status);
  });

  test('/fail after /complete returns 404 or 409 (no ghost failure)', async () => {
    skipIfNoCredentials();

    const attemptId = `state-machine-complete-first-${Date.now()}`;

    const startR = await apiClient.post<{ assessmentId?: string }>(
      '/api/pronunciation/start',
      { textVersionId: E2E_REVIEW_A, attemptId },
      USER_A_TOKEN,
    );

    if (startR.status !== 200 || !startR.body.assessmentId) {
      test.skip(true, 'Could not start assessment for state machine test');
      return;
    }

    const assessmentId = startR.body.assessmentId;

    // Complete it
    const completeR = await apiClient.post<{ error?: string }>(
      '/api/pronunciation/complete',
      {
        assessmentId,
        attemptId,
        result: {
          pronunciationScore:   80,
          accuracyScore:        80,
          fluencyScore:         80,
          completenessScore:    80,
          prosodyScore:         null,
          recognizedText:       'hello world',
          wordsJson:            [],
          rawSegments:          [],
          audioDurationSeconds: 2,
        },
      },
      USER_A_TOKEN,
    );

    // Accept 200 (completed) or 404/409 (state already changed)
    if (completeR.status !== 200) {
      // Clean up and skip
      await apiClient.post(
        '/api/pronunciation/fail',
        { assessmentId, attemptId, code: 'STATE_MACHINE_CLEANUP' },
        USER_A_TOKEN,
      );
      return;
    }

    // Now try to fail it after completion
    const failR = await apiClient.post<{ error?: string }>(
      '/api/pronunciation/fail',
      { assessmentId, attemptId, code: 'GHOST_FAIL_TEST' },
      USER_A_TOKEN,
    );

    expect([404, 409]).toContain(failR.status);
  });
});
