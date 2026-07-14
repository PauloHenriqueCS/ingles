import { CURRENT_CATALOG_VERSION } from '../learner/constants';
import { DIAGNOSTIC_MISSION_1_OBJECTIVES, DIAGNOSTIC_MISSION_2_OBJECTIVES } from './writing-diagnostic-objectives';
import type { WritingDiagnosticMissionPlan } from './writing-diagnostic-types';

/**
 * Cria o plano diagnóstico para a missão 1.
 *
 * O plano é determinístico — não varia entre chamadas para o mesmo usuário.
 * A IA não decide o que será avaliado: ela recebe o plano e executa.
 */
export function createMission1Plan(): WritingDiagnosticMissionPlan {
  return {
    diagnosticSequence: 1,
    catalogVersion: CURRENT_CATALOG_VERSION,
    objectives: [...DIAGNOSTIC_MISSION_1_OBJECTIVES],
    requiredCommunicativeFunctions: [
      'descrever uma situação presente ou recente',
      'expressar opinião ou preferência pessoal',
      'explicar o motivo de uma decisão ou reação',
      'conectar ideias com "because", "but", "so" ou equivalentes',
    ],
    optionalStretchSignals: [
      'uso espontâneo de present perfect',
      'uso de would/could/might para hipótese',
      'uso de conectores complexos (although, however, therefore)',
      'vocabulário além do cotidiano básico',
      'estruturas nominais complexas',
      'perguntas incorporadas (embedded questions)',
    ],
    forbiddenExplicitInstructions: [
      'use present perfect',
      'use past perfect',
      'use conditional',
      'use passive voice',
      'use reported speech',
      'use at least X tenses',
      'use advanced connectors',
      'voz passiva',
      'present perfect',
      'past perfect',
      'tempos verbais',
      'nível A1, A2, B1, B2, C1, C2',
      'CEFR',
      'diagnóstico',
      'avaliação',
      'teste',
    ],
    contentConstraints: {
      requireEverydaySituation: true,
      requireConflictOrDecision: true,
      avoidGenericSelfIntroduction: true,
      avoidGrammarTestLanguage: true,
    },
  };
}

/**
 * Cria o plano diagnóstico para a missão 2.
 *
 * Complementa a missão 1: busca evidências de referência temporal passada,
 * narração sequencial e intenção futura.
 */
export function createMission2Plan(): WritingDiagnosticMissionPlan {
  return {
    diagnosticSequence: 2,
    catalogVersion: CURRENT_CATALOG_VERSION,
    objectives: [...DIAGNOSTIC_MISSION_2_OBJECTIVES],
    requiredCommunicativeFunctions: [
      'narrar eventos passados em sequência',
      'expressar consequência de uma decisão',
      'indicar intenção ou plano futuro',
      'avaliar retrospectivamente uma decisão tomada',
    ],
    optionalStretchSignals: [
      'uso espontâneo de past perfect (had + participle)',
      'uso de conditionals (if I had known…, I would have…)',
      'uso de present perfect para ligar passado e presente',
      'coesão com conectores complexos',
      'vocabulário narrativo sofisticado',
    ],
    forbiddenExplicitInstructions: [
      'use past perfect',
      'use present perfect',
      'use conditional',
      'use passive voice',
      'use reported speech',
      'use at least X tenses',
      'use advanced connectors',
      'tempos verbais',
      'nível A1, A2, B1, B2, C1, C2',
      'CEFR',
      'diagnóstico',
      'avaliação',
      'teste',
    ],
    contentConstraints: {
      requireEverydaySituation: true,
      requireConflictOrDecision: true,
      avoidGenericSelfIntroduction: true,
      avoidGrammarTestLanguage: true,
    },
  };
}

/**
 * Cria o plano diagnóstico pela sequência.
 * Função utilitária para o serviço de geração.
 */
export function createDiagnosticPlan(sequence: 1 | 2): WritingDiagnosticMissionPlan {
  return sequence === 1 ? createMission1Plan() : createMission2Plan();
}
