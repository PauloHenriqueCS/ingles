import type { GrammarTopicRole } from './evidence-types';

export interface OpportunityEvaluationInput {
  topicId: string;
  topicRole: GrammarTopicRole;
  submissionTextLength: number;    // character count
  plannedTopic: boolean;
  topicExpectedInContext: boolean; // does the context family typically produce this structure?
  estimatedOccurrencesInText: number; // rough estimate (0, 1, 2+)
  missionRequiredStructure: boolean;  // did the mission explicitly ask for this structure?
  levelMatchesTopicMinimum: boolean;  // is learner's level >= topic.minimumExposureLevel?
}

export type OpportunityStrength = 'strong' | 'moderate' | 'weak' | 'none';

export interface OpportunityEvaluationResult {
  hasOpportunity: boolean;
  strength: OpportunityStrength;
  estimatedCount: number;       // estimated opportunities in the text
  opportunityWeight: number;    // 0–1 quality multiplier
  justifications: string[];
  confidence: number;           // 0–1
}

export function evaluateGrammarOpportunity(
  input: OpportunityEvaluationInput,
): OpportunityEvaluationResult {
  const {
    topicRole,
    submissionTextLength,
    plannedTopic,
    estimatedOccurrencesInText,
    missionRequiredStructure,
    levelMatchesTopicMinimum,
  } = input;

  const justifications: string[] = [];

  // none cases
  if (topicRole === 'locked' && !missionRequiredStructure) {
    justifications.push('Topic is locked and not required by mission');
    return {
      hasOpportunity: false,
      strength: 'none',
      estimatedCount: 0,
      opportunityWeight: 0,
      justifications,
      confidence: 0.9,
    };
  }

  if (submissionTextLength < 30) {
    justifications.push('Submission text too short to evaluate opportunity');
    return {
      hasOpportunity: false,
      strength: 'none',
      estimatedCount: 0,
      opportunityWeight: 0,
      justifications,
      confidence: 0.95,
    };
  }

  if (!levelMatchesTopicMinimum && !missionRequiredStructure) {
    justifications.push('Learner level below topic minimum and structure not required');
    return {
      hasOpportunity: false,
      strength: 'none',
      estimatedCount: 0,
      opportunityWeight: 0,
      justifications,
      confidence: 0.85,
    };
  }

  if (estimatedOccurrencesInText === 0 && !plannedTopic) {
    justifications.push('No estimated occurrences and topic not planned');
    return {
      hasOpportunity: false,
      strength: 'none',
      estimatedCount: 0,
      opportunityWeight: 0,
      justifications,
      confidence: 0.8,
    };
  }

  // strong: missionRequiredStructure OR (plannedTopic AND estimatedOccurrencesInText >= 2)
  if (missionRequiredStructure) {
    justifications.push('Mission explicitly required this structure');
    return {
      hasOpportunity: true,
      strength: 'strong',
      estimatedCount: Math.max(estimatedOccurrencesInText, 1),
      opportunityWeight: 1.0,
      justifications,
      confidence: 0.95,
    };
  }

  if (plannedTopic && estimatedOccurrencesInText >= 2) {
    justifications.push('Planned topic with 2+ estimated occurrences');
    return {
      hasOpportunity: true,
      strength: 'strong',
      estimatedCount: estimatedOccurrencesInText,
      opportunityWeight: 1.0,
      justifications,
      confidence: 0.9,
    };
  }

  // moderate: plannedTopic AND estimatedOccurrencesInText >= 1
  if (plannedTopic && estimatedOccurrencesInText >= 1) {
    justifications.push('Planned topic with 1+ estimated occurrence');
    return {
      hasOpportunity: true,
      strength: 'moderate',
      estimatedCount: estimatedOccurrencesInText,
      opportunityWeight: 0.7,
      justifications,
      confidence: 0.75,
    };
  }

  // weak: topicRole === 'exposure_only' OR (plannedTopic AND estimatedOccurrencesInText <= 1 AND !missionRequiredStructure)
  if (topicRole === 'exposure_only') {
    justifications.push('Topic role is exposure_only');
    return {
      hasOpportunity: true,
      strength: 'weak',
      estimatedCount: estimatedOccurrencesInText,
      opportunityWeight: 0.3,
      justifications,
      confidence: 0.6,
    };
  }

  if (plannedTopic && estimatedOccurrencesInText <= 1 && !missionRequiredStructure) {
    justifications.push('Planned topic with limited occurrences and no mission requirement');
    return {
      hasOpportunity: true,
      strength: 'weak',
      estimatedCount: estimatedOccurrencesInText,
      opportunityWeight: 0.3,
      justifications,
      confidence: 0.6,
    };
  }

  // Default: no meaningful opportunity
  justifications.push('Insufficient signals to confirm grammar opportunity');
  return {
    hasOpportunity: false,
    strength: 'none',
    estimatedCount: 0,
    opportunityWeight: 0,
    justifications,
    confidence: 0.5,
  };
}
