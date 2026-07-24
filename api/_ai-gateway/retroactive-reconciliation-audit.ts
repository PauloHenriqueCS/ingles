/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Audit trail for the retroactive-reconciliation admin action
 * (scripts/ai-gateway-retroactive-reconcile.ts), written to the existing
 * public.admin_audit_log table — same table and shape as
 * api/_account/audit.ts's recordAccountAuditEvent, not a parallel log.
 * target_type is a stable 'ai_gateway_reconciliation_run' so this trail can
 * be filtered independently of both the account-audit trail and the admin
 * console's own action taxonomy.
 *
 * Never logs provider payloads or secrets — only counts, event ids, and the
 * run's mode (dry_run/apply). Never throws: an audit failure must never
 * abort the reconciliation run itself.
 */

import { getSharedServiceClient } from './usage-repository';

export type RetroactiveReconciliationMode = 'dry_run' | 'apply';

export interface RetroactiveReconciliationAuditParams {
  runId: string;
  mode: RetroactiveReconciliationMode;
  candidateEventIds: string[];
  reconciliableEventIds: string[];
  stillUncoveredEventIds: string[];
  appliedEventIds: string[];
  failedEventIds: string[];
}

export async function recordRetroactiveReconciliationAudit(
  params: RetroactiveReconciliationAuditParams,
): Promise<void> {
  try {
    const supabase = getSharedServiceClient();
    await supabase.from('admin_audit_log').insert({
      actor_user_id: null,
      action: 'gateway.pricing.retroactive_reconciliation_run',
      target_type: 'ai_gateway_reconciliation_run',
      target_id: params.runId,
      reason: params.mode,
      result: params.failedEventIds.length > 0 ? 'failure' : 'success',
      after_state: {
        candidateCount: params.candidateEventIds.length,
        reconciliableCount: params.reconciliableEventIds.length,
        stillUncoveredCount: params.stillUncoveredEventIds.length,
        appliedCount: params.appliedEventIds.length,
        failedCount: params.failedEventIds.length,
        candidateEventIds: params.candidateEventIds,
        reconciliableEventIds: params.reconciliableEventIds,
        stillUncoveredEventIds: params.stillUncoveredEventIds,
        appliedEventIds: params.appliedEventIds,
        failedEventIds: params.failedEventIds,
      },
      environment: 'app',
    });
  } catch {
    // Never let an audit-log failure break the reconciliation run.
  }
}
