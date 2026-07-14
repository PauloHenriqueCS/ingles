/**
 * Three-layer deterministic comparison without AI.
 */

import type { RewriteCorrectionOutcomeStatus } from '../domain/writing-rewrite/rewrite-types';
import { computeWordDiff, wordOverlapSimilarity, splitIntoSentences } from '../domain/writing-rewrite/rewrite-diff';
import {
  normalizeTextForStructuralComparison,
  normalizeTextForExactComparison,
} from '../domain/writing-rewrite/rewrite-normalization';
import { detectCopy, type CopyDetectionResult } from '../domain/writing-rewrite/rewrite-copy-detection';

export interface MainMistake {
  mistake: string;
  correct: string;
  explanation?: string;
}

export interface DeterministicComparisonInput {
  originalText: string;
  correctedText: string;
  rewriteText: string;
  mainMistakes: MainMistake[];
}

export interface DeterministicComparisonResult {
  // Layer A: original vs rewrite
  layerA: {
    wordLevelSimilarity: number;         // 0–1
    meaningPreservationEstimate: number; // 0–100 (heuristic)
    sentenceCountChange: number;         // rewrite - original
  };
  // Layer B: corrected vs rewrite
  layerB: {
    structuralSimilarity: number;   // 0–1
    copyDetection: CopyDetectionResult;
  };
  // Layer C: per correction item
  layerC: Array<{
    mistake: MainMistake;
    outcomeEstimate: RewriteCorrectionOutcomeStatus;
    confidence: number; // 0–1
    rewriteExcerpt?: string;
  }>;
  // Initial score estimates (will be refined by model evaluator)
  estimatedCorrectionResolutionScore: number;
  estimatedNewErrorAvoidanceScore: number;
}

function computeWordLevelSimilarity(a: string, b: string): number {
  const aWords = a.toLowerCase().split(/\s+/).filter(Boolean);
  const bWords = b.toLowerCase().split(/\s+/).filter(Boolean);
  if (aWords.length === 0 && bWords.length === 0) return 1;
  if (aWords.length === 0 || bWords.length === 0) return 0;
  return wordOverlapSimilarity(a, b);
}

function computeStructuralSimilarity(a: string, b: string): number {
  const aNorm = normalizeTextForStructuralComparison(a);
  const bNorm = normalizeTextForStructuralComparison(b);

  const aWords = new Set(aNorm.split(/\s+/).filter(Boolean));
  const bWords = new Set(bNorm.split(/\s+/).filter(Boolean));

  if (aWords.size === 0 && bWords.size === 0) return 1;
  if (aWords.size === 0 || bWords.size === 0) return 0;

  let intersection = 0;
  for (const w of aWords) {
    if (bWords.has(w)) intersection++;
  }
  const union = aWords.size + bWords.size - intersection;
  return intersection / union;
}

function assessCorrectionInRewrite(
  mistake: MainMistake,
  rewriteText: string,
): { outcomeEstimate: RewriteCorrectionOutcomeStatus; confidence: number; rewriteExcerpt?: string } {
  const rewriteLower = normalizeTextForExactComparison(rewriteText);
  const correctLower = normalizeTextForExactComparison(mistake.correct);
  const mistakeLower = normalizeTextForExactComparison(mistake.mistake);

  if (correctLower && rewriteLower.includes(correctLower)) {
    return { outcomeEstimate: 'corrected', confidence: 0.8, rewriteExcerpt: mistake.correct };
  }

  if (mistakeLower && rewriteLower.includes(mistakeLower)) {
    return { outcomeEstimate: 'unchanged', confidence: 0.7 };
  }

  return { outcomeEstimate: 'partially_corrected', confidence: 0.5 };
}

export function runDeterministicComparison(
  input: DeterministicComparisonInput,
): DeterministicComparisonResult {
  const { originalText, correctedText, rewriteText, mainMistakes } = input;

  // ── Layer A: original vs rewrite ─────────────────────────────────────────
  const wordLevelSimilarity = computeWordLevelSimilarity(originalText, rewriteText);
  const meaningPreservationEstimate = Math.round(wordLevelSimilarity * 100);
  const originalSentences = splitIntoSentences(originalText);
  const rewriteSentences = splitIntoSentences(rewriteText);
  const sentenceCountChange = rewriteSentences.length - originalSentences.length;

  // ── Layer B: corrected vs rewrite ─────────────────────────────────────────
  const structuralSimilarity = computeStructuralSimilarity(correctedText, rewriteText);
  const copyDetection = detectCopy(rewriteText, correctedText);

  // ── Layer C: per correction item ─────────────────────────────────────────
  const layerC = mainMistakes.map(mistake => {
    const assessment = assessCorrectionInRewrite(mistake, rewriteText);
    return { mistake, ...assessment };
  });

  // ── Estimated scores ─────────────────────────────────────────────────────
  const correctedCount = layerC.filter(
    c => c.outcomeEstimate === 'corrected' || c.outcomeEstimate === 'valid_alternative',
  ).length;
  const applicableCount = layerC.filter(c => c.outcomeEstimate !== 'not_applicable').length;
  const estimatedCorrectionResolutionScore =
    applicableCount > 0 ? Math.round((correctedCount / applicableCount) * 100) : 0;

  // Penalize if rewrite seems notably shorter (possible shortcutting) but no new issues detected
  const lengthRatio =
    rewriteText.trim().length > 0 && originalText.trim().length > 0
      ? rewriteText.trim().length / originalText.trim().length
      : 1;
  const estimatedNewErrorAvoidanceScore = lengthRatio < 0.5 ? 60 : 80;

  return {
    layerA: { wordLevelSimilarity, meaningPreservationEstimate, sentenceCountChange },
    layerB: { structuralSimilarity, copyDetection },
    layerC,
    estimatedCorrectionResolutionScore,
    estimatedNewErrorAvoidanceScore,
  };
}
