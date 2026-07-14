import type { VocabularyItemKind } from './vocabulary-types';
import {
  normalizeVocabularyValue,
  normalizeForDeduplication,
  isMultiwordExpression,
  inferVocabularyKind,
  resolveLemma,
} from './vocabulary-normalization';

export interface VocabularyResolutionResult {
  normalizedValue: string;
  kind: VocabularyItemKind;
  isMultiword: boolean;
  candidateLemma: string | null;
  confidenceScore: number;  // 0–1, how confident we are in the resolution
}

// Resolve a raw string input to canonical metadata
export function resolveVocabularyInput(value: string): VocabularyResolutionResult {
  const normalizedValue = normalizeVocabularyValue(value);
  const multiword = isMultiwordExpression(value);
  const kind = inferVocabularyKind(value);
  // candidateLemma: resolveLemma for single words, null for multiword
  const candidateLemma = multiword ? null : resolveLemma(normalizedValue);

  // Confidence: higher for single words with clear kind, lower for multiword with ambiguous kind
  let confidenceScore = 0.8;
  if (multiword && kind === 'fixed_expression') {
    confidenceScore = 0.6;
  } else if (!multiword && kind === 'word') {
    confidenceScore = 0.9;
  } else if (kind === 'phrasal_verb') {
    confidenceScore = 0.85;
  } else if (kind === 'connector') {
    confidenceScore = 0.95;
  }

  return {
    normalizedValue,
    kind,
    isMultiword: multiword,
    candidateLemma,
    confidenceScore,
  };
}

// Resolve a form value — does this match the canonical item or a known variant?
export function resolveVocabularyForm(
  inputValue: string,
  canonicalValue: string,
  knownForms: string[],  // normalized forms from vocabulary_item_forms
): boolean {
  const normalizedInput = normalizeVocabularyValue(inputValue);
  const normalizedCanonical = normalizeVocabularyValue(canonicalValue);

  // Direct match to canonical
  if (normalizedInput === normalizedCanonical) return true;

  // Match against known forms
  for (const form of knownForms) {
    const normalizedForm = normalizeVocabularyValue(form);
    if (normalizedInput === normalizedForm) return true;
  }

  return false;
}

// Check if a submitted word is likely a form of the canonical item
export function isLikelyFormOf(submitted: string, canonical: string): boolean {
  const normalizedSubmitted = normalizeForDeduplication(submitted);
  const normalizedCanonical = normalizeForDeduplication(canonical);

  if (normalizedSubmitted === normalizedCanonical) return true;

  // Also try basic lemmatization of submitted compared to canonical normalized value
  const lemmatizedSubmitted = normalizeForDeduplication(submitted);
  const lemmatizedCanonical = normalizeVocabularyValue(canonical);

  return lemmatizedSubmitted === lemmatizedCanonical;
}

// Build a multiword token array
export function tokenizeMultiwordExpression(value: string): string[] {
  const normalized = normalizeVocabularyValue(value);
  return normalized.split(' ').filter(token => token.length > 0);
}
