import { createHash } from 'node:crypto';
import type { CEFRLevel } from '../../domain/curriculum/cefr';
import type {
  EnglishCueDraft,
  RawTranslationResponse,
  RawTranslatedBlock,
  RawTranslatedCue,
  CueQualityResult,
  SubtitleQualityValidationResult,
  ValidatedTranslatedCue,
} from './listening-subtitle-schema';
import type { AICallWithUsageFn } from './validate-questions-with-ai';
import {
  TRANSLATION_SYSTEM_PROMPT,
  VALIDATOR_SYSTEM_PROMPT,
  CORRECTION_SYSTEM_PROMPT,
  TRANSLATION_PROMPT_VERSION,
  VALIDATOR_PROMPT_VERSION,
  buildTranslationBatchUserPrompt,
  buildValidatorUserPrompt,
  buildCorrectionUserPrompt,
  buildMissingCuesUserPrompt,
} from './build-subtitle-translation-prompt';
import type { BlockCueData } from './build-subtitle-translation-prompt';

// Grounded in real data, not a guess: buildEnglishSubtitleCues run against a
// real generated A1 block (64 story sentences) produced 73 cues. Translating
// that many tightly-scoped items precisely in a single completion is where
// real episodes were losing specific cues (a dropped reaction beat, a
// swapped pronoun) — never total failures, always a handful scattered
// across a much larger set. Capping batches at 20 keeps each call's cue
// count small enough to keep per-cue fidelity high while bounding call
// count to a manageable ~4 calls for a 73-cue block.
export const TRANSLATION_BATCH_SIZE = 20;

// Found live (episode 23a7db4d, block 2 batch 2/4): two independent attempts,
// hours apart, both hung for ~241s (SUBTITLE_TIMEOUT_MS + its one retry) on
// the exact same batch — content/size were statistically identical to 3
// sibling batches that completed normally in 8-12s each, and the request
// never even had max_tokens set, so nothing forced a runaway/degenerate
// completion to cut short. 1800 is generous above the ~650-725 completion
// tokens observed for a 20-cue batch. 45s is generous above the 8-12s every
// successful batch call actually took — a genuine hang now fails fast
// instead of eating up to 240s. Scoped to this call site only: the validator
// and correction calls (different content/size profile, no live evidence of
// this failure mode) keep the client's default SUBTITLE_TIMEOUT_MS and no
// max_tokens cap.
export const BATCH_TRANSLATION_MAX_TOKENS = 1800;
export const BATCH_TRANSLATION_TIMEOUT_MS = 45_000;

// Found live (episode 23a7db4d, block 2 batch 2/4, again after the max_tokens
// fix landed): the batch that used to hang for 241s instead came back in
// 17.2s with completionTokens===1800 (exactly the ceiling) and
// finish_reason==='length' — the model genuinely wants to produce far more
// output for this specific batch than any sibling batch (~650-725 tokens).
// Raising max_tokens just moves the same problem to a higher ceiling; the
// structural fix is to shrink the batch itself when this happens, not the
// budget. Halving is bounded on two independent axes so a pathological
// batch can never loop indefinitely: depth (a 20-cue batch reaches a
// 1-cue leaf in at most 5 halvings) and total physical calls spent
// recovering one original batch.
export const MAX_BATCH_SUBDIVISION_DEPTH = 5;
export const MAX_BATCH_TRANSLATION_CALLS_PER_BATCH = 20;

function chunkCues(cues: EnglishCueDraft[], size: number): EnglishCueDraft[][] {
  const batches: EnglishCueDraft[][] = [];
  for (let i = 0; i < cues.length; i += size) batches.push(cues.slice(i, i + size));
  return batches.length > 0 ? batches : [[]];
}

function cueKeyRangeLabel(cues: EnglishCueDraft[]): string {
  if (cues.length === 0) return 'empty';
  if (cues.length === 1) return cues[0].cueKey;
  return `${cues[0].cueKey}..${cues[cues.length - 1].cueKey}`;
}

function hashCueContent(cues: EnglishCueDraft[]): string {
  const contentDigest = cues.map(c => `${c.cueKey}:${c.text}`).join('␟');
  return createHash('sha256').update(contentDigest, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Deterministic identity for one (sub-)batch translation call: same episode,
 * block, ORIGINAL batch position, the exact cueKey range covered, and the
 * exact cue content (via hash) always produce the same key, so the AI
 * Gateway's dedupe/reservation layer — and a retry of this same sub-batch —
 * recognize it as the same operation. The cueKey range is carried as its own
 * readable segment (not just folded into the hash) so a key is
 * human-diagnosable in gateway logs without reversing the hash. Deliberately
 * excludes attempt number, timestamp, and userId — those would make every
 * retry look like a brand-new operation, defeating the point.
 */
function buildBatchTranslationIdempotencyKey(
  episodeId: string,
  blockOrder: 1 | 2,
  originalBatchIndex: number,
  cues: EnglishCueDraft[],
): string {
  const range = cueKeyRangeLabel(cues);
  const hash = hashCueContent(cues);
  return `listening-subtitle-translate:${episodeId}:b${blockOrder}:batch${originalBatchIndex}:${range}:${TRANSLATION_PROMPT_VERSION}:${hash}`;
}

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

/**
 * The model's response was cut off by the token ceiling (finish_reason ===
 * 'length'), confirmed live: episode 23a7db4d block 2 batch 2/4 returned
 * completionTokens===BATCH_TRANSLATION_MAX_TOKENS with finish_reason
 * 'length' — the model genuinely wants to produce more output for this
 * batch than the ceiling allows. Distinct from SubtitleTranslationParseError
 * (which covers JSON that is malformed/empty for reasons OTHER than hitting
 * the token limit) so the two are never confused: adaptive subdivision only
 * ever reacts to THIS error's underlying signal (finish_reason), never to
 * "the JSON didn't parse" in general. Thrown only when subdivision has been
 * exhausted (a single cue still truncates, or a depth/call-count safety
 * limit was hit) — retryable, like a timeout, since this is a transient/
 * capacity problem, not a permanent content judgment.
 */
export class SubtitleTranslationOutputTruncatedError extends Error {
  readonly code = 'LISTENING_TRANSLATION_OUTPUT_TRUNCATED';
  readonly retryable = true;
  constructor(
    readonly blockOrder: 1 | 2,
    readonly batchIndex: number,
    readonly cueCount: number,
    readonly reason: 'single_cue_truncated' | 'max_depth_exceeded' | 'max_calls_exceeded',
    message: string,
  ) {
    super(message);
    this.name = 'SubtitleTranslationOutputTruncatedError';
  }
}

/** Numbers in text: extract digit-only tokens and spelled-out numbers. */
function extractNumbers(text: string): string[] {
  return (text.match(/\b\d[\d,.]*/g) ?? []).map(n => n.replace(/[,]/g, ''));
}

/**
 * True when text ends with a sentence-final mark (. ! ? or an ellipsis),
 * ignoring any trailing closing quote/paren. Used to catch a translation
 * that stops mid-sentence — found live: a cue whose English was the
 * complete "This can be my new home," she says to herself.' translated to
 * a pt-BR string that just stopped after "novo" (no digits lost, valid
 * non-empty JSON string, still genuinely incomplete — not a parser/merge
 * bug, since nothing between the raw API response and this check applies
 * any transformation beyond .trim()).
 */
function endsWithSentenceFinalPunctuation(text: string): boolean {
  const stripped = text.trim().replace(/["'”’)\]]+$/, '');
  return /[.!?…]$/.test(stripped);
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
      const textPtBr = typeof ptCue.textPtBr === 'string' ? ptCue.textPtBr : '';
      assertCueContentValid(blockOrder, enCue.cueKey, enCue.text, textPtBr);

      validated.push({
        cueKey: enCue.cueKey,
        cueOrder: enCue.cueOrder,
        blockOrder,
        sourceSentenceKeys: enCue.sourceSentenceKeys,
        textEn: enCue.text,
        textPtBr: textPtBr.trim(),
      });
    }

    result.set(blockOrder, validated);
  }

  return result;
}

// ─── Shared deterministic per-cue content check ──────────────────────────────
// Object identity/count/order is validateTranslationDeterministic's job
// (above); this is the per-cue TEXT check, reused both there and after a
// quality-correction round (correctBlockTranslation only rewrites text for
// specific cueKeys — those rewrites still need this same deterministic
// re-check before being accepted, since a correction pass could in principle
// drop a number or leave text empty).

function assertCueContentValid(blockOrder: 1 | 2, cueKey: string, textEn: string, textPtBr: string): void {
  if (!textPtBr || textPtBr.trim() === '') {
    throw new SubtitleTranslationValidationError(
      'LISTENING_TRANSLATION_INVALID_JSON',
      `Block ${blockOrder} cue "${cueKey}": empty translation`
    );
  }

  const enNumSet = new Set(extractNumbers(textEn));
  const ptNumSet = new Set(extractNumbers(textPtBr));
  for (const n of enNumSet) {
    if (!ptNumSet.has(n)) {
      throw new SubtitleTranslationValidationError(
        'LISTENING_TRANSLATION_NUMBER_MISMATCH',
        `Block ${blockOrder} cue "${cueKey}": number "${n}" missing in translation`
      );
    }
  }

  // Deterministic completeness check, independent of the semantic validator:
  // if the English cue is unambiguously a finished sentence, the translation
  // must look finished too. Only triggers when English itself ends with
  // sentence-final punctuation, so a cue that is a genuine mid-clause
  // fragment (e.g. ending in a comma) is never flagged.
  if (endsWithSentenceFinalPunctuation(textEn) && !endsWithSentenceFinalPunctuation(textPtBr)) {
    throw new SubtitleTranslationValidationError(
      'LISTENING_TRANSLATION_INCOMPLETE_SENTENCE',
      `Block ${blockOrder} cue "${cueKey}": translation does not end like a complete sentence, but the English cue does`
    );
  }

  // Deterministic question-mark parity: a cue that IS a question in English
  // must still read as a question in pt-BR. Presence-only check (not a
  // count match) to stay lenient about natural rewording.
  if (textEn.includes('?') && !textPtBr.includes('?')) {
    throw new SubtitleTranslationValidationError(
      'LISTENING_TRANSLATION_QUESTION_MISMATCH',
      `Block ${blockOrder} cue "${cueKey}": English cue is a question but the translation has no "?"`
    );
  }

  if (detectLanguage(textPtBr) === 'likely-en') {
    throw new SubtitleTranslationValidationError(
      'LISTENING_TRANSLATION_INVALID_JSON',
      `Block ${blockOrder} cue "${cueKey}": translation appears to still be in English`
    );
  }
}

/**
 * Re-runs the deterministic per-cue content check (numbers preserved,
 * non-empty, not still English) against a set of cues after a quality
 * correction round. Identity/count/order are unaffected by correction (it
 * only ever rewrites textPtBr for cueKeys it was explicitly given), so only
 * the text-level checks need re-asserting here.
 */
export function reassertCorrectedCuesDeterministically(
  blockOrder: 1 | 2,
  cues: ValidatedTranslatedCue[],
): void {
  for (const cue of cues) {
    assertCueContentValid(blockOrder, cue.cueKey, cue.textEn, cue.textPtBr);
  }
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

  const { text } = await callAI(TRANSLATION_SYSTEM_PROMPT, userPrompt, { temperature: 0.2, jsonMode: true });
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

// ─── AI validation of translation quality (per cue) ──────────────────────────
// Identity/count/order/number-preservation are already the deterministic
// layer's job — this only judges meaning fidelity, naturalness, and
// invented/omitted content, per cue, so a single borderline cue can no
// longer fail the entire block or hide which cue actually had a problem.

export class SubtitleQualityValidatorMalformedResponseError extends Error {
  readonly code = 'LISTENING_TRANSLATION_VALIDATOR_MALFORMED_RESPONSE';
  constructor(readonly blockOrder: number, detail: string) {
    super(`Quality validator returned a malformed/incomplete response for block ${blockOrder}: ${detail}`);
    this.name = 'SubtitleQualityValidatorMalformedResponseError';
  }
}

/**
 * Parses the validator's per-cue response. Throws
 * SubtitleQualityValidatorMalformedResponseError (never silently treats it
 * as "translation invalid") when the response isn't valid JSON, isn't the
 * expected shape, or is missing a verdict for any of the requested cueKeys —
 * a malformed response is a MODEL/PARSING problem, not evidence the
 * translation is bad, and callers must retry the validation call itself.
 */
function parseQualityValidatorResponse(
  rawText: string,
  blockOrder: number,
  requestedCueKeys: string[],
): SubtitleQualityValidationResult {
  const parsed = extractJson(rawText);
  if (!parsed || typeof parsed !== 'object') {
    throw new SubtitleQualityValidatorMalformedResponseError(blockOrder, 'response is not a JSON object');
  }
  const r = parsed as Record<string, unknown>;
  if (!Array.isArray(r.cues)) {
    throw new SubtitleQualityValidatorMalformedResponseError(blockOrder, 'response has no cues array');
  }

  const byKey = new Map<string, CueQualityResult>();
  for (const raw of r.cues as Array<Record<string, unknown>>) {
    if (typeof raw.cueKey !== 'string' || typeof raw.valid !== 'boolean') continue;
    byKey.set(raw.cueKey, {
      cueKey: raw.cueKey,
      valid: raw.valid,
      issues: Array.isArray(raw.issues) ? raw.issues.filter((i): i is string => typeof i === 'string') : [],
    });
  }

  const cueResults: CueQualityResult[] = [];
  for (const key of requestedCueKeys) {
    const result = byKey.get(key);
    if (!result) {
      throw new SubtitleQualityValidatorMalformedResponseError(blockOrder, `missing a verdict for cue "${key}"`);
    }
    cueResults.push(result);
  }

  return {
    schemaVersion: typeof r.schemaVersion === 'string' ? r.schemaVersion : '2.0',
    overallValid: cueResults.every(c => c.valid),
    cueResults,
  };
}

const MAX_VALIDATOR_CALL_ATTEMPTS = 2;

export async function validateBlockTranslationWithAI(
  blockOrder: 1 | 2,
  blockTextEn: string,
  validatedCues: ValidatedTranslatedCue[],
  cefrLevel: CEFRLevel,
  episodeId: string,
  callAI: AICallWithUsageFn,
): Promise<SubtitleQualityValidationResult> {
  const userPrompt = buildValidatorUserPrompt({
    episodeId, cefrLevel, blockOrder, blockTextEn,
    cues: validatedCues.map(c => ({
      cueKey: c.cueKey,
      sourceSentenceKeys: c.sourceSentenceKeys,
      textEn: c.textEn,
      textPtBr: c.textPtBr,
    })),
  });
  const requestedCueKeys = validatedCues.map(c => c.cueKey);

  let lastError: SubtitleQualityValidatorMalformedResponseError | null = null;
  for (let attempt = 1; attempt <= MAX_VALIDATOR_CALL_ATTEMPTS; attempt++) {
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
      attempt,
      t: Date.now(),
    }));

    try {
      return parseQualityValidatorResponse(text, blockOrder, requestedCueKeys);
    } catch (err) {
      if (!(err instanceof SubtitleQualityValidatorMalformedResponseError)) throw err;
      lastError = err;
      console.error(JSON.stringify({
        event: 'listening_subtitle_validator_malformed_response',
        episodeId, blockOrder, attempt, maxAttempts: MAX_VALIDATOR_CALL_ATTEMPTS,
        detail: err.message, t: Date.now(),
      }));
    }
  }

  // Every attempt returned a malformed response — this is a validator/model
  // availability problem, not a verdict on the translation. Surface it as
  // its own distinct, clearly-coded failure rather than guessing valid or
  // invalid.
  throw lastError!;
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

/**
 * Corrects ONLY the cues the quality validator marked invalid, each with its
 * own specific issue text — never a full-block re-translation. Cues already
 * marked valid pass through unchanged. Returns the corrected cues re-checked
 * against the deterministic per-cue content rules (numbers/non-empty/not
 * still-English), so a correction can't silently regress those.
 */
export async function correctBlockTranslation(
  blockOrder: 1 | 2,
  blockTextEn: string,
  validatedCues: ValidatedTranslatedCue[],
  validationResult: SubtitleQualityValidationResult,
  cefrLevel: CEFRLevel,
  episodeId: string,
  callAI: AICallWithUsageFn,
): Promise<ValidatedTranslatedCue[]> {
  const issuesByKey = new Map(validationResult.cueResults.filter(r => !r.valid).map(r => [r.cueKey, r.issues]));

  const failingCues = validatedCues
    .filter(c => issuesByKey.has(c.cueKey))
    .map(c => ({
      cueKey: c.cueKey, sourceSentenceKeys: c.sourceSentenceKeys, textEn: c.textEn, textPtBr: c.textPtBr,
      issues: issuesByKey.get(c.cueKey)!.length > 0 ? issuesByKey.get(c.cueKey)! : ['Quality review marked this translation invalid without a specific reason.'],
    }));
  const validCues = validatedCues
    .filter(c => !issuesByKey.has(c.cueKey))
    .map(c => ({ cueKey: c.cueKey, textPtBr: c.textPtBr }));

  const correctionPrompt = buildCorrectionUserPrompt({
    episodeId, cefrLevel, blockOrder, blockTextEn,
    failingCues, validCues,
  });

  const { text, usage } = await callAI(CORRECTION_SYSTEM_PROMPT, correctionPrompt, { temperature: 0.2, jsonMode: true });

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
    correctedCueKeys: failingCues.map(c => c.cueKey),
    t: Date.now(),
  }));

  const corrections = parseCorrectionResponse(text);

  const corrected = validatedCues.map(c => ({
    ...c,
    textPtBr: corrections && typeof corrections[c.cueKey] === 'string'
      ? corrections[c.cueKey].trim()
      : c.textPtBr,
  }));

  reassertCorrectedCuesDeterministically(blockOrder, corrected);
  return corrected;
}

// ─── Main translation call ────────────────────────────────────────────────────

/** Parses one call's raw text against the cues it was asked to translate, merging by cueKey. Shared by the top-level batch and every subdivided sub-batch — a cue a response omits or returns with an unrecognized cueKey is simply not included; the existing missing-cue repair loop in prepareListeningSubtitles (step 8) already re-requests exactly those. */
function parseAndMergeTranslatedCues(
  text: string,
  sourceCues: EnglishCueDraft[],
  blockOrder: 1 | 2,
  originalBatchIndex: number,
  originalBatchCount: number,
): RawTranslatedCue[] {
  if (!text || text.trim() === '') {
    throw new SubtitleTranslationParseError(
      `AI translation response was empty (block ${blockOrder}, batch ${originalBatchIndex + 1}/${originalBatchCount})`
    );
  }

  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Record<string, unknown>).cues)) {
    throw new SubtitleTranslationParseError(
      `AI translation response contains no valid JSON cues array (block ${blockOrder}, batch ${originalBatchIndex + 1}/${originalBatchCount})`
    );
  }

  const byKey = new Map(sourceCues.map(c => [c.cueKey, c]));
  const result: RawTranslatedCue[] = [];
  for (const raw of (parsed as { cues: Array<Record<string, unknown>> }).cues) {
    if (typeof raw.cueKey !== 'string' || typeof raw.textPtBr !== 'string' || !raw.textPtBr.trim()) continue;
    const source = byKey.get(raw.cueKey);
    if (!source) continue; // ignore any cueKey outside this (sub-)batch
    result.push({ cueKey: raw.cueKey, sourceSentenceKeys: source.sourceSentenceKeys, textPtBr: raw.textPtBr.trim() });
  }
  return result;
}

export interface AdaptiveBatchContext {
  episodeId: string;
  title: string;
  synopsis: string | null;
  cefrLevel: CEFRLevel;
  blockOrder: 1 | 2;
  blockTextEn: string;
  callAI: AICallWithUsageFn;
  glossary?: Record<string, string>;
  originalBatchIndex: number;
  originalBatchCount: number;
}

/**
 * Translates one cue range (the full original batch, or — after a
 * truncation — one half of it) and, if the model's response is cut off by
 * the token ceiling (finish_reason === 'length'), recovers by splitting the
 * range roughly in half and recursing on each half instead of just failing
 * or raising max_tokens further. Order is preserved (first half's results
 * always precede the second half's). Bounded on two independent axes so a
 * pathological batch can never loop indefinitely:
 *   - depth: MAX_BATCH_SUBDIVISION_DEPTH halvings is enough to reach a
 *     single cue from a full TRANSLATION_BATCH_SIZE (20) batch.
 *   - callBudget: total physical AI calls spent recovering ONE original
 *     batch, shared across the whole recursion tree via a mutable counter.
 * If a single cue is still truncated, or either limit is hit while more
 * than one cue remains, throws SubtitleTranslationOutputTruncatedError with
 * a diagnostic reason instead of subdividing further or looping.
 */
export async function translateCueRangeWithAdaptiveSubdivision(
  cues: EnglishCueDraft[],
  precedingCueText: string | undefined,
  followingCueText: string | undefined,
  depth: number,
  callBudget: { remaining: number },
  ctx: AdaptiveBatchContext,
): Promise<RawTranslatedCue[]> {
  const { blockOrder, originalBatchIndex, originalBatchCount } = ctx;

  if (callBudget.remaining <= 0) {
    throw new SubtitleTranslationOutputTruncatedError(
      blockOrder, originalBatchIndex, cues.length, 'max_calls_exceeded',
      `Block ${blockOrder} batch ${originalBatchIndex + 1}/${originalBatchCount}: exceeded the maximum number of calls ` +
      `(${MAX_BATCH_TRANSLATION_CALLS_PER_BATCH}) spent recovering from output truncation.`
    );
  }
  callBudget.remaining -= 1;

  const userPrompt = buildTranslationBatchUserPrompt({
    episodeId: ctx.episodeId, title: ctx.title, synopsis: ctx.synopsis, cefrLevel: ctx.cefrLevel,
    blockOrder, blockTextEn: ctx.blockTextEn,
    cues, precedingCueText, followingCueText,
    batchIndex: originalBatchIndex, batchCount: originalBatchCount, glossary: ctx.glossary,
  });

  const idempotencyKey = buildBatchTranslationIdempotencyKey(ctx.episodeId, blockOrder, originalBatchIndex, cues);
  const result = await ctx.callAI(TRANSLATION_SYSTEM_PROMPT, userPrompt, {
    temperature: 0.2,
    jsonMode: true,
    maxTokens: BATCH_TRANSLATION_MAX_TOKENS,
    timeoutMs: BATCH_TRANSLATION_TIMEOUT_MS,
    idempotencyKey,
  });

  console.error(JSON.stringify({
    event: 'listening_subtitle_token_usage',
    stage: 'listening_subtitle_translation',
    provider: 'openai',
    promptVersion: TRANSLATION_PROMPT_VERSION,
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    totalTokens: result.usage.totalTokens,
    durationMs: result.usage.durationMs,
    episodeId: ctx.episodeId,
    blockOrder,
    batch: originalBatchIndex + 1,
    batchCount: originalBatchCount,
    cueCount: cues.length,
    subdivisionDepth: depth,
    t: Date.now(),
  }));

  // finish_reason is the authoritative truncation signal — never inferred
  // from completionTokens alone (a batch could legitimately use exactly
  // BATCH_TRANSLATION_MAX_TOKENS worth of natural output on 'stop').
  if (result.finishReason === 'length') {
    console.error(JSON.stringify({
      event: 'listening_subtitle_batch_truncated',
      episodeId: ctx.episodeId,
      blockOrder,
      batch: originalBatchIndex + 1,
      batchCount: originalBatchCount,
      cueCount: cues.length,
      completionTokens: result.usage.completionTokens,
      maxTokens: BATCH_TRANSLATION_MAX_TOKENS,
      finishReason: result.finishReason,
      batchHash: hashCueContent(cues),
      subdivisionDepth: depth,
      t: Date.now(),
    }));

    if (cues.length <= 1) {
      throw new SubtitleTranslationOutputTruncatedError(
        blockOrder, originalBatchIndex, cues.length, 'single_cue_truncated',
        `Block ${blockOrder} batch ${originalBatchIndex + 1}/${originalBatchCount}: a single cue ` +
        `("${cues[0]?.cueKey}") still hit the output token limit (finish_reason=length) — cannot subdivide further.`
      );
    }
    if (depth >= MAX_BATCH_SUBDIVISION_DEPTH) {
      throw new SubtitleTranslationOutputTruncatedError(
        blockOrder, originalBatchIndex, cues.length, 'max_depth_exceeded',
        `Block ${blockOrder} batch ${originalBatchIndex + 1}/${originalBatchCount}: reached the maximum subdivision ` +
        `depth (${MAX_BATCH_SUBDIVISION_DEPTH}) with ${cues.length} cues still truncating (finish_reason=length).`
      );
    }

    const mid = Math.ceil(cues.length / 2);
    const firstHalf = cues.slice(0, mid);
    const secondHalf = cues.slice(mid);

    const firstResults = await translateCueRangeWithAdaptiveSubdivision(
      firstHalf, precedingCueText, secondHalf[0]?.text, depth + 1, callBudget, ctx,
    );
    const secondResults = await translateCueRangeWithAdaptiveSubdivision(
      secondHalf, firstHalf[firstHalf.length - 1]?.text, followingCueText, depth + 1, callBudget, ctx,
    );
    return [...firstResults, ...secondResults];
  }

  return parseAndMergeTranslatedCues(result.text, cues, blockOrder, originalBatchIndex, originalBatchCount);
}

/**
 * Translates both blocks' cues, in batches of TRANSLATION_BATCH_SIZE per
 * block. Returns the same RawTranslationResponse shape a single whole-block
 * call used to — validateTranslationDeterministic and everything downstream
 * is unaware batching (or adaptive subdivision within a batch) happens at
 * all. Each top-level batch's AI call happens exactly once per loop
 * iteration — a later batch failing never re-invokes an earlier, already-
 * succeeded batch within this same call.
 */
export async function translateSubtitles(
  blocks: [BlockCueData, BlockCueData],
  episodeId: string,
  title: string,
  synopsis: string | null,
  cefrLevel: CEFRLevel,
  callAI: AICallWithUsageFn,
  glossary?: Record<string, string>,
): Promise<RawTranslationResponse> {
  const resultBlocks: RawTranslatedBlock[] = [];

  for (const block of blocks) {
    const batches = chunkCues(block.cues, TRANSLATION_BATCH_SIZE);
    const translatedCues: RawTranslatedCue[] = [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const precedingCueText = i > 0 ? batches[i - 1][batches[i - 1].length - 1]?.text : undefined;
      const followingCueText = i < batches.length - 1 ? batches[i + 1][0]?.text : undefined;

      const batchResults = await translateCueRangeWithAdaptiveSubdivision(
        batch, precedingCueText, followingCueText, 0,
        { remaining: MAX_BATCH_TRANSLATION_CALLS_PER_BATCH },
        {
          episodeId, title, synopsis, cefrLevel,
          blockOrder: block.blockOrder, blockTextEn: block.blockTextEn,
          callAI, glossary,
          originalBatchIndex: i, originalBatchCount: batches.length,
        },
      );

      translatedCues.push(...batchResults);
    }

    resultBlocks.push({ blockOrder: block.blockOrder, cues: translatedCues });
  }

  return {
    schemaVersion: '1.0',
    episodeId,
    blocks: resultBlocks,
  };
}
