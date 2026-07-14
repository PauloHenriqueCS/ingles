import type {
  MissionPedagogicalPlan,
  LearnerPlanningSnapshot,
  PlanningMode,
  MissionDifficulty,
} from './planner-types';
import { PLANNER_VERSION, FALLBACK_DIFFICULTY } from './planner-constants';
import { resolveEffectiveWritingLevel, resolveSafeDifficulty } from './level-rules';
import { getObjectivesForLevel, getObjectiveById, CONTEXT_FAMILIES } from './communicative-objectives';
import { selectGrammarTopicsForMission } from './grammar-selection';
import { selectVocabularyForMission } from './vocabulary-selection';
import { resolveMissionSupportConfiguration } from './support-selection';
import { getNoveltyBudget } from './novelty-budget';
import { getRecoveryBudget } from './recovery-budget';
import { getAvailableContextFamilies, isObjectiveRecentlyUsed } from './recency-rules';
import { getDifficultyProfile } from './difficulty-rules';
import { DeterministicRandom } from './deterministic-random';
import type { GrammarTopic } from '../../curriculum/grammar-types';

export interface PlanWritingMissionInput {
  userId: string;
  mode: PlanningMode;
  difficulty?: MissionDifficulty;
  seed: string;
  snapshot: LearnerPlanningSnapshot;
  catalog: readonly GrammarTopic[];
  /** Optional override for diagnostic/calibration modes. */
  forcedObjectiveId?: string;
}

/**
 * Produces a deterministic MissionPedagogicalPlan from the learner snapshot.
 * Same seed + same snapshot → same plan.
 * Does NOT generate narrative content; only produces the pedagogical contract.
 */
export function planWritingMission(input: PlanWritingMissionInput): MissionPedagogicalPlan {
  const { userId, mode, seed, snapshot, catalog } = input;
  const rng = new DeterministicRandom(seed);

  // ── 1. Resolve effective level ────────────────────────────────────────────
  const levelResult = resolveEffectiveWritingLevel(snapshot.writingProfile);
  const effectiveLevel = levelResult.effectiveLevel;

  // ── 2. Resolve difficulty ─────────────────────────────────────────────────
  const requestedDifficulty: MissionDifficulty =
    input.difficulty ?? (levelResult.isFallback ? FALLBACK_DIFFICULTY : 'medium');
  const difficulty = resolveSafeDifficulty(requestedDifficulty, levelResult);

  // ── 3. Select communicative objective ─────────────────────────────────────
  let communicativeObjectiveId: string;
  if (input.forcedObjectiveId) {
    communicativeObjectiveId = input.forcedObjectiveId;
  } else {
    const allForLevel = getObjectivesForLevel(effectiveLevel);
    const candidates = allForLevel.filter(
      obj => !isObjectiveRecentlyUsed(obj.id, snapshot.recentPlans),
    );
    const pool = candidates.length > 0 ? candidates : allForLevel;
    const chosen = pool.length > 0
      ? rng.pick(pool)
      : { id: `obj.${effectiveLevel.toLowerCase()}.small_problem_response` };
    communicativeObjectiveId = chosen.id;
  }

  const objective = getObjectiveById(communicativeObjectiveId);
  const communicativeFunctions = objective?.functions.slice() ?? [];
  const objectiveTopicIds = objective?.compatibleGrammarTopicIds ?? [];

  // ── 4. Select grammar topics ──────────────────────────────────────────────
  const grammarResult = selectGrammarTopicsForMission({
    effectiveLevel,
    isConservative: levelResult.isConservative,
    communicativeObjectiveTopicIds: objectiveTopicIds,
    grammarMastery: snapshot.grammarMastery,
    catalog,
    recentPlans: snapshot.recentPlans,
    rng,
  });

  // ── 5. Select vocabulary ──────────────────────────────────────────────────
  const vocabularyItems = selectVocabularyForMission({
    level: effectiveLevel,
    objectiveContextFamilies: objective?.compatibleContextFamilies ?? [],
    learnerVocabularyState: [],
    recentErrors: [],
    recentPlansVocabIds: snapshot.recentPlans.flatMap(() => []),
  });

  // ── 6. Resolve support ────────────────────────────────────────────────────
  const primaryTopicStates = grammarResult.topics
    .filter(t => t.role === 'primary')
    .map(t => t.learnerState);

  const { supportLevel, supportConfiguration } = resolveMissionSupportConfiguration({
    level: effectiveLevel,
    difficulty,
    assessmentStatus: snapshot.writingProfile?.status ?? 'unknown',
    confidence: snapshot.writingProfile?.confidence ?? 0,
    primaryTopicStates,
    hasRecentStruggleSignals: false,
  });

  // ── 7. Build generation constraints ───────────────────────────────────────
  const difficultyProfile = getDifficultyProfile(effectiveLevel, difficulty);
  const availableContextFamilies = getAvailableContextFamilies(
    CONTEXT_FAMILIES,
    snapshot.recentPlans,
  );

  const forbiddenInstructions = buildForbiddenInstructions(
    grammarResult.forbiddenRequiredTopicIds,
    catalog,
  );

  // ── 8. Build validation rules ─────────────────────────────────────────────
  const requiredTopicCoverage = grammarResult.topics
    .filter(t => t.role === 'primary' && t.requiredOpportunityCount > 0)
    .map(t => t.topicId);

  const plan: MissionPedagogicalPlan = {
    id: crypto.randomUUID(),
    version: 1,
    userId,
    skill: 'writing',

    catalogVersion: snapshot.catalogVersion,
    plannerVersion: PLANNER_VERSION,

    learnerLevel: snapshot.writingProfile?.level ?? null,
    effectiveLevel,
    assessmentStatus: snapshot.writingProfile?.status ?? 'unknown',
    assessmentConfidence: snapshot.writingProfile?.confidence ?? 0,

    mode,
    difficulty,
    reason: levelResult.reason,

    communicativeObjectiveId,
    communicativeFunctions,

    grammarTopics: grammarResult.topics,
    vocabularyItems,

    prerequisitesSatisfied: grammarResult.prerequisitesSatisfied,
    prerequisitesMissing: grammarResult.prerequisitesMissing,

    supportLevel,
    supportConfiguration,

    noveltyBudget: getNoveltyBudget(effectiveLevel),
    recoveryBudget: getRecoveryBudget(effectiveLevel),

    generationConstraints: {
      requireEverydaySituation: true,
      requireConflictDecisionOrUnexpectedEvent: difficultyProfile.requiresDecision,
      avoidGenericTopic: true,
      avoidExplicitGrammarExercise: true,
      forbiddenRequiredTopicIds: grammarResult.forbiddenRequiredTopicIds,
      forbiddenInstructions,
      preferredContextFamilies: availableContextFamilies.slice(0, 5),
      avoidedContextFamilies: snapshot.recentPlans
        .slice(0, 3)
        .flatMap(p => p.contextFamilies),
    },

    validationRules: {
      requiredTopicCoverage,
      forbiddenRequiredTopicIds: grammarResult.forbiddenRequiredTopicIds,
      maximumEstimatedLevel: effectiveLevel,
      allowIncidentalAdvancedLanguage: true,
    },

    seed,
    createdAt: new Date().toISOString(),
    acceptedAt: null,
    supersededAt: null,
  };

  return plan;
}

function buildForbiddenInstructions(
  forbiddenTopicIds: string[],
  catalog: readonly GrammarTopic[],
): string[] {
  const catalogById = new Map(catalog.map(t => [t.id, t]));
  const instructions: string[] = [];

  for (const topicId of forbiddenTopicIds) {
    const topic = catalogById.get(topicId);
    if (!topic) continue;
    instructions.push(`Do not require use of ${topic.title.en}`);
  }

  // Always include these baseline restrictions
  instructions.push('Do not ask the student to demonstrate a specific grammar structure explicitly');
  instructions.push('Do not include the grammar topic name in the mission text');

  return instructions;
}
