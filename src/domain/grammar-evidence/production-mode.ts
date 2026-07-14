import type { GrammarProductionMode } from './evidence-types';

export interface ProductionModeInput {
  submissionType: 'original' | 'rewrite_v2' | 'unknown';
  sourceType: string;
  copySignalAssessment?: 'independent' | 'likely_independent' | 'uncertain' | 'likely_copied' | 'copied';
  correctedTextVisible?: boolean;
  correctionsExpanded?: boolean;
  supportSentencesAvailable?: boolean;
  helpUsed?: boolean;
  plannedTopic?: boolean;
  missionHasDirectInstruction?: boolean;
}

export function resolveProductionMode(input: ProductionModeInput): GrammarProductionMode {
  const {
    submissionType,
    sourceType,
    copySignalAssessment,
    correctedTextVisible,
    correctionsExpanded,
    supportSentencesAvailable,
    helpUsed,
    plannedTopic,
    missionHasDirectInstruction,
  } = input;

  // system_generated: sourceType === 'manual_admin' or external system input
  if (sourceType === 'manual_admin') {
    return 'system_generated';
  }

  // assisted:
  //   - correctedTextVisible AND correctedTextVisible=true during rewrite
  //   - OR copySignalAssessment in ['likely_copied', 'copied']
  //   - OR correctionsExpanded AND helpUsed
  if (correctedTextVisible === true && submissionType === 'rewrite_v2') {
    return 'assisted';
  }
  if (copySignalAssessment === 'likely_copied' || copySignalAssessment === 'copied') {
    return 'assisted';
  }
  if (correctionsExpanded === true && helpUsed === true) {
    return 'assisted';
  }

  // independent:
  //   - copySignalAssessment in ['independent', 'likely_independent']
  //     AND !correctedTextVisible AND !helpUsed
  //   - OR submissionType=original AND !plannedTopic AND !helpUsed
  if (
    (copySignalAssessment === 'independent' || copySignalAssessment === 'likely_independent') &&
    correctedTextVisible !== true &&
    helpUsed !== true
  ) {
    return 'independent';
  }
  if (submissionType === 'original' && plannedTopic !== true && helpUsed !== true) {
    return 'independent';
  }

  // guided:
  //   - plannedTopic AND missionHasDirectInstruction
  //   - OR supportSentencesAvailable AND !correctedTextVisible
  //   - OR submissionType=original AND plannedTopic AND !helpUsed
  if (plannedTopic === true && missionHasDirectInstruction === true) {
    return 'guided';
  }
  if (supportSentencesAvailable === true && correctedTextVisible !== true) {
    return 'guided';
  }
  if (submissionType === 'original' && plannedTopic === true && helpUsed !== true) {
    return 'guided';
  }

  // unknown: everything else
  return 'unknown';
}

export function productionModeToSupportLevel(mode: GrammarProductionMode): string {
  switch (mode) {
    case 'independent':     return 'none';
    case 'guided':          return 'low';
    case 'assisted':        return 'high';
    case 'system_generated': return 'none';
    case 'unknown':         return 'medium';
    default:                return 'none';
  }
}
