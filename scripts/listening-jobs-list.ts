#!/usr/bin/env tsx
/**
 * CLI: List listening jobs in the queue.
 *
 * Usage:
 *   npx tsx scripts/listening-jobs-list.ts
 *   npx tsx scripts/listening-jobs-list.ts --status pending
 *   npx tsx scripts/listening-jobs-list.ts --status dead_letter --limit 20
 *   npx tsx scripts/listening-jobs-list.ts --episode-id UUID
 *   npx tsx scripts/listening-jobs-list.ts --job-type GENERATE_LISTENING_STORY
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const statusFilter    = getArg('--status');
const episodeIdFilter = getArg('--episode-id');
const jobTypeFilter   = getArg('--job-type');
const limitArg        = getArg('--limit');
const limit           = limitArg ? parseInt(limitArg, 10) : 50;

// ── Env validation ────────────────────────────────────────────────────────────

const supabaseUrl      = process.env.VITE_SUPABASE_URL;
const supabaseKey      = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('ERROR: VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  process.exit(1);
}

// ── Run ───────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const supabase = createClient(supabaseUrl!, supabaseKey!);

  const base = supabase
    .from('listening_jobs')
    .select('id, job_type, status, priority, episode_id, cefr_level, attempts, max_attempts, error_code, next_attempt_at, created_at, finished_at');

  const withStatus    = statusFilter    ? base.eq('status', statusFilter)       : base;
  const withEpisode   = episodeIdFilter ? withStatus.eq('episode_id', episodeIdFilter) : withStatus;
  const withJobType   = jobTypeFilter   ? withEpisode.eq('job_type', jobTypeFilter)    : withEpisode;

  const { data, error } = await withJobType
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('ERROR:', error.message);
    process.exit(1);
  }

  const jobs = data ?? [];

  if (jobs.length === 0) {
    console.log('No jobs found.');
    return;
  }

  const counts: Record<string, number> = {};
  for (const job of jobs) {
    counts[job.status] = (counts[job.status] ?? 0) + 1;
  }

  console.log(`\nFound ${jobs.length} job(s):`);
  console.log('Status counts:', counts);
  console.log('');

  for (const job of jobs) {
    const parts = [
      job.id.slice(0, 8),
      job.job_type.padEnd(38),
      job.status.padEnd(12),
      `attempt ${job.attempts}/${job.max_attempts}`,
    ];
    if (job.episode_id) parts.push(`ep:${job.episode_id.slice(0, 8)}`);
    if (job.cefr_level) parts.push(job.cefr_level);
    if (job.error_code) parts.push(`err:${job.error_code}`);
    console.log(parts.join('  '));
  }
}

run().catch((err: unknown) => {
  console.error('ERROR:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
