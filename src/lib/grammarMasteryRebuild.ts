/**
 * SERVER-ONLY: full rebuild of mastery aggregate from evidence history.
 * Used for data corrections, backfills, and consistency checks.
 * Nunca importar em componentes React ou bundles client-side.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { evaluateMasteryTransition } from '../domain/grammar-evidence/mastery-transitions';
import { GRAMMAR_MASTERY_RULES_VERSION } from '../domain/grammar-evidence/rules-version';
import { transitionGrammarMasteryState } from './learnerGrammarMasteryService';
import { computeMasteryAggregateFromEvidence, persistMasteryAggregate } from './grammarMasteryAggregateRepository';
import { recordMasteryTransitionHistory } from './grammarMasteryHistoryRepository';
import { logGrammarEvidenceEvent } from './grammarEvidenceObservability';

export interface RebuildResult {
  grammarTopicId: string;
  userId: string;
  evidenceCount: number;
  previousConfidence: number;
  newConfidence: number;
  stateChanged: boolean;
  previousState: string;
  newState: string;
}

// Rebuild mastery aggregate for one user+topic from scratch
export async function rebuildLearnerGrammarMastery(
  supabase: SupabaseClient,
  userId: string,
  grammarTopicId: string,
): Promise<RebuildResult> {
  logGrammarEvidenceEvent({
    event: 'grammar_mastery_rebuild_started',
    userId,
    topicId: grammarTopicId,
    rulesVersion: GRAMMAR_MASTERY_RULES_VERSION,
  });

  // 2. Compute full aggregate from evidence
  const agg = await computeMasteryAggregateFromEvidence(supabase, userId, grammarTopicId);
  const previousState = agg.currentState;
  const previousConfidence = agg.confidence;

  // Count evidence rows (re-query for count)
  const { count: evidenceCount } = await supabase
    .from('learner_grammar_evidence')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('grammar_topic_id', grammarTopicId);

  // 3. Persist aggregate
  const updatedAt = new Date().toISOString();
  await persistMasteryAggregate(supabase, userId, grammarTopicId, agg, updatedAt);

  // 4. Evaluate mastery transition
  const transitionResult = evaluateMasteryTransition(agg);

  let stateChanged = false;
  let newState = previousState;

  // 5. If transition: update state + record history
  if (transitionResult.canTransition && transitionResult.targetState !== null) {
    try {
      await transitionGrammarMasteryState(supabase, {
        userId,
        grammarTopicId,
        newState: transitionResult.targetState,
        reason: transitionResult.reasonCode ?? undefined,
        confidence: agg.confidence,
      });

      await recordMasteryTransitionHistory(supabase, {
        userId,
        grammarTopicId,
        previousState,
        newState: transitionResult.targetState,
        previousConfidence,
        newConfidence: agg.confidence,
        reasonCode: transitionResult.reasonCode!,
        evidenceIds: [],
        rulesVersion: GRAMMAR_MASTERY_RULES_VERSION,
      });

      stateChanged = true;
      newState = transitionResult.targetState;
    } catch (err) {
      logGrammarEvidenceEvent({
        event: 'grammar_evidence_processing_failed',
        userId,
        topicId: grammarTopicId,
        errorMessage: err instanceof Error ? err.message : String(err),
        rulesVersion: GRAMMAR_MASTERY_RULES_VERSION,
      });
    }
  }

  const result: RebuildResult = {
    grammarTopicId,
    userId,
    evidenceCount: evidenceCount ?? 0,
    previousConfidence,
    newConfidence: agg.confidence,
    stateChanged,
    previousState,
    newState,
  };

  // 6. Log rebuild_completed
  logGrammarEvidenceEvent({
    event: 'grammar_mastery_rebuild_completed',
    userId,
    topicId: grammarTopicId,
    previousState,
    newState,
    rulesVersion: GRAMMAR_MASTERY_RULES_VERSION,
  });

  return result;
}

// Rebuild all topics for a user
export async function rebuildAllTopicsForUser(
  supabase: SupabaseClient,
  userId: string,
): Promise<RebuildResult[]> {
  // List all grammar_topic_ids from learner_grammar_mastery for this user
  const { data, error } = await supabase
    .from('learner_grammar_mastery')
    .select('grammar_topic_id')
    .eq('user_id', userId);

  if (error) throw new Error(`rebuildAllTopicsForUser: ${error.message}`);

  const topicIds = (data ?? []).map(row => String((row as Record<string, unknown>).grammar_topic_id));
  const results: RebuildResult[] = [];

  for (const grammarTopicId of topicIds) {
    const result = await rebuildLearnerGrammarMastery(supabase, userId, grammarTopicId);
    results.push(result);
  }

  return results;
}
