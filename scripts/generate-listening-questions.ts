#!/usr/bin/env tsx
/**
 * CLI: gera e valida as perguntas de compreensão para um episódio de listening.
 *
 * Usage:
 *   npm run listening:generate-questions -- --episode-id UUID
 *   npm run listening:generate-questions -- --episode-id UUID --dry-run
 *   npm run listening:generate-questions -- --episode-id UUID --force
 *
 * Flags:
 *   --episode-id UUID   ID do episódio (obrigatório)
 *   --dry-run           Gera e valida sem persistir
 *   --force             Substitui perguntas existentes (apenas para conteúdo não publicado)
 *   --min-confidence N  Confiança mínima do validador (padrão: 0.85)
 *   --verbose           Exibe detalhes adicionais (não em produção)
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import {
  generateListeningQuestions,
  createQuestionAICallFn,
} from '../src/services/listening/generate-listening-questions';

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
  console.error('Usage: npm run listening:generate-questions -- --episode-id UUID [--dry-run] [--force]');
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
    script: 'generate-listening-questions',
    episodeId,
    dryRun,
    forceRegeneration,
    t: Date.now(),
  }));

  const callAI = createQuestionAICallFn(openaiKey!);
  const supabase = !dryRun && supabaseUrl && supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey)
    : undefined;

  const result = await generateListeningQuestions(
    { episodeId: episodeId!, dryRun, forceRegeneration, minConfidence },
    callAI,
    supabase,
  );

  // Saída segura: sem respostas corretas, chaves de API ou conteúdo sensível
  const safeOutput = {
    status: 'Questions generated successfully',
    episodeId: result.episodeId,
    questionCount: result.questionCount,
    generatorPromptVersion: result.generatorPromptVersion,
    validatorPromptVersion: result.validatorPromptVersion,
    questions: result.questions.map(q => ({
      questionOrder: q.questionOrder,
      questionType: q.questionType,
      difficulty: q.difficulty,
      validationConfidence: q.validationConfidence,
    })),
    dryRun,
  };

  console.error(JSON.stringify({
    script: 'generate-listening-questions',
    event: 'complete',
    episodeId: result.episodeId,
    question1Type: result.questions[0]?.questionType,
    question1Confidence: result.questions[0]?.validationConfidence,
    question2Type: result.questions[1]?.questionType,
    question2Confidence: result.questions[1]?.validationConfidence,
    generatorPromptVersion: result.generatorPromptVersion,
    validatorPromptVersion: result.validatorPromptVersion,
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
    script: 'generate-listening-questions',
    event: 'error',
    code,
    message: msg,
    t: Date.now(),
  }));
  process.exit(1);
});
