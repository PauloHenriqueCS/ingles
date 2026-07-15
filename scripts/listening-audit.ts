#!/usr/bin/env tsx
/**
 * CLI: Run listening inventory and storage audit (same logic as the daily cron).
 *
 * Usage:
 *   npx tsx scripts/listening-audit.ts
 *   npx tsx scripts/listening-audit.ts --storage
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { auditListeningInventory } from '../src/services/listening/inventory/audit-listening-inventory';
import { auditListeningStorageConsistency } from '../src/services/listening/publication/audit-listening-storage';

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const doStorage = args.includes('--storage');

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
    script:     'listening-audit',
    doStorage,
    t: Date.now(),
  }));

  // ── Inventory audit ───────────────────────────────────────────────────────
  console.log('\n=== Inventory Audit ===\n');
  const inventoryResult = await auditListeningInventory(supabase);

  if (inventoryResult.issues.length === 0) {
    console.log('No inventory issues found.');
  } else {
    for (const issue of inventoryResult.issues) {
      console.log(`  - ${issue}`);
    }
  }
  console.log(`\nAlerts created: ${inventoryResult.alertsCreated}`);
  console.log(`Total issues: ${inventoryResult.issues.length}`);

  // ── Storage audit (optional) ──────────────────────────────────────────────
  if (doStorage) {
    console.log('\n=== Storage Audit ===\n');
    const storageResult = await auditListeningStorageConsistency();

    if (storageResult.issues.length === 0) {
      console.log('No storage issues found.');
    } else {
      for (const issue of storageResult.issues.slice(0, 30)) {
        console.log(JSON.stringify(issue));
      }
      if (storageResult.issues.length > 30) {
        console.log(`  … and ${storageResult.issues.length - 30} more issues`);
      }
    }
    console.log(`\nTotal storage issues: ${storageResult.summary.totalIssues}`);
    console.log(JSON.stringify(storageResult.summary, null, 2));
  }
}

run().catch((err: unknown) => {
  console.error('ERROR:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
