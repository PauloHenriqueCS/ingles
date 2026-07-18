/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Circuit breaker (Etapa 11, Fase 8), scoped by provider + model (nullable)
 * + feature. Only counts technical provider failures (timeout, 429, 5xx,
 * connection, invalid-response-attributable-to-provider) — auth, validation,
 * internal rate limit, plan/quota, kill-switch, and post-success pedagogical
 * errors are never recorded here (the caller decides what counts; this
 * module only tallies what it's told).
 *
 * States: closed → open (consecutive/window failures cross the configured
 * threshold) → half_open (after cooldown, limited probes) → closed (a probe
 * succeeds) or → open (a probe fails). Every transition is a single atomic
 * SQL statement (row lock via SELECT ... FOR UPDATE inside the function) —
 * concurrent callers can never both "win" a probe slot or double-transition.
 *
 * Thresholds (min samples, failure count/rate, cooldown, probe count) come
 * from the dashboard-configurable columns on the new
 * ai_gateway_circuit_breakers row itself — never hardcoded here.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSharedServiceClient } from './usage-repository';

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerStateResult {
  state: BreakerState;
  probeAllowed: boolean; // true unless half_open and probe slots are full
}

export interface CircuitBreakerInterface {
  getState(provider: string, model: string | null, featureKey: string): Promise<BreakerStateResult>;
  recordOutcome(provider: string, model: string | null, featureKey: string, success: boolean): Promise<BreakerState>;
}

export class SupabaseCircuitBreaker implements CircuitBreakerInterface {
  private readonly supabase: SupabaseClient;

  constructor(supabase?: SupabaseClient) {
    this.supabase = supabase ?? getSharedServiceClient();
  }

  async getState(provider: string, model: string | null, featureKey: string): Promise<BreakerStateResult> {
    const { data, error } = await this.supabase.rpc('get_gateway_breaker_state_v1', {
      p_provider: provider,
      p_model: model,
      p_feature_key: featureKey,
    });
    if (error) throw new Error(`get_gateway_breaker_state_v1 failed: ${error.message}`);
    const row = (Array.isArray(data) ? data[0] : data) as { state: string; probe_allowed: boolean };
    return { state: row.state as BreakerState, probeAllowed: row.probe_allowed };
  }

  async recordOutcome(provider: string, model: string | null, featureKey: string, success: boolean): Promise<BreakerState> {
    const { data, error } = await this.supabase.rpc('record_gateway_breaker_outcome_v1', {
      p_provider: provider,
      p_model: model,
      p_feature_key: featureKey,
      p_success: success,
    });
    if (error) throw new Error(`record_gateway_breaker_outcome_v1 failed: ${error.message}`);
    const row = (Array.isArray(data) ? data[0] : data) as { state: string };
    return row.state as BreakerState;
  }
}
