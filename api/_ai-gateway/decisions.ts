/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Technical decision log for the enforcement layer (Etapa 11): kill-switch,
 * rate limit, dedupe, entitlement, budget, and circuit-breaker verdicts.
 *
 * Recorded OUTSIDE ai_usage_events on purpose — ai_usage_events continues to
 * mean exactly one thing (a physical call attempt to a provider). A blocked
 * or would-block decision never reached the provider, so it must never be
 * confused with one, never counted in total_requests, and never consume a
 * reservation.
 *
 * Every write here is fail-open: a failure to record a decision must never
 * be the reason a request succeeds or fails.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSharedServiceClient } from './usage-repository';
import { sanitizeMetadata } from './sanitize';
import type { GatewayDecisionRecord } from './types';

export interface DecisionsRepositoryInterface {
  record(decision: GatewayDecisionRecord): Promise<void>;
}

export class SupabaseDecisionsRepository implements DecisionsRepositoryInterface {
  private readonly supabase: SupabaseClient;

  constructor(supabase?: SupabaseClient) {
    this.supabase = supabase ?? getSharedServiceClient();
  }

  async record(decision: GatewayDecisionRecord): Promise<void> {
    const { error } = await this.supabase.from('ai_gateway_decisions').insert({
      outcome:         decision.outcome,
      reason_code:     decision.reasonCode,
      feature_key:     decision.featureKey,
      provider:        decision.provider ?? null,
      user_id:         decision.userId ?? null,
      actor_type:      decision.actorType,
      gateway_mode:    decision.gatewayMode,
      policy_revision: decision.policyRevision ?? null,
      correlation_id:  decision.correlationId ?? null,
      metadata:        decision.metadata ? sanitizeMetadata(decision.metadata) : {},
    });
    if (error) throw new Error(`decisions.record failed: ${error.message}`);
  }
}

/**
 * Fail-open wrapper: never throws, never blocks the caller. `repo` is
 * optional so every existing GatewayDeps mock (none of which set
 * decisionsRepository) keeps working — a missing repository is treated the
 * same as a failed write: skip silently.
 */
export async function recordDecisionSafely(
  repo: DecisionsRepositoryInterface | undefined,
  decision: GatewayDecisionRecord,
  logger: (event: string, data?: Record<string, unknown>) => void,
): Promise<void> {
  if (!repo) return;
  try {
    await repo.record(decision);
  } catch (err) {
    logger('gateway.decision.recordFailed', { message: err instanceof Error ? err.message : String(err) });
  }
}
