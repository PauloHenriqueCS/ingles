/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Atomic consumption reservations (Etapa 11, Fase 5 — corrected). Reuses
 * usage_reservations/usage_reservation_items, and now also
 * ai_gateway_quota_buckets/ai_gateway_budget_buckets, all touched inside a
 * SINGLE atomic SQL function (reserve_gateway_usage_v1): quota (accumulated
 * per-period consumption, not just a per-call ceiling) and budget (USD,
 * across every applicable scope) are validated AND reserved together, under
 * deterministically-ordered row locks — closing the last-dollar/last-unit
 * race that existed when budget and reservation were two separate round
 * trips.
 *
 * "Reserved" (Fase 5 spec language) is this schema's pre-existing 'pending'
 * status — see types.ts's ReservationStatus comment.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSharedServiceClient } from './usage-repository';
import type {
  AiFeatureKey, ReservationActualMetric, ReservationResult, ReservationStatus, ReserveUsageParams,
} from './types';

export interface ReservationsRepositoryInterface {
  reserve(params: ReserveUsageParams): Promise<ReservationResult>;
  commit(reservationId: string, usageEventId: string, actualCostUsd: string | null, actualMetrics?: ReservationActualMetric[]): Promise<void>;
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
      p_metrics: params.estimatedMetrics.map((m) => ({
        quota_key: m.metricKey, unit_type: 'unit', reserved_quantity: m.quantity,
        limit_quantity: m.limitQuantity ?? null,
        period_type: m.periodType ?? null,
        period_start: m.periodStart ?? null,
        period_end: m.periodEnd ?? null,
      })),
      p_budget_scopes: params.budgetScopes.map((b) => ({
        scope_type: b.scopeType, scope_key: b.scopeKey, period_type: b.periodType,
        period_start: b.periodStart, period_end: b.periodEnd, limit_usd: b.limitUsd,
      })),
      p_estimated_cost_usd: params.estimatedCostUsd,
      p_expires_in_seconds: params.expiresInSeconds,
    });
    if (error) throw new Error(`reserve_gateway_usage_v1 failed: ${error.message}`);
    const row = (Array.isArray(data) ? data[0] : data) as {
      reservation_id: string | null; status: string; expires_at: string | null;
      blocked_reason: string | null; blocked_detail: string | null;
    };
    return {
      reservationId: row.reservation_id,
      status: row.status as ReservationStatus | 'blocked',
      expiresAt: row.expires_at,
      blockedReason: (row.blocked_reason as 'QUOTA_EXCEEDED' | 'BUDGET_EXCEEDED' | null) ?? null,
      blockedDetail: row.blocked_detail ?? null,
    };
  }

  async commit(reservationId: string, usageEventId: string, actualCostUsd: string | null, actualMetrics?: ReservationActualMetric[]): Promise<void> {
    const { error } = await this.supabase.rpc('commit_gateway_reservation_v1', {
      p_reservation_id: reservationId,
      p_usage_event_id: usageEventId,
      p_actual_cost_usd: actualCostUsd,
      p_actual_metrics: actualMetrics && actualMetrics.length > 0
        ? actualMetrics.map((m) => ({ quota_key: m.metricKey, actual_quantity: m.quantity }))
        : null,
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
