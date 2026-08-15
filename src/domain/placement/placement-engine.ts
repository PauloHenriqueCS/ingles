/**
 * PURE placement engine — the adaptive test's algorithm, with NO I/O and NO
 * hardcoded language/questions/tree. Everything specific (the checkpoint tree,
 * the questions, the answer key, the C2 rubric/threshold) is DATA passed in by
 * the caller (loaded from the DB). This module only knows the GENERIC rules:
 *   - a checkpoint of `main_question_count` main questions + 1 tiebreaker;
 *   - 2/2 → PASS, 0/2 → FAIL, 1/2 → tiebreaker (correct → PASS, wrong → FAIL);
 *   - PASS/FAIL routes to another checkpoint OR a terminal level (per the data);
 *   - the C2 gate total (0..max) crosses a data-driven threshold → C2 else C1.
 *
 * "Não sei" is just an option that is not the correct one → scored incorrect by
 * the caller before it reaches here (AnswerRecord.isCorrect).
 */

export type PlacementCheckpointKind = 'objective' | 'c2_gate';
export type PlacementQuestionRole = 'main' | 'tiebreaker';

export interface PlacementCheckpoint {
  checkpointKey: string;
  kind: PlacementCheckpointKind;
  mainQuestionCount: number;
  onPassCheckpointKey: string | null;
  onFailCheckpointKey: string | null;
  onPassLevelCode: string | null;
  onFailLevelCode: string | null;
}

export interface PlacementQuestionRef {
  questionKey: string;
  role: PlacementQuestionRole;
  sortOrder: number;
}

export interface AnswerRecord {
  questionKey: string;
  role: PlacementQuestionRole;
  isCorrect: boolean;
}

export type CheckpointDecision =
  | { type: 'ask'; questionKey: string; role: PlacementQuestionRole }
  | { type: 'resolved'; outcome: 'pass' | 'fail' };

/**
 * Decides the next step WITHIN a single objective checkpoint from the questions
 * it owns and the answers recorded so far. Deterministic and idempotent: given
 * the same answers it always returns the same next question (so a resume/reload
 * never branches differently).
 */
export function decideCheckpoint(
  checkpoint: PlacementCheckpoint,
  questions: PlacementQuestionRef[],
  answers: AnswerRecord[],
): CheckpointDecision {
  const mains = questions
    .filter((q) => q.role === 'main')
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const tiebreakers = questions
    .filter((q) => q.role === 'tiebreaker')
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const answeredKeys = new Set(answers.map((a) => a.questionKey));
  const requiredMains = mains.slice(0, checkpoint.mainQuestionCount);

  // 1) Serve every required main question first, in order.
  const nextMain = requiredMains.find((q) => !answeredKeys.has(q.questionKey));
  if (nextMain) {
    return { type: 'ask', questionKey: nextMain.questionKey, role: 'main' };
  }

  const correctMains = requiredMains.filter((q) => {
    const a = answers.find((x) => x.questionKey === q.questionKey);
    return a?.isCorrect === true;
  }).length;

  // 2) All mains answered → 2/2 PASS, 0/2 FAIL, else tiebreaker.
  if (correctMains === checkpoint.mainQuestionCount) {
    return { type: 'resolved', outcome: 'pass' };
  }
  if (correctMains === 0) {
    return { type: 'resolved', outcome: 'fail' };
  }

  // 3) Partial → tiebreaker decides.
  const nextTb = tiebreakers.find((q) => !answeredKeys.has(q.questionKey));
  if (nextTb) {
    return { type: 'ask', questionKey: nextTb.questionKey, role: 'tiebreaker' };
  }
  const tbAnswer = tiebreakers
    .map((q) => answers.find((a) => a.questionKey === q.questionKey))
    .find((a): a is AnswerRecord => !!a);
  return { type: 'resolved', outcome: tbAnswer?.isCorrect ? 'pass' : 'fail' };
}

export type TreeTransition =
  | { type: 'checkpoint'; checkpointKey: string }
  | { type: 'level'; levelCode: string };

/**
 * Routes a resolved checkpoint (pass/fail) to the next checkpoint OR a terminal
 * result level — purely from the checkpoint's own data (never `if (key==='B1')`).
 */
export function nextAfterCheckpoint(
  checkpoint: PlacementCheckpoint,
  outcome: 'pass' | 'fail',
): TreeTransition {
  const cpKey = outcome === 'pass' ? checkpoint.onPassCheckpointKey : checkpoint.onFailCheckpointKey;
  const lvl = outcome === 'pass' ? checkpoint.onPassLevelCode : checkpoint.onFailLevelCode;
  if (cpKey) return { type: 'checkpoint', checkpointKey: cpKey };
  if (lvl) return { type: 'level', levelCode: lvl };
  // The DB CHECK constraint guarantees exactly one side is set; this is a
  // defensive guard so a misconfigured row surfaces as an explicit error.
  throw new Error(`placement checkpoint ${checkpoint.checkpointKey} has no ${outcome} route`);
}

// ── C2 gate scoring (data-driven rubric) ─────────────────────────────────────

export interface C2Criterion {
  key: string;
  maxScore: number;
}

export type C2Scores = Record<string, number>;

export interface C2ValidationOk {
  ok: true;
  scores: C2Scores;
  total: number;
}
export interface C2ValidationErr {
  ok: false;
  error: string;
}

/**
 * Validates a raw model score object against the rubric criteria and computes
 * the total SERVER-SIDE (never trusts a model-provided total). Each criterion
 * must be an integer within [0, maxScore]; unknown/missing criteria are errors.
 */
export function validateAndScoreC2(
  raw: unknown,
  criteria: C2Criterion[],
): C2ValidationOk | C2ValidationErr {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'scores object missing' };
  const scoresIn = (raw as { scores?: unknown }).scores ?? raw;
  if (!scoresIn || typeof scoresIn !== 'object') return { ok: false, error: 'scores object missing' };

  const scores: C2Scores = {};
  let total = 0;
  for (const c of criteria) {
    const v = (scoresIn as Record<string, unknown>)[c.key];
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      return { ok: false, error: `criterion ${c.key} is not an integer` };
    }
    if (v < 0 || v > c.maxScore) {
      return { ok: false, error: `criterion ${c.key} out of range 0..${c.maxScore}` };
    }
    scores[c.key] = v;
    total += v;
  }
  return { ok: true, scores, total };
}

/** 8+ (threshold) → C2, otherwise C1. Threshold is data-driven. */
export function c2Decision(total: number, passThreshold: number): 'C2' | 'C1' {
  return total >= passThreshold ? 'C2' : 'C1';
}
