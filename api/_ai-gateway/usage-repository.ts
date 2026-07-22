/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Abstraction over the AI Gateway database tables:
 *   ai_usage_events, ai_usage_event_metrics, ai_provider_sessions.
 *
 * The repository receives normalized data only.
 * It knows nothing about OpenAI or Azure SDKs.
 * NULL costs mean "unknown" — never convert to 0.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServiceCredentials } from '../_env';
import type {
  ActorType,
  AiFeatureKey,
  ExecutionLocation,
  GatewayUsageMetric,
} from './types';

// ── Params ────────────────────────────────────────────────────────────────────

export interface StartEventParams {
  requestId: string;
  correlationId: string;
  parentEventId?: string;
  providerSessionRecordId?: string;
  idempotencyKey?: string;
  // Provider-assigned identifier for the physical unit this event represents
  // (e.g. a Realtime response.id). When paired with providerSessionRecordId,
  // this is the dedupe key enforced by the DB unique index
  // uq_aue_session_provider_request (see migration
  // 20260717140000_ai_gateway_realtime_dedupe.sql) — a duplicate causes
  // startEvent() to throw DuplicateUsageEventError instead of inserting a
  // second row, so a relayed usage event can never be double-counted.
  providerRequestId?: string;
  userId?: string;
  initiatedByUserId?: string;
  actorType: ActorType;
  featureKey: AiFeatureKey;
  provider: string;
  service?: string;
  model?: string;
  executionLocation: ExecutionLocation;
  isBillable: boolean;
  attemptNumber: number;
  callSequence: number;
  operationPart?: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  startedAt: number;  // Unix timestamp ms
}

/**
 * Thrown by startEvent() when providerSessionRecordId + providerRequestId
 * collide with an existing event (Postgres unique_violation, SQLSTATE
 * 23505, on uq_aue_session_provider_request). Callers treat this as "already
 * recorded" — an idempotent no-op, never a hard failure.
 */
export class DuplicateUsageEventError extends Error {
  constructor() {
    super('Duplicate usage event for this provider session + provider request id');
    this.name = 'DuplicateUsageEventError';
  }
}

export interface CompleteEventParams {
  latencyMs: number;
  httpStatus?: number;
  providerRequestId?: string;
  cacheHit?: boolean;
}

export interface FailEventParams {
  latencyMs: number;
  httpStatus?: number;
  errorCode?: string;
  errorCategory?: string;
  sanitizedErrorMessage?: string;
}

export interface CreateSessionParams {
  featureKey: AiFeatureKey;
  provider: string;
  userId?: string;
  initiatedByUserId?: string;
  internalSessionType?: string;
  internalSessionId?: string;
  authorizationFingerprint?: string;
  authorizationExpiresAt?: Date;
  metadata?: Record<string, unknown>;
}

// ── Cost calculation params ───────────────────────────────────────────────────
// calculatedCostUsd is always a decimal STRING, never a JS number — this is
// the exact value produced by the BigInt-rational math in cost-calculator.ts.
// Passing it as a string all the way to the NUMERIC column avoids any binary
// floating-point round-trip, which a JS `number` would risk.

export interface UsageEventForCosting {
  id: string;
  provider: string;
  service: string | null;
  model: string | null;
  startedAt: string; // ISO timestamp, as stored
  costStatus: string;
}

export interface UsageMetricForCosting {
  id: string;
  metricKey: string;
  quantity: number;
  isBillable: boolean;
}

export interface UpdateMetricCostParams {
  billableQuantity?: number;
  pricingId?: string;
  calculatedCostUsd: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateEventCostParams {
  costStatus: string;
  calculatedCostUsd: string;
}

// ── Interface ─────────────────────────────────────────────────────────────────

export interface UsageRepositoryInterface {
  startEvent(params: StartEventParams): Promise<string>;
  completeEvent(id: string, params: CompleteEventParams): Promise<void>;
  failEvent(id: string, params: FailEventParams): Promise<void>;
  cancelEvent(id: string): Promise<void>;
  insertMetrics(eventId: string, metrics: GatewayUsageMetric[]): Promise<void>;
  createProviderSession(params: CreateSessionParams): Promise<string>;
  activateSession(id: string, providerSessionId?: string): Promise<void>;
  completeSession(id: string, durationSeconds: number): Promise<void>;
  failSession(id: string): Promise<void>;
  expireSession(id: string): Promise<void>;
  getEventForCosting(eventId: string): Promise<UsageEventForCosting | null>;
  getMetricsForEvent(eventId: string): Promise<UsageMetricForCosting[]>;
  updateMetricCost(metricId: string, params: UpdateMetricCostParams): Promise<void>;
  updateEventCost(eventId: string, params: UpdateEventCostParams): Promise<void>;
}

// ── Service role client factory ───────────────────────────────────────────────

function createServiceClient(): SupabaseClient {
  const { url, key } = getSupabaseServiceCredentials();
  if (!url || !key) {
    throw new Error('Missing Supabase service role credentials (VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

let _sharedClient: SupabaseClient | null = null;

// Exported so other gateway repositories (e.g. pricing-repository.ts) reuse
// the same client instance instead of opening a second connection.
export function getSharedServiceClient(): SupabaseClient {
  if (!_sharedClient) _sharedClient = createServiceClient();
  return _sharedClient;
}

// ── SupabaseUsageRepository ───────────────────────────────────────────────────

export class SupabaseUsageRepository implements UsageRepositoryInterface {
  private readonly supabase: SupabaseClient;

  constructor(supabase?: SupabaseClient) {
    this.supabase = supabase ?? getSharedServiceClient();
  }

  async startEvent(p: StartEventParams): Promise<string> {
    const { data, error } = await this.supabase
      .from('ai_usage_events')
      .insert({
        request_id:               p.requestId,
        correlation_id:           p.correlationId,
        parent_event_id:          p.parentEventId ?? null,
        provider_session_record_id: p.providerSessionRecordId ?? null,
        idempotency_key:          p.idempotencyKey ?? null,
        user_id:                  p.userId ?? null,
        initiated_by_user_id:     p.initiatedByUserId ?? null,
        actor_type:               p.actorType,
        feature_key:              p.featureKey,
        provider:                 p.provider,
        service:                  p.service ?? null,
        model:                    p.model ?? null,
        provider_request_id:      p.providerRequestId ?? null,
        execution_location:       p.executionLocation,
        status:                   'started',
        attempt_number:           p.attemptNumber,
        call_sequence:            p.callSequence,
        operation_part:           p.operationPart ?? null,
        is_billable:              p.isBillable,
        cost_status:              p.isBillable ? 'pending' : 'not_applicable',
        resource_type:            p.resourceType ?? null,
        resource_id:              p.resourceId ?? null,
        metadata:                 p.metadata ?? {},
        started_at:               new Date(p.startedAt).toISOString(),
      })
      .select('id')
      .single();

    if (error || !data) {
      // 23505 = unique_violation. Only uq_aue_session_provider_request can
      // fire here (request_id has its own DEFAULT gen_random_uuid() and is
      // never client-supplied), so this always means "this provider session
      // + provider request id was already recorded."
      if (error?.code === '23505' && p.providerSessionRecordId && p.providerRequestId) {
        throw new DuplicateUsageEventError();
      }
      throw new Error(`startEvent failed: ${error?.message ?? 'no data'}`);
    }
    return (data as { id: string }).id;
  }

  async completeEvent(id: string, p: CompleteEventParams): Promise<void> {
    const { error } = await this.supabase
      .from('ai_usage_events')
      .update({
        status:            'succeeded',
        completed_at:      new Date().toISOString(),
        latency_ms:        p.latencyMs,
        http_status:       p.httpStatus ?? null,
        provider_request_id: p.providerRequestId ?? null,
        cache_hit:         p.cacheHit ?? false,
      })
      .eq('id', id);

    if (error) throw new Error(`completeEvent failed: ${error.message}`);
  }

  async failEvent(id: string, p: FailEventParams): Promise<void> {
    const { error } = await this.supabase
      .from('ai_usage_events')
      .update({
        status:                  'failed',
        completed_at:            new Date().toISOString(),
        latency_ms:              p.latencyMs,
        http_status:             p.httpStatus ?? null,
        error_code:              p.errorCode ?? null,
        error_category:          p.errorCategory ?? null,
        sanitized_error_message: p.sanitizedErrorMessage ?? null,
        cost_status:             'not_applicable',
      })
      .eq('id', id);

    if (error) throw new Error(`failEvent failed: ${error.message}`);
  }

  async cancelEvent(id: string): Promise<void> {
    const { error } = await this.supabase
      .from('ai_usage_events')
      .update({
        status:       'cancelled',
        completed_at: new Date().toISOString(),
        cost_status:  'not_applicable',
      })
      .eq('id', id);

    if (error) throw new Error(`cancelEvent failed: ${error.message}`);
  }

  async insertMetrics(eventId: string, metrics: GatewayUsageMetric[]): Promise<void> {
    if (metrics.length === 0) return;

    const rows = metrics.map(m => ({
      usage_event_id:      eventId,
      metric_key:          m.metricKey,
      unit_type:           m.unitType,
      quantity:            m.quantity,
      billable_quantity:   m.billableQuantity ?? null,
      is_billable:         m.isBillable,
      is_final:            true,
      measurement_source:  m.measurementSource,
      calculated_cost_usd: m.calculatedCostUsd ?? null,
      metadata:            m.metadata ?? {},
    }));

    const { error } = await this.supabase
      .from('ai_usage_event_metrics')
      .insert(rows);

    if (error) throw new Error(`insertMetrics failed: ${error.message}`);
  }

  async createProviderSession(p: CreateSessionParams): Promise<string> {
    const { data, error } = await this.supabase
      .from('ai_provider_sessions')
      .insert({
        feature_key:              p.featureKey,
        provider:                 p.provider,
        user_id:                  p.userId ?? null,
        initiated_by_user_id:     p.initiatedByUserId ?? null,
        internal_session_type:    p.internalSessionType ?? null,
        internal_session_id:      p.internalSessionId ?? null,
        authorization_fingerprint: p.authorizationFingerprint ?? null,
        authorization_expires_at: p.authorizationExpiresAt?.toISOString() ?? null,
        status:                   'authorized',
        metadata:                 p.metadata ?? {},
      })
      .select('id')
      .single();

    if (error || !data) {
      throw new Error(`createProviderSession failed: ${error?.message ?? 'no data'}`);
    }
    return (data as { id: string }).id;
  }

  async activateSession(id: string, providerSessionId?: string): Promise<void> {
    const { error } = await this.supabase
      .from('ai_provider_sessions')
      .update({
        status:              'active',
        started_at:          new Date().toISOString(),
        provider_session_id: providerSessionId ?? null,
      })
      .eq('id', id);

    if (error) throw new Error(`activateSession failed: ${error.message}`);
  }

  async completeSession(id: string, durationSeconds: number): Promise<void> {
    if (durationSeconds < 0) {
      throw new Error('completeSession: durationSeconds cannot be negative');
    }
    const { error } = await this.supabase
      .from('ai_provider_sessions')
      .update({
        status:           'completed',
        ended_at:         new Date().toISOString(),
        duration_seconds: durationSeconds,
      })
      .eq('id', id);

    if (error) throw new Error(`completeSession failed: ${error.message}`);
  }

  async failSession(id: string): Promise<void> {
    const { error } = await this.supabase
      .from('ai_provider_sessions')
      .update({
        status:   'failed',
        ended_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) throw new Error(`failSession failed: ${error.message}`);
  }

  async expireSession(id: string): Promise<void> {
    const { error } = await this.supabase
      .from('ai_provider_sessions')
      .update({
        status:   'expired',
        ended_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) throw new Error(`expireSession failed: ${error.message}`);
  }

  // ── Cost calculation reads/writes ────────────────────────────────────────

  async getEventForCosting(eventId: string): Promise<UsageEventForCosting | null> {
    const { data, error } = await this.supabase
      .from('ai_usage_events')
      .select('id, provider, service, model, started_at, cost_status')
      .eq('id', eventId)
      .maybeSingle();

    if (error || !data) return null;
    const row = data as { id: string; provider: string; service: string | null; model: string | null; started_at: string; cost_status: string };
    return {
      id:         row.id,
      provider:   row.provider,
      service:    row.service,
      model:      row.model,
      startedAt:  row.started_at,
      costStatus: row.cost_status,
    };
  }

  async getMetricsForEvent(eventId: string): Promise<UsageMetricForCosting[]> {
    const { data, error } = await this.supabase
      .from('ai_usage_event_metrics')
      .select('id, metric_key, quantity, is_billable')
      .eq('usage_event_id', eventId)
      .eq('is_final', true);

    if (error || !data) return [];
    return (data as Array<{ id: string; metric_key: string; quantity: number; is_billable: boolean }>).map((r) => ({
      id:         r.id,
      metricKey:  r.metric_key,
      quantity:   r.quantity,
      isBillable: r.is_billable,
    }));
  }

  async updateMetricCost(metricId: string, p: UpdateMetricCostParams): Promise<void> {
    const payload: Record<string, unknown> = {
      billable_quantity:   p.billableQuantity ?? null,
      pricing_id:          p.pricingId ?? null,
      // Decimal string, not a JS number — preserves exact precision into NUMERIC.
      calculated_cost_usd: p.calculatedCostUsd,
    };
    if (p.metadata) payload.metadata = p.metadata;

    const { error } = await this.supabase
      .from('ai_usage_event_metrics')
      .update(payload)
      .eq('id', metricId);

    if (error) throw new Error(`updateMetricCost failed: ${error.message}`);
  }

  async updateEventCost(eventId: string, p: UpdateEventCostParams): Promise<void> {
    const { error } = await this.supabase
      .from('ai_usage_events')
      .update({
        cost_status:         p.costStatus,
        // Decimal string, not a JS number — preserves exact precision into NUMERIC.
        calculated_cost_usd: p.calculatedCostUsd,
      })
      .eq('id', eventId);

    if (error) throw new Error(`updateEventCost failed: ${error.message}`);
  }
}
