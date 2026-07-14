import type { GrammarProductionMode, GrammarTopicRole, GrammarEvidenceType } from './evidence-types';

export const CURRENT_EVIDENCE_WEIGHTS_VERSION = 'v1';

interface EvidenceWeights {
  independent_success: number;
  guided_success: number;
  assisted_success: number;
  system_generated: number;
  partial_independent: number;
  partial_guided: number;
  partial_assisted: number;
  error_primary: number;
  error_secondary: number;
  error_exposure_only: number;
  error_unplanned: number;
  error_locked: number;
  attempt_above_level: number;
  retention_success: number;
  retention_failure: number;
  no_opportunity: number;
}

const WEIGHTS_V1: EvidenceWeights = {
  independent_success: 1.00,
  guided_success: 0.65,
  assisted_success: 0.30,
  system_generated: 0.00,
  partial_independent: 0.45,
  partial_guided: 0.25,
  partial_assisted: 0.15,
  error_primary: -0.70,
  error_secondary: -0.45,
  error_exposure_only: -0.10,
  error_unplanned: -0.15,
  error_locked: -0.05,
  attempt_above_level: 0.05,
  retention_success: 0.90,
  retention_failure: -0.60,
  no_opportunity: 0.00,
};

export interface WeightCalculationInput {
  evidenceType: GrammarEvidenceType;
  productionMode: GrammarProductionMode;
  topicRole: GrammarTopicRole;
  weightsVersion?: string;
}

export function calculateEvidenceWeight(input: WeightCalculationInput): number {
  const { evidenceType, productionMode, topicRole } = input;

  // system_generated → always 0
  if (productionMode === 'system_generated') {
    return 0.00;
  }

  switch (evidenceType) {
    case 'successful_use': {
      switch (productionMode) {
        case 'independent': return WEIGHTS_V1.independent_success;
        case 'guided':      return WEIGHTS_V1.guided_success;
        case 'assisted':    return WEIGHTS_V1.assisted_success;
        default:            return 0.40; // unknown
      }
    }

    case 'partial_success': {
      switch (productionMode) {
        case 'independent': return WEIGHTS_V1.partial_independent;
        case 'guided':      return WEIGHTS_V1.partial_guided;
        case 'assisted':    return WEIGHTS_V1.partial_assisted;
        default:            return 0.20; // unknown
      }
    }

    case 'error': {
      switch (topicRole) {
        case 'primary':       return WEIGHTS_V1.error_primary;
        case 'secondary':     return WEIGHTS_V1.error_secondary;
        case 'review':        return WEIGHTS_V1.error_secondary;
        case 'exposure_only': return WEIGHTS_V1.error_exposure_only;
        case 'locked':        return WEIGHTS_V1.error_locked;
        case 'unplanned':     return WEIGHTS_V1.error_unplanned;
        default:              return WEIGHTS_V1.error_unplanned;
      }
    }

    case 'attempt_above_level': return WEIGHTS_V1.attempt_above_level;
    case 'retention_success':   return WEIGHTS_V1.retention_success;
    case 'retention_failure':   return WEIGHTS_V1.retention_failure;
    case 'no_opportunity':      return WEIGHTS_V1.no_opportunity;
    case 'opportunity':         return 0.00; // just marks potential
    default:                    return 0.00;
  }
}

export function getWeights(version?: string): EvidenceWeights {
  // Return WEIGHTS_V1 for 'v1' or default
  void version;
  return WEIGHTS_V1;
}

export function isPositiveEvidence(weight: number): boolean {
  return weight > 0;
}

export function isNegativeEvidence(weight: number): boolean {
  return weight < 0;
}
