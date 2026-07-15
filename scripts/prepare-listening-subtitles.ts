#!/usr/bin/env tsx
/**
 * CLI: gera e valida as legendas de um episódio de listening.
 *
 * Usage:
 *   npm run listening:prepare-subtitles -- --episode-id UUID
 *   npm run listening:prepare-subtitles -- --episode-id UUID --dry-run
 *   npm run listening:prepare-subtitles -- --episode-id UUID --force
 *
 * Flags:
 *   --episode-id UUID   ID do episódio (obrigatório)
 *   --dry-run           Gera e valida sem persistir
 *   --force             Substitui legendas existentes (apenas para conteúdo não publicado)
 *   --min-confidence N  Confiança mínima do validador (padrão: 0.90)
 *   --verbose           Exibe detalhes adicionais (não em produção)
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import {
  prepareListeningSubtitles,
  createSubtitleAICallFn,
} from '../src/services/listening/prepare-listening-subtitles';

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
const minConfidenceArg = getArg('--min-confidence');
const minConfidence = minConfidenceArg ? parseFloat(minConfidenceArg) : undefined;

if (!episodeId) {
  console.error('ERROR: --episode-id is required.');
  console.error('Usage: npm run listening:prepare-subtitles -- --episode-id UUID [--dry-run] [--force]');
  process.exit(1);
}

// ── Env validation ────────────────────────────────────────────────────────────

const openaiKey = process.env.OPENAI_API_KEY;
if (!openaiKey) {
  console.error('ERROR: OPENAI_API_KEY environment variable is not set.');
  process.exit(1);
}

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!dryRun && (!supabaseUrl || !supabaseServiceKey)) {
  console.error('ERROR: VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set for non-dry-run mode.');
  process.exit(1);
}

// ── Run ───────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  console.error(JSON.stringify({
    script: 'prepare-listening-subtitles',
    episodeId,
    dryRun,
    forceRegeneration,
    t: Date.now(),
  }));

  const callAI = createSubtitleAICallFn(openaiKey!);
  const supabase = !dryRun && supabaseUrl && supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey)
    : undefined;

  const result = await prepareListeningSubtitles(
    { episodeId: episodeId!, dryRun, forceRegeneration, minConfidence },
    callAI,
    supabase,
  );

  const safeOutput = {
    status: result.status,
    episodeId: result.episodeId,
    blockCount: result.blockCount,
    englishCueCount: result.englishCueCount,
    portugueseCueCount: result.portugueseCueCount,
    translationPromptVersion: result.translationPromptVersion,
    validatorPromptVersion: result.validatorPromptVersion,
    dryRun,
  };

  console.error(JSON.stringify({
    script: 'prepare-listening-subtitles',
    event: 'complete',
    episodeId: result.episodeId,
    englishCueCount: result.englishCueCount,
    portugueseCueCount: result.portugueseCueCount,
    translationPromptVersion: result.translationPromptVersion,
    t: Date.now(),
  }));

  console.log(JSON.stringify(safeOutput, null, 2));

  if (verbose) {
    console.error('[verbose] Full result (development only):');
    console.error(JSON.stringify(result, null, 2));
  }
}

run().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string }).code ?? 'UNKNOWN';
  console.error(JSON.stringify({
    script: 'prepare-listening-subtitles',
    event: 'error',
    code,
    message: msg,
    t: Date.now(),
  }));
  process.exit(1);
});
