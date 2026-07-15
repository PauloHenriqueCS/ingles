#!/usr/bin/env tsx
/**
 * CLI: Create a new listening episode pipeline for a given CEFR level.
 *
 * Usage:
 *   npx tsx scripts/listening-pipeline-create.ts --level A2
 *   npx tsx scripts/listening-pipeline-create.ts --level B1 --theme travel
 *   npx tsx scripts/listening-pipeline-create.ts --level C1 --seed "an architect and her deadline"
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { enqueueListeningEpisodePipeline } from '../src/services/listening/pipeline/enqueue-listening-episode-pipeline';
import type { CEFRLevel } from '../src/domain/curriculum/cefr';

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const level = getArg('--level') as CEFRLevel | null;
const theme = getArg('--theme');
const seed  = getArg('--seed');

const VALID_LEVELS: CEFRLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

if (!level || !VALID_LEVELS.includes(level)) {
  console.error(`ERROR: --level is required. Valid values: ${VALID_LEVELS.join(', ')}`);
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
    script: 'listening-pipeline-create',
    level,
    theme: theme ?? null,
    seed:  seed ?? null,
    t: Date.now(),
  }));

  const result = await enqueueListeningEpisodePipeline(supabase, {
    cefrLevel: level!,
    theme:     theme ?? null,
    seed:      seed ?? undefined,
    source:    'admin',
  });

  if (result.created) {
    console.log(JSON.stringify({
      status:         'created',
      jobId:          result.jobId,
      idempotencyKey: result.idempotencyKey,
      level,
      theme:          theme ?? null,
    }, null, 2));
  } else {
    console.log(JSON.stringify({
      status:         'already_exists',
      jobId:          result.jobId,
      idempotencyKey: result.idempotencyKey,
      message:        'Pipeline with the same idempotency key already exists. Use a different --seed to force a new one.',
    }, null, 2));
  }
}

run().catch((err: unknown) => {
  console.error('ERROR:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
