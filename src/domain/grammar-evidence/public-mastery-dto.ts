import type { GrammarMasteryState } from '../learner/grammar-mastery-types';
import type { MasteryAggregate } from './mastery-rules';

export interface PublicGrammarMasteryDTO {
  grammarTopicId: string;
  titlePtBR: string;
  state: GrammarMasteryState;
  confidence: number;           // 0–1, suitable for progress bar
  progress: {
    opportunities: number;
    successfulUses: number;
    independentUses: number;
    distinctContexts: number;
  };
  lastPracticedAt: string | null;
  maintenanceDueAt: string | null;
}

export function buildPublicMasteryDTO(params: {
  grammarTopicId: string;
  titlePtBR: string;
  agg: MasteryAggregate;
  lastPracticedAt?: string | null;
  maintenanceDueAt?: string | null;
}): PublicGrammarMasteryDTO {
  const { grammarTopicId, titlePtBR, agg, lastPracticedAt, maintenanceDueAt } = params;

  // NEVER expose: internal weights, raw evidence, excerpts, reason codes, full rules, other users' data
  return {
    grammarTopicId,
    titlePtBR,
    state: agg.currentState,
    confidence: agg.confidence,
    progress: {
      opportunities: agg.totalOpportunities,
      successfulUses: agg.successfulUses,
      independentUses: agg.independentUses,
      distinctContexts: agg.distinctContextCount,
    },
    lastPracticedAt: lastPracticedAt ?? null,
    maintenanceDueAt: maintenanceDueAt ?? null,
  };
}
