#!/usr/bin/env tsx
/**
 * CLI: sincroniza legendas com o áudio de um episódio de listening.
 *
 * Usage:
 *   npm run listening:synchronize -- --episode-id UUID
 *   npm run listening:synchronize -- --episode-id UUID --block 1
 *   npm run listening:synchronize -- --episode-id UUID --validate-only
 *   npm run listening:synchronize -- --episode-id UUID --force
 *   npm run listening:synchronize -- --episode-id UUID --inspect
 *
 * Flags:
 *   --episode-id UUID    ID do episódio (obrigatório)
 *   --block 1|2          Sincroniza apenas o bloco especificado
 *   --validate-only      Valida sem persistir
 *   --force              Regenera mesmo que já exista timing
 *   --inspect            Exibe manifest completo (desenvolvimento)
 *   --verbose            Exibe logs detalhados
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { synchronizeListeningEpisode } from '../src/services/listening/timing/synchronize-listening-episode';

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
const validateOnly = hasFlag('--validate-only');
const forceRegeneration = hasFlag('--force');
const inspect = hasFlag('--inspect');
const verbose = hasFlag('--verbose');

if (!episodeId) {
  console.error('ERROR: --episode-id is required.');
  console.error('Usage: npm run listening:synchronize -- --episode-id UUID [--block 1|2] [--validate-only] [--force] [--inspect]');
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

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('ERROR: VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  process.exit(1);
}

// ── Run ───────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.error(JSON.stringify({
    script: 'synchronize-listening-audio',
    episodeId,
    blockFilter: blockFilter ?? 'all',
    validateOnly,
    forceRegeneration,
    t: Date.now(),
  }));

  const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

  const result = await synchronizeListeningEpisode(
    { episodeId: episodeId!, forceRegeneration, blockFilter, validateOnly },
    supabase,
  );

  const safeOutput = {
    status: validateOnly ? 'Validation passed (nothing persisted)' : 'Synchronization completed',
    episodeId: result.episodeId,
    timingStatus: result.timingStatus,
    alignerVersion: result.alignerVersion,
    blocks: result.blocks.map(b => ({
      blockId: b.blockId,
      blockOrder: b.blockOrder,
      audioAssetId: b.audioAssetId,
      sentenceTimingCount: b.sentenceTimingCount,
      cueTimingCount: b.cueTimingCount,
      alignmentRate: b.alignmentRate.toFixed(4),
      averageConfidence: b.averageConfidence.toFixed(4),
      timingHash: b.timingHash,
      status: b.status,
    })),
    validateOnly,
  };

  console.error(JSON.stringify({
    script: 'synchronize-listening-audio',
    event: 'complete',
    episodeId: result.episodeId,
    timingStatus: result.timingStatus,
    blockCount: result.blocks.length,
    t: Date.now(),
  }));

  console.log(JSON.stringify(safeOutput, null, 2));

  if (verbose) {
    for (const b of result.blocks) {
      console.error(`[verbose] Block ${b.blockOrder}: ${b.sentenceTimingCount} sentence timings, ${b.cueTimingCount} cue timings, rate=${b.alignmentRate.toFixed(3)}, confidence=${b.averageConfidence.toFixed(3)}, hash=${b.timingHash}`);
    }
  }

  if (inspect && result.blocks.length > 0) {
    console.error('[inspect] Timing hash per block:');
    for (const b of result.blocks) {
      console.error(`  Block ${b.blockOrder}: ${b.timingHash}`);
    }
  }
}

run().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string }).code ?? 'UNKNOWN';
  console.error(JSON.stringify({
    script: 'synchronize-listening-audio',
    event: 'error',
    code,
    message: msg,
    t: Date.now(),
  }));
  process.exit(1);
});
