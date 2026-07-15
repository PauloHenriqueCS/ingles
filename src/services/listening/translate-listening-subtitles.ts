import type { CEFRLevel } from '../../domain/curriculum/cefr';
import type {
  EnglishCueDraft,
  RawTranslationResponse,
  RawTranslatedCue,
  SubtitleAIValidationResult,
  ValidatedTranslatedCue,
} from './listening-subtitle-schema';
import type { AICallWithUsageFn } from './validate-questions-with-ai';
import {
  TRANSLATION_SYSTEM_PROMPT,
  VALIDATOR_SYSTEM_PROMPT,
  TRANSLATION_PROMPT_VERSION,
  VALIDATOR_PROMPT_VERSION,
  buildTranslationUserPrompt,
  buildValidatorUserPrompt,
  buildCorrectionUserPrompt,
} from './build-subtitle-translation-prompt';
import type { BlockCueData } from './build-subtitle-translation-prompt';

export { TRANSLATION_PROMPT_VERSION, VALIDATOR_PROMPT_VERSION };

// ─── Parse helpers ────────────────────────────────────────────────────────────

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
  }
}

// ─── Deterministic validation of the translation response ────────────────────

export class SubtitleTranslationParseError extends Error {
  readonly code = 'LISTENING_TRANSLATION_INVALID_JSON';
  constructor(message: string) {
    super(message);
    this.name = 'SubtitleTranslationParseError';
  }
}

export class SubtitleTranslationValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SubtitleTranslationValidationError';
    this.code = code;
  }
}

/** Numbers in text: extract digit-only tokens and spelled-out numbers. */
function extractNumbers(text: string): string[] {
  return (text.match(/\b\d[\d,.]*/g) ?? []).map(n => n.replace(/[,]/g, ''));
}

function detectLanguage(text: string): 'likely-en' | 'unknown' {
  // Simple heuristic: if >40% of common English function words are present and
  // no common pt-BR function words, flag as likely English.
  const lower = text.toLowerCase();
  const enWords = ['the ', ' is ', ' are ', ' was ', ' were ', ' he ', ' she ', ' they '];
  const ptWords = ['que ', ' ela ', ' ele ', ' com ', ' uma ', ' um ', ' para ', ' isso ', 'ção', 'ão ', 'ões'];
  const enHits = enWords.filter(w => lower.includes(w)).length;
  const ptHits = ptWords.filter(w => lower.includes(w)).length;
  if (enHits >= 3 && ptHits === 0) return 'likely-en';
  return 'unknown';
}

export function validateTranslationDeterministic(
  raw: unknown,
  englishCuesByBlock: Map<1 | 2, EnglishCueDraft[]>,
): Map<1 | 2, ValidatedTranslatedCue[]> {
  if (!raw || typeof raw !== 'object') {
    throw new SubtitleTranslationParseError('Translation response is not a JSON object');
  }
  const r = raw as Record<string, unknown>;

  if (!Array.isArray(r.blocks) || r.blocks.length !== 2) {
    throw new SubtitleTranslationValidationError(
      'LISTENING_TRANSLATION_INVALID_JSON',
      `Expected 2 blocks, got ${Array.isArray(r.blocks) ? r.blocks.length : 'non-array'}`
    );
  }

  const result = new Map<1 | 2, ValidatedTranslatedCue[]>();

  for (const rawBlock of r.blocks as Array<Record<string, unknown>>) {
    const blockOrder = rawBlock.blockOrder as 1 | 2;
    if (blockOrder !== 1 && blockOrder !== 2) {
      throw new SubtitleTranslationValidationError(
        'LISTENING_TRANSLATION_INVALID_JSON',
        `Invalid blockOrder: ${blockOrder}`
      );
    }

    const enCues = englishCuesByBlock.get(blockOrder);
    if (!enCues) {
      throw new SubtitleTranslationValidationError(
        'LISTENING_TRANSLATION_INVALID_JSON',
        `No English cues for block ${blockOrder}`
      );
    }

    if (!Array.isArray(rawBlock.cues)) {
      throw new SubtitleTranslationValidationError(
        'LISTENING_TRANSLATION_INVALID_JSON',
        `Block ${blockOrder} has no cues array`
      );
    }

    const ptCues = rawBlock.cues as Array<Record<string, unknown>>;

    if (ptCues.length !== enCues.length) {
      throw new SubtitleTranslationValidationError(
        ptCues.length < enCues.length ? 'LISTENING_TRANSLATION_MISSING_CUE' : 'LISTENING_TRANSLATION_EXTRA_CUE',
        `Block ${blockOrder}: expected ${enCues.length} cues, got ${ptCues.length}`
      );
    }

    const enKeyMap = new Map(enCues.map((c, i) => [c.cueKey, { cue: c, index: i }]));
    const validated: ValidatedTranslatedCue[] = [];

    for (let i = 0; i < ptCues.length; i++) {
      const ptCue = ptCues[i] as RawTranslatedCue;
      const expectedKey = enCues[i].cueKey;

      if (ptCue.cueKey !== expectedKey) {
        throw new SubtitleTranslationValidationError(
          'LISTENING_TRANSLATION_KEY_MISMATCH',
          `Block ${blockOrder} cue ${i + 1}: expected key "${expectedKey}", got "${ptCue.cueKey}"`
        );
      }

      if (!enKeyMap.has(ptCue.cueKey)) {
        throw new SubtitleTranslationValidationError(
          'LISTENING_TRANSLATION_KEY_MISMATCH',
          `Block ${blockOrder}: unknown cue key "${ptCue.cueKey}"`
        );
      }

      const enEntry = enKeyMap.get(ptCue.cueKey)!;
      const enCue = enEntry.cue;

      if (!ptCue.textPtBr || typeof ptCue.textPtBr !== 'string' || ptCue.textPtBr.trim() === '') {
        throw new SubtitleTranslationValidationError(
          'LISTENING_TRANSLATION_INVALID_JSON',
          `Block ${blockOrder} cue "${ptCue.cueKey}": empty translation`
        );
      }

      // Check numbers are preserved
      const enNums = extractNumbers(enCue.text);
      const ptNums = extractNumbers(ptCue.textPtBr);
      const enNumSet = new Set(enNums);
      const ptNumSet = new Set(ptNums);
      for (const n of enNumSet) {
        if (!ptNumSet.has(n)) {
          throw new SubtitleTranslationValidationError(
            'LISTENING_TRANSLATION_NUMBER_MISMATCH',
            `Block ${blockOrder} cue "${ptCue.cueKey}": number "${n}" missing in translation`
          );
        }
      }

      // Reject translation that is still in English (simple heuristic)
      if (detectLanguage(ptCue.textPtBr) === 'likely-en') {
        throw new SubtitleTranslationValidationError(
          'LISTENING_TRANSLATION_INVALID_JSON',
          `Block ${blockOrder} cue "${ptCue.cueKey}": translation appears to still be in English`
        );
      }

      validated.push({
        cueKey: ptCue.cueKey,
        cueOrder: enCue.cueOrder,
        blockOrder,
        sourceSentenceKeys: enCue.sourceSentenceKeys,
        textEn: enCue.text,
        textPtBr: ptCue.textPtBr.trim(),
      });
    }

    result.set(blockOrder, validated);
  }

  return result;
}

// ─── AI validation of translation ────────────────────────────────────────────

function parseValidatorResponse(rawText: string, blockOrder: number): SubtitleAIValidationResult {
  const parsed = extractJson(rawText);
  if (!parsed || typeof parsed !== 'object') {
    return {
      schemaVersion: '1.0', valid: false, confidence: 0,
      checks: { meaningPreserved: false, noAddedInformation: false, noMissingInformation: false,
        ptBrNatural: false, namesPreserved: false, numbersPreserved: false, cueAlignmentValid: false },
      issues: [`Validator returned non-JSON for block ${blockOrder}`],
      correctedTextPtBr: null,
    };
  }
  const r = parsed as Record<string, unknown>;
  const checks = (r.checks && typeof r.checks === 'object') ? r.checks as Record<string, unknown> : {};
  const result: SubtitleAIValidationResult = {
    schemaVersion: typeof r.schemaVersion === 'string' ? r.schemaVersion : '1.0',
    valid: r.valid === true,
    confidence: typeof r.confidence === 'number' ? r.confidence : 0,
    checks: {
      meaningPreserved:      checks.meaningPreserved === true,
      noAddedInformation:    checks.noAddedInformation === true,
      noMissingInformation:  checks.noMissingInformation === true,
      ptBrNatural:           checks.ptBrNatural === true,
      namesPreserved:        checks.namesPreserved === true,
      numbersPreserved:      checks.numbersPreserved === true,
      cueAlignmentValid:     checks.cueAlignmentValid === true,
    },
    issues: Array.isArray(r.issues) ? r.issues.filter((i): i is string => typeof i === 'string') : [],
    correctedTextPtBr: (r.correctedTextPtBr && typeof r.correctedTextPtBr === 'object' && !Array.isArray(r.correctedTextPtBr))
      ? r.correctedTextPtBr as Record<string, string>
      : null,
  };
  result.valid = result.valid &&
    result.checks.meaningPreserved && result.checks.noAddedInformation &&
    result.checks.noMissingInformation && result.checks.ptBrNatural &&
    result.checks.namesPreserved && result.checks.numbersPreserved &&
    result.checks.cueAlignmentValid &&
    result.confidence >= 0.90;
  return result;
}

export async function validateBlockTranslationWithAI(
  blockOrder: 1 | 2,
  blockTextEn: string,
  validatedCues: ValidatedTranslatedCue[],
  cefrLevel: CEFRLevel,
  episodeId: string,
  callAI: AICallWithUsageFn,
  minConfidence: number,
): Promise<SubtitleAIValidationResult> {
  const userPrompt = buildValidatorUserPrompt({
    episodeId, cefrLevel, blockOrder, blockTextEn,
    cues: validatedCues.map(c => ({
      cueKey: c.cueKey,
      sourceSentenceKeys: c.sourceSentenceKeys,
      textEn: c.textEn,
      textPtBr: c.textPtBr,
    })),
  });

  const { text, usage } = await callAI(VALIDATOR_SYSTEM_PROMPT, userPrompt);

  console.error(JSON.stringify({
    event: 'listening_subtitle_token_usage',
    stage: 'listening_subtitle_translation_validation',
    provider: 'openai',
    promptVersion: VALIDATOR_PROMPT_VERSION,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    durationMs: usage.durationMs,
    episodeId,
    blockOrder,
    t: Date.now(),
  }));

  const result = parseValidatorResponse(text, blockOrder);
  // Re-apply minConfidence threshold
  result.valid = result.valid && result.confidence >= minConfidence;
  return result;
}

// ─── Correction of failed cues ────────────────────────────────────────────────

function parseCorrectionResponse(rawText: string): Record<string, string> | null {
  const parsed = extractJson(rawText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const r = parsed as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) {
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

export async function correctBlockTranslation(
  blockOrder: 1 | 2,
  blockTextEn: string,
  validatedCues: ValidatedTranslatedCue[],
  validationResult: SubtitleAIValidationResult,
  cefrLevel: CEFRLevel,
  episodeId: string,
  callAI: AICallWithUsageFn,
): Promise<ValidatedTranslatedCue[]> {
  // Determine which cue keys failed based on issues mentioning them
  // and correctedTextPtBr from the validator
  const correctedByValidator = validationResult.correctedTextPtBr ?? {};
  const failingKeys = new Set(
    validationResult.issues
      .map(issue => {
        const m = issue.match(/\[([^\]]+)\]/);
        return m ? m[1] : null;
      })
      .filter((k): k is string => k !== null)
  );

  // If validator provided corrections, use them directly (no extra AI call)
  if (Object.keys(correctedByValidator).length > 0) {
    return validatedCues.map(c => ({
      ...c,
      textPtBr: typeof correctedByValidator[c.cueKey] === 'string'
        ? (correctedByValidator[c.cueKey] as string).trim()
        : c.textPtBr,
    }));
  }

  // Build correction prompt
  const allFailKeys = failingKeys.size > 0 ? failingKeys : new Set(validatedCues.map(c => c.cueKey));
  const failingCues = validatedCues
    .filter(c => allFailKeys.has(c.cueKey))
    .map(c => ({ cueKey: c.cueKey, sourceSentenceKeys: c.sourceSentenceKeys, textEn: c.textEn, textPtBr: c.textPtBr, issues: validationResult.issues }));
  const validCues = validatedCues
    .filter(c => !allFailKeys.has(c.cueKey))
    .map(c => ({ cueKey: c.cueKey, textPtBr: c.textPtBr }));

  const correctionPrompt = buildCorrectionUserPrompt({
    episodeId, cefrLevel, blockOrder, blockTextEn,
    failingCues, validCues,
  });

  const { text, usage } = await callAI(VALIDATOR_SYSTEM_PROMPT, correctionPrompt);

  console.error(JSON.stringify({
    event: 'listening_subtitle_token_usage',
    stage: 'listening_subtitle_translation_correction',
    provider: 'openai',
    promptVersion: VALIDATOR_PROMPT_VERSION,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    durationMs: usage.durationMs,
    episodeId,
    blockOrder,
    t: Date.now(),
  }));

  const corrections = parseCorrectionResponse(text);
  if (!corrections) return validatedCues;

  return validatedCues.map(c => ({
    ...c,
    textPtBr: typeof corrections[c.cueKey] === 'string'
      ? corrections[c.cueKey].trim()
      : c.textPtBr,
  }));
}

// ─── Main translation call ────────────────────────────────────────────────────

export async function translateSubtitles(
  blocks: [BlockCueData, BlockCueData],
  episodeId: string,
  title: string,
  synopsis: string | null,
  cefrLevel: CEFRLevel,
  callAI: AICallWithUsageFn,
  glossary?: Record<string, string>,
): Promise<RawTranslationResponse> {
  const userPrompt = buildTranslationUserPrompt({
    episodeId, title, synopsis, cefrLevel, blocks, glossary,
  });

  const { text, usage } = await callAI(TRANSLATION_SYSTEM_PROMPT, userPrompt);

  console.error(JSON.stringify({
    event: 'listening_subtitle_token_usage',
    stage: 'listening_subtitle_translation',
    provider: 'openai',
    promptVersion: TRANSLATION_PROMPT_VERSION,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    durationMs: usage.durationMs,
    episodeId,
    t: Date.now(),
  }));

  const parsed = extractJson(text);
  if (!parsed) {
    throw new SubtitleTranslationParseError('AI translation response contains no valid JSON');
  }
  return parsed as RawTranslationResponse;
}
