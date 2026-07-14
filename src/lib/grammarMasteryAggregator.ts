/**
 * SERVER-ONLY: orchestrate aggregate update + transition evaluation + history.
 * Nunca importar em componentes React ou bundles client-side.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { LearnerGrammarEvidence } from '../domain/grammar-evidence/evidence-types';
import { evaluateMasteryTransition } from '../domain/grammar-evidence/mastery-transitions';
import { GRAMMAR_MASTERY_RULES_VERSION } from '../domain/grammar-evidence/rules-version';
import { transitionGrammarMasteryState } from './learnerGrammarMasteryService';
import { getRecentEvidenceForTopic } from './grammarEvidenceRepository';
import { computeMasteryAggregateFromEvidence, persistMasteryAggregate } from './grammarMasteryAggregateRepository';
import { recordMasteryTransitionHistory } from './grammarMasteryHistoryRepository';
import { logGrammarEvidenceEvent } from './grammarEvidenceObservability';

// Called after new evidence is created. Updates aggregates + evaluates transitions.
export async function updateMasteryAfterEvidence(
  supabase: SupabaseClient,
  userId: string,
  grammarTopicId: string,
  newEvidence: LearnerGrammarEvidence,
): Promise<void> {
  const updatedAt = new Date().toISOString();

  // 1. Compute full aggregate from all evidence (including new)
  const agg = await computeMasteryAggregateFromEvidence(supabase, userId, grammarTopicId);
  const previousState = agg.currentState;
  const previousConfidence = agg.confidence;

  // 2. Persist aggregate counters
  await persistMasteryAggregate(supabase, userId, grammarTopicId, agg, updatedAt);

  logGrammarEvidenceEvent({
    event: 'grammar_mastery_aggregate_updated',
    userId,
    topicId: grammarTopicId,
    rulesVersion: GRAMMAR_MASTERY_RULES_VERSION,
  });

  // 3. Load recent failure window (last 14 days)
  const recentEvidence = await getRecentEvidenceForTopic(supabase, userId, grammarTopicId, 14);

  const failureCount = recentEvidence.filter(
    e => e.evidenceType === 'error' || e.evidenceType === 'retention_failure',
  ).length;
  const opportunityCount = recentEvidence.filter(
    e =>
      e.evidenceType === 'opportunity' ||
      e.evidenceType === 'successful_use' ||
      e.evidenceType === 'error' ||
      e.evidenceType === 'partial_success' ||
      e.evidenceType === 'retention_success' ||
      e.evidenceType === 'retention_failure',
  ).length;
  const contextsWithFailure = new Set(
    recentEvidence
      .filter(e => e.evidenceType === 'error' || e.evidenceType === 'retention_failure')
      .map(e => e.contextFamily),
  );

  const regressionWindow = {
    failureCount,
    opportunityCount,
    distinctContextsWithFailure: contextsWithFailure.size,
  };

  // 4. Evaluate mastery transition
  const transitionResult = evaluateMasteryTransition(agg, regressionWindow);

  // 5. If transition canTransition AND targetState:
  if (transitionResult.canTransition && transitionResult.targetState !== null) {
    try {
      await transitionGrammarMasteryState(supabase, {
        userId,
        grammarTopicId,
        newState: transitionResult.targetState,
        reason: transitionResult.reasonCode ?? undefined,
        confidence: agg.confidence,
      });

      // b. Record history
      await recordMasteryTransitionHistory(supabase, {
        userId,
        grammarTopicId,
        previousState,
        newState: transitionResult.targetState,
        previousConfidence,
        newConfidence: agg.confidence,
        reasonCode: transitionResult.reasonCode!,
        evidenceIds: [newEvidence.id],
        rulesVersion: GRAMMAR_MASTERY_RULES_VERSION,
      });

      // c. Log event
      logGrammarEvidenceEvent({
        event: 'grammar_mastery_transitioned',
        userId,
        topicId: grammarTopicId,
        previousState,
        newState: transitionResult.targetState,
        rulesVersion: GRAMMAR_MASTERY_RULES_VERSION,
      });
    } catch (err) {
      // Log but don't re-throw — counter update succeeded; transition failure is non-fatal
      logGrammarEvidenceEvent({
        event: 'grammar_evidence_processing_failed',
        userId,
        topicId: grammarTopicId,
        errorMessage: err instanceof Error ? err.message : String(err),
        rulesVersion: GRAMMAR_MASTERY_RULES_VERSION,
      });
    }
  } else if (!transitionResult.canTransition && transitionResult.blockedReasons.length > 0) {
    // 6. If blocked: log event
    logGrammarEvidenceEvent({
      event: 'grammar_mastery_transition_blocked',
      userId,
      topicId: grammarTopicId,
      rulesVersion: GRAMMAR_MASTERY_RULES_VERSION,
    });
  }
}
