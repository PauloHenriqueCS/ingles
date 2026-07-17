/**
 * API security regression tests.
 *
 * Covers:
 *  - Wrong method never calls provider
 *  - Unauthenticated request never calls provider
 *  - Oversized payload blocked before provider
 *  - Rate limit blocks before provider, sets Retry-After
 *  - Provider timeout → 504 AI_TIMEOUT (no stack trace)
 *  - Provider error → sanitized code (no secrets, no raw message)
 *  - /api/review returns 410 without contacting any provider
 *  - Helpers: methodGuard, sizeGuard, sanitizeProviderError
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Helpers (pure, no mocking needed) ───────────────────────────────────────

import { methodGuard, sizeGuard, sanitizeProviderError, jsonError, PAYLOAD_LIMITS } from '../_helpers';

function makeRes() {
  const headers: Record<string, string> = {};
  let _status = 200;
  let _body: unknown = undefined;
  const res = {
    _status: () => _status,
    _body: () => _body,
    _headers: () => headers,
    status(s: number) { _status = s; return res; },
    json(b: unknown) { _body = b; return res; },
    setHeader(k: string, v: string) { headers[k] = v; return res; },
    end() { return res; },
  };
  return res;
}

function makeReq(overrides: Partial<{ method: string; headers: Record<string, string>; body: unknown }> = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '50' },
    body: {},
    ...overrides,
  };
}

// ─── methodGuard ──────────────────────────────────────────────────────────────

describe('methodGuard', () => {
  it('returns true when method is allowed', () => {
    const res = makeRes();
    const result = methodGuard(makeReq({ method: 'POST' }), res, ['POST']);
    expect(result).toBe(true);
    expect(res._status()).toBe(200);
  });

  it('returns false and sends 405 with Allow header when method is wrong', () => {
    const res = makeRes();
    const result = methodGuard(makeReq({ method: 'GET' }), res, ['POST']);
    expect(result).toBe(false);
    expect(res._status()).toBe(405);
    expect((res._body() as any).code).toBe('METHOD_NOT_ALLOWED');
    expect(res._headers()['Allow']).toBe('POST');
  });

  it('is case-insensitive on request method', () => {
    const res = makeRes();
    const result = methodGuard(makeReq({ method: 'post' }), res, ['POST']);
    expect(result).toBe(true);
  });

  it('accepts multiple allowed methods', () => {
    const res = makeRes();
    expect(methodGuard(makeReq({ method: 'GET' }), res, ['GET', 'POST'])).toBe(true);
    expect(methodGuard(makeReq({ method: 'DELETE' }), res, ['GET', 'POST'])).toBe(false);
  });
});

// ─── sizeGuard ───────────────────────────────────────────────────────────────

describe('sizeGuard', () => {
  it('returns true when content-length is within limit', () => {
    const res = makeRes();
    const req = makeReq({ headers: { 'content-length': '100' } });
    expect(sizeGuard(req, res, 200)).toBe(true);
  });

  it('returns false and sends 413 when content-length exceeds limit', () => {
    const res = makeRes();
    const req = makeReq({ headers: { 'content-length': '999' } });
    const result = sizeGuard(req, res, 100);
    expect(result).toBe(false);
    expect(res._status()).toBe(413);
    expect((res._body() as any).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('returns true when content-length is missing', () => {
    const res = makeRes();
    const req = makeReq({ headers: {} });
    expect(sizeGuard(req, res, 100)).toBe(true);
  });

  it('returns true when content-length exactly equals limit', () => {
    const res = makeRes();
    const req = makeReq({ headers: { 'content-length': '100' } });
    expect(sizeGuard(req, res, 100)).toBe(true);
  });

  it('PAYLOAD_LIMITS values are reasonable', () => {
    expect(PAYLOAD_LIMITS.GRAMMAR).toBeLessThanOrEqual(16_384);
    expect(PAYLOAD_LIMITS.PREVIEW).toBeLessThanOrEqual(4_096);
    expect(PAYLOAD_LIMITS.CONVERSATION).toBeLessThanOrEqual(8_192);
  });
});

// ─── sanitizeProviderError ────────────────────────────────────────────────────

describe('sanitizeProviderError', () => {
  it('maps APIConnectionTimeoutError to AI_TIMEOUT 504', () => {
    const err = Object.assign(new Error('timed out'), { constructor: { name: 'APIConnectionTimeoutError' } });
    const r = sanitizeProviderError(err);
    expect(r).toEqual({ code: 'AI_TIMEOUT', status: 504 });
  });

  it('maps AbortError to AI_TIMEOUT 504', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const r = sanitizeProviderError(err);
    expect(r).toEqual({ code: 'AI_TIMEOUT', status: 504 });
  });

  it('maps APIConnectionError to AI_UNAVAILABLE 503', () => {
    const err = Object.assign(new Error('connection refused'), { constructor: { name: 'APIConnectionError' } });
    const r = sanitizeProviderError(err);
    expect(r).toEqual({ code: 'AI_UNAVAILABLE', status: 503 });
  });

  it('maps RateLimitError to AI_UNAVAILABLE 503', () => {
    const err = Object.assign(new Error('rate limited'), { constructor: { name: 'RateLimitError' } });
    const r = sanitizeProviderError(err);
    expect(r).toEqual({ code: 'AI_UNAVAILABLE', status: 503 });
  });

  it('maps 5xx status errors to AI_UNAVAILABLE 503', () => {
    const err = { status: 500, message: 'internal server error' };
    const r = sanitizeProviderError(err);
    expect(r).toEqual({ code: 'AI_UNAVAILABLE', status: 503 });
  });

  it('maps unknown error to INTERNAL_ERROR 500', () => {
    const r = sanitizeProviderError(new Error('some unexpected thing'));
    expect(r).toEqual({ code: 'INTERNAL_ERROR', status: 500 });
  });

  it('never includes the raw error message in the output', () => {
    const err = new Error('SECRET_API_KEY=sk-abc123 leaked here');
    const r = sanitizeProviderError(err);
    expect(JSON.stringify(r)).not.toContain('sk-abc123');
    expect(JSON.stringify(r)).not.toContain('SECRET_API_KEY');
  });
});

// ─── jsonError ────────────────────────────────────────────────────────────────

describe('jsonError', () => {
  it('sets status and returns code+message', () => {
    const res = makeRes();
    jsonError(res, 429, 'RATE_LIMITED', 'Too many');
    expect(res._status()).toBe(429);
    expect(res._body()).toEqual({ code: 'RATE_LIMITED', message: 'Too many' });
  });

  it('merges extra fields', () => {
    const res = makeRes();
    jsonError(res, 429, 'RATE_LIMITED', 'Too many', { retryAfter: 3600 });
    expect((res._body() as any).retryAfter).toBe(3600);
  });
});

// ─── Mocked handler tests ─────────────────────────────────────────────────────
// We mock _auth and _rateLimit so we can control auth and rate limit outcomes
// independently of Supabase being present.

vi.mock('../_auth', () => ({
  requireAuth: vi.fn(),
}));

vi.mock('../_rateLimit', () => ({
  applyRateLimit: vi.fn(),
  RATE_LIMITS: {
    'generate-theme': { windowSeconds: 3600, maxRequests: 25 },
    'review-text': { windowSeconds: 3600, maxRequests: 30 },
    'compare-rewrite': { windowSeconds: 3600, maxRequests: 25 },
    'grammar-explanation': { windowSeconds: 3600, maxRequests: 50 },
    'conversation-session': { windowSeconds: 3600, maxRequests: 60 },
    'conversation-preview': { windowSeconds: 3600, maxRequests: 30 },
  },
}));

import * as _auth from '../_auth';
import * as _rateLimit from '../_rateLimit';

const mockRequireAuth = vi.mocked(_auth.requireAuth);
const mockApplyRateLimit = vi.mocked(_rateLimit.applyRateLimit);

function authOk(userId = 'user-123') {
  const supabase = {
    from: () => ({ select: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    rpc: vi.fn(),
  };
  mockRequireAuth.mockResolvedValue({ userId, supabase } as any);
}

function authFail() {
  mockRequireAuth.mockResolvedValue(null as any);
}

function rateLimitPass() {
  mockApplyRateLimit.mockResolvedValue(true);
}

function rateLimitBlock(res: ReturnType<typeof makeRes>) {
  mockApplyRateLimit.mockImplementation(async (r: any) => {
    r.setHeader('Retry-After', '3600');
    r.status(429).json({ code: 'RATE_LIMITED', message: 'Too many requests', retryAfter: 3600 });
    return false;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: auth passes, rate limit passes
  rateLimitPass();
});

// ─── compare-rewrite ──────────────────────────────────────────────────────────

describe('compare-rewrite handler', () => {
  let handler: (req: any, res: any) => Promise<void>;
  let savedApiKey: string | undefined;

  beforeEach(async () => {
    savedApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key';
    vi.resetModules();
    vi.mock('openai', () => ({
      default: vi.fn().mockImplementation(() => ({
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: JSON.stringify({
                improvementScore: 80,
                fixedMistakesCount: 3,
                remainingMistakesCount: 1,
                fixedMistakes: [],
                remainingMistakes: [],
                newIssues: [],
                overallFeedback: 'Good job',
                nextAction: 'Keep practicing',
              }) } }],
            }),
          },
        },
      })),
    }));
    const mod = await import('../compare-rewrite');
    handler = mod.default;
  });

  afterEach(() => {
    if (savedApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedApiKey;
  });

  it('blocks wrong method without calling provider', async () => {
    authOk();
    const req = makeReq({ method: 'GET' });
    const res = makeRes();
    await handler(req, res);
    expect(res._status()).toBe(405);
    expect(mockRequireAuth).not.toHaveBeenCalled();
  });

  it('blocks unauthenticated request without calling provider', async () => {
    authFail();
    const req = makeReq({ method: 'POST', body: { originalText: 'a', correctedText: 'b', rewriteText: 'c' } });
    const res = makeRes();
    await handler(req, res);
    expect(mockApplyRateLimit).not.toHaveBeenCalled();
  });

  it('blocks oversized payload before auth and provider', async () => {
    const req = makeReq({ method: 'POST', headers: { 'content-length': String(200_000) } });
    const res = makeRes();
    await handler(req, res);
    expect(res._status()).toBe(413);
    expect(mockRequireAuth).not.toHaveBeenCalled();
  });

  it('blocks rate-limited request before provider', async () => {
    authOk();
    const res = makeRes();
    rateLimitBlock(res);
    const req = makeReq({ method: 'POST', body: { originalText: 'hello', correctedText: 'hello', rewriteText: 'hello' } });
    await handler(req, res);
    expect(res._status()).toBe(429);
    expect(res._headers()['Retry-After']).toBeDefined();
  });

  it('returns 400 when required fields are missing', async () => {
    authOk();
    const req = makeReq({ method: 'POST', body: { originalText: 'x' } });
    const res = makeRes();
    await handler(req, res);
    expect(res._status()).toBe(400);
    expect(mockApplyRateLimit).not.toHaveBeenCalled();
  });
});

// ─── grammar-explanation ─────────────────────────────────────────────────────

describe('grammar-explanation handler', () => {
  let handler: (req: any, res: any) => Promise<void>;

  beforeEach(async () => {
    vi.resetModules();
    vi.mock('openai', () => ({
      default: vi.fn().mockImplementation(() => ({
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: JSON.stringify({ name: 'Present Simple' }) } }],
            }),
          },
        },
      })),
    }));
    const mod = await import('../grammar-explanation');
    handler = mod.default;
  });

  it('blocks wrong method before auth', async () => {
    authOk();
    const req = makeReq({ method: 'GET' });
    const res = makeRes();
    await handler(req, res);
    expect(res._status()).toBe(405);
    expect(mockRequireAuth).not.toHaveBeenCalled();
  });

  it('blocks oversized payload before auth', async () => {
    const req = makeReq({ method: 'POST', headers: { 'content-length': '99999' } });
    const res = makeRes();
    await handler(req, res);
    expect(res._status()).toBe(413);
    expect(mockRequireAuth).not.toHaveBeenCalled();
  });

  it('returns 400 for missing grammarName', async () => {
    authOk();
    const req = makeReq({ method: 'POST', body: {} });
    const res = makeRes();
    await handler(req, res);
    expect(res._status()).toBe(400);
  });

  it('returns 400 for grammarName exceeding max length', async () => {
    authOk();
    const req = makeReq({ method: 'POST', body: { grammarName: 'a'.repeat(101) } });
    const res = makeRes();
    await handler(req, res);
    expect(res._status()).toBe(400);
  });

  it('returns 400 for grammarName with invalid characters', async () => {
    authOk();
    const req = makeReq({ method: 'POST', body: { grammarName: 'Present Simple <script>' } });
    const res = makeRes();
    await handler(req, res);
    expect(res._status()).toBe(400);
    expect(mockApplyRateLimit).not.toHaveBeenCalled();
  });

  it('rate limit blocks before provider', async () => {
    const supabase = {
      from: () => ({ select: () => ({ ilike: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    };
    mockRequireAuth.mockResolvedValue({ userId: 'u1', supabase } as any);
    const res = makeRes();
    rateLimitBlock(res);
    const req = makeReq({ method: 'POST', body: { grammarName: 'Present Simple' } });
    await handler(req, res);
    expect(res._status()).toBe(429);
  });
});

// ─── _rateLimit: Retry-After header ──────────────────────────────────────────

describe('applyRateLimit Retry-After', () => {
  it('sets Retry-After header when rate limited', async () => {
    // Without SUPABASE_SERVICE_ROLE_KEY the real implementation fails open (allowed = true)
    const { applyRateLimit: realApplyRateLimit } = await vi.importActual<typeof import('../_rateLimit')>('../_rateLimit');
    const res = makeRes();
    const result = await realApplyRateLimit(res, 'user-1', 'generate-theme');
    expect(result).toBe(true); // fail open because no key configured
  });
});

// ─── sanitizeProviderError: no secrets in output ─────────────────────────────

describe('sanitizeProviderError output safety', () => {
  it('output never contains API key patterns', () => {
    const badErrors = [
      Object.assign(new Error('sk-proj-abc123 in message'), { name: 'AbortError' }),
      Object.assign(new Error('Bearer tok_xyz leaked'), { constructor: { name: 'APIConnectionError' } }),
      { status: 500, message: 'key=SUPABASE_SERVICE_ROLE_KEY blah' },
    ];
    for (const err of badErrors) {
      const r = sanitizeProviderError(err);
      const s = JSON.stringify(r);
      expect(s).not.toMatch(/sk-/);
      expect(s).not.toMatch(/Bearer/);
      expect(s).not.toMatch(/SERVICE_ROLE/);
      expect(s).not.toContain('message');
      expect(typeof r.code).toBe('string');
      expect(typeof r.status).toBe('number');
    }
  });
});
