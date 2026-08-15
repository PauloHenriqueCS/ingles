/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Atomic, serverless-safe CONCURRENCY limiting for the Gateway — the piece
 * that finally makes ai_runtime_controls.max_concurrent_requests a live
 * control instead of dead config (it was resolved by policy-resolver.ts but
 * never consumed by any enforcement path).
 *
 * "Concorrência" here means: how many paid provider calls a user may have
 * SIMULTANEOUSLY IN FLIGHT — a different mechanism from the hourly rate limit
 * (requests per window, rate-limiter.ts). One `active` row in
 * ai_gateway_concurrency_slots == one in-flight paid call.
 *
 * Cross-instance safety: several Vercel instances handle requests at once, so
 * an in-process counter (a Map) would never see another instance's in-flight
 * calls. Coordination therefore lives in Postgres —
 * acquire_gateway_concurrency_slot_v1 serializes the count+insert per scope
 * with a transactional advisory lock (see
 * 20260814120000_ai_gateway_concurrency_slots.sql). Abandoned slots (process
 * died mid-call) are recovered by the lease (expires_at): the enforce
 * pipeline's finally releases on the normal/error paths, and the lease covers
 * crash/abort/timeout where nothing runs to release.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSharedServiceClient } from './usage-repository';

export interface ConcurrencyAcquireResult {
  acquired: boolean;
  slotId: string | null;
  activeCount: number;
}

export interface ConcurrencyLimiterInterface {
  acquire(
    scopeKey: string,
    userId: string | null,
    featureKey: string,
    provider: string,
    maxConcurrent: number,
    leaseSeconds: number,
  ): Promise<ConcurrencyAcquireResult>;
  release(slotId: string, reason: string): Promise<void>;
}

export class SupabaseConcurrencyLimiter implements ConcurrencyLimiterInterface {
  private readonly supabase: SupabaseClient;

  constructor(supabase?: SupabaseClient) {
    this.supabase = supabase ?? getSharedServiceClient();
  }

  async acquire(
    scopeKey: string,
    userId: string | null,
    featureKey: string,
    provider: string,
    maxConcurrent: number,
    leaseSeconds: number,
  ): Promise<ConcurrencyAcquireResult> {
    const { data, error } = await this.supabase.rpc('acquire_gateway_concurrency_slot_v1', {
      p_scope_key: scopeKey.slice(0, 200),
      p_user_id: userId,
      p_feature_key: featureKey,
      p_provider: provider,
      p_max_concurrent: maxConcurrent,
      p_lease_seconds: leaseSeconds,
    });
    // Throw on infra failure — the caller (enforcement.ts) decides the policy
    // (fail closed: no provider call). Never silently "allow" on error, that
    // is exactly the fail-open the audit flagged for paid calls.
    if (error) throw new Error(`acquire_gateway_concurrency_slot_v1 failed: ${error.message}`);
    const row = (Array.isArray(data) ? data[0] : data) as
      | { slot_id: string | null; acquired: boolean; active_count: number }
      | undefined;
    if (!row) throw new Error('acquire_gateway_concurrency_slot_v1 returned no row');
    return {
      acquired: row.acquired === true,
      slotId: row.slot_id ?? null,
      activeCount: typeof row.active_count === 'number' ? row.active_count : 0,
    };
  }

  async release(slotId: string, reason: string): Promise<void> {
    const { error } = await this.supabase.rpc('release_gateway_concurrency_slot_v1', {
      p_slot_id: slotId,
      p_reason: reason,
    });
    if (error) throw new Error(`release_gateway_concurrency_slot_v1 failed: ${error.message}`);
  }
}
