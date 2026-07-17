/**
 * SERVER-ONLY — never import from src/ or any client-side code.
 *
 * Explicit, gateway-driven daily aggregation. No generic trigger on the raw
 * tables — the gateway calls this after metrics and cost are persisted, so
 * behavior stays observable and easy to roll back.
 *
 *   rebuildDailyBucketForEvent — the live-path entrypoint: one event id in,
 *                                its whole bucket rebuilt atomically (SQL side).
 *
 *   reconcileDailyBucketsForDate — bounded, paginated backfill/repair for a
 *                                  single UTC day. Loads only bucket keys
 *                                  (never raw events) into memory, a page at
 *                                  a time. Server-only, id/date-only inputs —
 *                                  never a client-supplied price or count.
 */

import { sanitizeError } from './sanitize';
import type { DailyRollupRepositoryInterface } from './daily-rollup-repository';

export interface DailyRollupDeps {
  dailyRollupRepository: DailyRollupRepositoryInterface;
  logger: (event: string, data?: Record<string, unknown>) => void;
}

/**
 * Rebuilds the single daily bucket a usage event belongs to. Idempotent —
 * the underlying RPC always fully recomputes from raw data, so calling this
 * again for the same event (or a sibling event in the same bucket) never
 * duplicates counts. Returns the usage_daily row id, or null if the event
 * itself no longer exists.
 */
export async function rebuildDailyBucketForEvent(
  eventId: string,
  deps: DailyRollupDeps,
): Promise<string | null> {
  return deps.dailyRollupRepository.rebuildBucketForEvent(eventId);
}

export interface ReconcileDateOutcome {
  bucketsProcessed: number;
  bucketsFailed: number;
  lastBucketKey: string | null;
}

/**
 * Reconciles every bucket present for a single UTC date, paginated. A
 * failure on one bucket is logged and does not stop the remaining buckets —
 * this is a repair operation, not a critical-path call.
 */
export async function reconcileDailyBucketsForDate(
  usageDate: string,
  deps: DailyRollupDeps,
  pageSize = 100,
): Promise<ReconcileDateOutcome> {
  let after: string | null = null;
  let processed = 0;
  let failed = 0;

  for (;;) {
    const page = await deps.dailyRollupRepository.listBucketsForDate(usageDate, pageSize, after);
    if (page.length === 0) break;

    for (const bucket of page) {
      try {
        await deps.dailyRollupRepository.rebuildBucket(bucket);
        processed++;
      } catch (err) {
        failed++;
        deps.logger('gateway.dailyRollup.bucketFailed', {
          bucketKey: bucket.bucketKey,
          ...sanitizeError(err),
        });
      }
      after = bucket.bucketKey;
    }

    if (page.length < pageSize) break;
  }

  return { bucketsProcessed: processed, bucketsFailed: failed, lastBucketKey: after };
}
