import type { CEFRLevel } from '../../domain/curriculum/cefr';
import type { EnglishCueDraft, SubtitleAIValidationResult } from './listening-subtitle-schema';

export const TRANSLATION_PROMPT_VERSION = 'listening-subtitle-translation-v1';
export const VALIDATOR_PROMPT_VERSION = 'listening-subtitle-translation-validator-v1';

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

export const VALIDATOR_SYSTEM_PROMPT = `You are a quality assurance specialist for Brazilian Portuguese subtitle translations used in English language learning apps.

Evaluate each translated cue against the English source and return a structured JSON validation report.

Evaluate:
1. meaningPreserved: Is the full meaning of the English cue conveyed in Portuguese?
2. noAddedInformation: Does the Portuguese add anything not in the English?
3. noMissingInformation: Does the Portuguese omit anything from the English?
4. ptBrNatural: Is the Portuguese natural Brazilian Portuguese (not European, not literal)?
5. namesPreserved: Are character names and proper nouns preserved correctly?
6. numbersPreserved: Are all numbers (digits, spelled-out numbers, measurements) preserved?
7. cueAlignmentValid: Does each Portuguese cue correspond to its English cue_key?

Return ONLY valid JSON. No explanation outside JSON.`;

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

  lines.push('Return ONLY valid JSON:');
  lines.push(`{
  "schemaVersion": "1.0",
  "valid": <boolean>,
  "confidence": <0.0–1.0>,
  "checks": {
    "meaningPreserved": <boolean>,
    "noAddedInformation": <boolean>,
    "noMissingInformation": <boolean>,
    "ptBrNatural": <boolean>,
    "namesPreserved": <boolean>,
    "numbersPreserved": <boolean>,
    "cueAlignmentValid": <boolean>
  },
  "issues": [<string>],
  "correctedTextPtBr": null or { "<cueKey>": "<corrected pt-BR text>", … }
}`);

  return lines.join('\n');
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
