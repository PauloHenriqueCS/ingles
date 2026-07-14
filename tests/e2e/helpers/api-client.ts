/**
 * Typed API client for integration tests against a real running backend.
 *
 * Reads API_BASE from environment. All methods throw on network errors.
 * Tests using this helper MUST be guarded with skipWhenNoApiBase().
 */

export const API_BASE = process.env.E2E_API_BASE ?? process.env.E2E_BASE_URL ?? '';

/** Skip the test file when API_BASE is not configured. */
export function requireApiBase() {
  if (!API_BASE) {
    throw new Error(
      'E2E_API_BASE not set. Set E2E_API_BASE=https://your-deployment.vercel.app ' +
      'or run vercel dev locally to enable API integration tests.',
    );
  }
}

export interface ApiResponse<T> {
  status: number;
  ok: boolean;
  body: T;
  headers: Record<string, string>;
}

async function request<T>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  let body: T;
  try {
    body = (await resp.json()) as T;
  } catch {
    body = null as unknown as T;
  }

  const respHeaders: Record<string, string> = {};
  resp.headers.forEach((v, k) => { respHeaders[k] = v; });

  return { status: resp.status, ok: resp.ok, body, headers: respHeaders };
}

export const apiClient = {
  get:    <T>(path: string, token?: string) => request<T>('GET',  path, { token }),
  post:   <T>(path: string, body: unknown, token?: string) => request<T>('POST', path, { token, body }),
  put:    <T>(path: string, body: unknown, token?: string) => request<T>('PUT',  path, { token, body }),
  delete: <T>(path: string, token?: string) => request<T>('DELETE', path, { token }),
};

// ── Typed wrappers ────────────────────────────────────────────────────────────

export type StatusResponse = {
  status: 'available' | 'processing' | 'completed' | 'failed_retryable' | 'failed_final';
  canAnalyze: boolean;
  assessmentId: string | null;
  result?: unknown;
};

export function getStatus(textVersionId: string, token: string) {
  return apiClient.get<StatusResponse>(
    `/api/pronunciation/status?textVersionId=${encodeURIComponent(textVersionId)}`,
    token,
  );
}

export function startAssessment(
  textVersionId: string,
  attemptId: string,
  token: string,
) {
  return apiClient.post<{
    assessmentId: string;
    attemptId: string;
    token: string;
    region: string;
    language: string;
    referenceText: string;
  }>('/api/pronunciation/start', { textVersionId, attemptId }, token);
}

export function completeAssessment(
  assessmentId: string,
  attemptId: string,
  result: unknown,
  token: string,
) {
  return apiClient.post<{ assessmentId: string; status: string }>(
    '/api/pronunciation/complete',
    { assessmentId, attemptId, result },
    token,
  );
}

export function failAssessment(
  assessmentId: string,
  attemptId: string,
  code: string,
  token: string,
) {
  return apiClient.post<{ status: string }>(
    '/api/pronunciation/fail',
    { assessmentId, attemptId, code },
    token,
  );
}
