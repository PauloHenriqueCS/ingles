/**
 * SERVER-ONLY: nunca importar em componentes React ou bundles client-side.
 * Usar apenas em /api/* (Vercel serverless functions).
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { LearnerGrammarMastery, GrammarMasteryState } from '../domain/learner/grammar-mastery-types';
import { assertTransitionAllowed } from '../domain/learner/grammar-mastery-transitions';
import { validateConfidence, validateGrammarMasteryState, validateGrammarMasteryCounters } from '../domain/learner/learner-profile-validation';
import { getLearnerGrammarMastery, listLearnerGrammarMastery, upsertLearnerGrammarMastery } from './learnerGrammarMasteryRepository';
import { CURRENT_CATALOG_VERSION } from '../domain/learner/constants';

export { getLearnerGrammarMastery, listLearnerGrammarMastery };

export interface TransitionGrammarMasteryParams {
  userId: string;
  grammarTopicId: string;
  newState: GrammarMasteryState;
  reason?: string;
  confidence?: number;
}

/**
 * Executa uma transição de estado de domínio gramatical.
 *
 * Valida a transição antes de qualquer escrita.
 * Regressões exigem `reason` não-vazio.
 * Transições inválidas lançam InvalidGrammarMasteryTransitionError.
 */
export async function transitionGrammarMasteryState(
  supabase: SupabaseClient,
  params: TransitionGrammarMasteryParams,
): Promise<LearnerGrammarMastery> {
  const { userId, grammarTopicId, newState, reason, confidence } = params;

  validateGrammarMasteryState(newState);
  if (confidence !== undefined) validateConfidence(confidence);

  const existing = await getLearnerGrammarMastery(supabase, userId, grammarTopicId);
  const currentState: GrammarMasteryState = existing?.state ?? 'locked';

  assertTransitionAllowed(currentState, newState, reason);

  const now = new Date().toISOString();
  const base = existing ?? {
    userId,
    grammarTopicId,
    catalogVersion: CURRENT_CATALOG_VERSION,
    state: 'locked' as GrammarMasteryState,
    totalOpportunities: 0,
    successfulUses: 0,
    errorCount: 0,
    independentUses: 0,
    guidedUses: 0,
    assistedUses: 0,
    distinctContextCount: 0,
    confidence: 0,
    firstIntroducedAt: null,
    lastPracticedAt: null,
    lastSuccessfulUseAt: null,
    masteredAt: null,
    maintenanceDueAt: null,
  };

  return upsertLearnerGrammarMastery(supabase, {
    ...base,
    state: newState,
    confidence: confidence ?? base.confidence,
    firstIntroducedAt:
      newState === 'introduced' && base.firstIntroducedAt == null ? now : base.firstIntroducedAt,
    masteredAt:
      newState === 'mastered' && base.masteredAt == null ? now : base.masteredAt,
  });
}

export interface UpdateGrammarMasteryCountersParams {
  userId: string;
  grammarTopicId: string;
  totalOpportunities: number;
  successfulUses: number;
  errorCount: number;
  independentUses: number;
  guidedUses: number;
  assistedUses: number;
  distinctContextCount: number;
  confidence: number;
  lastPracticedAt?: string;
  lastSuccessfulUseAt?: string | null;
}

/**
 * Atualiza contadores de evidências sem alterar o estado de domínio.
 * Não registra histórico de nível (contadores não são alterações de nível).
 * Valida invariantes dos contadores antes de qualquer escrita.
 */
export async function updateGrammarMasteryCounters(
  supabase: SupabaseClient,
  params: UpdateGrammarMasteryCountersParams,
): Promise<LearnerGrammarMastery> {
  const { userId, grammarTopicId, confidence } = params;

  validateConfidence(confidence);
  validateGrammarMasteryCounters({
    totalOpportunities: params.totalOpportunities,
    successfulUses: params.successfulUses,
    errorCount: params.errorCount,
    independentUses: params.independentUses,
    guidedUses: params.guidedUses,
    assistedUses: params.assistedUses,
  });

  const existing = await getLearnerGrammarMastery(supabase, userId, grammarTopicId);

  const base = existing ?? {
    userId,
    grammarTopicId,
    catalogVersion: CURRENT_CATALOG_VERSION,
    state: 'locked' as GrammarMasteryState,
    firstIntroducedAt: null,
    lastPracticedAt: null,
    lastSuccessfulUseAt: null,
    masteredAt: null,
    maintenanceDueAt: null,
  };

  return upsertLearnerGrammarMastery(supabase, {
    ...base,
    totalOpportunities: params.totalOpportunities,
    successfulUses: params.successfulUses,
    errorCount: params.errorCount,
    independentUses: params.independentUses,
    guidedUses: params.guidedUses,
    assistedUses: params.assistedUses,
    distinctContextCount: params.distinctContextCount,
    confidence,
    lastPracticedAt: params.lastPracticedAt ?? (existing?.lastPracticedAt ?? null),
    lastSuccessfulUseAt:
      params.lastSuccessfulUseAt !== undefined
        ? params.lastSuccessfulUseAt
        : (existing?.lastSuccessfulUseAt ?? null),
  });
}
