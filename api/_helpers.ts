/**
 * SERVER-ONLY shared helpers for API route security.
 * Never import from src/ or any client-side bundle.
 */

// ── Error codes ───────────────────────────────────────────────────────────────

export type ApiErrorCode =
  | 'UNAUTHORIZED'
  | 'METHOD_NOT_ALLOWED'
  | 'INVALID_REQUEST'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'AI_TIMEOUT'
  | 'AI_UNAVAILABLE'
  | 'INTERNAL_ERROR';

// ── Payload size limits (bytes) ───────────────────────────────────────────────

export const PAYLOAD_LIMITS = {
  GRAMMAR:      8_192,    //   8 KB — single grammar name
  THEME:       65_536,    //  64 KB — learning context + history
  REVIEW:     131_072,    // 128 KB — student essay
  COMPARE:    131_072,    // 128 KB — three texts + mistakes list
  CONVERSATION:  4_096,   //   4 KB — session config (body is minimal)
  PREVIEW:       2_048,   //   2 KB — voice + pace
  TTS:          16_384,   //  16 KB — TTS text payload
} as const;

// ── Timeout values (ms) ───────────────────────────────────────────────────────

export const TIMEOUTS = {
  SHORT:  20_000,   // TTS preview, session creation
  MEDIUM: 45_000,   // comparison, grammar explanation
  LONG:   55_000,   // review-text, generate-theme (multi-attempt internally)
} as const;

// ── Standardized JSON error response ─────────────────────────────────────────

export function jsonError(
  res: any,
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): void {
  res.status(status).json({ code, message, ...extra });
}

// ── Method guard ──────────────────────────────────────────────────────────────

/**
 * Returns true if method is allowed; sends 405 and returns false otherwise.
 * Must be the first check — before auth and before any DB/provider call.
 */
export function methodGuard(req: any, res: any, allowed: string[]): boolean {
  if (!allowed.includes((req.method ?? '').toUpperCase())) {
    res.setHeader('Allow', allowed.join(', '));
    jsonError(res, 405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');
    return false;
  }
  return true;
}

// ── Payload size guard ────────────────────────────────────────────────────────

/**
 * Checks the Content-Length request header. Returns false and sends 413 if
 * the declared size exceeds maxBytes. Does NOT buffer the raw body.
 */
export function sizeGuard(req: any, res: any, maxBytes: number): boolean {
  const cl = parseInt(req.headers?.['content-length'] ?? '0', 10);
  if (!isNaN(cl) && cl > maxBytes) {
    jsonError(res, 413, 'PAYLOAD_TOO_LARGE', 'O conteúdo enviado é maior que o permitido.');
    return false;
  }
  return true;
}

// ── Safe structured log ───────────────────────────────────────────────────────

/**
 * Logs only route, code, status, timing, and explicitly allowlisted fields.
 * Never logs user content, prompts, API keys, tokens, or provider responses.
 */
export function safeLog(
  route: string,
  event: string,
  status: number,
  extra?: Record<string, string | number | boolean | null>,
): void {
  const entry: Record<string, unknown> = { route, event, status, t: Date.now() };
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      entry[k] = v;
    }
  }
  console.error(JSON.stringify(entry));
}

// ── Catch-all slug resolver ───────────────────────────────────────────────────

/**
 * Extracts the slug from a [...slug].ts catch-all dispatcher.
 * Primary source: Vercel-injected req.query.slug (works on Next.js and some
 * framework configs). Fallback: parse from req.url directly, which always
 * works regardless of how Vercel injects path params.
 *
 * @param apiBase  The static URL prefix of this dispatcher, e.g. '/api/listening'
 */
export function resolveSlug(req: any, apiBase: string): string {
  const s = req.query?.slug;
  if (Array.isArray(s) && s.length > 0) return s.join('/');
  if (typeof s === 'string' && s) return s;
  // URL fallback: strip the static prefix and any query string
  const urlPath = ((req.url ?? '') as string).split('?')[0];
  const prefix = apiBase.endsWith('/') ? apiBase : `${apiBase}/`;
  return urlPath.startsWith(prefix) ? urlPath.slice(prefix.length).replace(/\/$/, '') : '';
}

// ── Provider error sanitizer ──────────────────────────────────────────────────

/**
 * Maps a caught error to a safe {code, status} pair.
 * Never surfaces internal error messages, stack traces, or API keys.
 */
export function sanitizeProviderError(err: unknown): { code: string; status: number } {
  if (err && typeof err === 'object') {
    const e = err as any;

    // OpenAI SDK typed errors
    if (e.constructor?.name === 'APIConnectionTimeoutError' || e.message === 'timeout') {
      return { code: 'AI_TIMEOUT', status: 504 };
    }
    if (e.constructor?.name === 'APIConnectionError') {
      return { code: 'AI_UNAVAILABLE', status: 503 };
    }
    if (e.constructor?.name === 'RateLimitError' || e.status === 429) {
      return { code: 'AI_UNAVAILABLE', status: 503 };
    }
    if (typeof e.status === 'number' && e.status >= 500) {
      return { code: 'AI_UNAVAILABLE', status: 503 };
    }

    // AbortError from fetch
    if (e.name === 'AbortError') {
      return { code: 'AI_TIMEOUT', status: 504 };
    }
  }
  return { code: 'INTERNAL_ERROR', status: 500 };
}
