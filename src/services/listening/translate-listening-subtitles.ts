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
  buildMissingCuesUserPrompt,
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

    // Identity-based matching from here on — by cueKey, never by array
    // position. A response containing the right set of cues in a different
    // order must not be rejected as a mismatch.
    const enKeyMap = new Map(enCues.map(c => [c.cueKey, c]));
    const ptKeyMap = new Map<string, RawTranslatedCue>();
    for (const raw of ptCues) {
      const ptCue = raw as unknown as RawTranslatedCue;
      if (ptKeyMap.has(ptCue.cueKey)) {
        throw new SubtitleTranslationValidationError(
          'LISTENING_TRANSLATION_DUPLICATE_CUE',
          `Block ${blockOrder}: cue key "${ptCue.cueKey}" appears more than once`
        );
      }
      ptKeyMap.set(ptCue.cueKey, ptCue);
    }

    const unknownKey = [...ptKeyMap.keys()].find(k => !enKeyMap.has(k));
    if (unknownKey !== undefined) {
      throw new SubtitleTranslationValidationError(
        'LISTENING_TRANSLATION_KEY_MISMATCH',
        `Block ${blockOrder}: unknown cue key "${unknownKey}"`
      );
    }

    // Same count + no duplicates + every pt key is a known en key ⇒ the pt
    // key set is exactly the en key set. Safe to iterate en cues in their
    // canonical order — the output order never depends on the model's.
    const validated: ValidatedTranslatedCue[] = [];
    for (const enCue of enCues) {
      const ptCue = ptKeyMap.get(enCue.cueKey)!;

      if (!ptCue.textPtBr || typeof ptCue.textPtBr !== 'string' || ptCue.textPtBr.trim() === '') {
        throw new SubtitleTranslationValidationError(
          'LISTENING_TRANSLATION_INVALID_JSON',
          `Block ${blockOrder} cue "${enCue.cueKey}": empty translation`
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
            `Block ${blockOrder} cue "${enCue.cueKey}": number "${n}" missing in translation`
          );
        }
      }

      // Reject translation that is still in English (simple heuristic)
      if (detectLanguage(ptCue.textPtBr) === 'likely-en') {
        throw new SubtitleTranslationValidationError(
          'LISTENING_TRANSLATION_INVALID_JSON',
          `Block ${blockOrder} cue "${enCue.cueKey}": translation appears to still be in English`
        );
      }

      validated.push({
        cueKey: enCue.cueKey,
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

// ─── Targeted repair for missing/omitted cues ────────────────────────────────
// Used when validateTranslationDeterministic throws LISTENING_TRANSLATION_MISSING_CUE:
// rather than re-translating the whole episode, find exactly which cueKeys
// have no usable pt-BR entry and re-request only those.

/**
 * Pure diff against the raw AI response — which EN cues in each block have
 * no corresponding non-empty pt-BR entry. Independent of
 * validateTranslationDeterministic's throw/hard-fail checks (duplicate/unknown
 * keys), so it works even against a response that is otherwise malformed,
 * as long as it has a `blocks[].cues[]` shape.
 */
export function findMissingCueKeys(
  raw: unknown,
  englishCuesByBlock: Map<1 | 2, EnglishCueDraft[]>,
): Map<1 | 2, EnglishCueDraft[]> {
  const missing = new Map<1 | 2, EnglishCueDraft[]>();
  const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  const blocks = Array.isArray(r.blocks) ? (r.blocks as Array<Record<string, unknown>>) : [];

  for (const [blockOrder, enCues] of englishCuesByBlock) {
    const rawBlock = blocks.find(b => b.blockOrder === blockOrder);
    const ptCues = Array.isArray(rawBlock?.cues) ? (rawBlock!.cues as Array<Record<string, unknown>>) : [];

    const usableKeys = new Set<string>();
    for (const c of ptCues) {
      if (typeof c.cueKey === 'string' && typeof c.textPtBr === 'string' && c.textPtBr.trim() !== '') {
        usableKeys.add(c.cueKey);
      }
    }

    const blockMissing = enCues.filter(c => !usableKeys.has(c.cueKey));
    if (blockMissing.length > 0) missing.set(blockOrder, blockMissing);
  }

  return missing;
}

/** Merges repaired cues into a raw translation response, by cueKey, per block. */
export function mergeRepairedCues(
  raw: RawTranslationResponse,
  repairedByBlock: Map<1 | 2, RawTranslatedCue[]>,
): RawTranslationResponse {
  return {
    ...raw,
    blocks: raw.blocks.map(block => {
      const repaired = repairedByBlock.get(block.blockOrder as 1 | 2);
      if (!repaired || repaired.length === 0) return block;
      const byKey = new Map(block.cues.map(c => [c.cueKey, c]));
      for (const rc of repaired) byKey.set(rc.cueKey, rc);
      return { ...block, cues: [...byKey.values()] };
    }),
  };
}

export interface MissingCueRepairInput {
  episodeId: string;
  title: string;
  synopsis: string | null;
  cefrLevel: CEFRLevel;
  missingByBlock: Map<1 | 2, EnglishCueDraft[]>;
  blockTextEnByOrder: Map<1 | 2, string>;
  callAI: AICallWithUsageFn;
  glossary?: Record<string, string>;
}

/** Requests translations for ONLY the given missing cues (never the full episode). */
export async function translateMissingCues(
  input: MissingCueRepairInput,
): Promise<Map<1 | 2, RawTranslatedCue[]>> {
  const { episodeId, title, synopsis, cefrLevel, missingByBlock, blockTextEnByOrder, callAI, glossary } = input;

  const missingByBlockWithText = new Map<1 | 2, { blockTextEn: string; cues: EnglishCueDraft[] }>();
  for (const [blockOrder, cues] of missingByBlock) {
    missingByBlockWithText.set(blockOrder, { blockTextEn: blockTextEnByOrder.get(blockOrder) ?? '', cues });
  }

  const userPrompt = buildMissingCuesUserPrompt({
    episodeId, title, synopsis, cefrLevel, missingByBlock: missingByBlockWithText, glossary,
  });

  const { text } = await callAI(TRANSLATION_SYSTEM_PROMPT, userPrompt);
  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Record<string, unknown>).cues)) {
    throw new SubtitleTranslationParseError('AI missing-cue repair response contains no valid JSON cues array');
  }

  const rawCues = (parsed as { cues: Array<Record<string, unknown>> }).cues;
  const bySourceKey = new Map<string, EnglishCueDraft>();
  for (const cues of missingByBlock.values()) {
    for (const c of cues) bySourceKey.set(c.cueKey, c);
  }

  const result = new Map<1 | 2, RawTranslatedCue[]>();
  for (const rc of rawCues) {
    const cueKey = rc.cueKey;
    const textPtBr = rc.textPtBr;
    if (typeof cueKey !== 'string' || typeof textPtBr !== 'string' || !textPtBr.trim()) continue;
    const source = bySourceKey.get(cueKey);
    if (!source) continue; // ignore cues we did not ask to be repaired
    const list = result.get(source.blockOrder) ?? [];
    list.push({ cueKey, sourceSentenceKeys: source.sourceSentenceKeys, textPtBr: textPtBr.trim() });
    result.set(source.blockOrder, list);
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
