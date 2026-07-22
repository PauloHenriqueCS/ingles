/**
 * SERVER-ONLY rate limiting via Supabase atomic RPC.
 *
 * Requires:
 *   - SUPABASE_SERVICE_ROLE_KEY env var (no VITE_ prefix — never exposed to browser)
 *   - Migration 20260714130000_api_rate_limits.sql applied to the database
 *
 * If either is missing, rate limiting fails OPEN (allows the request).
 * This prevents accidental lockout during initial setup.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { jsonError } from './_helpers';
import { getSupabaseServiceCredentials } from './_env';

// ── Rate limit configuration ──────────────────────────────────────────────────

interface RateLimitConfig {
  windowSeconds: number;
  maxRequests: number;
}

export const RATE_LIMITS: Record<string, RateLimitConfig> = {
  'generate-theme':       { windowSeconds: 3600, maxRequests: 25  },
  'review-text':          { windowSeconds: 3600, maxRequests: 30  },
  'compare-rewrite':      { windowSeconds: 3600, maxRequests: 25  },
  'grammar-explanation':  { windowSeconds: 3600, maxRequests: 50  },
  'conversation-session': { windowSeconds: 3600, maxRequests: 60  },
  'conversation-preview': { windowSeconds: 3600, maxRequests: 30  },
  'pronunciation-start':  { windowSeconds: 3600, maxRequests: 60  },
  'plan-entitlements':    { windowSeconds: 60,   maxRequests: 30  },
  'tts':                                { windowSeconds: 3600, maxRequests: 300 },
  'pronunciation-training-generate-text': { windowSeconds: 3600, maxRequests: 25  },
  'pronunciation-training-token':         { windowSeconds: 3600, maxRequests: 60  },
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

interface RateLimitResult {
  allowed: boolean;
  retryAfter?: number;
}

async function checkRateLimitRaw(
  userId: string,
  routeKey: string,
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  const client = getServiceClient();
  if (!client) return { allowed: true };

  const { data, error } = await client.rpc('check_and_increment_rate_limit', {
    p_user_id:        userId,
    p_route_key:      routeKey,
    p_window_seconds: config.windowSeconds,
    p_max_requests:   config.maxRequests,
  });

  if (error) {
    // RPC missing (migration not applied) → fail open
    return { allowed: true };
  }

  const row = (data ?? {}) as { allowed?: boolean; retry_after?: number };
  return {
    allowed:    row.allowed !== false,
    retryAfter: row.retry_after,
  };
}

// ── Public helper: check and respond ─────────────────────────────────────────

/**
 * Checks the rate limit for a route. If blocked, sends 429 and returns false.
 * If allowed (or if rate limiting is not configured), returns true.
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

  let result: RateLimitResult;
  try {
    result = await checkRateLimitRaw(userId, routeKey, config);
  } catch {
    return true; // fail open
  }

  if (!result.allowed) {
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

  return true;
}
