#!/usr/bin/env tsx
/**
 * CLI: Reset a failed or dead_letter job back to pending for re-processing.
 *
 * Usage:
 *   npx tsx scripts/listening-jobs-retry.ts --job-id UUID
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const jobId = getArg('--job-id');

if (!jobId) {
  console.error('ERROR: --job-id is required.');
  console.error('Usage: npx tsx scripts/listening-jobs-retry.ts --job-id UUID');
  process.exit(1);
}

// ── Env validation ────────────────────────────────────────────────────────────

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('ERROR: VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  process.exit(1);
}

// ── Run ───────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const supabase = createClient(supabaseUrl!, supabaseKey!);

  const { data: job, error: fetchError } = await supabase
    .from('listening_jobs')
    .select('id, job_type, status, attempts, max_attempts, error_code')
    .eq('id', jobId)
    .maybeSingle();

  if (fetchError || !job) {
    console.error(`ERROR: Job ${jobId} not found.`);
    process.exit(1);
  }

  if (!['failed', 'dead_letter'].includes(job.status)) {
    console.error(`ERROR: Job ${jobId} has status '${job.status}'. Only failed/dead_letter jobs can be retried.`);
    process.exit(1);
  }

  console.log(`Retrying ${job.job_type} job ${job.id} (was ${job.status}, attempts=${job.attempts}/${job.max_attempts})…`);

  const { error: updateError } = await supabase
    .from('listening_jobs')
    .update({
      status:          'pending',
      attempts:        0,
      error_code:      null,
      error_message:   null,
      locked_by:       null,
      locked_at:       null,
      lock_expires_at: null,
      next_attempt_at: new Date().toISOString(),
    })
    .eq('id', jobId);

  if (updateError) {
    console.error('ERROR:', updateError.message);
    process.exit(1);
  }

  console.log(`Job ${jobId} reset to pending.`);
}

run().catch((err: unknown) => {
  console.error('ERROR:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
