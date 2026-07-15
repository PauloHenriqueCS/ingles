#!/usr/bin/env tsx
/**
 * CLI: Cancel a pending or retry job.
 *
 * Usage:
 *   npx tsx scripts/listening-jobs-cancel.ts --job-id UUID
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
  console.error('Usage: npx tsx scripts/listening-jobs-cancel.ts --job-id UUID');
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
    .select('id, job_type, status, episode_id')
    .eq('id', jobId)
    .maybeSingle();

  if (fetchError || !job) {
    console.error(`ERROR: Job ${jobId} not found.`);
    process.exit(1);
  }

  if (!['pending', 'retry'].includes(job.status)) {
    console.error(
      `ERROR: Job ${jobId} has status '${job.status}'. ` +
      `Only pending/retry jobs can be cancelled (not processing/completed/failed).`
    );
    process.exit(1);
  }

  console.log(`Cancelling ${job.job_type} job ${job.id} (status=${job.status})…`);

  const { error: updateError } = await supabase
    .from('listening_jobs')
    .update({
      status:      'cancelled',
      finished_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .in('status', ['pending', 'retry']); // guard against race with a worker claiming it

  if (updateError) {
    console.error('ERROR:', updateError.message);
    process.exit(1);
  }

  console.log(`Job ${jobId} cancelled.`);
}

run().catch((err: unknown) => {
  console.error('ERROR:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
