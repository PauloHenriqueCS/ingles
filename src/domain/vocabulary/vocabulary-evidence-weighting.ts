import type { VocabularyEvidenceType, VocabularyProductionMode } from './vocabulary-types';

export const CURRENT_VOCABULARY_WEIGHTS_VERSION = 'v1';

interface VocabularyWeights {
  independent_success: number;    // 1.00
  independent_recall: number;     // 1.10
  guided_success: number;         // 0.65
  assisted_success: number;       // 0.25
  valid_synonym: number;          // 0.60
  partial_use: number;            // 0.30
  copied_use: number;             // 0.10
  system_generated: number;       // 0.00
  incorrect_planned: number;      // -0.60
  meaning_error: number;          // -0.75
  form_error: number;             // -0.40
  spelling_error_minor: number;   // -0.15
  missed_required: number;        // -0.35
  retention_success: number;      // 1.20
  retention_failure: number;      // -0.90
}

const WEIGHTS_V1: VocabularyWeights = {
  independent_success: 1.00,
  independent_recall: 1.10,
  guided_success: 0.65,
  assisted_success: 0.25,
  valid_synonym: 0.60,
  partial_use: 0.30,
  copied_use: 0.10,
  system_generated: 0.00,
  incorrect_planned: -0.60,
  meaning_error: -0.75,
  form_error: -0.40,
  spelling_error_minor: -0.15,
  missed_required: -0.35,
  retention_success: 1.20,
  retention_failure: -0.90,
};

export interface VocabularyWeightInput {
  evidenceType: VocabularyEvidenceType;
  productionMode: VocabularyProductionMode;
  weightsVersion?: string;
}

export function calculateVocabularyEvidenceWeight(input: VocabularyWeightInput): number {
  const { evidenceType, productionMode } = input;
  const w = WEIGHTS_V1;

  // system_generated → 0 always
  if (productionMode === 'system_generated') return w.system_generated;

  switch (evidenceType) {
    case 'exposure':
      return 0;

    case 'recognized':
      return 0.20;

    case 'recalled':
      switch (productionMode) {
        case 'independent':
        case 'unknown':
          return w.independent_recall;
        case 'guided':
          return w.guided_success;
        case 'assisted':
          return w.assisted_success;
        default:
          return w.independent_recall;
      }

    case 'successful_use':
      switch (productionMode) {
        case 'independent':
        case 'unknown':
          return w.independent_success;
        case 'guided':
          return w.guided_success;
        case 'assisted':
          return w.assisted_success;
        default:
          return w.independent_success;
      }

    case 'partial_use':
      return w.partial_use;

    case 'valid_synonym':
      return w.valid_synonym;

    case 'copied_use':
      return w.copied_use;

    case 'incorrect_use':
      switch (productionMode) {
        case 'independent':
        case 'unknown':
          return w.incorrect_planned;
        case 'guided':
          return -0.40;
        case 'assisted':
          return -0.20;
        default:
          return w.incorrect_planned;
      }

    case 'meaning_error':
      return w.meaning_error;

    case 'form_error':
      return w.form_error;

    case 'spelling_error':
      return w.spelling_error_minor;

    case 'missed_required_item':
      return w.missed_required;

    case 'retention_success':
      return w.retention_success;

    case 'retention_failure':
      return w.retention_failure;

    default:
      return 0;
  }
}

export function isPositiveVocabularyEvidence(evidenceType: VocabularyEvidenceType): boolean {
  return (
    evidenceType === 'recalled' ||
    evidenceType === 'successful_use' ||
    evidenceType === 'valid_synonym' ||
    evidenceType === 'partial_use' ||
    evidenceType === 'copied_use' ||
    evidenceType === 'recognized' ||
    evidenceType === 'retention_success'
  );
}

export function isNegativeVocabularyEvidence(evidenceType: VocabularyEvidenceType): boolean {
  return (
    evidenceType === 'incorrect_use' ||
    evidenceType === 'meaning_error' ||
    evidenceType === 'form_error' ||
    evidenceType === 'spelling_error' ||
    evidenceType === 'missed_required_item' ||
    evidenceType === 'retention_failure'
  );
}
