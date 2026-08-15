/**
 * SERVER-ONLY rate limiting via Supabase atomic RPC.
 *
 * Single source of truth for per-user-action rate limits. Keyed by
 * user_id + route_key, backed by the atomic check_and_increment_rate_limit
 * RPC on public.api_rate_limits (a single INSERT ... ON CONFLICT increment —
 * atomic and shared across every Vercel instance, so the 26th call of a 25/h
 * limit is blocked no matter which instance serves it). This is the
 * AUTHORITATIVE layer for the audited business numbers below; the AI Gateway's
 * own per-feature limiter (api/_ai-gateway/rate-limiter.ts) is an optional
 * admin-armed backstop over the SAME RPC — not a second, divergent system.
 *
 * Requires:
 *   - SUPABASE_SERVICE_ROLE_KEY env var (no VITE_ prefix — never exposed to browser)
 *   - Migration for public.api_rate_limits + check_and_increment_rate_limit
 *
 * Fail behavior when the rate-limit infrastructure itself is unavailable
 * (missing service-role key, RPC error/exception) is decided PER ROUTE by
 * `failClosed`:
 *   - failClosed: true  → 503 RATE_LIMIT_INFRA_FAILURE, the provider is NOT
 *     called. Used for every route that can incur an external paid AI cost:
 *     an outage of the protection must never silently turn a paid endpoint
 *     unlimited (audit finding §12).
 *   - failClosed: false → fail open (allow). Used only for non-cost routes
 *     (entitlement reads, account/subscription ops) where locking a user out
 *     on an infra blip is worse than letting one request through.
 *
 * A genuine limit hit (the RPC says "over the ceiling") is ALWAYS 429
 * RATE_LIMITED + Retry-After, never conflated with the 503 above — the two
 * mean different things to the client and to on-call.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { jsonError } from './_helpers';
import { getSupabaseServiceCredentials } from './_env';

// ── Rate limit configuration ──────────────────────────────────────────────────

interface RateLimitConfig {
  windowSeconds: number;
  maxRequests: number;
  /** See file header. Defaults to false (fail-open) when omitted. Every route
   *  that can trigger an external paid AI call sets this true. */
  failClosed?: boolean;
}

export const RATE_LIMITS: Record<string, RateLimitConfig> = {
  // ── Paid AI routes — fail CLOSED (a protection outage must not uncap cost) ──
  'generate-theme':       { windowSeconds: 3600, maxRequests: 25,  failClosed: true },
  'review-text':          { windowSeconds: 3600, maxRequests: 30,  failClosed: true },
  'compare-rewrite':      { windowSeconds: 3600, maxRequests: 25,  failClosed: true },
  'grammar-explanation':  { windowSeconds: 3600, maxRequests: 50,  failClosed: true },
  'conversation-session': { windowSeconds: 3600, maxRequests: 60,  failClosed: true },
  'conversation-preview': { windowSeconds: 3600, maxRequests: 30,  failClosed: true },
  // Gates STARTING a pronunciation assessment (issues the Azure token the
  // browser then uses to run the paid Speech assessment). This key already
  // existed but was never wired to the main endpoint — now it is (handleStart).
  'pronunciation-start':  { windowSeconds: 3600, maxRequests: 60,  failClosed: true },
  'tts':                                  { windowSeconds: 3600, maxRequests: 300, failClosed: true },
  'pronunciation-training-generate-text': { windowSeconds: 3600, maxRequests: 25,  failClosed: true },
  'pronunciation-training-token':         { windowSeconds: 3600, maxRequests: 60,  failClosed: true },
  'pronunciation-training-start':         { windowSeconds: 3600, maxRequests: 60,  failClosed: true },
  // Listening story generation entry points (OpenAI + Azure TTS). NEW keys.
  // Value 25/h matches the house precedent for "generate content" routes
  // (generate-theme, pronunciation-training-generate-text). It sits far above
  // the ~1/day commercial quota, so it never limits a legitimate user — it is
  // pure burst/abuse protection over the shared-story/TTS-retry entry points.
  'listening-generate':           { windowSeconds: 3600, maxRequests: 25, failClosed: true },
  'listening-generation-start':   { windowSeconds: 3600, maxRequests: 25, failClosed: true },

  // ── Non-cost routes — fail OPEN (never lock a user out of these on a blip) ──
  'plan-entitlements':    { windowSeconds: 60,   maxRequests: 30 },
  'account-deactivate':   { windowSeconds: 3600, maxRequests: 10 },
  'subscription-sync':    { windowSeconds: 300,  maxRequests: 10 },
};

// ── Service role client (singleton) ──────────────────────────────────────────

let _serviceClient: SupabaseClient | null = null;

function getServiceClient(): SupabaseClient | null {
  if (_serviceClient) return _serviceClient;
  const { url, key } = getSupabaseServiceCredentials();
  if (!url || !key) return null;
  _serviceClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _serviceClient;
}

// ── Core check ────────────────────────────────────────────────────────────────

type RateLimitOutcome =
  | { status: 'allowed' }
  | { status: 'limited'; retryAfter?: number }
  | { status: 'infra_error'; detail: string };

async function checkRateLimitRaw(
  userId: string,
  routeKey: string,
  config: RateLimitConfig,
): Promise<RateLimitOutcome> {
  const client = getServiceClient();
  // Missing service-role credentials is an INFRASTRUCTURE failure, not an
  // "allow" — the caller (paid routes) fails closed on it rather than silently
  // running unlimited.
  if (!client) return { status: 'infra_error', detail: 'missing_service_credentials' };

  const { data, error } = await client.rpc('check_and_increment_rate_limit', {
    p_user_id:        userId,
    p_route_key:      routeKey,
    p_window_seconds: config.windowSeconds,
    p_max_requests:   config.maxRequests,
  });

  if (error) {
    // RPC missing / DB unreachable → infrastructure failure (was silently
    // fail-open before this fix).
    return { status: 'infra_error', detail: error.message };
  }

  const row = (data ?? {}) as { allowed?: boolean; retry_after?: number };
  if (row.allowed === false) {
    return { status: 'limited', retryAfter: row.retry_after };
  }
  return { status: 'allowed' };
}

// ── Public helper: check and respond ─────────────────────────────────────────

/**
 * Checks the rate limit for a route. If blocked (429) or infra-failed on a
 * fail-closed route (503), sends the response and returns false — the caller
 * must `return` and never reach the provider. If allowed (or if the route is
 * not configured, or fail-open infra failure), returns true.
 *
 * Call AFTER auth and payload validation, BEFORE the provider call.
 */
export async function applyRateLimit(
  res: any,
  userId: string,
  routeKey: string,
): Promise<boolean> {
  const config = RATE_LIMITS[routeKey];
  if (!config) return true;

  let result: RateLimitOutcome;
  try {
    result = await checkRateLimitRaw(userId, routeKey, config);
  } catch (err) {
    result = { status: 'infra_error', detail: err instanceof Error ? err.message : 'unknown' };
  }

  if (result.status === 'allowed') return true;

  if (result.status === 'limited') {
    const extra: Record<string, unknown> = {};
    if (result.retryAfter !== undefined) {
      res.setHeader('Retry-After', String(result.retryAfter));
      extra['retryAfter'] = result.retryAfter;
    }
    jsonError(
      res,
      429,
      'RATE_LIMITED',
      'Muitas solicitações em pouco tempo. Aguarde um momento e tente novamente.',
      extra,
    );
    return false;
  }

  // result.status === 'infra_error'
  // Always log for diagnosis — this is an operational failure of the
  // protection layer, not user behavior.
  console.error(JSON.stringify({
    rateLimit: 'infra_error', routeKey, failClosed: config.failClosed === true,
    detail: result.detail, t: Date.now(),
  }));

  if (config.failClosed) {
    // Controlled operational error — NOT reported as if the user exceeded the
    // limit. No provider call happens (caller returns).
    res.setHeader('Retry-After', '30');
    jsonError(
      res,
      503,
      'RATE_LIMIT_INFRA_FAILURE',
      'Serviço temporariamente indisponível. Tente novamente em instantes.',
      { retryAfter: 30 },
    );
    return false;
  }

  // Fail-open route (non-cost) — allow through on infra failure.
  return true;
}
