/**
 * Pure promotion engine — no async, no DB calls.
 * All logic derived from the evidence bundle and rules.
 */

import type { CEFRLevel } from '../domain/curriculum/cefr';
import type {
  PromotionEvidenceBundle,
  SkillPromotionEvaluation,
  RequirementResult,
  PromotionRequirementStatus,
  PromotionRegressionSignal,
  TopicMasteryInfo,
} from '../domain/promotion/promotion-types';
import {
  PROMOTION_ENGINE_VERSION,
  PROMOTION_CURRICULUM_VERSION,
  MIN_VALID_MISSIONS_BY_LEVEL,
  PROMOTION_RULES,
  PROMOTION_PROGRESS_WEIGHTS,
  MAX_SUPPORTED_PROMOTION_LEVEL,
  NEXT_LEVEL,
} from '../domain/promotion/promotion-rules';

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function req(
  key: string,
  label: string,
  status: PromotionRequirementStatus,
  currentValue: number | string | null,
  requiredValue: number | string | null,
  explanation: string,
  confidence?: number,
  pendingItems?: string[],
): RequirementResult {
  const r: RequirementResult = { key, label, status, currentValue, requiredValue, explanation };
  if (confidence !== undefined) r.confidence = confidence;
  if (pendingItems !== undefined) r.pendingItems = pendingItems;
  return r;
}

// ── Confidence calculation ────────────────────────────────────────────────────

function calculateConfidence(
  bundle: PromotionEvidenceBundle,
  requiredMissions: number,
): number {
  const reductions: number[] = [];
  const { missions, checkpoints, topicMastery, consistency } = bundle;

  if (missions.validCount < requiredMissions * 1.5) {
    reductions.push(0.15);
  }
  if (consistency.distinctDates < 3) {
    reductions.push(0.20);
  }
  if (consistency.singleSessionOnly) {
    reductions.push(0.25);
  }
  if (checkpoints.completedCount < 3) {
    reductions.push(0.10);
  }
  if (topicMastery.length === 0) {
    reductions.push(0.10);
  }

  const totalReduction = reductions.reduce((sum, r) => sum + r, 0);
  return clamp(1.0 - totalReduction, 0, 1);
}

// ── Progress calculation ──────────────────────────────────────────────────────

function calculateProgress(
  bundle: PromotionEvidenceBundle,
  requiredMissions: number,
  essentialTopicCoverage: number,
  prerequisiteCoverage: number,
  objectiveAccuracy: number | null,
  distinctContexts: number,
  promotionConfidence: number,
): number {
  const { missions, checkpoints, consistency } = bundle;
  const w = PROMOTION_PROGRESS_WEIGHTS;

  const missionScore = clamp(missions.validCount / requiredMissions, 0, 1);
  const essentialTopicsScore = clamp(essentialTopicCoverage, 0, 1);
  const prerequisitesScore = clamp(prerequisiteCoverage, 0, 1);
  const objectiveAccuracyScore = objectiveAccuracy != null
    ? clamp(objectiveAccuracy / PROMOTION_RULES.minimumObjectiveAccuracy, 0, 1)
    : 0;
  const contextDiversityScore = clamp(
    distinctContexts / PROMOTION_RULES.minimumDistinctContexts,
    0,
    1,
  );
  const checkpointScore =
    clamp(checkpoints.passedCount / PROMOTION_RULES.requiredCheckpointPasses, 0, 1) *
    (checkpoints.completedCount >= PROMOTION_RULES.requiredCompletedCheckpoints ? 1 : 0.5);
  const consistencyScore =
    consistency.distinctDates >= PROMOTION_RULES.minimumDistinctDates && !consistency.singleSessionOnly
      ? 1
      : 0;
  const confidenceScore = clamp(
    promotionConfidence / PROMOTION_RULES.minimumConfidence,
    0,
    1,
  );

  const weighted =
    w.missions * missionScore +
    w.essentialTopics * essentialTopicsScore +
    w.prerequisites * prerequisitesScore +
    w.objectiveAccuracy * objectiveAccuracyScore +
    w.contextDiversity * contextDiversityScore +
    w.checkpoints * checkpointScore +
    w.consistency * consistencyScore +
    w.confidence * confidenceScore;

  return clamp(weighted * 100, 0, 100);
}

// ── Regression signal ─────────────────────────────────────────────────────────

function calculateRegressionSignal(
  topicMastery: TopicMasteryInfo[],
  objectiveAccuracy: number | null,
  confidence: number,
  singleSessionOnly: boolean,
): PromotionRegressionSignal {
  const essentialMastered = topicMastery.filter(t => t.isEssential && t.mastered);
  const avgConfidence =
    essentialMastered.length > 0
      ? essentialMastered.reduce((sum, t) => sum + t.confidence, 0) / essentialMastered.length
      : null;

  if (singleSessionOnly && objectiveAccuracy != null && objectiveAccuracy < 0.60) {
    return 'reassessment_required';
  }
  if (objectiveAccuracy != null && (objectiveAccuracy < 0.50 || confidence < 0.40)) {
    return 'possible_regression';
  }
  if (objectiveAccuracy != null && objectiveAccuracy < 0.65) {
    return 'attention_required';
  }
  if (avgConfidence != null && avgConfidence > 0.7) {
    return 'stable';
  }
  // Default when no data to determine
  return 'stable';
}

// ── Writing skill evaluation ──────────────────────────────────────────────────

function evaluateWritingRequirements(
  bundle: PromotionEvidenceBundle,
  requiredMissions: number,
): {
  requirements: RequirementResult[];
  essentialTopicCoverage: number;
  prerequisiteCoverage: number;
  objectiveAccuracy: number | null;
  distinctContexts: number;
  hasConfigError: boolean;
} {
  const { missions, topicMastery, checkpoints, consistency } = bundle;
  const requirements: RequirementResult[] = [];

  const essentialTopics = topicMastery.filter(t => t.isEssential);
  const hasConfigError = essentialTopics.length === 0;

  // 1. Mission count
  const missionStatus: PromotionRequirementStatus =
    missions.validCount >= requiredMissions ? 'passed' : 'failed';
  requirements.push(req(
    'missions',
    'Missões válidas',
    missionStatus,
    missions.validCount,
    requiredMissions,
    missionStatus === 'passed'
      ? `${missions.validCount} missões concluídas (mínimo: ${requiredMissions})`
      : `Apenas ${missions.validCount} de ${requiredMissions} missões concluídas`,
  ));

  // 2. Essential topic coverage
  let essentialTopicCoverage = 0;
  if (hasConfigError) {
    requirements.push(req(
      'essential_topics',
      'Tópicos essenciais dominados',
      'configuration_error',
      null,
      PROMOTION_RULES.minimumEssentialTopicCoverage,
      'Nenhum tópico essencial encontrado no catálogo para este nível. Erro de configuração.',
    ));
  } else {
    const masteredEssential = essentialTopics.filter(t => t.mastered);
    essentialTopicCoverage = masteredEssential.length / essentialTopics.length;
    const topicStatus: PromotionRequirementStatus =
      essentialTopicCoverage >= PROMOTION_RULES.minimumEssentialTopicCoverage ? 'passed' : 'failed';
    requirements.push(req(
      'essential_topics',
      'Tópicos essenciais dominados',
      topicStatus,
      Math.round(essentialTopicCoverage * 100),
      Math.round(PROMOTION_RULES.minimumEssentialTopicCoverage * 100),
      topicStatus === 'passed'
        ? `${masteredEssential.length}/${essentialTopics.length} tópicos essenciais dominados`
        : `Apenas ${masteredEssential.length}/${essentialTopics.length} tópicos essenciais dominados`,
    ));
  }

  // 3. Prerequisites coverage
  let prerequisiteCoverage = 0;
  if (hasConfigError) {
    requirements.push(req(
      'prerequisites',
      'Pré-requisitos dominados',
      'configuration_error',
      null,
      100,
      'Erro de configuração: sem tópicos essenciais para verificar pré-requisitos.',
    ));
  } else {
    const essentialWithPrereqs = essentialTopics.filter(t => t.prerequisites.length > 0);
    if (essentialWithPrereqs.length === 0) {
      prerequisiteCoverage = 1.0;
      requirements.push(req(
        'prerequisites',
        'Pré-requisitos dominados',
        'passed',
        100,
        100,
        'Nenhum pré-requisito pendente para este nível.',
      ));
    } else {
      const allPrereqsMet = essentialWithPrereqs.every(t => t.prerequisitesMastered);
      prerequisiteCoverage = allPrereqsMet ? 1.0 : 0.0;
      const prereqStatus: PromotionRequirementStatus = allPrereqsMet ? 'passed' : 'failed';
      const notMet = essentialWithPrereqs.filter(t => !t.prerequisitesMastered);
      requirements.push(req(
        'prerequisites',
        'Pré-requisitos dominados',
        prereqStatus,
        allPrereqsMet ? 100 : Math.round((essentialWithPrereqs.length - notMet.length) / essentialWithPrereqs.length * 100),
        100,
        prereqStatus === 'passed'
          ? 'Todos os pré-requisitos foram dominados.'
          : `${notMet.length} tópicos essenciais com pré-requisitos pendentes.`,
        undefined,
        notMet.map(t => t.topicId),
      ));
    }
  }

  // 4. Objective accuracy (weighted average)
  let objectiveAccuracy: number | null = null;
  const topicsWithOpportunities = topicMastery.filter(t => t.isEssential && t.totalOpportunities > 0);
  if (topicsWithOpportunities.length === 0) {
    requirements.push(req(
      'objective_accuracy',
      'Precisão nos objetivos',
      'insufficient_data',
      null,
      Math.round(PROMOTION_RULES.minimumObjectiveAccuracy * 100),
      'Dados insuficientes para calcular precisão: nenhuma oportunidade registrada.',
    ));
  } else {
    const totalWeight = topicsWithOpportunities.reduce((s, t) => s + t.confidence, 0);
    if (totalWeight === 0) {
      objectiveAccuracy = 0;
    } else {
      const weightedSum = topicsWithOpportunities.reduce((s, t) => {
        const rate = t.successfulUses / Math.max(t.totalOpportunities, 1);
        return s + rate * t.confidence;
      }, 0);
      objectiveAccuracy = weightedSum / totalWeight;
    }
    const accuracyStatus: PromotionRequirementStatus =
      objectiveAccuracy >= PROMOTION_RULES.minimumObjectiveAccuracy ? 'passed' : 'failed';
    requirements.push(req(
      'objective_accuracy',
      'Precisão nos objetivos',
      accuracyStatus,
      Math.round(objectiveAccuracy * 100),
      Math.round(PROMOTION_RULES.minimumObjectiveAccuracy * 100),
      accuracyStatus === 'passed'
        ? `Precisão de ${Math.round(objectiveAccuracy * 100)}% (mínimo: ${Math.round(PROMOTION_RULES.minimumObjectiveAccuracy * 100)}%)`
        : `Precisão de ${Math.round(objectiveAccuracy * 100)}% abaixo do mínimo de ${Math.round(PROMOTION_RULES.minimumObjectiveAccuracy * 100)}%`,
    ));
  }

  // 5. Context diversity
  const masteredEssential = essentialTopics.filter(t => t.mastered);
  const distinctContexts =
    masteredEssential.length > 0
      ? Math.max(...masteredEssential.map(t => t.distinctContextCount))
      : 0;
  const contextStatus: PromotionRequirementStatus =
    distinctContexts >= PROMOTION_RULES.minimumDistinctContexts ? 'passed' : 'failed';
  requirements.push(req(
    'context_diversity',
    'Diversidade de contextos',
    contextStatus,
    distinctContexts,
    PROMOTION_RULES.minimumDistinctContexts,
    contextStatus === 'passed'
      ? `${distinctContexts} contextos distintos (mínimo: ${PROMOTION_RULES.minimumDistinctContexts})`
      : `Apenas ${distinctContexts} contextos distintos (mínimo: ${PROMOTION_RULES.minimumDistinctContexts})`,
  ));

  // 6. Checkpoints
  let checkpointStatus: PromotionRequirementStatus;
  if (checkpoints.completedCount < PROMOTION_RULES.requiredCompletedCheckpoints) {
    checkpointStatus = 'insufficient_data';
  } else {
    checkpointStatus =
      checkpoints.passedCount >= PROMOTION_RULES.requiredCheckpointPasses ? 'passed' : 'failed';
  }
  requirements.push(req(
    'checkpoints',
    'Checkpoints aprovados',
    checkpointStatus,
    `${checkpoints.passedCount}/${checkpoints.completedCount}`,
    `${PROMOTION_RULES.requiredCheckpointPasses}/${PROMOTION_RULES.requiredCompletedCheckpoints}`,
    checkpointStatus === 'insufficient_data'
      ? `Apenas ${checkpoints.completedCount} de ${PROMOTION_RULES.requiredCompletedCheckpoints} checkpoints completados.`
      : checkpointStatus === 'passed'
        ? `${checkpoints.passedCount} de ${checkpoints.completedCount} checkpoints aprovados.`
        : `Apenas ${checkpoints.passedCount} de ${checkpoints.completedCount} checkpoints aprovados (mínimo: ${PROMOTION_RULES.requiredCheckpointPasses}).`,
  ));

  // 7. Consistency
  const consistencyStatus: PromotionRequirementStatus =
    consistency.distinctDates >= PROMOTION_RULES.minimumDistinctDates && !consistency.singleSessionOnly
      ? 'passed'
      : consistency.distinctDates < 2
        ? 'insufficient_data'
        : 'failed';
  requirements.push(req(
    'consistency',
    'Consistência ao longo do tempo',
    consistencyStatus,
    consistency.distinctDates,
    PROMOTION_RULES.minimumDistinctDates,
    consistencyStatus === 'passed'
      ? `Evidências em ${consistency.distinctDates} dias distintos.`
      : consistency.singleSessionOnly
        ? 'Todas as evidências vêm de uma única sessão.'
        : `Evidências em apenas ${consistency.distinctDates} dias distintos (mínimo: ${PROMOTION_RULES.minimumDistinctDates}).`,
  ));

  return {
    requirements,
    essentialTopicCoverage,
    prerequisiteCoverage,
    objectiveAccuracy,
    distinctContexts,
    hasConfigError,
  };
}

// ── Pronunciation skill evaluation ────────────────────────────────────────────

function evaluatePronunciationRequirements(
  bundle: PromotionEvidenceBundle,
  requiredMissions: number,
): {
  requirements: RequirementResult[];
  essentialTopicCoverage: number;
  prerequisiteCoverage: number;
  objectiveAccuracy: number | null;
  distinctContexts: number;
  hasConfigError: boolean;
} {
  const { missions, checkpoints, consistency, pronunciationAccuracy } = bundle;
  const requirements: RequirementResult[] = [];

  // 1. Mission count (pronunciation assessments)
  const missionStatus: PromotionRequirementStatus =
    missions.validCount >= requiredMissions ? 'passed' : 'failed';
  requirements.push(req(
    'missions',
    'Avaliações de pronúncia concluídas',
    missionStatus,
    missions.validCount,
    requiredMissions,
    missionStatus === 'passed'
      ? `${missions.validCount} avaliações concluídas (mínimo: ${requiredMissions})`
      : `Apenas ${missions.validCount} de ${requiredMissions} avaliações concluídas`,
  ));

  // 2. Essential topics — insufficient_data (no curriculum for pronunciation yet)
  requirements.push(req(
    'essential_topics',
    'Tópicos essenciais (pronúncia)',
    'insufficient_data',
    null,
    null,
    'Currículo de tópicos para pronúncia ainda não disponível.',
  ));

  // 3. Prerequisites — insufficient_data
  requirements.push(req(
    'prerequisites',
    'Pré-requisitos (pronúncia)',
    'insufficient_data',
    null,
    null,
    'Verificação de pré-requisitos não disponível para pronúncia.',
  ));

  // 4. Objective accuracy (pronunciationAccuracy)
  let objectiveAccuracy: number | null = null;
  if (pronunciationAccuracy == null) {
    requirements.push(req(
      'objective_accuracy',
      'Precisão de pronúncia',
      'insufficient_data',
      null,
      Math.round(PROMOTION_RULES.minimumObjectiveAccuracy * 100),
      'Dados de precisão de pronúncia não disponíveis.',
    ));
  } else {
    objectiveAccuracy = pronunciationAccuracy;
    const accuracyStatus: PromotionRequirementStatus =
      objectiveAccuracy >= PROMOTION_RULES.minimumObjectiveAccuracy ? 'passed' : 'failed';
    requirements.push(req(
      'objective_accuracy',
      'Precisão de pronúncia',
      accuracyStatus,
      Math.round(objectiveAccuracy * 100),
      Math.round(PROMOTION_RULES.minimumObjectiveAccuracy * 100),
      accuracyStatus === 'passed'
        ? `Precisão de ${Math.round(objectiveAccuracy * 100)}%`
        : `Precisão de ${Math.round(objectiveAccuracy * 100)}% abaixo do mínimo`,
    ));
  }

  // 5. Context diversity — insufficient_data
  requirements.push(req(
    'context_diversity',
    'Diversidade de contextos (pronúncia)',
    'insufficient_data',
    null,
    PROMOTION_RULES.minimumDistinctContexts,
    'Infraestrutura de contextos de pronúncia ainda não disponível.',
  ));

  // 6. Checkpoints
  let checkpointStatus: PromotionRequirementStatus;
  if (checkpoints.completedCount < PROMOTION_RULES.requiredCompletedCheckpoints) {
    checkpointStatus = 'insufficient_data';
  } else {
    checkpointStatus =
      checkpoints.passedCount >= PROMOTION_RULES.requiredCheckpointPasses ? 'passed' : 'failed';
  }
  requirements.push(req(
    'checkpoints',
    'Checkpoints aprovados',
    checkpointStatus,
    `${checkpoints.passedCount}/${checkpoints.completedCount}`,
    `${PROMOTION_RULES.requiredCheckpointPasses}/${PROMOTION_RULES.requiredCompletedCheckpoints}`,
    checkpointStatus === 'insufficient_data'
      ? `Apenas ${checkpoints.completedCount} de ${PROMOTION_RULES.requiredCompletedCheckpoints} checkpoints completados.`
      : checkpointStatus === 'passed'
        ? `${checkpoints.passedCount} checkpoints aprovados.`
        : `Apenas ${checkpoints.passedCount} checkpoints aprovados.`,
  ));

  // 7. Consistency
  const consistencyStatus: PromotionRequirementStatus =
    consistency.distinctDates >= PROMOTION_RULES.minimumDistinctDates && !consistency.singleSessionOnly
      ? 'passed'
      : consistency.distinctDates < 2
        ? 'insufficient_data'
        : 'failed';
  requirements.push(req(
    'consistency',
    'Consistência ao longo do tempo',
    consistencyStatus,
    consistency.distinctDates,
    PROMOTION_RULES.minimumDistinctDates,
    consistencyStatus === 'passed'
      ? `Evidências em ${consistency.distinctDates} dias distintos.`
      : `Evidências em apenas ${consistency.distinctDates} dias distintos.`,
  ));

  return {
    requirements,
    essentialTopicCoverage: 0,
    prerequisiteCoverage: 0,
    objectiveAccuracy,
    distinctContexts: 0,
    hasConfigError: false,
  };
}

// ── Conversation skill evaluation ─────────────────────────────────────────────

function evaluateConversationRequirements(
  bundle: PromotionEvidenceBundle,
  requiredMissions: number,
): {
  requirements: RequirementResult[];
  essentialTopicCoverage: number;
  prerequisiteCoverage: number;
  objectiveAccuracy: number | null;
  distinctContexts: number;
  hasConfigError: boolean;
} {
  const { checkpoints, consistency, conversationSessionCount, conversationDistinctContexts } = bundle;
  const requirements: RequirementResult[] = [];

  const sessionCount = conversationSessionCount ?? 0;
  const distinctContexts = conversationDistinctContexts ?? 0;

  // 1. Session count (valid conversation sessions)
  const missionStatus: PromotionRequirementStatus =
    sessionCount >= requiredMissions ? 'passed' : 'failed';
  requirements.push(req(
    'missions',
    'Sessões de conversação válidas',
    missionStatus,
    sessionCount,
    requiredMissions,
    missionStatus === 'passed'
      ? `${sessionCount} sessões válidas (mínimo: ${requiredMissions})`
      : `Apenas ${sessionCount} de ${requiredMissions} sessões válidas`,
  ));

  // 2. Essential topics — insufficient_data
  requirements.push(req(
    'essential_topics',
    'Tópicos essenciais (conversação)',
    'insufficient_data',
    null,
    null,
    'Currículo de tópicos para conversação ainda não disponível.',
  ));

  // 3. Prerequisites — insufficient_data
  requirements.push(req(
    'prerequisites',
    'Pré-requisitos (conversação)',
    'insufficient_data',
    null,
    null,
    'Verificação de pré-requisitos não disponível para conversação.',
  ));

  // 4. Objective accuracy — insufficient_data
  requirements.push(req(
    'objective_accuracy',
    'Precisão nos objetivos (conversação)',
    'insufficient_data',
    null,
    Math.round(PROMOTION_RULES.minimumObjectiveAccuracy * 100),
    'Dados de precisão para conversação ainda não disponíveis.',
  ));

  // 5. Context diversity (conversationDistinctContexts)
  const contextStatus: PromotionRequirementStatus =
    distinctContexts >= PROMOTION_RULES.minimumDistinctContexts ? 'passed' : 'failed';
  requirements.push(req(
    'context_diversity',
    'Diversidade de contextos',
    contextStatus,
    distinctContexts,
    PROMOTION_RULES.minimumDistinctContexts,
    contextStatus === 'passed'
      ? `${distinctContexts} contextos distintos de conversação.`
      : `Apenas ${distinctContexts} contextos distintos (mínimo: ${PROMOTION_RULES.minimumDistinctContexts}).`,
  ));

  // 6. Checkpoints
  let checkpointStatus: PromotionRequirementStatus;
  if (checkpoints.completedCount < PROMOTION_RULES.requiredCompletedCheckpoints) {
    checkpointStatus = 'insufficient_data';
  } else {
    checkpointStatus =
      checkpoints.passedCount >= PROMOTION_RULES.requiredCheckpointPasses ? 'passed' : 'failed';
  }
  requirements.push(req(
    'checkpoints',
    'Checkpoints aprovados',
    checkpointStatus,
    `${checkpoints.passedCount}/${checkpoints.completedCount}`,
    `${PROMOTION_RULES.requiredCheckpointPasses}/${PROMOTION_RULES.requiredCompletedCheckpoints}`,
    checkpointStatus === 'insufficient_data'
      ? `Apenas ${checkpoints.completedCount} de ${PROMOTION_RULES.requiredCompletedCheckpoints} checkpoints completados.`
      : checkpointStatus === 'passed'
        ? `${checkpoints.passedCount} checkpoints aprovados.`
        : `Apenas ${checkpoints.passedCount} checkpoints aprovados.`,
  ));

  // 7. Consistency
  const consistencyStatus: PromotionRequirementStatus =
    consistency.distinctDates >= PROMOTION_RULES.minimumDistinctDates && !consistency.singleSessionOnly
      ? 'passed'
      : consistency.distinctDates < 2
        ? 'insufficient_data'
        : 'failed';
  requirements.push(req(
    'consistency',
    'Consistência ao longo do tempo',
    consistencyStatus,
    consistency.distinctDates,
    PROMOTION_RULES.minimumDistinctDates,
    consistencyStatus === 'passed'
      ? `Evidências em ${consistency.distinctDates} dias distintos.`
      : `Evidências em apenas ${consistency.distinctDates} dias distintos.`,
  ));

  return {
    requirements,
    essentialTopicCoverage: 0,
    prerequisiteCoverage: 0,
    objectiveAccuracy: null,
    distinctContexts,
    hasConfigError: false,
  };
}

// ── Main pure evaluation function ─────────────────────────────────────────────

export function evaluateSkillForPromotion(
  bundle: PromotionEvidenceBundle,
): SkillPromotionEvaluation {
  const { userId, skill, currentLevel, missions, topicMastery, checkpoints, consistency } = bundle;
  const evaluatedAt = new Date().toISOString();

  // 1. Maximum level check
  if (currentLevel === MAX_SUPPORTED_PROMOTION_LEVEL) {
    return {
      userId,
      skill,
      currentLevel,
      targetLevel: null,
      decision: 'maximum_supported_level',
      eligibleForPromotion: false,
      promotionConfidence: 0,
      progressPercent: 100,
      regressionSignal: 'stable',
      evaluatedAt,
      engineVersion: PROMOTION_ENGINE_VERSION,
      curriculumVersion: PROMOTION_CURRICULUM_VERSION,
      requirements: [],
      blockingReasons: ['Nível máximo suportado pelo motor de promoção (C1).'],
      summary: 'O aluno já atingiu o nível máximo suportado (C1).',
      evidenceSnapshot: { currentLevel, skill },
    };
  }

  const targetLevel = NEXT_LEVEL[currentLevel] as CEFRLevel;
  const requiredMissions = MIN_VALID_MISSIONS_BY_LEVEL[currentLevel] ?? 8;

  // 2. Early insufficient data check (very little data)
  if (missions.validCount < 2) {
    return {
      userId,
      skill,
      currentLevel,
      targetLevel,
      decision: 'insufficient_data',
      eligibleForPromotion: false,
      promotionConfidence: 0,
      progressPercent: 0,
      regressionSignal: 'stable',
      evaluatedAt,
      engineVersion: PROMOTION_ENGINE_VERSION,
      curriculumVersion: PROMOTION_CURRICULUM_VERSION,
      requirements: [],
      blockingReasons: ['Dados insuficientes para avaliar promoção (menos de 2 missões válidas).'],
      summary: 'Dados insuficientes para avaliar promoção.',
      evidenceSnapshot: { currentLevel, skill, missionCount: missions.validCount },
    };
  }

  // 3. Collect requirement results per skill
  let evalResult: {
    requirements: RequirementResult[];
    essentialTopicCoverage: number;
    prerequisiteCoverage: number;
    objectiveAccuracy: number | null;
    distinctContexts: number;
    hasConfigError: boolean;
  };

  if (skill === 'writing') {
    evalResult = evaluateWritingRequirements(bundle, requiredMissions);
  } else if (skill === 'pronunciation') {
    evalResult = evaluatePronunciationRequirements(bundle, requiredMissions);
  } else {
    // conversation (and any future skills default to conversation-style)
    evalResult = evaluateConversationRequirements(bundle, requiredMissions);
  }

  const {
    requirements,
    essentialTopicCoverage,
    prerequisiteCoverage,
    objectiveAccuracy,
    distinctContexts,
    hasConfigError,
  } = evalResult;

  // 4. Calculate confidence
  const promotionConfidence = calculateConfidence(bundle, requiredMissions);

  // 5. Calculate progress
  const progressPercent = calculateProgress(
    bundle,
    requiredMissions,
    essentialTopicCoverage,
    prerequisiteCoverage,
    objectiveAccuracy,
    distinctContexts,
    promotionConfidence,
  );

  // 6. Regression signal
  const regressionSignal = calculateRegressionSignal(
    topicMastery,
    objectiveAccuracy,
    promotionConfidence,
    consistency.singleSessionOnly,
  );

  // 7. Collect blocking reasons
  const blockingReasons: string[] = [];

  if (hasConfigError) {
    return {
      userId,
      skill,
      currentLevel,
      targetLevel,
      decision: 'configuration_error',
      eligibleForPromotion: false,
      promotionConfidence,
      progressPercent,
      regressionSignal,
      evaluatedAt,
      engineVersion: PROMOTION_ENGINE_VERSION,
      curriculumVersion: PROMOTION_CURRICULUM_VERSION,
      requirements,
      blockingReasons: ['Erro de configuração: nenhum tópico essencial encontrado no catálogo para este nível.'],
      summary: 'Erro de configuração do currículo. Contate o suporte.',
      evidenceSnapshot: { currentLevel, skill, essentialTopicsCount: 0 },
    };
  }

  if (promotionConfidence < PROMOTION_RULES.minimumConfidence) {
    blockingReasons.push(
      `Confiança insuficiente: ${Math.round(promotionConfidence * 100)}% (mínimo: ${Math.round(PROMOTION_RULES.minimumConfidence * 100)}%)`,
    );
  }

  const failedReqs = requirements.filter(r => r.status === 'failed');
  for (const r of failedReqs) {
    blockingReasons.push(r.explanation);
  }

  // 8. Determine decision
  const hasAnyConfigError = requirements.some(r => r.status === 'configuration_error');
  if (hasAnyConfigError) {
    return {
      userId,
      skill,
      currentLevel,
      targetLevel,
      decision: 'configuration_error',
      eligibleForPromotion: false,
      promotionConfidence,
      progressPercent,
      regressionSignal,
      evaluatedAt,
      engineVersion: PROMOTION_ENGINE_VERSION,
      curriculumVersion: PROMOTION_CURRICULUM_VERSION,
      requirements,
      blockingReasons: ['Erro de configuração detectado nos requisitos.'],
      summary: 'Erro de configuração do currículo.',
      evidenceSnapshot: { currentLevel, skill },
    };
  }

  const hasInsufficientData = requirements.some(r => r.status === 'insufficient_data');
  const allCriticalPassed = requirements
    .filter(r => r.status !== 'insufficient_data')
    .every(r => r.status === 'passed');

  let decision: SkillPromotionEvaluation['decision'];

  if (blockingReasons.length === 0 && allCriticalPassed && !hasInsufficientData) {
    decision = 'promote';
  } else if (hasInsufficientData && !allCriticalPassed) {
    decision = 'insufficient_data';
  } else if (blockingReasons.length > 0 || !allCriticalPassed) {
    decision = 'keep_level';
  } else {
    // All critical passed but missing data for some: insufficient to confirm
    decision = 'insufficient_data';
  }

  const eligibleForPromotion = decision === 'promote';

  const summary =
    decision === 'promote'
      ? `Aluno elegível para promoção de ${currentLevel} para ${targetLevel}.`
      : decision === 'insufficient_data'
        ? `Dados insuficientes para determinar promoção de ${currentLevel} para ${targetLevel}.`
        : `Aluno mantém nível ${currentLevel}. ${blockingReasons[0] ?? ''}`;

  const evidenceSnapshot: Record<string, unknown> = {
    currentLevel,
    targetLevel,
    skill,
    missions: {
      validCount: missions.validCount,
      distinctDates: missions.distinctDates,
    },
    topicMastery: {
      total: topicMastery.length,
      essential: topicMastery.filter(t => t.isEssential).length,
      mastered: topicMastery.filter(t => t.mastered).length,
    },
    checkpoints: {
      completed: checkpoints.completedCount,
      passed: checkpoints.passedCount,
    },
    consistency: {
      distinctDates: consistency.distinctDates,
      singleSessionOnly: consistency.singleSessionOnly,
    },
  };

  return {
    userId,
    skill,
    currentLevel,
    targetLevel,
    decision,
    eligibleForPromotion,
    promotionConfidence,
    progressPercent,
    regressionSignal,
    evaluatedAt,
    engineVersion: PROMOTION_ENGINE_VERSION,
    curriculumVersion: PROMOTION_CURRICULUM_VERSION,
    requirements,
    blockingReasons,
    summary,
    evidenceSnapshot,
  };
}
