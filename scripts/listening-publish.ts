/**
 * npm run listening:publish -- --episode-id UUID [--validate-only]
 *
 * Valida e publica um episódio de Listening.
 * Nunca imprime: signed URLs, service role key, tokens, respostas corretas.
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
config();

import { publishListeningEpisode } from '../src/services/listening/publication/publish-listening-episode';
import { validateListeningEpisodeForPublication } from '../src/services/listening/publication/validate-listening-publication';

function parseArgs(): { episodeId: string; validateOnly: boolean } {
  const args = process.argv.slice(2);
  let episodeId = '';
  let validateOnly = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--episode-id' && args[i + 1]) {
      episodeId = args[i + 1];
      i++;
    }
    if (args[i] === '--validate-only') {
      validateOnly = true;
    }
  }

  return { episodeId, validateOnly };
}

async function main(): Promise<void> {
  const { episodeId, validateOnly } = parseArgs();

  if (!episodeId || !/^[0-9a-f-]{36}$/i.test(episodeId)) {
    console.error('Uso: npm run listening:publish -- --episode-id UUID [--validate-only]');
    process.exit(1);
  }

  console.log(`\nListening Publication — Episode ${episodeId}`);
  console.log('─'.repeat(60));

  // ── Validação ─────────────────────────────────────────────────────────────

  console.log('\nValidating episode...');
  const validation = await validateListeningEpisodeForPublication(episodeId);

  console.log('\nValidation checks:');
  for (const [check, passed] of Object.entries(validation.checks)) {
    console.log(`  ${passed ? '✓' : '✗'} ${check}`);
  }

  if (validation.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const w of validation.warnings) {
      console.log(`  ⚠ [${w.code}] ${w.message}`);
    }
  }

  if (!validation.valid) {
    console.log('\nValidation FAILED:');
    for (const e of validation.errors) {
      console.log(`  ✗ [${e.code}] ${e.message}${e.blockId ? ` (block: ${e.blockId})` : ''}`);
    }
    process.exit(1);
  }

  console.log('\nValidation PASSED.');

  if (validateOnly) {
    console.log('\n--validate-only: skipping publication.\n');
    process.exit(0);
  }

  // ── Publicação ────────────────────────────────────────────────────────────

  console.log('\nPublishing...');
  const result = await publishListeningEpisode({
    episodeId,
    publicationSource: 'script',
  });

  console.log('\n' + '═'.repeat(60));
  console.log('Listening episode published successfully');
  console.log('═'.repeat(60));
  console.log(`Episode ID          : ${result.episodeId}`);
  console.log(`Publication version : ${result.publicationVersion}`);
  console.log(`Published at        : ${result.publishedAt}`);
  console.log(`Publication status  : ${result.publicationStatus}`);

  for (const block of result.blocks) {
    console.log(`\nBlock ${block.blockOrder}:`);
    console.log(`  Final path  : ${block.finalAudioPath}`);
    console.log(`  Duration    : ${block.durationMs} ms`);
    console.log(`  Audio hash  : ${block.audioHash}`);
  }

  console.log('');
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('Publication failed:', message);
  process.exit(1);
});
