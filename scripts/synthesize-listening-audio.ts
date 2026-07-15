#!/usr/bin/env tsx
/**
 * CLI: sintetiza áudio MP3 para os blocos de um episódio de listening via Azure Speech SDK.
 *
 * Usage:
 *   npm run listening:synthesize-audio -- --episode-id UUID
 *   npm run listening:synthesize-audio -- --episode-id UUID --block 1
 *   npm run listening:synthesize-audio -- --episode-id UUID --force
 *   npm run listening:synthesize-audio -- --episode-id UUID --validate-only
 *
 * Flags:
 *   --episode-id UUID    ID do episódio (obrigatório)
 *   --block 1|2          Sintetiza apenas o bloco especificado
 *   --force              Regenera mesmo que o áudio já exista
 *   --validate-only      Valida config e bookmarks sem chamar o Azure
 *   --verbose            Exibe detalhes adicionais (não em produção)
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { synthesizeListeningEpisode } from '../src/services/listening/audio/synthesize-listening-episode';

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

const episodeId = getArg('--episode-id');
const blockArg = getArg('--block');
const forceRegeneration = hasFlag('--force');
const validateOnly = hasFlag('--validate-only');
const verbose = hasFlag('--verbose');

if (!episodeId) {
  console.error('ERROR: --episode-id is required.');
  console.error('Usage: npm run listening:synthesize-audio -- --episode-id UUID [--block 1|2] [--force] [--validate-only]');
  process.exit(1);
}

let blockFilter: 1 | 2 | undefined;
if (blockArg !== null) {
  const parsed = parseInt(blockArg, 10);
  if (parsed !== 1 && parsed !== 2) {
    console.error('ERROR: --block must be 1 or 2.');
    process.exit(1);
  }
  blockFilter = parsed as 1 | 2;
}

// ── Env validation ────────────────────────────────────────────────────────────

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const azureKey = process.env.AZURE_SPEECH_KEY;
const azureRegion = process.env.AZURE_SPEECH_REGION;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('ERROR: VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  process.exit(1);
}

if (!validateOnly && (!azureKey || !azureRegion)) {
  console.error('ERROR: AZURE_SPEECH_KEY and AZURE_SPEECH_REGION must be set for audio synthesis.');
  process.exit(1);
}

// ── Run ───────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.error(JSON.stringify({
    script: 'synthesize-listening-audio',
    episodeId,
    blockFilter: blockFilter ?? 'all',
    forceRegeneration,
    validateOnly,
    t: Date.now(),
  }));

  const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

  const result = await synthesizeListeningEpisode(
    { episodeId: episodeId!, forceRegeneration, blockFilter, validateOnly },
    supabase,
    azureKey,
    azureRegion,
  );

  const safeOutput = {
    status: validateOnly ? 'Validation passed (no audio synthesized)' : 'Audio synthesized successfully',
    episodeId: result.episodeId,
    audioStatus: result.audioStatus,
    actualDurationSeconds: result.actualDurationSeconds,
    blocks: result.blocks.map(b => ({
      blockId: b.blockId,
      blockOrder: b.blockOrder,
      audioAssetId: b.audioAssetId,
      audioPath: b.audioPath,
      durationMs: b.durationMs,
      fileSizeBytes: b.fileSizeBytes,
      bookmarkCount: b.bookmarkCount,
      wordTimingCount: b.wordTimingCount,
      wordTimingStatus: b.wordTimingStatus,
      status: b.status,
    })),
    validateOnly,
  };

  console.error(JSON.stringify({
    script: 'synthesize-listening-audio',
    event: 'complete',
    episodeId: result.episodeId,
    audioStatus: result.audioStatus,
    blockCount: result.blocks.length,
    actualDurationSeconds: result.actualDurationSeconds,
    t: Date.now(),
  }));

  console.log(JSON.stringify(safeOutput, null, 2));

  if (verbose && result.blocks.length > 0) {
    for (const b of result.blocks) {
      console.error(`[verbose] Block ${b.blockOrder}: ${b.durationMs}ms, ${b.fileSizeBytes} bytes, ${b.bookmarkCount} bookmarks, ${b.wordTimingCount} words`);
    }
  }
}

run().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string }).code ?? 'UNKNOWN';
  console.error(JSON.stringify({
    script: 'synthesize-listening-audio',
    event: 'error',
    code,
    message: msg,
    t: Date.now(),
  }));
  process.exit(1);
});
