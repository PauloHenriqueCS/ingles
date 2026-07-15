/**
 * Copy detection using deterministic signals.
 * Pure TypeScript — no external dependencies.
 */

import {
  normalizeTextForExactComparison,
  normalizeTextForStructuralComparison,
} from './rewrite-normalization';
import { splitIntoSentences, tokenizeIntoWords } from './rewrite-diff';
import type { RewriteIndependenceAssessment } from './rewrite-types';

// ── Signal thresholds ───────────────────────────────────────────────────────

/** Structural similarity (word overlap after expansion) threshold for 'copied'. */
const STRUCTURAL_SIMILARITY_COPIED = 0.95;

/** Structural similarity threshold for 'likely_copied'. */
const STRUCTURAL_SIMILARITY_LIKELY_COPIED = 0.85;

/** Structural similarity threshold for 'uncertain'. */
const STRUCTURAL_SIMILARITY_UNCERTAIN = 0.70;

/** Length ratio delta — very close lengths (within 5% relative). */
const LENGTH_RATIO_DELTA_TIGHT = 0.05;

// ── Exported types ──────────────────────────────────────────────────────────

export interface CopySignals {
  exactMatchNormalized: boolean;
  similarityStructural: number;       // 0–1
  lengthRatioDelta: number;           // |len(rewrite)/len(corrected) - 1|
  uniqueWordDelta: number;            // fraction of unique words in rewrite not in corrected
  sentenceCountDelta: number;         // |sentences(rewrite) - sentences(corrected)| / sentences(corrected)
  copySignalCount: number;            // how many signals fired
}

export interface CopyDetectionResult {
  signals: CopySignals;
  assessment: RewriteIndependenceAssessment;
  confidence: number; // 0–1
}

// ── Internal helpers ────────────────────────────────────────────────────────

function computeStructuralSimilarity(a: string, b: string): number {
  const aNorm = normalizeTextForStructuralComparison(a);
  const bNorm = normalizeTextForStructuralComparison(b);

  const aWords = new Set(tokenizeIntoWords(aNorm));
  const bWords = new Set(tokenizeIntoWords(bNorm));

  if (aWords.size === 0 && bWords.size === 0) return 1;
  if (aWords.size === 0 || bWords.size === 0) return 0;

  let intersectionSize = 0;
  for (const w of aWords) {
    if (bWords.has(w)) intersectionSize++;
  }
  const unionSize = aWords.size + bWords.size - intersectionSize;
  return intersectionSize / unionSize;
}

function computeLengthRatioDelta(rewrite: string, corrected: string): number {
  const rLen = rewrite.trim().length;
  const cLen = corrected.trim().length;
  if (cLen === 0) return rLen === 0 ? 0 : 1;
  return Math.abs(rLen / cLen - 1);
}

function computeUniqueWordDelta(rewrite: string, corrected: string): number {
  const rWords = tokenizeIntoWords(normalizeTextForStructuralComparison(rewrite));
  const cWords = new Set(tokenizeIntoWords(normalizeTextForStructuralComparison(corrected)));

  if (rWords.length === 0) return 0;

  const uniqueInRewrite = rWords.filter(w => !cWords.has(w));
  return uniqueInRewrite.length / rWords.length;
}

function computeSentenceCountDelta(rewrite: string, corrected: string): number {
  const rCount = splitIntoSentences(rewrite).length;
  const cCount = splitIntoSentences(corrected).length;
  if (cCount === 0) return rCount === 0 ? 0 : 1;
  return Math.abs(rCount - cCount) / cCount;
}

// ── Main export ─────────────────────────────────────────────────────────────

export function detectCopy(
  rewriteText: string,
  correctedText: string,
): CopyDetectionResult {
  const exactMatchNormalized =
    normalizeTextForExactComparison(rewriteText) ===
    normalizeTextForExactComparison(correctedText);

  const similarityStructural = computeStructuralSimilarity(rewriteText, correctedText);
  const lengthRatioDelta = computeLengthRatioDelta(rewriteText, correctedText);
  const uniqueWordDelta = computeUniqueWordDelta(rewriteText, correctedText);
  const sentenceCountDelta = computeSentenceCountDelta(rewriteText, correctedText);

  // Count how many signals fired
  let copySignalCount = 0;
  if (exactMatchNormalized) copySignalCount++;
  if (similarityStructural >= STRUCTURAL_SIMILARITY_LIKELY_COPIED) copySignalCount++;
  if (lengthRatioDelta <= LENGTH_RATIO_DELTA_TIGHT) copySignalCount++;
  if (uniqueWordDelta <= 0.05) copySignalCount++;
  if (sentenceCountDelta <= 0.10) copySignalCount++;

  const signals: CopySignals = {
    exactMatchNormalized,
    similarityStructural,
    lengthRatioDelta,
    uniqueWordDelta,
    sentenceCountDelta,
    copySignalCount,
  };

  // Assessment logic
  let assessment: RewriteIndependenceAssessment;
  let confidence: number;

  if (
    exactMatchNormalized ||
    (similarityStructural >= STRUCTURAL_SIMILARITY_COPIED &&
      lengthRatioDelta <= LENGTH_RATIO_DELTA_TIGHT &&
      uniqueWordDelta <= 0.05)
  ) {
    assessment = 'copied';
    confidence = 0.97;
  } else if (similarityStructural >= STRUCTURAL_SIMILARITY_LIKELY_COPIED && copySignalCount >= 3) {
    assessment = 'likely_copied';
    confidence = 0.85;
  } else if (similarityStructural >= STRUCTURAL_SIMILARITY_UNCERTAIN || copySignalCount >= 2) {
    assessment = 'uncertain';
    confidence = 0.65;
  } else if (similarityStructural >= 0.50 && copySignalCount <= 1) {
    assessment = 'likely_independent';
    confidence = 0.75;
  } else {
    assessment = 'independent';
    confidence = 0.90;
  }

  return { signals, assessment, confidence };
}
