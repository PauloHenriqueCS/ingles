import { canTransitionGrammarMastery } from '../learner/grammar-mastery-transitions';
import type { GrammarMasteryState } from '../learner/grammar-mastery-types';
import type { MasteryAggregate, TransitionEvaluationResult } from './mastery-rules';
import { evaluateForwardTransition, evaluateRegressionTransition } from './mastery-rules';

export interface RegressionWindow {
  failureCount: number;
  opportunityCount: number;
  distinctContextsWithFailure: number;
}

// Evaluate the appropriate next state based on aggregates
export function evaluateMasteryTransition(
  agg: MasteryAggregate,
  regressionWindow?: RegressionWindow,
): TransitionEvaluationResult {
  // 1. Check regression first (if window provided)
  if (regressionWindow !== undefined) {
    const regressionResult = evaluateRegressionTransition(agg, regressionWindow);
    if (regressionResult.canTransition && regressionResult.targetState !== null) {
      // 3. Validate against canTransitionGrammarMastery from existing domain
      const isAllowed = canTransitionGrammarMastery(
        agg.currentState,
        regressionResult.targetState,
        regressionResult.reasonCode ?? 'regression',
      );
      if (isAllowed) {
        return regressionResult;
      }
      return {
        canTransition: false,
        targetState: null,
        reasonCode: null,
        blockedReasons: [
          ...regressionResult.blockedReasons,
          `Domain transition ${agg.currentState} → ${regressionResult.targetState} not allowed`,
        ],
      };
    }
  }

  // 2. Check forward transition
  const forwardResult = evaluateForwardTransition(agg);
  if (forwardResult.canTransition && forwardResult.targetState !== null) {
    // 3. Validate against canTransitionGrammarMastery from existing domain
    const isAllowed = canTransitionGrammarMastery(
      agg.currentState,
      forwardResult.targetState,
    );
    if (isAllowed) {
      return forwardResult;
    }
    return {
      canTransition: false,
      targetState: null,
      reasonCode: null,
      blockedReasons: [
        ...forwardResult.blockedReasons,
        `Domain transition ${agg.currentState} → ${forwardResult.targetState} not allowed`,
      ],
    };
  }

  return forwardResult;
}

// Get all valid next states from current (used for UI or planning)
export function getValidNextStates(current: GrammarMasteryState): readonly GrammarMasteryState[] {
  const all: GrammarMasteryState[] = [
    'locked',
    'introduced',
    'practicing',
    'consolidating',
    'mastered',
    'maintenance',
  ];
  return all.filter(state => canTransitionGrammarMastery(current, state));
}
