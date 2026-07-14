/**
 * SERVER-ONLY: write to learner_grammar_mastery_history.
 * Append-only audit log of meaningful mastery state transitions.
 * Only call on state changes, NOT on counter updates.
 * Nunca importar em componentes React ou bundles client-side.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { GrammarMasteryState } from '../domain/learner/grammar-mastery-types';
import type { GrammarMasteryReasonCode } from '../domain/grammar-evidence/evidence-types';

export interface RecordMasteryHistoryInput {
  userId: string;
  grammarTopicId: string;
  previousState: GrammarMasteryState;
  newState: GrammarMasteryState;
  previousConfidence: number;
  newConfidence: number;
  reasonCode: GrammarMasteryReasonCode;
  evidenceIds: string[];
  rulesVersion: string;
}

export async function recordMasteryTransitionHistory(
  supabase: SupabaseClient,
  input: RecordMasteryHistoryInput,
): Promise<void> {
  const { error } = await supabase
    .from('learner_grammar_mastery_history')
    .insert({
      user_id: input.userId,
      grammar_topic_id: input.grammarTopicId,
      previous_state: input.previousState,
      new_state: input.newState,
      previous_confidence: input.previousConfidence,
      new_confidence: input.newConfidence,
      reason_code: input.reasonCode,
      evidence_ids: input.evidenceIds,
      rules_version: input.rulesVersion,
      changed_at: new Date().toISOString(),
    });

  if (error) throw new Error(`recordMasteryTransitionHistory: ${error.message}`);
}
