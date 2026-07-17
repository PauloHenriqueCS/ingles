#!/usr/bin/env tsx
/**
 * CLI: Reconcile every usage_daily bucket for a single UTC date.
 *
 * Server-only, paginated (never loads raw events into memory — only bucket
 * keys, a page at a time), idempotent — safe to re-run. A failure on one
 * bucket does not stop the rest. Not wired to a cron in this stage; run
 * manually or wire into a future scheduled job.
 *
 * Usage:
 *   npx tsx scripts/ai-gateway-reconcile-day.ts 2026-07-17
 */

import 'dotenv/config';
import { getProductionDeps, reconcileDailyBucketsForDate } from '../api/_ai-gateway/index';

const usageDate = process.argv[2];

if (!usageDate || !/^\d{4}-\d{2}-\d{2}$/.test(usageDate)) {
  console.error('Usage: npx tsx scripts/ai-gateway-reconcile-day.ts <YYYY-MM-DD>');
  process.exit(1);
}

if (!process.env.VITE_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  process.exit(1);
}

async function main() {
  const deps = getProductionDeps();
  const outcome = await reconcileDailyBucketsForDate(usageDate, {
    dailyRollupRepository: deps.dailyRollupRepository,
    logger: deps.logger,
  });

  console.log(`Date ${usageDate}: ${outcome.bucketsProcessed} bucket(s) rebuilt, ${outcome.bucketsFailed} failed.`);
  if (outcome.bucketsFailed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Reconciliation failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
