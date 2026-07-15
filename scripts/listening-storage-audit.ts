/**
 * npm run listening:storage-audit
 *
 * Audita consistência entre banco e Storage.
 * Não apaga nenhum arquivo. Apenas gera relatório.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
config();

import { auditListeningStorageConsistency } from '../src/services/listening/publication/audit-listening-storage';

async function main(): Promise<void> {
  console.log('\nListening Storage Audit');
  console.log('─'.repeat(60));
  console.log(`Started at: ${new Date().toISOString()}`);

  const result = await auditListeningStorageConsistency();

  console.log('\nSummary:');
  console.log(`  Total issues              : ${result.summary.totalIssues}`);
  console.log(`  Records without files     : ${result.summary.recordsWithoutFiles}`);
  console.log(`  Files without records     : ${result.summary.filesWithoutRecords}`);
  console.log(`  Stale staging paths       : ${result.summary.staleStagingPaths}`);
  console.log(`  Hash/size mismatches      : ${result.summary.hashMismatches}`);
  console.log(`  Empty files               : ${result.summary.emptyFiles}`);

  if (result.issues.length === 0) {
    console.log('\n✓ No issues found.');
  } else {
    console.log('\nIssues:');
    for (const issue of result.issues) {
      const loc = issue.path ? ` → ${issue.path}` : '';
      const ep = issue.episodeId ? ` [ep: ${issue.episodeId.slice(0, 8)}...]` : '';
      console.log(`  [${issue.type}]${ep}${loc}`);
      console.log(`    ${issue.details}`);
    }
  }

  console.log(`\nAudit completed at: ${result.auditedAt}`);
  console.log('');

  process.exit(result.summary.totalIssues > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Audit failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
