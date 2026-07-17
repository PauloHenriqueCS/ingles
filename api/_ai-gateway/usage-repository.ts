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
}

// ── Service role client factory ───────────────────────────────────────────────

function createServiceClient(): SupabaseClient {
  const url = process.env.VITE_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) {
    throw new Error('Missing Supabase service role credentials (VITE_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

let _sharedClient: SupabaseClient | null = null;

function getSharedServiceClient(): SupabaseClient {
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
}
