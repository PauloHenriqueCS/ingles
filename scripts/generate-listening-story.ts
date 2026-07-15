#!/usr/bin/env tsx
/**
 * CLI: generate a listening story for a given CEFR level and optionally persist it.
 *
 * Usage:
 *   npx tsx scripts/generate-listening-story.ts --level A1
 *   npx tsx scripts/generate-listening-story.ts --level B2 --theme travel --dry-run
 *   npx tsx scripts/generate-listening-story.ts --level A2 --seed "two friends at a coffee shop"
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import {
  generateListeningStory,
  createDefaultAICallFn,
} from '../src/services/listening/generate-listening-story';
import type { CEFRLevel } from '../src/domain/curriculum/cefr';

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

const level = getArg('--level') as CEFRLevel | null;
const theme = getArg('--theme');
const seed = getArg('--seed');
const dryRun = hasFlag('--dry-run');

const VALID_LEVELS: CEFRLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

if (!level || !VALID_LEVELS.includes(level)) {
  console.error(`ERROR: --level is required. Valid values: ${VALID_LEVELS.join(', ')}`);
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
    script: 'generate-listening-story',
    level,
    theme: theme ?? null,
    seed: seed ?? null,
    dryRun,
    t: Date.now(),
  }));

  const callAI = createDefaultAICallFn(openaiKey!);
  const supabase = !dryRun && supabaseUrl && supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey)
    : undefined;

  const result = await generateListeningStory(
    { cefrLevel: level!, theme, seed, dryRun },
    callAI,
    supabase,
  );

  const { story, episodeId, idempotencyKey } = result;

  console.error(JSON.stringify({
    script: 'generate-listening-story',
    event: 'complete',
    episodeId: episodeId ?? '(dry-run)',
    idempotencyKey,
    title: story.title,
    block1Words: story.blocks[0].wordCount,
    block2Words: story.blocks[1].wordCount,
    block1Sentences: story.blocks[0].sentences.length,
    block2Sentences: story.blocks[1].sentences.length,
    t: Date.now(),
  }));

  if (dryRun) {
    console.log(JSON.stringify(story, null, 2));
  } else {
    console.log(JSON.stringify({ episodeId, idempotencyKey, title: story.title }, null, 2));
  }
}

run().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string }).code ?? 'UNKNOWN';
  console.error(JSON.stringify({ script: 'generate-listening-story', event: 'error', code, message: msg, t: Date.now() }));
  process.exit(1);
});
