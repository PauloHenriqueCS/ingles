#!/usr/bin/env tsx
/**
 * CLI: Trigger listening inventory ensure (same logic as the daily cron).
 *
 * Usage:
 *   npx tsx scripts/listening-inventory-ensure.ts
 *   npx tsx scripts/listening-inventory-ensure.ts --level A2
 *   npx tsx scripts/listening-inventory-ensure.ts --dry-run
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { ensureListeningInventory } from '../src/services/listening/inventory/ensure-listening-inventory';
import { getListeningInventoryStatus } from '../src/services/listening/inventory/get-listening-inventory-status';
import type { CEFRLevel } from '../src/domain/curriculum/cefr';

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

const levelArg = getArg('--level') as CEFRLevel | null;
const dryRun   = hasFlag('--dry-run');

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

  if (dryRun) {
    // Dry run: just show current status and what would be created
    const levels = await getListeningInventoryStatus(supabase);
    const needsGeneration = levels.filter(s =>
      s.missingCount > 0 && (!levelArg || s.cefrLevel === levelArg)
    );

    if (needsGeneration.length === 0) {
      console.log('Inventory is healthy — no pipelines would be created.');
    } else {
      console.log('Would create pipelines for:');
      for (const s of needsGeneration) {
        console.log(`  ${s.cefrLevel}: ${s.missingCount} pipeline(s) (published=${s.publishedAvailable}, inPipeline=${s.inPipeline})`);
      }
      const total = needsGeneration.reduce((n, s) => n + s.missingCount, 0);
      console.log(`\nTotal: ${total} pipeline(s) would be created.`);
    }
    return;
  }

  console.error(JSON.stringify({
    script: 'listening-inventory-ensure',
    level:  levelArg ?? 'all',
    t: Date.now(),
  }));

  const result = await ensureListeningInventory(supabase, {
    targetLevel: levelArg ?? undefined,
    source:      'admin',
  });

  console.log(JSON.stringify(result, null, 2));

  if (result.created === 0) {
    console.log('\nInventory is healthy — no new pipelines created.');
  } else {
    console.log(`\nCreated ${result.created} pipeline(s) for level(s): ${result.levels.join(', ')}`);
  }
}

run().catch((err: unknown) => {
  console.error('ERROR:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
