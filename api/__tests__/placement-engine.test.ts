/**
 * Pure placement engine tests — the adaptive tree, checkpoint scoring (2/2, 0/2,
 * 1/2 → tiebreaker), and the data-driven C2 scoring/decision. The tree fixtures
 * mirror the English V1 seed (20260815130100_seed_placement_english_v1.sql), so
 * a divergence between the algorithm and the seeded tree fails CI.
 */
import { describe, it, expect } from 'vitest';
import {
  decideCheckpoint,
  nextAfterCheckpoint,
  validateAndScoreC2,
  c2Decision,
  type PlacementCheckpoint,
  type PlacementQuestionRef,
  type AnswerRecord,
  type C2Criterion,
} from '../../src/domain/placement/placement-engine';

// ── Tree fixtures (mirror the English V1 seed) ───────────────────────────────
const TREE: Record<string, PlacementCheckpoint> = {
  A2: { checkpointKey: 'A2', kind: 'objective', mainQuestionCount: 2, onPassCheckpointKey: null, onFailCheckpointKey: null, onPassLevelCode: 'A2', onFailLevelCode: 'A1' },
  B1: { checkpointKey: 'B1', kind: 'objective', mainQuestionCount: 2, onPassCheckpointKey: 'B2', onFailCheckpointKey: 'A2', onPassLevelCode: null, onFailLevelCode: null },
  B2: { checkpointKey: 'B2', kind: 'objective', mainQuestionCount: 2, onPassCheckpointKey: 'C1', onFailCheckpointKey: null, onPassLevelCode: null, onFailLevelCode: 'B1' },
  C1: { checkpointKey: 'C1', kind: 'objective', mainQuestionCount: 2, onPassCheckpointKey: 'C2_GATE', onFailCheckpointKey: null, onPassLevelCode: null, onFailLevelCode: 'B2' },
  C2_GATE: { checkpointKey: 'C2_GATE', kind: 'c2_gate', mainQuestionCount: 2, onPassCheckpointKey: null, onFailCheckpointKey: null, onPassLevelCode: 'C2', onFailLevelCode: 'C1' },
};

const START = 'B1';

/** Walks the tree from B1 given a per-checkpoint pass/fail plan. */
function walk(plan: Record<string, 'pass' | 'fail'>): string {
  let key = START;
  for (let i = 0; i < 10; i++) {
    const cp = TREE[key];
    const outcome = plan[key];
    if (!outcome) throw new Error(`no plan for ${key}`);
    const t = nextAfterCheckpoint(cp, outcome);
    if (t.type === 'level') return t.levelCode;
    key = t.checkpointKey;
  }
  throw new Error('did not converge');
}

describe('adaptive tree (mirrors seed)', () => {
  it('B1 FAIL + A2 FAIL → A1', () => {
    expect(walk({ B1: 'fail', A2: 'fail' })).toBe('A1');
  });
  it('B1 FAIL + A2 PASS → A2', () => {
    expect(walk({ B1: 'fail', A2: 'pass' })).toBe('A2');
  });
  it('B1 PASS + B2 FAIL → B1', () => {
    expect(walk({ B1: 'pass', B2: 'fail' })).toBe('B1');
  });
  it('B1 PASS + B2 PASS + C1 FAIL → B2', () => {
    expect(walk({ B1: 'pass', B2: 'pass', C1: 'fail' })).toBe('B2');
  });
  it('B1 PASS + B2 PASS + C1 PASS + C2 FAIL → C1', () => {
    expect(walk({ B1: 'pass', B2: 'pass', C1: 'pass', C2_GATE: 'fail' })).toBe('C1');
  });
  it('B1 PASS + B2 PASS + C1 PASS + C2 PASS → C2', () => {
    expect(walk({ B1: 'pass', B2: 'pass', C1: 'pass', C2_GATE: 'pass' })).toBe('C2');
  });
});

// ── Checkpoint scoring ───────────────────────────────────────────────────────
const QS: PlacementQuestionRef[] = [
  { questionKey: 'Q1', role: 'main', sortOrder: 1 },
  { questionKey: 'Q2', role: 'main', sortOrder: 2 },
  { questionKey: 'TB', role: 'tiebreaker', sortOrder: 1 },
];
const cp = TREE.B1;
const a = (questionKey: string, isCorrect: boolean, role: 'main' | 'tiebreaker' = 'main'): AnswerRecord => ({ questionKey, role, isCorrect });

describe('decideCheckpoint', () => {
  it('serves main questions in order first', () => {
    expect(decideCheckpoint(cp, QS, [])).toEqual({ type: 'ask', questionKey: 'Q1', role: 'main' });
    expect(decideCheckpoint(cp, QS, [a('Q1', true)])).toEqual({ type: 'ask', questionKey: 'Q2', role: 'main' });
  });
  it('2/2 → PASS', () => {
    expect(decideCheckpoint(cp, QS, [a('Q1', true), a('Q2', true)])).toEqual({ type: 'resolved', outcome: 'pass' });
  });
  it('0/2 → FAIL', () => {
    expect(decideCheckpoint(cp, QS, [a('Q1', false), a('Q2', false)])).toEqual({ type: 'resolved', outcome: 'fail' });
  });
  it('1/2 → asks the tiebreaker', () => {
    expect(decideCheckpoint(cp, QS, [a('Q1', true), a('Q2', false)])).toEqual({ type: 'ask', questionKey: 'TB', role: 'tiebreaker' });
  });
  it('tiebreaker correct → PASS, wrong → FAIL', () => {
    expect(decideCheckpoint(cp, QS, [a('Q1', true), a('Q2', false), a('TB', true, 'tiebreaker')])).toEqual({ type: 'resolved', outcome: 'pass' });
    expect(decideCheckpoint(cp, QS, [a('Q1', false), a('Q2', true), a('TB', false, 'tiebreaker')])).toEqual({ type: 'resolved', outcome: 'fail' });
  });
});

// ── C2 scoring (data-driven rubric) ──────────────────────────────────────────
const CRITERIA: C2Criterion[] = [
  { key: 'meaning_preservation', maxScore: 2 },
  { key: 'register_adaptation', maxScore: 2 },
  { key: 'naturalness', maxScore: 2 },
  { key: 'precision_nuance', maxScore: 2 },
  { key: 'reformulation_flexibility', maxScore: 2 },
];
const scores = (v: number[]) => ({ scores: Object.fromEntries(CRITERIA.map((c, i) => [c.key, v[i]])) });

describe('C2 scoring', () => {
  it('sums valid scores server-side (ignores any model total)', () => {
    const r = validateAndScoreC2({ ...scores([2, 2, 2, 1, 2]), total: 999 }, CRITERIA);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.total).toBe(9);
  });
  it('total 8 → C2, total 7 → C1', () => {
    expect(c2Decision(8, 8)).toBe('C2');
    expect(c2Decision(7, 8)).toBe('C1');
  });
  it('rejects a missing criterion', () => {
    const bad: any = { scores: { meaning_preservation: 2 } };
    expect(validateAndScoreC2(bad, CRITERIA).ok).toBe(false);
  });
  it('rejects out-of-range and non-integer scores', () => {
    expect(validateAndScoreC2(scores([3, 2, 2, 2, 2]), CRITERIA).ok).toBe(false);
    expect(validateAndScoreC2(scores([1.5, 2, 2, 2, 2]), CRITERIA).ok).toBe(false);
  });
  it('rejects a non-object payload (invalid JSON shape)', () => {
    expect(validateAndScoreC2(null, CRITERIA).ok).toBe(false);
    expect(validateAndScoreC2('nope', CRITERIA).ok).toBe(false);
  });
});
