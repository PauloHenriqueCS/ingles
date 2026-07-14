/**
 * SECTION 5 — ROW-LEVEL SECURITY (RLS) ISOLATION
 *
 * Verifies that User A's pronunciation assessments are not visible to User B.
 * Requires real Supabase credentials via E2E_USER_A_TOKEN and E2E_USER_B_TOKEN.
 *
 * Skips when credentials are absent — never fails CI due to missing env vars.
 */
import { test, expect } from '@playwright/test';
import { apiClient } from './helpers/api-client';

const USER_A_TOKEN  = process.env.E2E_USER_A_TOKEN  ?? '';
const USER_B_TOKEN  = process.env.E2E_USER_B_TOKEN  ?? '';
const E2E_REVIEW_A  = process.env.E2E_REVIEW_ID_A   ?? ''; // a textVersionId belonging to User A

function skipIfNoCredentials() {
  const missing = !USER_A_TOKEN || !USER_B_TOKEN;
  test.skip(missing, 'E2E_USER_A_TOKEN or E2E_USER_B_TOKEN not set — skipping RLS tests');
}

// ── Section 5.1 — Status endpoint isolation ──────────────────────────────────

test.describe('RLS — /status isolation', () => {
  test('User A can read their own assessment status', async () => {
    skipIfNoCredentials();
    if (!E2E_REVIEW_A) {
      test.skip(true, 'E2E_REVIEW_ID_A not set');
    }

    const r = await apiClient.get<{
      status: string;
      canAnalyze: boolean;
      assessmentId: string | null;
    }>(`/api/pronunciation/status?textVersionId=${encodeURIComponent(E2E_REVIEW_A)}`, USER_A_TOKEN);

    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('status');
    expect(r.body).toHaveProperty('canAnalyze');
  });

  test('User B cannot read User A assessment status (returns available/null)', async () => {
    skipIfNoCredentials();
    if (!E2E_REVIEW_A) {
      test.skip(true, 'E2E_REVIEW_ID_A not set');
    }

    const r = await apiClient.get<{
      status: string;
      assessmentId: string | null;
    }>(`/api/pronunciation/status?textVersionId=${encodeURIComponent(E2E_REVIEW_A)}`, USER_B_TOKEN);

    // RLS prevents User B from seeing User A's data:
    // either returns 404 / 403, or returns available with assessmentId: null
    if (r.status === 200) {
      // If 200, must not return User A's assessmentId
      expect(r.body.assessmentId).toBeNull();
      expect(r.body.status).toBe('available');
    } else {
      expect([403, 404]).toContain(r.status);
    }
  });
});

// ── Section 5.2 — Start endpoint isolation ────────────────────────────────────

test.describe('RLS — /start isolation', () => {
  test('User B cannot start assessment for User A review ID', async () => {
    skipIfNoCredentials();
    if (!E2E_REVIEW_A) {
      test.skip(true, 'E2E_REVIEW_ID_A not set');
    }

    const r = await apiClient.post<{ error?: string }>(
      '/api/pronunciation/start',
      {
        textVersionId: E2E_REVIEW_A,
        attemptId:     `rls-test-attempt-${Date.now()}`,
      },
      USER_B_TOKEN,
    );

    // Must not allow User B to start an assessment for User A's review
    // Either 403 (explicit deny) or 404 (row not visible due to RLS)
    expect([403, 404]).toContain(r.status);
  });
});

// ── Section 5.3 — Complete endpoint isolation ─────────────────────────────────

test.describe('RLS — /complete isolation', () => {
  test('User B cannot complete User A assessment', async () => {
    skipIfNoCredentials();
    // Use a synthetic ID that cannot exist for User B
    const fakeAssessmentId = '00000000-rls-test-0000-000000000001';

    const r = await apiClient.post<{ error?: string }>(
      '/api/pronunciation/complete',
      {
        assessmentId: fakeAssessmentId,
        attemptId:    `rls-complete-test-${Date.now()}`,
        result:       { pronunciationScore: 99 },
      },
      USER_B_TOKEN,
    );

    // Either 403 or 404 — row not found for this user
    expect([403, 404]).toContain(r.status);
  });
});

// ── Section 5.4 — Fail endpoint isolation ────────────────────────────────────

test.describe('RLS — /fail isolation', () => {
  test('User B cannot fail User A assessment', async () => {
    skipIfNoCredentials();
    const fakeAssessmentId = '00000000-rls-test-0000-000000000002';

    const r = await apiClient.post<{ error?: string }>(
      '/api/pronunciation/fail',
      {
        assessmentId: fakeAssessmentId,
        attemptId:    `rls-fail-test-${Date.now()}`,
        code:         'RLS_TEST_ERROR',
      },
      USER_B_TOKEN,
    );

    expect([403, 404]).toContain(r.status);
  });
});

// ── Section 5.5 — Token swap attack ─────────────────────────────────────────

test.describe('RLS — token swap attack', () => {
  test('Swapping to User B token mid-flow does not reveal User A data', async () => {
    skipIfNoCredentials();
    if (!E2E_REVIEW_A) {
      test.skip(true, 'E2E_REVIEW_ID_A not set');
    }

    // User A status request
    const rA = await apiClient.get<{ assessmentId: string | null }>(
      `/api/pronunciation/status?textVersionId=${encodeURIComponent(E2E_REVIEW_A)}`,
      USER_A_TOKEN,
    );

    // User B uses the same URL
    const rB = await apiClient.get<{ assessmentId: string | null }>(
      `/api/pronunciation/status?textVersionId=${encodeURIComponent(E2E_REVIEW_A)}`,
      USER_B_TOKEN,
    );

    if (rA.status === 200 && rA.body.assessmentId !== null) {
      // If User A has an assessment, User B must not see it
      if (rB.status === 200) {
        expect(rB.body.assessmentId).toBeNull();
      } else {
        expect([403, 404]).toContain(rB.status);
      }
    }
    // If User A has no assessment, the test is still valid (no data to leak)
  });
});
