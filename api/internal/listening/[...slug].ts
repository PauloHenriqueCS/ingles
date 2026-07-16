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
import { getJobsServiceClient } from '../../../src/services/listening/jobs/_supabase';
import { recoverStuckListeningJobs } from '../../../src/services/listening/jobs/recover-stuck-listening-jobs';
import { processNextListeningJob } from '../../../src/services/listening/jobs/process-listening-job';
import {
  TEXT_JOB_TYPES, AZURE_JOB_TYPES, SYNC_JOB_TYPES, PUBLISH_JOB_TYPES,
  JOB_CONCURRENCY, RETENTION_DAYS,
} from '../../../src/services/listening/jobs/listening-job-config';
import type { ListeningJobType } from '../../../src/services/listening/jobs/listening-job-types';
import { ensureListeningInventory } from '../../../src/services/listening/inventory/ensure-listening-inventory';
import { auditListeningInventory } from '../../../src/services/listening/inventory/audit-listening-inventory';
import { getListeningInventoryStatus } from '../../../src/services/listening/inventory/get-listening-inventory-status';
import { auditListeningStorageConsistency } from '../../../src/services/listening/publication/audit-listening-storage';
import { repairListeningPipeline } from '../../../src/services/listening/pipeline/repair-listening-pipeline';
import type { CEFRLevel } from '../../../src/domain/curriculum/cefr';

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
    const result = await recoverStuckListeningJobs(supabase);
    safeLog('internal/listening/repair', 'repair_completed', 200, { recovered: result.recoveredCount });
    return res.status(200).json({ recovered: result.recoveredCount, jobIds: result.jobIds });
  } catch (err) {
    safeLog('internal/listening/repair', 'repair_error', 500, { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: 'Repair error' });
  }
}

// ── GET /api/internal/listening/inventory/ensure ─────────────────────────────

async function handleInventoryEnsure(req: any, res: any): Promise<void> {
  if (!methodGuard(req, res, ['GET'])) return;
  try {
    const supabase = getJobsServiceClient();
    const result = await ensureListeningInventory(supabase, { source: 'inventory_cron' });
    safeLog('internal/listening/inventory/ensure', 'inventory_ensure_completed', 200, { created: result.created });
    return res.status(200).json({ pipelinesCreated: result.created, levels: result.levels });
  } catch (err) {
    safeLog('internal/listening/inventory/ensure', 'inventory_ensure_error', 500, { error: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: 'Inventory ensure error' });
  }
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
      if (level && !VALID_LEVELS.has(level)) {
        return res.status(400).json({ success: false, error: `Invalid level. Use: ${[...VALID_LEVELS].join(', ')}` });
      }
      try {
        const t0 = Date.now();
        const result = await ensureListeningInventory(supabase, { targetLevel: level as CEFRLevel | undefined, source: 'admin' });
        const durationMs = Date.now() - t0;
        safeLog('supply', 'generation_triggered', 200, { level: level ?? 'all', ...result, durationMs });
        return res.status(200).json({ success: true, action: 'generate', level: level ?? 'all', pipelinesCreated: result.created, levelsAffected: result.levels, durationMs });
      } catch (err) {
        safeLog('supply', 'generation_error', 500, { level: level ?? 'all', error: String(err) });
        return res.status(500).json({ success: false, error: 'Generation failed.', detail: String(err) });
      }
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

// ── Dispatcher ────────────────────────────────────────────────────────────────

export default async function handler(req: any, res: any): Promise<void> {
  if (!checkCronAuth(req)) {
    safeLog('internal/listening', 'unauthorized', 401, {});
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const slug = resolveSlug(req, '/api/internal/listening');

  switch (slug) {
    case 'jobs/dispatch':      return handleJobsDispatch(req, res);
    case 'repair':             return handleRepair(req, res);
    case 'inventory/ensure':   return handleInventoryEnsure(req, res);
    case 'audit':              return handleAudit(req, res);
    case 'storage-audit':      return handleStorageAudit(req, res);
    case 'cleanup':            return handleCleanup(req, res);
    case 'supply':             return handleSupply(req, res);
    default:
      return res.status(404).json({ error: 'Route not found', slug });
  }
}
