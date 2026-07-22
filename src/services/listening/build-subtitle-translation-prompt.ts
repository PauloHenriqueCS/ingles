import type { CEFRLevel } from '../../domain/curriculum/cefr';
import type { EnglishCueDraft } from './listening-subtitle-schema';

export const TRANSLATION_PROMPT_VERSION = 'listening-subtitle-translation-v1';
export const VALIDATOR_PROMPT_VERSION = 'listening-subtitle-translation-validator-v2';

// ─── System prompts ───────────────────────────────────────────────────────────

export const TRANSLATION_SYSTEM_PROMPT = `You are a professional subtitle translator specialising in Brazilian Portuguese for English language learning applications.

Your task is to translate English subtitle cues into natural Brazilian Portuguese (pt-BR), maintaining perfect alignment with the source cues by cue_key.

ABSOLUTE RULES:
- Return ONLY valid JSON. No markdown. No explanation outside JSON. First character must be "{".
- Translate EVERY cue provided. Do not skip, remove, or add any cue.
- Preserve the exact JSON structure: schemaVersion, episodeId, blocks[].blockOrder, blocks[].cues[].cueKey, blocks[].cues[].sourceSentenceKeys, blocks[].cues[].textPtBr.
- Do NOT translate proper names (character names, place names) unless a well-known standard Brazilian Portuguese equivalent exists.
- Preserve all numbers, apartment numbers, phone numbers, dates, and measurements exactly.
- Use Brazilian Portuguese (pt-BR), NEVER European Portuguese (pt-PT).
- Be natural and colloquial — avoid overly formal or literal translations.
- Do NOT add information not present in the English cue.
- Do NOT remove information present in the English cue.
- Do NOT summarise or paraphrase beyond what is necessary for natural Brazilian Portuguese.
- Keep translations concise — subtitles must be readable on screen.
- Maintain the emotional tone (humor, tension, warmth) of the original.`;

// Judges MEANING/QUALITY only — cue identity, count, order, and number
// preservation are already enforced deterministically before this ever
// runs (validateTranslationDeterministic), so this prompt does not repeat
// them. Explicitly lenient about style: an earlier, stricter version of
// this prompt (with no leniency guidance and an all-7-checks-must-pass
// gate) was rejecting adequate translations over acceptable stylistic
// variation with no way to tell which specific cue caused the failure.
export const VALIDATOR_SYSTEM_PROMPT = `You are a linguistic quality reviewer for Brazilian Portuguese (pt-BR) subtitle translations used in an English-learning app.

For EACH cue below, judge ONLY:
- Meaning fidelity: does the Portuguese convey the same meaning as the English, without inventing information or omitting anything that matters to the meaning?
- Natural Brazilian Portuguese: does it read as natural, idiomatic pt-BR (not machine-literal, not European Portuguese)?
- Names: are character/place names preserved (not translated, unless a standard pt-BR equivalent exists)?

Do NOT mark a cue invalid for:
- word-for-word phrasing differences that preserve the same meaning;
- natural word reordering;
- register/synonym choices (formal vs. informal) that do not change the meaning;
- omitting filler words that carry no meaning in Portuguese;
- minor stylistic variation a native speaker would consider equally correct.

Only mark a cue invalid for a REAL problem: wrong or missing meaning, invented information, an omission that matters, unnatural/incorrect Portuguese, or a lost/altered name. When in doubt, and the translation is understandable and accurate, mark it valid.

Return ONLY valid JSON, exactly this shape — include EVERY cueKey you were given, in any order:
{
  "schemaVersion": "2.0",
  "cues": [
    { "cueKey": "<cueKey>", "valid": <boolean>, "issues": [<string>] }
  ]
}
"issues" must be empty when valid is true. When valid is false, state the SPECIFIC problem (not a vague label like "not natural") so it can be fixed without guessing.`;

// Dedicated to the correction step — distinct from VALIDATOR_SYSTEM_PROMPT,
// which describes a review/evaluation task, not a rewrite task.
export const CORRECTION_SYSTEM_PROMPT = `You are correcting specific Brazilian Portuguese (pt-BR) subtitle translations that failed quality review.

RULES:
- Fix ONLY the cues listed as needing correction, using the exact problem stated for each.
- Do not change anything not called out in the stated problem.
- Do not translate proper names unless a standard pt-BR equivalent exists.
- Preserve all numbers exactly.
- Use natural Brazilian Portuguese (pt-BR), never European Portuguese.

Return ONLY valid JSON, exactly this shape — one entry per cueKey you were asked to fix, nothing else:
{ "<cueKey>": "<corrected pt-BR text>" }`;

// ─── Prompt builders ──────────────────────────────────────────────────────────

export interface BlockCueData {
  blockOrder: 1 | 2;
  blockTextEn: string;
  cues: EnglishCueDraft[];
}

export interface TranslationPromptInput {
  episodeId: string;
  title: string;
  synopsis: string | null;
  cefrLevel: CEFRLevel;
  blocks: [BlockCueData, BlockCueData];
  glossary?: Record<string, string>;
}

export function buildTranslationUserPrompt(input: TranslationPromptInput): string {
  const { episodeId, title, synopsis, cefrLevel, blocks, glossary } = input;
  const lines: string[] = [
    `Episode ID: ${episodeId}`,
    `Title: ${title}`,
    synopsis ? `Synopsis: ${synopsis}` : '',
    `CEFR Level: ${cefrLevel}`,
    '',
  ];

  if (glossary && Object.keys(glossary).length > 0) {
    lines.push('=== GLOSSARY (mandatory terms) ===');
    for (const [en, pt] of Object.entries(glossary)) {
      lines.push(`  ${en} → ${pt}`);
    }
    lines.push('');
  }

  for (const block of blocks) {
    lines.push(`=== BLOCK ${block.blockOrder} — FULL ENGLISH TEXT ===`);
    lines.push(block.blockTextEn);
    lines.push('');
    lines.push(`--- Block ${block.blockOrder} cues to translate ---`);
    for (const cue of block.cues) {
      lines.push(`[${cue.cueKey}] (source: ${cue.sourceSentenceKeys.join(', ')}) ${cue.text}`);
    }
    lines.push('');
  }

  lines.push('Return ONLY the JSON below. Replace <…> placeholders with actual translations:');
  lines.push(JSON.stringify({
    schemaVersion: '1.0',
    episodeId,
    blocks: blocks.map(b => ({
      blockOrder: b.blockOrder,
      cues: b.cues.map(c => ({
        cueKey: c.cueKey,
        sourceSentenceKeys: c.sourceSentenceKeys,
        textPtBr: '<tradução aqui>',
      })),
    })),
  }, null, 2));

  return lines.filter(l => l !== undefined).join('\n');
}

export interface ValidationPromptInput {
  episodeId: string;
  cefrLevel: CEFRLevel;
  blockOrder: 1 | 2;
  blockTextEn: string;
  cues: Array<{ cueKey: string; sourceSentenceKeys: string[]; textEn: string; textPtBr: string }>;
  glossary?: Record<string, string>;
}

export function buildValidatorUserPrompt(input: ValidationPromptInput): string {
  const { episodeId, cefrLevel, blockOrder, blockTextEn, cues, glossary } = input;
  const lines: string[] = [
    `Episode ID: ${episodeId}`,
    `CEFR Level: ${cefrLevel}`,
    `Block: ${blockOrder}`,
    '',
    `Full English block text:`,
    blockTextEn,
    '',
  ];

  if (glossary && Object.keys(glossary).length > 0) {
    lines.push('=== GLOSSARY ===');
    for (const [en, pt] of Object.entries(glossary)) {
      lines.push(`  ${en} → ${pt}`);
    }
    lines.push('');
  }

  lines.push('Cues to validate (English → Portuguese):');
  for (const c of cues) {
    lines.push(`[${c.cueKey}] EN: ${c.textEn}`);
    lines.push(`[${c.cueKey}] PT: ${c.textPtBr}`);
    lines.push('');
  }

  lines.push('Return ONLY valid JSON, one entry per cue listed above:');
  lines.push(JSON.stringify({
    schemaVersion: '2.0',
    cues: cues.map(c => ({ cueKey: c.cueKey, valid: '<boolean>', issues: ['<string, only if valid is false>'] })),
  }, null, 2));

  return lines.join('\n');
}

export interface MissingCuesPromptInput {
  episodeId: string;
  title: string;
  synopsis: string | null;
  cefrLevel: CEFRLevel;
  missingByBlock: Map<1 | 2, { blockTextEn: string; cues: EnglishCueDraft[] }>;
  glossary?: Record<string, string>;
}

/**
 * Targeted repair prompt for LISTENING_TRANSLATION_MISSING_CUE: asks for a
 * translation of ONLY the cues a previous pass omitted, identified by the
 * same stable cueKey used everywhere else — never re-requests the full set.
 */
export function buildMissingCuesUserPrompt(input: MissingCuesPromptInput): string {
  const { episodeId, title, synopsis, cefrLevel, missingByBlock, glossary } = input;
  const lines: string[] = [
    `Episode ID: ${episodeId}`,
    `Title: ${title}`,
    synopsis ? `Synopsis: ${synopsis}` : '',
    `CEFR Level: ${cefrLevel}`,
    '',
    'A previous translation pass omitted some cues. Translate ONLY the missing cues listed below.',
    'Do not return any cue that is not explicitly listed here.',
    '',
  ];

  if (glossary && Object.keys(glossary).length > 0) {
    lines.push('=== GLOSSARY (mandatory terms) ===');
    for (const [en, pt] of Object.entries(glossary)) {
      lines.push(`  ${en} → ${pt}`);
    }
    lines.push('');
  }

  const allCueKeys: string[] = [];
  for (const [blockOrder, data] of missingByBlock) {
    lines.push(`=== BLOCK ${blockOrder} — FULL ENGLISH TEXT (context) ===`);
    lines.push(data.blockTextEn);
    lines.push('');
    lines.push(`--- Block ${blockOrder} MISSING cues to translate ---`);
    for (const cue of data.cues) {
      lines.push(`[${cue.cueKey}] (source: ${cue.sourceSentenceKeys.join(', ')}) ${cue.text}`);
      allCueKeys.push(cue.cueKey);
    }
    lines.push('');
  }

  lines.push('Return ONLY the JSON below. Replace <…> placeholders with actual translations. Include EVERY cueKey listed here, and nothing else:');
  lines.push(JSON.stringify({
    cues: allCueKeys.map(cueKey => ({ cueKey, textPtBr: '<tradução aqui>' })),
  }, null, 2));

  return lines.filter(l => l !== undefined).join('\n');
}

export interface CorrectionPromptInput {
  episodeId: string;
  cefrLevel: CEFRLevel;
  blockOrder: 1 | 2;
  blockTextEn: string;
  failingCues: Array<{ cueKey: string; sourceSentenceKeys: string[]; textEn: string; textPtBr: string; issues: string[] }>;
  validCues: Array<{ cueKey: string; textPtBr: string }>;
  glossary?: Record<string, string>;
}

export function buildCorrectionUserPrompt(input: CorrectionPromptInput): string {
  const { episodeId, cefrLevel, blockOrder, blockTextEn, failingCues, validCues, glossary } = input;
  const lines: string[] = [
    `Episode ID: ${episodeId}`,
    `CEFR Level: ${cefrLevel}`,
    `Block: ${blockOrder}`,
    '',
    'The following cue translations have validation issues. Fix ONLY the failing cues.',
    'Keep the already-valid cues unchanged.',
    '',
    `Full English block text:`,
    blockTextEn,
    '',
  ];

  if (glossary && Object.keys(glossary).length > 0) {
    lines.push('=== GLOSSARY ===');
    for (const [en, pt] of Object.entries(glossary)) lines.push(`  ${en} → ${pt}`);
    lines.push('');
  }

  lines.push('=== ALREADY VALID (keep as-is) ===');
  for (const c of validCues) lines.push(`[${c.cueKey}] ${c.textPtBr}`);
  lines.push('');

  lines.push('=== NEEDS CORRECTION ===');
  for (const c of failingCues) {
    lines.push(`[${c.cueKey}] EN: ${c.textEn}`);
    lines.push(`[${c.cueKey}] Current PT: ${c.textPtBr}`);
    lines.push(`[${c.cueKey}] Issues: ${c.issues.join('; ')}`);
    lines.push('');
  }

  lines.push('Return ONLY a JSON object mapping cue_key → corrected pt-BR text for the FAILING cues:');
  lines.push(`{ "<cueKey>": "<corrected translation>", … }`);
  return lines.join('\n');
}
