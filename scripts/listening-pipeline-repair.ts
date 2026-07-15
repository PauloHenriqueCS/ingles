#!/usr/bin/env tsx
/**
 * CLI: Repair a stuck episode pipeline by creating the appropriate missing job.
 *
 * Usage:
 *   npx tsx scripts/listening-pipeline-repair.ts --episode-id UUID
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { repairListeningPipeline } from '../src/services/listening/pipeline/repair-listening-pipeline';

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const episodeId = getArg('--episode-id');

if (!episodeId) {
  console.error('ERROR: --episode-id is required.');
  console.error('Usage: npx tsx scripts/listening-pipeline-repair.ts --episode-id UUID');
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

  console.error(JSON.stringify({
    script:    'listening-pipeline-repair',
    episodeId,
    t: Date.now(),
  }));

  const result = await repairListeningPipeline(supabase, episodeId!);

  console.log(JSON.stringify(result, null, 2));

  if (result.repaired) {
    console.log(`\nPipeline repair triggered: ${result.action}`);
  } else {
    console.log(`\nNo repair needed or episode is immutable: ${result.action}`);
  }
}

run().catch((err: unknown) => {
  console.error('ERROR:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
