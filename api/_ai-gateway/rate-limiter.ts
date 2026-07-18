/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Atomic, serverless-safe rate limiting for the Gateway (Etapa 11, Fase 3).
 *
 * Reuses the check_and_increment_rate_limit(user_id, route_key,
 * window_seconds, max_requests) RPC — a single INSERT ... ON CONFLICT
 * atomic increment already designed for api/_rateLimit.ts (migration
 * 20260714130000_api_rate_limits.sql). That migration was written but never
 * actually applied to the remote database (the function and its
 * api_rate_limits table do not exist there today — confirmed by direct
 * schema audit), which is why api/_rateLimit.ts has been silently fail-open
 * this whole time. This module's migration (20260718*_ai_gateway_enforcement)
 * re-declares both idempotently (CREATE TABLE IF NOT EXISTS / CREATE OR
 * REPLACE FUNCTION) so this etapa's delivery is correct and self-contained
 * regardless of whether the older migration is ever applied on its own.
 *
 * The Gateway's own rate-limit calls are namespaced under a distinct
 * route_key prefix ("gateway:<featureKey>") so they can never collide with
 * api/_rateLimit.ts's existing route keys (e.g. "generate-theme") — this
 * module does not change that file's behavior at all.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSharedServiceClient } from './usage-repository';

export interface RateLimitCheckResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export interface RateLimiterInterface {
  check(userId: string, featureKey: string, windowSeconds: number, maxRequests: number): Promise<RateLimitCheckResult>;
}

export class SupabaseRateLimiter implements RateLimiterInterface {
  private readonly supabase: SupabaseClient;

  constructor(supabase?: SupabaseClient) {
    this.supabase = supabase ?? getSharedServiceClient();
  }

  async check(userId: string, featureKey: string, windowSeconds: number, maxRequests: number): Promise<RateLimitCheckResult> {
    const routeKey = `gateway:${featureKey}`.slice(0, 64);
    const { data, error } = await this.supabase.rpc('check_and_increment_rate_limit', {
      p_user_id: userId,
      p_route_key: routeKey,
      p_window_seconds: windowSeconds,
      p_max_requests: maxRequests,
    });
    if (error) {
      // Missing RPC / DB unreachable — fail open, same policy as
      // api/_rateLimit.ts. The caller decides whether "open" means "allow"
      // (legacy/observe) or "policy unavailable, fail closed" (enforce).
      throw new Error(`check_and_increment_rate_limit failed: ${error.message}`);
    }
    const row = (data ?? {}) as { allowed?: boolean; retry_after?: number };
    return { allowed: row.allowed !== false, retryAfterSeconds: row.retry_after };
  }
}
