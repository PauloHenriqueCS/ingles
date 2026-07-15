/**
 * npm run listening:cleanup-staging -- --episode-id UUID
 *
 * Remove arquivos de staging de um episódio publicado.
 * Idempotente. Nunca remove arquivos definitivos.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
config();

import { cleanupPublishedListeningStaging } from '../src/services/listening/publication/cleanup-listening-staging';

function parseArgs(): { episodeId: string } {
  const args = process.argv.slice(2);
  let episodeId = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--episode-id' && args[i + 1]) {
      episodeId = args[i + 1];
      i++;
    }
  }
  return { episodeId };
}

async function main(): Promise<void> {
  const { episodeId } = parseArgs();

  if (!episodeId || !/^[0-9a-f-]{36}$/i.test(episodeId)) {
    console.error('Uso: npm run listening:cleanup-staging -- --episode-id UUID');
    process.exit(1);
  }

  console.log(`\nListening Staging Cleanup — Episode ${episodeId}`);
  console.log('─'.repeat(60));

  const result = await cleanupPublishedListeningStaging(episodeId);

  if (result.removedPaths.length > 0) {
    console.log('\nRemoved:');
    for (const p of result.removedPaths) console.log(`  ✓ ${p}`);
  }

  if (result.skippedPaths.length > 0) {
    console.log('\nSkipped:');
    for (const p of result.skippedPaths) console.log(`  - ${p}`);
  }

  if (result.errors.length > 0) {
    console.log('\nErrors:');
    for (const e of result.errors) console.log(`  ✗ ${e}`);
  }

  console.log(`\nDone. Removed: ${result.removedPaths.length}, Skipped: ${result.skippedPaths.length}, Errors: ${result.errors.length}`);
  console.log('');

  process.exit(result.errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Cleanup failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
