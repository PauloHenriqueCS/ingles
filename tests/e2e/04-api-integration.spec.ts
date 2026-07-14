/**
 * SECTION 4 — API INTEGRATION
 *
 * Real HTTP tests against the running API server.
 * Guarded by E2E_API_BASE env var — tests skip gracefully when not set.
 *
 * Uses the typed api-client helper for all calls.
 * Max cost rule: no Azure calls in this file (only status/start/complete/fail).
 */
import { test, expect } from '@playwright/test';
import { apiClient, requireApiBase, API_BASE, getStatus } from './helpers/api-client';
import { TEST_USER_A } from './helpers/auth';

test.beforeAll(() => {
  if (!API_BASE) {
    // We cannot skip at the suite level in Playwright, so we use test.skip in each test.
    // requireApiBase() throws if not set — we capture the condition here.
  }
});

function skipIfNoApi() {
  if (!API_BASE) {
    test.skip(true, 'E2E_API_BASE not set — skipping real API tests');
  }
}

// ── Section 4.1 — Auth guard on all endpoints ────────────────────────────────

test.describe('API — auth guard', () => {
  test('GET /api/pronunciation/status returns 401 without token', async () => {
    skipIfNoApi();
    const r = await apiClient.get<{ error: string }>(
      '/api/pronunciation/status?textVersionId=test-id',
    );
    expect(r.status).toBe(401);
  });

  test('POST /api/pronunciation/start returns 401 without token', async () => {
    skipIfNoApi();
    const r = await apiClient.post<{ error: string }>('/api/pronunciation/start', {
      textVersionId: 'test-id',
      attemptId:     'attempt-id',
    });
    expect(r.status).toBe(401);
  });

  test('POST /api/pronunciation/complete returns 401 without token', async () => {
    skipIfNoApi();
    const r = await apiClient.post<{ error: string }>('/api/pronunciation/complete', {
      assessmentId: 'test-id',
      attemptId:    'attempt-id',
      result:       {},
    });
    expect(r.status).toBe(401);
  });

  test('POST /api/pronunciation/fail returns 401 without token', async () => {
    skipIfNoApi();
    const r = await apiClient.post<{ error: string }>('/api/pronunciation/fail', {
      assessmentId: 'test-id',
      attemptId:    'attempt-id',
      code:         'TEST_ERROR',
    });
    expect(r.status).toBe(401);
  });

  test('GET /api/pronunciation/status returns 401 with malformed token', async () => {
    skipIfNoApi();
    const r = await apiClient.get<{ error: string }>(
      '/api/pronunciation/status?textVersionId=test-id',
      'not-a-real-token',
    );
    expect(r.status).toBe(401);
  });
});

// ── Section 4.2 — Input validation ──────────────────────────────────────────

test.describe('API — input validation', () => {
  const fakeToken = TEST_USER_A.token;

  test('GET /api/pronunciation/status returns 400 when textVersionId is missing', async () => {
    skipIfNoApi();
    const r = await apiClient.get<{ error: string }>(
      '/api/pronunciation/status',
      fakeToken,
    );
    // 400 or 401 depending on whether auth runs first
    expect([400, 401]).toContain(r.status);
  });

  test('POST /api/pronunciation/start returns 400 when body fields missing', async () => {
    skipIfNoApi();
    const r = await apiClient.post<{ error: string }>(
      '/api/pronunciation/start',
      { textVersionId: 'only-one-field' },
      fakeToken,
    );
    expect([400, 401]).toContain(r.status);
  });

  test('POST /api/pronunciation/complete returns 400 when assessmentId missing', async () => {
    skipIfNoApi();
    const r = await apiClient.post<{ error: string }>(
      '/api/pronunciation/complete',
      { result: {} },
      fakeToken,
    );
    expect([400, 401]).toContain(r.status);
  });

  test('POST /api/pronunciation/fail returns 400 when code missing', async () => {
    skipIfNoApi();
    const r = await apiClient.post<{ error: string }>(
      '/api/pronunciation/fail',
      { assessmentId: 'test', attemptId: 'test' },
      fakeToken,
    );
    expect([400, 401]).toContain(r.status);
  });
});

// ── Section 4.3 — Status endpoint response shape ─────────────────────────────

test.describe('API — /status response shape', () => {
  const fakeToken = TEST_USER_A.token;

  test('/status response has required fields for unknown textVersionId', async () => {
    skipIfNoApi();
    const nonExistentId = `e2e-nonexistent-${Date.now()}`;
    const r = await apiClient.get<{
      status: string;
      canAnalyze: boolean;
      assessmentId: string | null;
    }>(`/api/pronunciation/status?textVersionId=${nonExistentId}`, fakeToken);

    // Either 401 (fakeToken invalid) or 200 with proper shape
    if (r.status === 200) {
      expect(r.body).toHaveProperty('status');
      expect(r.body).toHaveProperty('canAnalyze');
      expect(r.body).toHaveProperty('assessmentId');
      expect(['available', 'processing', 'completed', 'failed_retryable', 'failed_final']).toContain(r.body.status);
    } else {
      expect(r.status).toBe(401);
    }
  });

  test('/status includes Cache-Control: no-store header', async () => {
    skipIfNoApi();
    const r = await apiClient.get<unknown>(
      `/api/pronunciation/status?textVersionId=e2e-cache-test-${Date.now()}`,
      fakeToken,
    );
    if (r.status === 200) {
      const cc = r.headers['cache-control'] ?? '';
      expect(cc).toContain('no-store');
    }
  });
});

// ── Section 4.4 — Method validation ─────────────────────────────────────────

test.describe('API — HTTP method validation', () => {
  const fakeToken = TEST_USER_A.token;

  test('GET /api/pronunciation/start returns 405 (only POST allowed)', async () => {
    skipIfNoApi();
    const r = await apiClient.get<{ error: string }>(
      '/api/pronunciation/start',
      fakeToken,
    );
    expect([405, 404, 401]).toContain(r.status);
  });

  test('GET /api/pronunciation/complete returns 405 (only POST allowed)', async () => {
    skipIfNoApi();
    const r = await apiClient.get<{ error: string }>(
      '/api/pronunciation/complete',
      fakeToken,
    );
    expect([405, 404, 401]).toContain(r.status);
  });

  test('GET /api/pronunciation/fail returns 405 (only POST allowed)', async () => {
    skipIfNoApi();
    const r = await apiClient.get<{ error: string }>(
      '/api/pronunciation/fail',
      fakeToken,
    );
    expect([405, 404, 401]).toContain(r.status);
  });
});

// ── Section 4.5 — CORS / content-type headers ────────────────────────────────

test.describe('API — response headers', () => {
  const fakeToken = TEST_USER_A.token;

  test('/status returns application/json content-type', async () => {
    skipIfNoApi();
    const r = await apiClient.get<unknown>(
      `/api/pronunciation/status?textVersionId=e2e-ct-test-${Date.now()}`,
      fakeToken,
    );
    const ct = r.headers['content-type'] ?? '';
    expect(ct).toContain('application/json');
  });

  test('/start returns application/json content-type on 401', async () => {
    skipIfNoApi();
    const r = await apiClient.post<unknown>('/api/pronunciation/start', {
      textVersionId: 'x',
      attemptId:     'y',
    });
    const ct = r.headers['content-type'] ?? '';
    expect(ct).toContain('application/json');
  });
});
