#!/usr/bin/env tsx
/**
 * CLI: Check listening inventory status across all CEFR levels.
 *
 * Usage:
 *   npx tsx scripts/listening-inventory-check.ts
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { getListeningInventoryStatus } from '../src/services/listening/inventory/get-listening-inventory-status';

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

  const levels = await getListeningInventoryStatus(supabase);

  const STATUS_ICON: Record<string, string> = {
    healthy:  '✓',
    low:      '~',
    critical: '!',
    empty:    'X',
  };

  console.log('\nListening Inventory Status\n' + '─'.repeat(72));
  console.log(
    'Level'.padEnd(8) +
    'Status'.padEnd(10) +
    'Published'.padEnd(12) +
    'In Pipeline'.padEnd(14) +
    'Failed'.padEnd(10) +
    'Missing'
  );
  console.log('─'.repeat(72));

  for (const s of levels) {
    const icon = STATUS_ICON[s.status] ?? '?';
    console.log(
      s.cefrLevel.padEnd(8) +
      `${icon} ${s.status}`.padEnd(10) +
      String(s.publishedAvailable).padEnd(12) +
      String(s.inPipeline).padEnd(14) +
      String(s.failed).padEnd(10) +
      String(s.missingCount)
    );
  }

  console.log('─'.repeat(72));

  const totalPublished = levels.reduce((n, s) => n + s.publishedAvailable, 0);
  const totalMissing   = levels.reduce((n, s) => n + s.missingCount, 0);
  const problemLevels  = levels.filter(s => s.status !== 'healthy');

  console.log(`\nTotal published: ${totalPublished}  |  Total missing: ${totalMissing}`);

  if (problemLevels.length === 0) {
    console.log('All levels are healthy.');
  } else {
    console.log(`Levels needing attention: ${problemLevels.map(s => s.cefrLevel).join(', ')}`);
  }
}

run().catch((err: unknown) => {
  console.error('ERROR:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
