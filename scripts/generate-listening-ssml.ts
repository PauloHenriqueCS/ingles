#!/usr/bin/env tsx
/**
 * CLI: gera SSML determinístico para os blocos de um episódio de listening.
 *
 * Usage:
 *   npm run listening:generate-ssml -- --episode-id UUID
 *   npm run listening:generate-ssml -- --episode-id UUID --dry-run
 *   npm run listening:generate-ssml -- --episode-id UUID --force
 *
 * Flags:
 *   --episode-id UUID   ID do episódio (obrigatório)
 *   --dry-run           Gera e valida sem persistir
 *   --force             Substitui SSML existente (apenas para conteúdo não publicado)
 *   --verbose           Exibe detalhes adicionais (não em produção)
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { generateListeningSsml } from '../src/services/listening/generate-listening-ssml';

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
const dryRun = hasFlag('--dry-run');
const forceRegeneration = hasFlag('--force');
const verbose = hasFlag('--verbose');

if (!episodeId) {
  console.error('ERROR: --episode-id is required.');
  console.error('Usage: npm run listening:generate-ssml -- --episode-id UUID [--dry-run] [--force]');
  process.exit(1);
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
    script: 'generate-listening-ssml',
    episodeId,
    dryRun,
    forceRegeneration,
    t: Date.now(),
  }));

  const supabase = createClient(supabaseUrl!, supabaseServiceKey!);

  const result = await generateListeningSsml(
    { episodeId: episodeId!, dryRun, forceRegeneration },
    supabase,
  );

  const safeOutput = {
    status: 'SSML generated successfully',
    episodeId: result.episodeId,
    voiceName: result.voiceName,
    locale: result.locale,
    generatorVersion: result.generatorVersion,
    blocks: result.blocks.map(b => ({
      blockId: b.blockId,
      blockOrder: b.blockOrder,
      sentenceCount: b.sentenceCount,
      bookmarkCount: b.bookmarkCount,
      ssmlVersion: b.ssmlVersion,
      contentHash: b.contentHash,
      ssmlLengthChars: b.ssml.length,
    })),
    dryRun,
  };

  console.error(JSON.stringify({
    script: 'generate-listening-ssml',
    event: 'complete',
    episodeId: result.episodeId,
    block1SentenceCount: result.blocks[0]?.sentenceCount,
    block2SentenceCount: result.blocks[1]?.sentenceCount,
    generatorVersion: result.generatorVersion,
    t: Date.now(),
  }));

  console.log(JSON.stringify(safeOutput, null, 2));

  if (verbose) {
    console.error('[verbose] Full SSML block 1:');
    console.error(result.blocks[0]?.ssml);
    console.error('[verbose] Full SSML block 2:');
    console.error(result.blocks[1]?.ssml);
  }
}

run().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string }).code ?? 'UNKNOWN';
  console.error(JSON.stringify({
    script: 'generate-listening-ssml',
    event: 'error',
    code,
    message: msg,
    t: Date.now(),
  }));
  process.exit(1);
});
