/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Generic idempotency/deduplication primitive (Etapa 11, Fase 4). Protects
 * against double-click, browser retry, React Strict Mode, job re-delivery,
 * and cross-instance concurrency for any logical action identified by a
 * natural key (submissionId, reviewId, jobId, provider response.id,
 * sessionId) or a caller-generated idempotency key.
 *
 * Never persists content to deduplicate — only the identifier itself and an
 * optional `resultRef` (a domain id to look up the real result elsewhere,
 * e.g. an ai_usage_events.id or a writing_entries.id). The AI response
 * itself is never stored in the Gateway "just for replay."
 *
 * Backed by begin/complete/fail_gateway_idempotent_op_v1 — single-statement
 * atomic Postgres functions using INSERT ... ON CONFLICT, so two concurrent
 * callers racing the same (scope, idempotencyKey) can never both proceed:
 * exactly one gets 'started', the other gets 'in_progress' or 'completed'.
 */

import { createHmac } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSharedServiceClient } from './usage-repository';

export type DedupeOutcome = 'started' | 'in_progress' | 'completed' | 'reclaimed';

export interface DedupeBeginResult {
  lockId: string;
  outcome: DedupeOutcome;
  resultRef: string | null;
}

export interface DedupeStoreInterface {
  begin(scope: string, idempotencyKey: string, leaseSeconds: number): Promise<DedupeBeginResult>;
  complete(lockId: string, resultRef: string | null): Promise<void>;
  fail(lockId: string): Promise<void>;
}

export class SupabaseDedupeStore implements DedupeStoreInterface {
  private readonly supabase: SupabaseClient;

  constructor(supabase?: SupabaseClient) {
    this.supabase = supabase ?? getSharedServiceClient();
  }

  async begin(scope: string, idempotencyKey: string, leaseSeconds: number): Promise<DedupeBeginResult> {
    const { data, error } = await this.supabase.rpc('begin_gateway_idempotent_op_v1', {
      p_scope: scope,
      p_idempotency_key: idempotencyKey,
      p_lease_seconds: leaseSeconds,
    });
    if (error) throw new Error(`begin_gateway_idempotent_op_v1 failed: ${error.message}`);
    const row = (Array.isArray(data) ? data[0] : data) as { lock_id: string; outcome: string; result_ref: string | null };
    return { lockId: row.lock_id, outcome: row.outcome as DedupeOutcome, resultRef: row.result_ref };
  }

  async complete(lockId: string, resultRef: string | null): Promise<void> {
    const { error } = await this.supabase.rpc('complete_gateway_idempotent_op_v1', {
      p_lock_id: lockId,
      p_result_ref: resultRef,
    });
    if (error) throw new Error(`complete_gateway_idempotent_op_v1 failed: ${error.message}`);
  }

  async fail(lockId: string): Promise<void> {
    const { error } = await this.supabase.rpc('fail_gateway_idempotent_op_v1', { p_lock_id: lockId });
    if (error) throw new Error(`fail_gateway_idempotent_op_v1 failed: ${error.message}`);
  }
}

/**
 * HMAC-SHA-256 fingerprint over technical identifiers only — never over
 * prompt/response content. Use when no natural key exists and the caller
 * needs a stable, opaque per-action identifier derived from parameters that
 * are themselves safe to log (e.g. userId + featureKey + resourceId), with
 * a server-only secret so it cannot be forged or reversed by a client.
 */
export function computeIdempotencyFingerprint(secret: string, parts: string[]): string {
  return createHmac('sha256', secret).update(parts.join('|'), 'utf8').digest('hex');
}
