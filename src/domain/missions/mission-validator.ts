import type { MissionPedagogicalPlan, CEFRLevel } from '../pedagogy/planner/planner-types';
import type {
  GeneratedMissionCandidate,
  MissionValidationResult,
  MissionValidationWarning,
} from './mission-generation-types';
import type { MissionRejectionCode } from './mission-rejection-codes';

const CEFR_ORDER: Readonly<Record<CEFRLevel, number>> = {
  A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6,
};

const VALID_LEVELS = new Set<string>(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
const VALID_DIFFS = new Set<string>(['easy', 'medium', 'hard']);

const WRITE_VERB_PATTERNS = [
  /^escreva\b/i,
  /^conte\b/i,
  /^descreva\b/i,
  /^fale sobre\b/i,
  /^write\b/i,
  /^tell\b/i,
  /^describe\b/i,
  /^talk about\b/i,
];

const EXPLICIT_GRAMMAR_PATTERNS = [
  /use o present/i,
  /pratique o/i,
  /demonstre o uso/i,
  /aplique o/i,
  /exercite o/i,
  /use the present/i,
  /practice the/i,
  /demonstrate the use/i,
  /use this grammar/i,
  /using .{0,30} tense/i,
];

function cefrOrder(level: string): number {
  return CEFR_ORDER[level as CEFRLevel] ?? 0;
}

function startsWithWriteVerb(text: string): boolean {
  const trimmed = text.trimStart();
  return WRITE_VERB_PATTERNS.some(p => p.test(trimmed));
}

function detectsExplicitGrammarExercise(text: string): boolean {
  return EXPLICIT_GRAMMAR_PATTERNS.some(p => p.test(text));
}

function hasCommunicativePurpose(candidate: GeneratedMissionCandidate): boolean {
  return (
    (candidate.missionSetup ?? '').trim().length > 10 &&
    (candidate.missionTask ?? '').trim().length > 10
  );
}

/**
 * Validates a generated mission candidate against the pedagogical plan.
 * Pure function: no side effects, no DB access.
 */
export function validateMissionAgainstPedagogicalPlan(
  candidate: GeneratedMissionCandidate,
  plan: MissionPedagogicalPlan,
): MissionValidationResult {
  const warnings: MissionValidationWarning[] = [];

  function reject(code: MissionRejectionCode, detail: string): MissionValidationResult {
    return { valid: false, rejectionCode: code, rejectionDetail: detail, warnings };
  }

  function warn(code: MissionRejectionCode, detail: string): void {
    warnings.push({ code, detail, severity: 'warning' });
  }

  // ── Structural checks ──────────────────────────────────────────────────────

  if (!candidate.title?.trim()) {
    return reject('INVALID_TITLE', 'Mission title is missing or empty');
  }

  if (!candidate.missionSetup?.trim()) {
    return reject('INVALID_MISSION_SETUP', 'missionSetup is missing or empty');
  }

  if (!candidate.missionTask?.trim()) {
    return reject('INVALID_MISSION_TASK', 'missionTask is missing or empty');
  }

  if (!VALID_LEVELS.has(candidate.level)) {
    return reject('INVALID_LEVEL_FIELD', `Invalid CEFR level: "${candidate.level}"`);
  }

  if (!VALID_DIFFS.has(candidate.difficulty)) {
    return reject('INVALID_DIFFICULTY_FIELD', `Invalid difficulty: "${candidate.difficulty}"`);
  }

  // ── Communicative purpose ──────────────────────────────────────────────────

  if (!hasCommunicativePurpose(candidate)) {
    return reject('NO_COMMUNICATIVE_PURPOSE', 'Mission lacks a clear communicative purpose (setup and task must each be > 10 chars)');
  }

  if (startsWithWriteVerb(candidate.missionSetup)) {
    return reject(
      'SETUP_STARTS_WITH_WRITE',
      'missionSetup begins with an imperative write/describe verb instead of describing a situation',
    );
  }

  // ── Level compliance ───────────────────────────────────────────────────────

  const maxOrder = cefrOrder(plan.validationRules.maximumEstimatedLevel);
  const candidateOrder = cefrOrder(candidate.level);

  if (candidateOrder > maxOrder) {
    return reject(
      'LEVEL_TOO_HIGH',
      `Mission declares level ${candidate.level} but plan allows maximum ${plan.validationRules.maximumEstimatedLevel}`,
    );
  }

  if (candidateOrder < maxOrder) {
    warn('LEVEL_MISMATCH', `Mission level ${candidate.level} is below planned level ${plan.effectiveLevel}`);
  }

  // ── Grammar compliance ─────────────────────────────────────────────────────

  // Check forbidden instructions
  for (const instruction of plan.generationConstraints.forbiddenInstructions) {
    const match = instruction.match(/Do not require use of (.+)/i);
    if (match) {
      const forbiddenTitle = match[1].toLowerCase();
      const found = candidate.requiredGrammar.some(g => g.toLowerCase().includes(forbiddenTitle));
      if (found) {
        return reject(
          'FORBIDDEN_GRAMMAR_REQUIRED',
          `Mission requires "${match[1]}" which is forbidden by the pedagogical plan`,
        );
      }
    }
  }

  // Check explicit grammar exercise
  const fullText = [
    candidate.missionSetup,
    candidate.missionTask,
    ...(candidate.instructions ?? []),
  ].join(' ');

  if (detectsExplicitGrammarExercise(fullText)) {
    return reject(
      'EXPLICIT_GRAMMAR_EXERCISE',
      'Mission explicitly asks the student to use or practice a specific grammar structure',
    );
  }

  // Warn if grammar topic title appears verbatim in the mission text
  const missionTextLower = [candidate.missionSetup, candidate.missionTask].join(' ').toLowerCase();
  for (const grammarItem of candidate.requiredGrammar) {
    const itemLower = grammarItem.toLowerCase();
    if (itemLower.length > 4 && missionTextLower.includes(itemLower)) {
      warn('GRAMMAR_TOPIC_NAME_EXPOSED', `Grammar item "${grammarItem}" appears verbatim in mission text`);
    }
  }

  // ── Conflict/decision check ────────────────────────────────────────────────

  if (plan.generationConstraints.requireConflictDecisionOrUnexpectedEvent) {
    const conflictSignals = [
      candidate.conflict,
      candidate.missionSetup,
      candidate.missionTask,
    ].join(' ').toLowerCase();

    const conflictKeywords = [
      'problem', 'issue', 'conflict', 'decision', 'decide', 'unexpected', 'wrong',
      'mistake', 'trouble', 'challenge', 'crisis', 'urgente', 'urgency',
      'problema', 'decisão', 'imprevisto', 'errado', 'perdeu', 'esqueceu',
      'recebeu', 'precisou', 'aconteceu', 'urgente', 'erro',
    ];

    const hasConflictSignal =
      candidate.conflict.trim().length > 0 ||
      conflictKeywords.some(kw => conflictSignals.includes(kw));

    if (!hasConflictSignal) {
      warn(
        'MISSING_CONFLICT_OR_DECISION',
        'Plan requires a conflict, decision, or unexpected event but none was detected in the mission',
      );
    }
  }

  return { valid: true, rejectionCode: null, rejectionDetail: null, warnings };
}

/**
 * Type guard: verifies the raw AI output has the minimum required fields
 * before attempting full pedagogical validation.
 */
export function validateMissionStructure(
  candidate: unknown,
): candidate is GeneratedMissionCandidate {
  if (!candidate || typeof candidate !== 'object') return false;
  const c = candidate as Record<string, unknown>;
  return (
    typeof c.title === 'string' &&
    typeof c.missionSetup === 'string' &&
    typeof c.missionTask === 'string' &&
    typeof c.mission === 'string' &&
    typeof c.level === 'string' &&
    typeof c.difficulty === 'string' &&
    Array.isArray(c.requiredGrammar) &&
    Array.isArray(c.instructions)
  );
}
