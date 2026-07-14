import type { GrammarMasteryState } from '../learner/grammar-mastery-types';
import type { GrammarMasteryReasonCode } from './evidence-types';

export const CURRENT_MASTERY_RULES_VERSION = 'v1';

export interface MasteryAggregate {
  totalOpportunities: number;
  successfulUses: number;
  partialUses: number;
  errorCount: number;
  independentUses: number;
  guidedUses: number;
  assistedUses: number;
  retentionSuccesses: number;
  retentionFailures: number;
  distinctContextCount: number;
  weightedSuccessScore: number;
  weightedErrorScore: number;
  confidence: number;
  currentState: GrammarMasteryState;
}

export interface TransitionEvaluationResult {
  canTransition: boolean;
  targetState: GrammarMasteryState | null;
  reasonCode: GrammarMasteryReasonCode | null;
  blockedReasons: string[];
}

export const CONSOLIDATION_CRITERIA_V1 = {
  minOpportunities: 4,
  minSuccessfulUses: 2,
  minIndependentUses: 1,
  minDistinctContexts: 2,
  minConfidence: 0.55,
} as const;

export const MASTERY_CRITERIA_V1 = {
  minOpportunities: 7,
  minSuccessfulUses: 5,
  minIndependentUses: 3,
  minDistinctContexts: 3,
  minWeightedPrecision: 0.80,
  minRetentionSuccesses: 1,
  minConfidence: 0.80,
} as const;

// Evaluate if conditions are met for the next forward transition
export function evaluateForwardTransition(agg: MasteryAggregate): TransitionEvaluationResult {
  const { currentState } = agg;

  switch (currentState) {
    case 'locked': {
      // locked → introduced: just needs to be called explicitly
      return {
        canTransition: true,
        targetState: 'introduced',
        reasonCode: 'TOPIC_INTRODUCED',
        blockedReasons: [],
      };
    }

    case 'introduced': {
      // introduced → practicing: ≥1 total opportunity
      if (agg.totalOpportunities >= 1) {
        const reasonCode: GrammarMasteryReasonCode = agg.guidedUses >= 1
          ? 'GUIDED_PRACTICE_STARTED'
          : 'FIRST_VALID_OPPORTUNITY';
        return {
          canTransition: true,
          targetState: 'practicing',
          reasonCode,
          blockedReasons: [],
        };
      }
      return {
        canTransition: false,
        targetState: null,
        reasonCode: null,
        blockedReasons: ['No opportunities recorded yet'],
      };
    }

    case 'practicing': {
      // practicing → consolidating (CONSOLIDATION_CRITERIA_V1)
      const blockedReasons: string[] = [];
      const c = CONSOLIDATION_CRITERIA_V1;

      if (agg.totalOpportunities < c.minOpportunities) {
        blockedReasons.push(`Need ${c.minOpportunities} opportunities, have ${agg.totalOpportunities}`);
      }
      if (agg.successfulUses < c.minSuccessfulUses) {
        blockedReasons.push(`Need ${c.minSuccessfulUses} successful uses, have ${agg.successfulUses}`);
      }
      if (agg.independentUses < c.minIndependentUses) {
        blockedReasons.push(`Need ${c.minIndependentUses} independent use, have ${agg.independentUses}`);
      }
      if (agg.distinctContextCount < c.minDistinctContexts) {
        blockedReasons.push(`Need ${c.minDistinctContexts} distinct contexts, have ${agg.distinctContextCount}`);
      }
      if (agg.confidence < c.minConfidence) {
        blockedReasons.push(`Need confidence ≥ ${c.minConfidence}, have ${agg.confidence.toFixed(3)}`);
      }

      if (blockedReasons.length === 0) {
        return {
          canTransition: true,
          targetState: 'consolidating',
          reasonCode: 'SUFFICIENT_PRACTICE_EVIDENCE',
          blockedReasons: [],
        };
      }
      return {
        canTransition: false,
        targetState: null,
        reasonCode: null,
        blockedReasons,
      };
    }

    case 'consolidating': {
      // consolidating → mastered (MASTERY_CRITERIA_V1)
      const blockedReasons: string[] = [];
      const m = MASTERY_CRITERIA_V1;

      if (agg.totalOpportunities < m.minOpportunities) {
        blockedReasons.push(`Need ${m.minOpportunities} opportunities, have ${agg.totalOpportunities}`);
      }
      if (agg.successfulUses < m.minSuccessfulUses) {
        blockedReasons.push(`Need ${m.minSuccessfulUses} successful uses, have ${agg.successfulUses}`);
      }
      if (agg.independentUses < m.minIndependentUses) {
        blockedReasons.push(`Need ${m.minIndependentUses} independent uses, have ${agg.independentUses}`);
      }
      if (agg.distinctContextCount < m.minDistinctContexts) {
        blockedReasons.push(`Need ${m.minDistinctContexts} distinct contexts, have ${agg.distinctContextCount}`);
      }

      const totalAbsScore = agg.weightedSuccessScore + agg.weightedErrorScore;
      const precision = totalAbsScore > 0
        ? agg.weightedSuccessScore / totalAbsScore
        : 0;
      if (precision < m.minWeightedPrecision) {
        blockedReasons.push(`Need weighted precision ≥ ${m.minWeightedPrecision}, have ${precision.toFixed(3)}`);
      }

      if (agg.retentionSuccesses < m.minRetentionSuccesses) {
        blockedReasons.push(`Need ${m.minRetentionSuccesses} retention success, have ${agg.retentionSuccesses}`);
      }
      if (agg.confidence < m.minConfidence) {
        blockedReasons.push(`Need confidence ≥ ${m.minConfidence}, have ${agg.confidence.toFixed(3)}`);
      }

      if (blockedReasons.length === 0) {
        return {
          canTransition: true,
          targetState: 'mastered',
          reasonCode: 'MASTERY_CRITERIA_MET',
          blockedReasons: [],
        };
      }
      return {
        canTransition: false,
        targetState: null,
        reasonCode: null,
        blockedReasons,
      };
    }

    case 'mastered': {
      // mastered → maintenance: called externally by scheduler
      return {
        canTransition: true,
        targetState: 'maintenance',
        reasonCode: 'MAINTENANCE_DUE',
        blockedReasons: [],
      };
    }

    case 'maintenance': {
      // Terminal: stays maintenance until scheduler acts
      return {
        canTransition: false,
        targetState: null,
        reasonCode: null,
        blockedReasons: ['maintenance state is terminal; scheduler controls transitions'],
      };
    }

    default: {
      return {
        canTransition: false,
        targetState: null,
        reasonCode: null,
        blockedReasons: ['Unknown state'],
      };
    }
  }
}

// Evaluate if regression is warranted (must be conservative — err on side of NOT regressing)
export function evaluateRegressionTransition(
  agg: MasteryAggregate,
  recentFailureWindow: {
    failureCount: number;
    opportunityCount: number;
    distinctContextsWithFailure: number;
  },
): TransitionEvaluationResult {
  const { currentState } = agg;
  const { failureCount, opportunityCount, distinctContextsWithFailure } = recentFailureWindow;

  switch (currentState) {
    case 'mastered': {
      // mastered → consolidating:
      //   failureCount >= 3 AND opportunityCount >= 4
      //   AND distinctContextsWithFailure >= 2
      //   AND retentionFailures >= 1
      //   AND confidence < 0.60
      if (
        failureCount >= 3 &&
        opportunityCount >= 4 &&
        distinctContextsWithFailure >= 2 &&
        agg.retentionFailures >= 1 &&
        agg.confidence < 0.60
      ) {
        const reasonCode: GrammarMasteryReasonCode = agg.retentionFailures >= 1
          ? 'RETENTION_FAILURE'
          : 'REPEATED_RECENT_FAILURES';
        return {
          canTransition: true,
          targetState: 'consolidating',
          reasonCode,
          blockedReasons: [],
        };
      }
      return {
        canTransition: false,
        targetState: null,
        reasonCode: null,
        blockedReasons: ['Regression criteria not met for mastered state'],
      };
    }

    case 'consolidating': {
      // consolidating → practicing:
      //   failureCount >= 4 AND opportunityCount >= 5
      //   AND distinctContextsWithFailure >= 2
      //   AND confidence < 0.40
      if (
        failureCount >= 4 &&
        opportunityCount >= 5 &&
        distinctContextsWithFailure >= 2 &&
        agg.confidence < 0.40
      ) {
        return {
          canTransition: true,
          targetState: 'practicing',
          reasonCode: 'REPEATED_RECENT_FAILURES',
          blockedReasons: [],
        };
      }
      return {
        canTransition: false,
        targetState: null,
        reasonCode: null,
        blockedReasons: ['Regression criteria not met for consolidating state'],
      };
    }

    case 'maintenance': {
      // maintenance → consolidating:
      //   retentionFailures >= 2 AND retentionSuccesses === 0 AND confidence < 0.50
      if (
        agg.retentionFailures >= 2 &&
        agg.retentionSuccesses === 0 &&
        agg.confidence < 0.50
      ) {
        return {
          canTransition: true,
          targetState: 'consolidating',
          reasonCode: 'RETENTION_FAILURE',
          blockedReasons: [],
        };
      }
      return {
        canTransition: false,
        targetState: null,
        reasonCode: null,
        blockedReasons: ['Regression criteria not met for maintenance state'],
      };
    }

    // Never regress from locked, introduced, or practicing to locked
    default: {
      return {
        canTransition: false,
        targetState: null,
        reasonCode: null,
        blockedReasons: ['No valid regression from current state'],
      };
    }
  }
}
