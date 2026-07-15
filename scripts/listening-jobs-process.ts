#!/usr/bin/env tsx
/**
 * CLI: Process listening jobs locally (outside Vercel cron).
 *
 * Usage:
 *   npx tsx scripts/listening-jobs-process.ts
 *   npx tsx scripts/listening-jobs-process.ts --count 5
 *   npx tsx scripts/listening-jobs-process.ts --job-type GENERATE_LISTENING_STORY
 *   npx tsx scripts/listening-jobs-process.ts --count 10 --job-type SYNTHESIZE_LISTENING_BLOCK_AUDIO
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { processNextListeningJob } from '../src/services/listening/jobs/process-listening-job';
import { LISTENING_JOB_TYPES } from '../src/services/listening/jobs/listening-job-types';
import type { ListeningJobType } from '../src/services/listening/jobs/listening-job-types';

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const countArg   = getArg('--count');
const jobTypeArg = getArg('--job-type');
const maxJobs    = countArg ? parseInt(countArg, 10) : 1;

const ALL_JOB_TYPES = Object.values(LISTENING_JOB_TYPES) as ListeningJobType[];

const eligibleTypes: ListeningJobType[] = jobTypeArg
  ? [jobTypeArg as ListeningJobType]
  : ALL_JOB_TYPES;

// ── Env validation ────────────────────────────────────────────────────────────

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('ERROR: VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  process.exit(1);
}

// ── Run ───────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const supabase  = createClient(supabaseUrl!, supabaseKey!);
  const workerId  = `local-worker-${Date.now()}`;

  console.error(JSON.stringify({
    script:        'listening-jobs-process',
    maxJobs,
    eligibleTypes,
    workerId,
    t: Date.now(),
  }));

  let processed = 0;
  let succeeded = 0;
  let failed    = 0;

  for (let i = 0; i < maxJobs; i++) {
    const result = await processNextListeningJob(supabase, workerId, eligibleTypes);

    if (!result.processed) {
      console.log(`No eligible jobs found (processed ${processed} so far).`);
      break;
    }

    processed++;
    if (result.success) succeeded++;
    else failed++;

    console.log(JSON.stringify({
      jobId:      result.jobId,
      jobType:    result.jobType,
      success:    result.success,
      durationMs: result.durationMs,
    }));
  }

  console.log(`\nDone. Processed: ${processed}  Success: ${succeeded}  Failed: ${failed}`);
}

run().catch((err: unknown) => {
  console.error('ERROR:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
