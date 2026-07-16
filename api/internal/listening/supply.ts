/**
 * Manual supply control for the Listening module.
 *
 * GET  /api/internal/listening/supply              → inventory status per level
 * POST /api/internal/listening/supply              → run an action:
 *   { action: 'generate' }                         → ensure inventory for all levels
 *   { action: 'generate', level: 'B1' }            → ensure inventory for one level
 *   { action: 'repair',   episodeId: '<uuid>' }    → repair a stuck/failed episode
 *
 * All requests require Authorization: Bearer {CRON_SECRET}.
 */

import { checkCronAuth } from '../../_auth';
import { safeLog } from '../../_helpers';
import { getListeningInventoryStatus } from '../../../src/services/listening/inventory/get-listening-inventory-status';
import { ensureListeningInventory } from '../../../src/services/listening/inventory/ensure-listening-inventory';
import { repairListeningPipeline } from '../../../src/services/listening/pipeline/repair-listening-pipeline';
import { getJobsServiceClient } from '../../../src/services/listening/jobs/_supabase';
import type { CEFRLevel } from '../../../src/domain/curriculum/cefr';

const VALID_LEVELS = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);

export default async function handler(req: any, res: any) {
  if (!checkCronAuth(req)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const supabase = getJobsServiceClient();

  // ── GET: inventory status ─────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const statuses = await getListeningInventoryStatus(supabase);
      const inventory = statuses.map(s => ({
        level:      s.cefrLevel,
        published:  s.publishedAvailable,
        inPipeline: s.inPipeline,
        failed:     s.failed,
        missing:    s.missingCount,
        status:     s.status,
      }));
      safeLog('supply', 'status_requested', 200, { levelsChecked: inventory.length });
      return res.status(200).json({ success: true, inventory });
    } catch (err) {
      safeLog('supply', 'status_error', 500, { error: String(err) });
      return res.status(500).json({ success: false, error: 'Failed to fetch inventory status.' });
    }
  }

  // ── POST: actions ─────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    let body: { action?: string; level?: string; episodeId?: string } = {};
    try {
      const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
      body = JSON.parse(raw);
    } catch {
      return res.status(400).json({ success: false, error: 'Invalid JSON body.' });
    }

    const { action, level, episodeId } = body;

    // ── action: generate ────────────────────────────────────────────────────
    if (action === 'generate') {
      if (level && !VALID_LEVELS.has(level)) {
        return res.status(400).json({ success: false, error: `Invalid level. Use: ${[...VALID_LEVELS].join(', ')}` });
      }
      try {
        const t0 = Date.now();
        const result = await ensureListeningInventory(supabase, {
          targetLevel: level as CEFRLevel | undefined,
          source:      'admin',
        });
        const durationMs = Date.now() - t0;
        safeLog('supply', 'generation_triggered', 200, { level: level ?? 'all', ...result, durationMs });
        return res.status(200).json({
          success:           true,
          action:            'generate',
          level:             level ?? 'all',
          pipelinesCreated:  result.created,
          levelsAffected:    result.levels,
          durationMs,
        });
      } catch (err) {
        safeLog('supply', 'generation_error', 500, { level: level ?? 'all', error: String(err) });
        return res.status(500).json({ success: false, error: 'Generation failed.', detail: String(err) });
      }
    }

    // ── action: repair ──────────────────────────────────────────────────────
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
      success: false,
      error:   "Invalid action. Use: 'generate' or 'repair'.",
      usage:   {
        generate_all:   'POST { "action": "generate" }',
        generate_level: 'POST { "action": "generate", "level": "B1" }',
        repair_episode: 'POST { "action": "repair",   "episodeId": "<uuid>" }',
      },
    });
  }

  return res.status(405).json({ success: false, error: 'Method not allowed. Use GET or POST.' });
}
