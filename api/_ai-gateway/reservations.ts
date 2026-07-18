/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Atomic consumption reservations (Etapa 11, Fase 5). Reuses the existing
 * usage_reservations / usage_reservation_items tables (foundation
 * migration, BLOCO 7/8 — created empty, unused until now). No new table is
 * added here — only atomic SQL functions (reserve/commit/release/expire)
 * and a unique index on idempotency_key, so two concurrent callers can
 * never both win the same reservation and a retry with the same
 * idempotency key is always safe.
 *
 * "Reserved" (Fase 5 spec language) is this schema's pre-existing 'pending'
 * status — see types.ts's ReservationStatus comment.
 *
 * Only used by the enforce-mode pipeline (enforcement.ts), which no
 * feature reaches in production at the end of this stage.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSharedServiceClient } from './usage-repository';
import type { AiFeatureKey, ReservationResult, ReservationStatus, ReserveUsageParams } from './types';

export interface ReservationsRepositoryInterface {
  reserve(params: ReserveUsageParams): Promise<ReservationResult>;
  commit(reservationId: string, usageEventId: string, actualCostUsd: string | null): Promise<void>;
  release(reservationId: string, reason: string): Promise<void>;
  markReconciliationRequired(reservationId: string, reason: string): Promise<void>;
}

export class SupabaseReservationsRepository implements ReservationsRepositoryInterface {
  private readonly supabase: SupabaseClient;

  constructor(supabase?: SupabaseClient) {
    this.supabase = supabase ?? getSharedServiceClient();
  }

  async reserve(params: ReserveUsageParams): Promise<ReservationResult> {
    const { data, error } = await this.supabase.rpc('reserve_gateway_usage_v1', {
      p_idempotency_key: params.idempotencyKey,
      p_user_id: params.userId ?? null,
      p_initiated_by_user_id: params.initiatedByUserId ?? null,
      p_feature_key: params.featureKey,
      p_provider: params.provider,
      p_model: params.model ?? null,
      p_metrics: params.estimatedMetrics.map((m) => ({ quota_key: m.metricKey, unit_type: 'unit', reserved_quantity: m.quantity })),
      p_estimated_cost_usd: params.estimatedCostUsd,
      p_expires_in_seconds: params.expiresInSeconds,
    });
    if (error) throw new Error(`reserve_gateway_usage_v1 failed: ${error.message}`);
    const row = (Array.isArray(data) ? data[0] : data) as { reservation_id: string; status: string; expires_at: string };
    return { reservationId: row.reservation_id, status: row.status as ReservationStatus, expiresAt: row.expires_at };
  }

  async commit(reservationId: string, usageEventId: string, actualCostUsd: string | null): Promise<void> {
    const { error } = await this.supabase.rpc('commit_gateway_reservation_v1', {
      p_reservation_id: reservationId,
      p_usage_event_id: usageEventId,
      p_actual_cost_usd: actualCostUsd,
    });
    if (error) throw new Error(`commit_gateway_reservation_v1 failed: ${error.message}`);
  }

  async release(reservationId: string, reason: string): Promise<void> {
    const { error } = await this.supabase.rpc('release_gateway_reservation_v1', {
      p_reservation_id: reservationId,
      p_reason: reason,
    });
    if (error) throw new Error(`release_gateway_reservation_v1 failed: ${error.message}`);
  }

  async markReconciliationRequired(reservationId: string, reason: string): Promise<void> {
    const { error } = await this.supabase.rpc('mark_gateway_reservation_reconciliation_required_v1', {
      p_reservation_id: reservationId,
      p_reason: reason,
    });
    if (error) throw new Error(`mark_gateway_reservation_reconciliation_required_v1 failed: ${error.message}`);
  }
}

export type { AiFeatureKey };
