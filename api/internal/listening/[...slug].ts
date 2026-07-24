/**
 * Consolidated dispatcher for all /api/internal/listening/* routes.
 * Replaces 7 individual files to stay within Vercel Hobby plan's 12-function limit.
 *
 * Routes:
 *   GET  /api/internal/listening/jobs/dispatch      → job queue worker (cron every minute)
 *   GET  /api/internal/listening/repair             → recover stuck jobs (cron every 10 min)
 *   GET  /api/internal/listening/inventory/ensure   → ensure inventory levels (cron daily)
 *   GET  /api/internal/listening/audit              → inventory quality audit (cron daily)
 *   GET  /api/internal/listening/storage-audit      → storage consistency audit (cron weekly)
 *   GET  /api/internal/listening/cleanup            → purge old jobs/alerts (cron weekly)
 *   GET  /api/internal/listening/supply             → inventory status (admin)
 *   POST /api/internal/listening/supply             → generate/repair episodes (admin)
 *
 * All routes require Authorization: Bearer {CRON_SECRET}.
 */

import { checkCronAuth } from '../_auth';
import { methodGuard, safeLog, resolveSlug } from '../../_helpers';
import { handleProductConfigStatusRoute } from '../_product-config-status-route-handler';
import {
  getSharedServiceClient, getProductionDeps, reconcileSessionReservation, releaseSessionReservation,
  releaseExpiredPendingReservations,
} from '../../_ai-gateway/index';
import { hangupAndPersist } from '../../_realtime-hangup';
import {
  WEBRTC_CONNECT_FEATURE_KEY, REALTIME_MAX_SESSION_SECONDS,
  REALTIME_HEARTBEAT_STALE_SECONDS, AUTHORIZATION_SWEEP_GRACE_SECONDS,
} from '../../_realtime-constants';
import { getJobsServiceClient } from '../../../src/services/listening/jobs/_supabase';
import { recoverStuckListeningJobs } from '../../../src/services/listening/jobs/recover-stuck-listening-jobs';
import { recoverStuckListeningGroupJobs } from '../../../src/services/listening/group-generation/recover-stuck-listening-group-jobs';
import { processNextListeningJob } from '../../../src/services/listening/jobs/process-listening-job';
import {
  TEXT_JOB_TYPES, AZURE_JOB_TYPES, SYNC_JOB_TYPES, PUBLISH_JOB_TYPES,
  JOB_CONCURRENCY, RETENTION_DAYS,
} from '../../../src/services/listening/jobs/listening-job-config';
import type { ListeningJobType } from '../../../src/services/listening/jobs/listening-job-types';
import { auditListeningInventory } from '../../../src/services/listening/inventory/audit-listening-inventory';
import { getListeningInventoryStatus } from '../../../src/services/listening/inventory/get-listening-inventory-status';
import { auditListeningStorageConsistency } from '../../../src/services/listening/publication/audit-listening-storage';
import { repairListeningPipeline } from '../../../src/services/listening/pipeline/repair-listening-pipeline';

const BATCH_SIZE = 3;
const VALID_LEVELS = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);

// ── GET /api/internal/listening/jobs/dispatch ─────────────────────────────────

async function handleJobsDispatch(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['GET'])) return;

  const workerId = `vercel-cron-${Date.now()}`;
  const supabase = getJobsServiceClient();
  const processed: Array<{ jobId: string; jobType: string; success: boolean; durationMs: number }> = [];

  try {
    const { data: activeJobs } = await supabase
      .from('listening_jobs')
      .select('job_type')
      .eq('status', 'processing');

    const activeJobTypes = (activeJobs ?? []).map((j: { job_type: string }) => j.job_type);
    const activeText    = activeJobTypes.filter((t: string) => TEXT_JOB_TYPES.includes(t as ListeningJobType)).length;
    const activeAzure   = activeJobTypes.filter((t: string) => AZURE_JOB_TYPES.includes(t as ListeningJobType)).length;
    const activeSync    = activeJobTypes.filter((t: string) => SYNC_JOB_TYPES.includes(t as ListeningJobType)).length;
    const activePublish = activeJobTypes.filter((t: string) => PUBLISH_JOB_TYPES.includes(t as ListeningJobType)).length;

    const eligibleTypes: ListeningJobType[] = [];
    if (activeText    < JOB_CONCURRENCY.maxConcurrentText)    eligibleTypes.push(...TEXT_JOB_TYPES);
    if (activeAzure   < JOB_CONCURRENCY.maxConcurrentAzure)   eligibleTypes.push(...AZURE_JOB_TYPES);
    if (activeSync    < JOB_CONCURRENCY.maxConcurrentSync)     eligibleTypes.push(...SYNC_JOB_TYPES);
    if (activePublish < JOB_CONCURRENCY.maxConcurrentPublish)  eligibleTypes.push(...PUBLISH_JOB_TYPES);

    if (eligibleTypes.length === 0) {
      safeLog('internal/listening/jobs/dispatch', 'concurrency_limit_reached', 200, {});
      return res.status(200).json({ processed: 0, reason: 'concurrency_limit_reached' });
    }

    for (let i = 0; i < BATCH_SIZE; i++) {
      const result = await processNextListeningJob(supabase, workerId, eligibleTypes);
      if (!result.processed) break;
      processed.push({ jobId: result.jobId!, jobType: result.jobType!, success: result.success ?? false, durationMs: result.durationMs ?? 0 });
    }

    safeLog('internal/listening/jobs/dispatch', 'dispatch_completed', 200, { processed: processed.length });
    return res.status(200).json({ processed: processed.length, jobs: processed });
  } catch (err) {
    safeLog('internal/listening/jobs/dispatch', 'dispatch_error', 500, { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: 'Dispatch error' });
  }
}

// ── GET /api/internal/listening/repair ───────────────────────────────────────

async function handleRepair(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['GET'])) return;
  try {
    const supabase = getJobsServiceClient();
    // Two independent recovery mechanisms share this one cron slot
    // (listening-repair-stuck-jobs, every 10 min — see
    // supabase/migrations/20260715240000_create_listening_cron_jobs.sql):
    // the legacy per-user on-demand sessions, and the shared level_group
    // jobs added by the group-generation pipeline. No new cron is created.
    const [onDemandResult, groupResult] = await Promise.all([
      recoverStuckListeningJobs(supabase),
      recoverStuckListeningGroupJobs(supabase),
    ]);
    safeLog('internal/listening/repair', 'repair_completed', 200, {
      recovered: onDemandResult.recoveredCount,
      groupRecovered: groupResult.recoveredCount,
    });
    return res.status(200).json({
      recovered: onDemandResult.recoveredCount,
      jobIds: onDemandResult.jobIds,
      groupRecovered: groupResult.recoveredCount,
      groupJobIds: groupResult.jobIds,
    });
  } catch (err) {
    safeLog('internal/listening/repair', 'repair_error', 500, { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: 'Repair error' });
  }
}

// ── GET /api/internal/listening/inventory/ensure ─────────────────────────────
// Preventive stock generation is DISABLED. Shared Listening content is now
// generated strictly on demand, per level_group, the first time a user of
// that group actually needs a story and none is available for reuse — see
// getOrCreateListeningGroupJob, wired into getListeningToday. This route
// (and the 'generate' action of /supply below) are kept as safe no-ops
// rather than deleted so the still-scheduled pg_cron target
// (listening-ensure-inventory — unscheduled in
// supabase/migrations/20260722110000_disable_listening_inventory_preventive_generation.sql,
// but a manual caller could still hit this URL with the cron secret) and any
// external monitoring get a clear 200 instead of a 404 or a resurrected
// preventive pipeline.

async function handleInventoryEnsure(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['GET'])) return;
  safeLog('internal/listening/inventory/ensure', 'inventory_ensure_disabled', 200, {});
  return res.status(200).json({
    disabled: true,
    reason: 'Preventive inventory generation was replaced by on-demand shared level-group generation (src/services/listening/group-generation).',
    pipelinesCreated: 0,
    levels: [],
  });
}

// ── GET /api/internal/listening/audit ────────────────────────────────────────

async function handleAudit(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['GET'])) return;
  try {
    const supabase = getJobsServiceClient();
    const result = await auditListeningInventory(supabase);
    safeLog('internal/listening/audit', 'audit_completed', 200, { alertsCreated: result.alertsCreated, issues: result.issues.length });
    return res.status(200).json({ alertsCreated: result.alertsCreated, issueCount: result.issues.length, issues: result.issues.slice(0, 20) });
  } catch (err) {
    safeLog('internal/listening/audit', 'audit_error', 500, { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: 'Audit error' });
  }
}

// ── GET /api/internal/listening/storage-audit ────────────────────────────────

async function handleStorageAudit(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['GET'])) return;
  try {
    const result = await auditListeningStorageConsistency();
    safeLog('internal/listening/storage-audit', 'storage_audit_completed', 200, { totalIssues: result.summary.totalIssues });
    return res.status(200).json({ auditedAt: result.auditedAt, totalIssues: result.summary.totalIssues, summary: result.summary, issues: result.issues.slice(0, 50) });
  } catch (err) {
    safeLog('internal/listening/storage-audit', 'storage_audit_error', 500, { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: 'Storage audit error' });
  }
}

// ── GET /api/internal/listening/cleanup ──────────────────────────────────────

async function handleCleanup(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['GET'])) return;
  try {
    const supabase = getJobsServiceClient();
    let totalDeleted = 0;

    const completedCutoff = new Date(Date.now() - RETENTION_DAYS.COMPLETED * 24 * 60 * 60 * 1000).toISOString();
    const { data: deletedCompleted } = await supabase.from('listening_jobs').delete().eq('status', 'completed').lt('finished_at', completedCutoff).select('id');
    totalDeleted += (deletedCompleted?.length ?? 0);

    const cancelledCutoff = new Date(Date.now() - RETENTION_DAYS.CANCELLED * 24 * 60 * 60 * 1000).toISOString();
    const { data: deletedCancelled } = await supabase.from('listening_jobs').delete().eq('status', 'cancelled').lt('finished_at', cancelledCutoff).select('id');
    totalDeleted += (deletedCancelled?.length ?? 0);

    const failedCutoff = new Date(Date.now() - RETENTION_DAYS.FAILED * 24 * 60 * 60 * 1000).toISOString();
    const { data: deletedFailed } = await supabase.from('listening_jobs').delete().eq('status', 'failed').lt('finished_at', failedCutoff).select('id');
    totalDeleted += (deletedFailed?.length ?? 0);

    const alertCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await supabase.from('listening_operational_alerts').delete().eq('status', 'resolved').lt('resolved_at', alertCutoff);

    safeLog('internal/listening/cleanup', 'cleanup_completed', 200, { deleted: totalDeleted });
    return res.status(200).json({ deleted: totalDeleted });
  } catch (err) {
    safeLog('internal/listening/cleanup', 'cleanup_error', 500, { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: 'Cleanup error' });
  }
}

// ── GET|POST /api/internal/listening/supply ───────────────────────────────────

async function handleSupply(req: any, res: any): Promise<void> {
  const supabase = getJobsServiceClient();

  if (req.method === 'GET') {
    try {
      const statuses = await getListeningInventoryStatus(supabase);
      const inventory = statuses.map((s: any) => ({
        level: s.cefrLevel, published: s.publishedAvailable, inPipeline: s.inPipeline,
        failed: s.failed, missing: s.missingCount, status: s.status,
      }));
      safeLog('supply', 'status_requested', 200, { levelsChecked: inventory.length });
      return res.status(200).json({ success: true, inventory });
    } catch (err) {
      safeLog('supply', 'status_error', 500, { error: String(err) });
      return res.status(500).json({ success: false, error: 'Failed to fetch inventory status.' });
    }
  }

  if (req.method === 'POST') {
    let body: { action?: string; level?: string; episodeId?: string } = {};
    try {
      const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
      body = JSON.parse(raw);
    } catch {
      return res.status(400).json({ success: false, error: 'Invalid JSON body.' });
    }

    const { action, level, episodeId } = body;

    if (action === 'generate') {
      // Preventive stock generation is disabled — see handleInventoryEnsure
      // above. Shared content now comes exclusively from
      // getOrCreateListeningGroupJob, triggered on demand from
      // getListeningToday.
      if (level && !VALID_LEVELS.has(level)) {
        return res.status(400).json({ success: false, error: `Invalid level. Use: ${[...VALID_LEVELS].join(', ')}` });
      }
      safeLog('supply', 'generation_disabled', 200, { level: level ?? 'all' });
      return res.status(200).json({
        success: true, action: 'generate', disabled: true,
        reason: 'Preventive inventory generation was replaced by on-demand shared level-group generation (src/services/listening/group-generation).',
        level: level ?? 'all', pipelinesCreated: 0, levelsAffected: [],
      });
    }

    if (action === 'repair') {
      if (!episodeId || !/^[0-9a-f-]{36}$/i.test(episodeId)) {
        return res.status(400).json({ success: false, error: 'episodeId is required and must be a valid UUID.' });
      }
      try {
        const result = await repairListeningPipeline(supabase, episodeId);
        safeLog('supply', 'repair_triggered', 200, { episodeId, ...result });
        return res.status(200).json({ success: true, action: 'repair', episodeId, ...result });
      } catch (err) {
        safeLog('supply', 'repair_error', 500, { episodeId, error: String(err) });
        return res.status(500).json({ success: false, error: 'Repair failed.', detail: String(err) });
      }
    }

    return res.status(400).json({
      success: false, error: "Invalid action. Use: 'generate' or 'repair'.",
      usage: { generate_all: 'POST { "action": "generate" }', generate_level: 'POST { "action": "generate", "level": "B1" }', repair_episode: 'POST { "action": "repair", "episodeId": "<uuid>" }' },
    });
  }

  return res.status(405).json({ success: false, error: 'Method not allowed. Use GET or POST.' });
}

// ── GET /api/internal/listening/conversation-sweep ───────────────────────────
// Unrelated to listening — nested here for the same function-count reason
// as every other unrelated route folded into an existing dispatcher in this
// codebase (see handlePlanEntitlements in api/pronunciation-training/
// [...slug].ts): this deployment hit Vercel's Hobby-plan 12-function cap
// (confirmed by a real production deployment failure, errorCode
// exceeded_serverless_functions_per_deployment) once Etapa 11's realtime
// hardening needed one more internal, cron-triggered, service-role-only
// endpoint. This file was already the established "internal cron job"
// pattern (checkCronAuth, GET, pg_cron + pg_net via Vault secrets — see
// supabase/migrations/20260715240000_create_listening_cron_jobs.sql for the
// scheduling half of that pattern, extended in
// 20260723020000_conversation_session_heartbeat_and_hangup_evidence.sql for
// this route), so it was the natural home even though its name says
// "listening".
//
// Runs every minute (registered in the migration above). Closes two
// distinct classes of orphaned realtime state that no cooperative client
// path (session-end/session-failed/session-complete/session-control) can
// ever reach on its own, because by definition the client that would call
// them is gone — tab closed, crash, or lost network, with no beforeunload/
// sendBeacon guaranteed to fire:
//
//   1. ai_provider_sessions stuck 'active' whose heartbeat (renewed by
//      handleSessionActive and every handleSessionControl poll — see
//      api/conversation/[...slug].ts) has gone quiet for longer than
//      REALTIME_HEARTBEAT_STALE_SECONDS, OR stuck 'authorized'/'connecting'
//      (client fetched a token but the call never even reached
//      session-active) past its authorization_expires_at. Each gets a real
//      hangupAndPersist() attempt (using whatever call_id was captured —
//      see handleWebrtcConnect) before being marked 'expired', so a
//      genuinely abandoned OpenAI Realtime call is not just forgotten
//      locally but actually terminated server-side.
//
//   2. conversation_session_authorizations stuck 'authorized' past
//      authorized_at + authorized_max_seconds + a grace window (the same
//      authoritative duration computation handleSessionComplete uses,
//      clamped to authorized_max_seconds, mirrored into
//      conversation_sessions only when > 0) — closes the exact quota-bypass
//      gap this table was created to prevent (2026-07-21 audit) for the one
//      path session-complete alone can never cover: nobody left to call it.
//      Also reconciles that row's upfront conversation.realtime_usage
//      budget reservation (see api/_ai-gateway/reservation-reconciliation.ts)
//      the same way /session-complete itself would — the "safe expiration"
//      strategy for an incomplete session: commit whatever real cost
//      genuinely accrued, never silently return budget for spend that
//      already happened just because nobody was left to close the session
//      cooperatively.
//
//   3. pronunciation.assess_text ai_provider_sessions rows abandoned past
//      their authorization_expires_at — the same class of gap as #1, but
//      for Pronunciation (added following an independent audit finding:
//      Pronunciation had no sweep equivalent to Conversation's). Reuses the
//      exact same reconcileSessionReservation used by Conversation and by
//      assess_text's own /complete — commits real cost if a usage event
//      exists, releases in full if none does, and never releases when cost
//      isn't fully known yet. No hangupAndPersist equivalent here: Azure has
//      no session to actively terminate, this only closes the bookkeeping
//      row and reconciles its budget reservation.
//
//   4. Any OTHER feature's reservation still 'pending' well past its own
//      expires_at (releaseExpiredPendingReservations, in the shared
//      reservation-reconciliation.ts module) — the generic "process died
//      mid-request" case executeEnforcedPipeline's own release-on-error path
//      can never reach, because there is no error to catch when nothing ever
//      ran to catch it (function timeout, crash, mid-request redeploy).
//      Root-caused (read-only investigation) as the reason a small number of
//      pre-existing writing.evaluate_rewrite reservations were found stuck
//      'pending' long after their 120s expiry. Excludes
//      conversation.realtime_usage/pronunciation.assess_text, which are
//      already covered — more carefully, with real-usage correlation — by
//      #2 and #3 above.
//
// Every UPDATE below is the same guarded-by-current-status pattern used
// throughout api/conversation/[...slug].ts (matches no rows if another path
// already closed the same row first — concurrency-safe, idempotent, safe to
// run every minute even if a previous run is still finishing a slow hangup
// call for an unrelated row).

const PRONUNCIATION_ASSESS_TEXT_FEATURE_KEY = 'pronunciation.assess_text';

interface StaleProviderSessionRow {
  id: string;
  provider_session_id: string | null;
  started_at: string | null;
}

interface StaleAssessTextSessionRow {
  id: string;
  metadata: Record<string, unknown> | null;
}

async function closeStaleProviderSession(
  supabase: ReturnType<typeof getSharedServiceClient>,
  row: StaleProviderSessionRow,
): Promise<void> {
  if (row.provider_session_id) {
    await hangupAndPersist(row.id, row.provider_session_id).catch(() => undefined);
  }
  const startedAtMs = row.started_at ? new Date(row.started_at).getTime() : null;
  const durationSeconds = startedAtMs !== null && Number.isFinite(startedAtMs)
    ? Math.max(0, (Date.now() - startedAtMs) / 1000)
    : null;
  await supabase
    .from('ai_provider_sessions')
    .update({
      status: 'expired',
      ended_at: new Date().toISOString(),
      ...(durationSeconds !== null ? { duration_seconds: durationSeconds, measurement_source: 'sweep_expired' } : {}),
    })
    .eq('id', row.id)
    .in('status', ['active', 'authorized', 'connecting']);
}

/**
 * Closes one abandoned pronunciation.assess_text ai_provider_sessions row
 * and reconciles its budget reservation (see reconcileSessionReservation) —
 * commits real cost if a usage event was recorded, releases in full if
 * none was, never releases when cost isn't fully known yet. Idempotent: the
 * closing UPDATE is guarded by current status, so a row another path (or a
 * concurrent sweep tick) already closed is a safe no-op that never
 * double-reconciles.
 */
async function closeStaleAssessTextSession(
  supabase: ReturnType<typeof getSharedServiceClient>,
  row: StaleAssessTextSessionRow,
): Promise<void> {
  const { data: updated } = await supabase
    .from('ai_provider_sessions')
    .update({ status: 'expired', ended_at: new Date().toISOString() })
    .eq('id', row.id)
    .in('status', ['authorized', 'connecting', 'active'])
    .select('id')
    .maybeSingle();

  if (!updated) return; // another path (or a concurrent sweep tick) already closed it — no-op

  const reservationId = row.metadata && typeof row.metadata.gatewayBudgetReservationId === 'string'
    ? row.metadata.gatewayBudgetReservationId
    : undefined;
  if (!reservationId) return;

  try {
    const gatewayDeps = getProductionDeps();
    await reconcileSessionReservation(gatewayDeps, PRONUNCIATION_ASSESS_TEXT_FEATURE_KEY, reservationId, row.id);
  } catch (e) {
    safeLog('internal/listening/conversation-sweep', 'assess_text_budget_reconcile_failed', 200, { error: e instanceof Error ? e.message : String(e) });
  }
}

async function handleConversationSweep(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['GET'])) return;
  const supabase = getSharedServiceClient();
  const nowIso = new Date().toISOString();

  let expiredSessions = 0;
  let closedAuthorizations = 0;
  let expiredAssessTextSessions = 0;
  let releasedExpiredReservations = 0;

  try {
    // ── 1a. 'active' sessions whose heartbeat has gone stale ────────────────
    const heartbeatCutoff = new Date(Date.now() - REALTIME_HEARTBEAT_STALE_SECONDS * 1000).toISOString();
    const { data: staleActive } = await supabase
      .from('ai_provider_sessions')
      .select('id, provider_session_id, started_at')
      .eq('feature_key', WEBRTC_CONNECT_FEATURE_KEY)
      .eq('provider', 'openai')
      .eq('status', 'active')
      .lt('last_heartbeat_at', heartbeatCutoff);

    for (const row of (staleActive ?? []) as StaleProviderSessionRow[]) {
      await closeStaleProviderSession(supabase, row);
      expiredSessions++;
    }

    // ── 1b. 'authorized'/'connecting' sessions past their auth window ───────
    const { data: staleAuthorized } = await supabase
      .from('ai_provider_sessions')
      .select('id, provider_session_id, started_at')
      .eq('feature_key', WEBRTC_CONNECT_FEATURE_KEY)
      .eq('provider', 'openai')
      .in('status', ['authorized', 'connecting'])
      .not('authorization_expires_at', 'is', null)
      .lt('authorization_expires_at', nowIso);

    for (const row of (staleAuthorized ?? []) as StaleProviderSessionRow[]) {
      await closeStaleProviderSession(supabase, row);
      expiredSessions++;
    }

    // ── 2. conversation_session_authorizations abandoned past their grace ──
    // DB-side filter is a safe superset (authorized_max_seconds can never
    // exceed REALTIME_MAX_SESSION_SECONDS — see computeAuthorizedRecording
    // in api/conversation/[...slug].ts); the exact per-row deadline
    // (authorized_at + its own authorized_max_seconds + grace) is checked
    // in JS below before any row is actually closed.
    const csaOuterCutoff = new Date(Date.now() - (REALTIME_MAX_SESSION_SECONDS + AUTHORIZATION_SWEEP_GRACE_SECONDS) * 1000).toISOString();
    const { data: staleAuthRows } = await supabase
      .from('conversation_session_authorizations')
      .select('id, user_id, session_date, authorized_at, authorized_max_seconds, gateway_budget_reservation_id, gateway_session_id')
      .eq('status', 'authorized')
      .lt('authorized_at', csaOuterCutoff);

    for (const row of (staleAuthRows ?? []) as Array<{
      id: string; user_id: string; session_date: string; authorized_at: string; authorized_max_seconds: number;
      gateway_budget_reservation_id: string | null; gateway_session_id: string | null;
    }>) {
      const authorizedAtMs = new Date(row.authorized_at).getTime();
      const graceDeadlineMs = authorizedAtMs + row.authorized_max_seconds * 1000 + AUTHORIZATION_SWEEP_GRACE_SECONDS * 1000;
      if (Date.now() < graceDeadlineMs) continue; // DB filter was a safe superset — not actually past grace yet

      const durationSeconds = Math.floor(Math.max(0, Math.min((Date.now() - authorizedAtMs) / 1000, row.authorized_max_seconds)));
      const { data: updated } = await supabase
        .from('conversation_session_authorizations')
        .update({ status: 'completed', completed_at: new Date().toISOString(), duration_seconds: durationSeconds })
        .eq('id', row.id)
        .eq('status', 'authorized')
        .select('id')
        .maybeSingle();

      if (!updated) continue; // another path (or a concurrent sweep tick) already closed it — no-op
      closedAuthorizations++;

      if (durationSeconds > 0) {
        const { error: insertErr } = await supabase
          .from('conversation_sessions')
          .insert({ user_id: row.user_id, session_date: row.session_date, duration_sec: durationSeconds });
        if (insertErr) {
          safeLog('internal/listening/conversation-sweep', 'mirror_duration_failed', 200, { error: insertErr.message });
        }
      }

      // Reconcile the upfront conversation.realtime_usage budget reservation
      // (see api/_ai-gateway/reservation-reconciliation.ts) for a session
      // nobody was left to call /session-complete for — this is the "safe
      // expiration/finalization strategy" for an incomplete session: it
      // commits whatever real cost genuinely accrued (never guesses, never
      // silently returns budget for spend that already happened), the same
      // reconciliation /session-complete itself would have run.
      if (row.gateway_budget_reservation_id) {
        try {
          const gatewayDeps = getProductionDeps();
          if (row.gateway_session_id) {
            await reconcileSessionReservation(gatewayDeps, 'conversation.realtime_usage', row.gateway_budget_reservation_id, row.gateway_session_id);
          } else {
            await releaseSessionReservation(gatewayDeps, row.gateway_budget_reservation_id, 'no_gateway_session_to_reconcile_against');
          }
        } catch (e) {
          safeLog('internal/listening/conversation-sweep', 'budget_reconcile_failed', 200, { error: e instanceof Error ? e.message : String(e) });
        }
      }
    }

    // ── 3. pronunciation.assess_text abandoned ai_provider_sessions ────────
    // Pronunciation has no active-heartbeat/connecting phase (unlike
    // Conversation's WebRTC sessions) — a session only ever sits in
    // 'authorized' until /complete or /fail reports back, or the browser
    // simply vanishes.
    const { data: staleAssessText } = await supabase
      .from('ai_provider_sessions')
      .select('id, metadata')
      .eq('feature_key', PRONUNCIATION_ASSESS_TEXT_FEATURE_KEY)
      .eq('provider', 'azure')
      .in('status', ['authorized', 'connecting', 'active'])
      .not('authorization_expires_at', 'is', null)
      .lt('authorization_expires_at', nowIso);

    for (const row of (staleAssessText ?? []) as StaleAssessTextSessionRow[]) {
      await closeStaleAssessTextSession(supabase, row);
      expiredAssessTextSessions++;
    }

    // ── 4. Any other feature's reservation stuck 'pending' past its own
    // expiry — the generic "process died mid-request" case (see header
    // comment above). Best-effort, never affects this sweep's own response.
    try {
      const result = await releaseExpiredPendingReservations(getProductionDeps(), nowIso);
      releasedExpiredReservations = result.releasedCount;
    } catch (e) {
      safeLog('internal/listening/conversation-sweep', 'expired_reservation_sweep_failed', 200, { error: e instanceof Error ? e.message : String(e) });
    }

    safeLog('internal/listening/conversation-sweep', 'swept', 200, {
      expiredSessions, closedAuthorizations, expiredAssessTextSessions, releasedExpiredReservations,
    });
    return res.status(200).json({
      success: true, expiredSessions, closedAuthorizations, expiredAssessTextSessions, releasedExpiredReservations,
    });
  } catch (err) {
    safeLog('internal/listening/conversation-sweep', 'sweep_error', 500, { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ success: false, error: 'Sweep failed.', detail: String(err) });
  }
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

export default async function handler(req: any, res: any): Promise<void> {
  const slug = resolveSlug(req, '/api/internal/listening');

  // Reused function slot for /api/internal/product-config/* (see
  // vercel.json) — independent auth (PRODUCT_CONFIG_STATUS_SECRET, not
  // CRON_SECRET), handled entirely inside this branch. Nothing below is
  // reached for this slug, so the listening routes below are unaffected.
  if (slug.startsWith('product-config/')) {
    return handleProductConfigStatusRoute(req, res, slug.slice('product-config/'.length));
  }

  if (!checkCronAuth(req)) {
    safeLog('internal/listening', 'unauthorized', 401, {});
    return res.status(401).json({ error: 'Unauthorized' });
  }

  switch (slug) {
    case 'dispatch':
    case 'jobs/dispatch':      return handleJobsDispatch(req, res);
    case 'repair':             return handleRepair(req, res);
    case 'inventory/ensure':   return handleInventoryEnsure(req, res);
    case 'audit':              return handleAudit(req, res);
    case 'storage-audit':      return handleStorageAudit(req, res);
    case 'cleanup':            return handleCleanup(req, res);
    case 'supply':             return handleSupply(req, res);
    case 'conversation-sweep': return handleConversationSweep(req, res);
    default:
      return res.status(404).json({ error: 'Route not found', slug });
  }
}
