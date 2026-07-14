import type { VocabularyRelationType } from './vocabulary-types';
import { normalizeVocabularyValue } from './vocabulary-normalization';

export interface RelationCheckInput {
  submittedValue: string;
  plannedValue: string;
  relationTypes: VocabularyRelationType[];
  contextHints: string[];  // context hints from vocabulary_item_relations
  contextFamily?: string;  // current context family
}

export interface RelationCheckResult {
  isAcceptableAlternative: boolean;
  relationType: VocabularyRelationType | null;
  confidenceScore: number;
  explanationCode: string;
}

// Check if submitted word is an acceptable alternative to the planned word
export function checkVocabularyRelation(input: RelationCheckInput): RelationCheckResult {
  const { relationTypes, contextHints, contextFamily } = input;

  // Priority order of relation types
  const priority: VocabularyRelationType[] = [
    'synonym',
    'preferred_alternative',
    'near_synonym',
    'contextual_equivalent',
    'related',
    'antonym',
  ];

  // Check each relation type in priority order
  for (const relType of priority) {
    if (!relationTypes.includes(relType)) continue;

    switch (relType) {
      case 'synonym':
        return {
          isAcceptableAlternative: true,
          relationType: 'synonym',
          confidenceScore: 0.95,
          explanationCode: 'SYNONYM_ACCEPTED',
        };

      case 'preferred_alternative':
        return {
          isAcceptableAlternative: true,
          relationType: 'preferred_alternative',
          confidenceScore: 0.90,
          explanationCode: 'PREFERRED_ALTERNATIVE_ACCEPTED',
        };

      case 'near_synonym': {
        // Acceptable if contextFamily matches contextHints OR no context hints
        const noHints = contextHints.length === 0;
        const contextMatches = contextFamily
          ? contextHints.some(hint => contextFamily.includes(hint) || hint.includes(contextFamily))
          : false;
        if (noHints || contextMatches) {
          return {
            isAcceptableAlternative: true,
            relationType: 'near_synonym',
            confidenceScore: noHints ? 0.75 : 0.85,
            explanationCode: 'NEAR_SYNONYM_ACCEPTED',
          };
        }
        // Context doesn't match — not acceptable
        return {
          isAcceptableAlternative: false,
          relationType: 'near_synonym',
          confidenceScore: 0.5,
          explanationCode: 'NEAR_SYNONYM_CONTEXT_MISMATCH',
        };
      }

      case 'contextual_equivalent': {
        // Acceptable only if context family matches
        if (!contextFamily) {
          return {
            isAcceptableAlternative: false,
            relationType: 'contextual_equivalent',
            confidenceScore: 0.3,
            explanationCode: 'CONTEXTUAL_EQUIVALENT_NO_CONTEXT',
          };
        }
        const matches = contextHints.some(hint =>
          contextFamily.includes(hint) || hint.includes(contextFamily),
        );
        if (matches) {
          return {
            isAcceptableAlternative: true,
            relationType: 'contextual_equivalent',
            confidenceScore: 0.80,
            explanationCode: 'CONTEXTUAL_EQUIVALENT_ACCEPTED',
          };
        }
        return {
          isAcceptableAlternative: false,
          relationType: 'contextual_equivalent',
          confidenceScore: 0.4,
          explanationCode: 'CONTEXTUAL_EQUIVALENT_CONTEXT_MISMATCH',
        };
      }

      case 'antonym':
        return {
          isAcceptableAlternative: false,
          relationType: 'antonym',
          confidenceScore: 0.95,
          explanationCode: 'ANTONYM_NOT_ACCEPTABLE',
        };

      case 'related':
        return {
          isAcceptableAlternative: false,
          relationType: 'related',
          confidenceScore: 0.70,
          explanationCode: 'RELATED_NOT_SUBSTITUTE',
        };
    }
  }

  // No matching relation found
  return {
    isAcceptableAlternative: false,
    relationType: null,
    confidenceScore: 0.0,
    explanationCode: 'NO_RELATION_FOUND',
  };
}

// Build a set of normalized values for a relation group
export function buildRelationSet(
  plannedNormalized: string,
  synonymNormalizedValues: string[],
): Set<string> {
  const result = new Set<string>();
  result.add(normalizeVocabularyValue(plannedNormalized));
  for (const syn of synonymNormalizedValues) {
    result.add(normalizeVocabularyValue(syn));
  }
  return result;
}
