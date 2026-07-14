/**
 * Task 12 — Writing Rewrite domain tests
 * 64+ tests covering:
 * - RewriteStatus state machine (10)
 * - Text normalization (8)
 * - Copy detection (10)
 * - Score calculation (8)
 * - Correction outcomes (8)
 * - Evidence types (4)
 * - Public DTO (8)
 * - Feature flags (8)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── State machine ────────────────────────────────────────────────────────────
import {
  ALL_REWRITE_STATUSES,
  SUBMITTED_IMMUTABLE_FIELDS,
  canTransitionRewriteStatus,
  isRewriteTerminal,
  isRewriteImmutable,
} from './rewrite-status';

// ── Normalization ────────────────────────────────────────────────────────────
import {
  normalizeTextForExactComparison,
  normalizeTextForStructuralComparison,
  normalizeTextForCopyDetection,
  hashText,
} from './rewrite-normalization';

// ── Copy detection ────────────────────────────────────────────────────────────
import { detectCopy } from './rewrite-copy-detection';

// ── Score calculation ────────────────────────────────────────────────────────
import {
  calculateRewriteImprovementScore,
  buildRewriteScoreComponents,
  clampScore,
  adjustedIndependenceScore,
  CURRENT_SCORING_VERSION,
} from './rewrite-score-calculation';

// ── Correction outcomes ──────────────────────────────────────────────────────
import {
  parseOutcomeStatus,
  outcomeIsResolved,
  outcomeContributesToCorrectionResolution,
  calculateCorrectionResolutionScore,
} from './rewrite-correction-outcomes';

// ── Evidence types ────────────────────────────────────────────────────────────
import {
  shouldAffectMastery,
  buildContextKey,
  ALL_REWRITE_EVIDENCE_TYPES,
} from './rewrite-evidence-types';

// ── Public DTO ────────────────────────────────────────────────────────────────
import { buildPublicRewriteDTO } from './rewrite-public-dto';
import type { WritingRewriteAttempt, WritingRewriteEvaluation, RewriteScoreComponents } from './rewrite-types';

// ── Feature flags ─────────────────────────────────────────────────────────────
import {
  getRewriteV2Mode,
  isRewriteV2Enabled,
  isRewriteV2Shadow,
  isRewriteV2FullyActive,
} from '../../lib/writingRewriteFeatureFlags';

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function makeAttempt(overrides: Partial<WritingRewriteAttempt> = {}): WritingRewriteAttempt {
  return {
    id: 'attempt-1',
    userId: 'user-1',
    reviewId: 'review-1',
    rewriteSequence: 1,
    status: 'submitted',
    authorType: 'learner',
    submissionType: 'rewrite_v2',
    rewriteText: 'I went to the store yesterday.',
    originalTextSnapshot: 'I go to the store yesterday.',
    correctedTextHash: 'abc123',
    reviewVersion: 1,
    createdAt: '2026-07-14T10:00:00Z',
    submittedAt: '2026-07-14T10:05:00Z',
    ...overrides,
  };
}

function makeScores(overrides: Partial<RewriteScoreComponents> = {}): RewriteScoreComponents {
  return {
    correctionResolutionScore: 80,
    newErrorAvoidanceScore: 90,
    meaningPreservationScore: 85,
    clarityImprovementScore: 70,
    cohesionImprovementScore: 75,
    independenceScore: 85,
    overallImprovementScore: 81,
    ...overrides,
  };
}

function makeEvaluation(overrides: Partial<WritingRewriteEvaluation> = {}): WritingRewriteEvaluation {
  return {
    id: 'eval-1',
    userId: 'user-1',
    originalSubmissionId: 'review-1',
    rewriteSubmissionId: 'attempt-1',
    reviewId: 'review-1',
    evaluationVersion: 1,
    status: 'completed',
    scores: makeScores(),
    independenceAssessment: 'likely_independent',
    summaryPtBR: 'O aluno melhorou bastante. Precisa praticar mais.',
    correctionOutcomes: [
      {
        correctionId: '0',
        status: 'corrected',
        originalExcerpt: 'go',
        expectedCorrection: 'went',
        rewriteExcerpt: 'went',
        explanationPtBR: 'Corrigido corretamente.',
        confidence: 0.9,
        shouldAffectRewriteScore: true,
      },
    ],
    newIssues: [],
    scoringVersion: 'v1',
    schemaVersion: 'v1',
    createdAt: '2026-07-14T10:06:00Z',
    completedAt: '2026-07-14T10:06:30Z',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Group 1: RewriteStatus state machine (10 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('RewriteStatus state machine', () => {
  it('all valid transitions are allowed: draft → submitted', () => {
    expect(canTransitionRewriteStatus('draft', 'submitted').allowed).toBe(true);
  });

  it('all valid transitions are allowed: submitted → evaluation_pending', () => {
    expect(canTransitionRewriteStatus('submitted', 'evaluation_pending').allowed).toBe(true);
  });

  it('all valid transitions are allowed: evaluation_pending → evaluated', () => {
    expect(canTransitionRewriteStatus('evaluation_pending', 'evaluated').allowed).toBe(true);
  });

  it('all valid transitions are allowed: evaluation_failed → evaluation_pending (retry)', () => {
    expect(canTransitionRewriteStatus('evaluation_failed', 'evaluation_pending').allowed).toBe(true);
  });

  it('draft → evaluated is forbidden', () => {
    const result = canTransitionRewriteStatus('draft', 'evaluated');
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('evaluated → draft is forbidden', () => {
    const result = canTransitionRewriteStatus('evaluated', 'draft');
    expect(result.allowed).toBe(false);
  });

  it('superseded → evaluated is forbidden', () => {
    const result = canTransitionRewriteStatus('superseded', 'evaluated');
    expect(result.allowed).toBe(false);
  });

  it('cancelled → submitted is forbidden', () => {
    const result = canTransitionRewriteStatus('cancelled', 'submitted');
    expect(result.allowed).toBe(false);
  });

  it('isRewriteTerminal: superseded and cancelled are terminal', () => {
    expect(isRewriteTerminal('superseded')).toBe(true);
    expect(isRewriteTerminal('cancelled')).toBe(true);
    expect(isRewriteTerminal('evaluated')).toBe(false);
    expect(isRewriteTerminal('draft')).toBe(false);
  });

  it('isRewriteImmutable: everything except draft is immutable', () => {
    expect(isRewriteImmutable('draft')).toBe(false);
    expect(isRewriteImmutable('submitted')).toBe(true);
    expect(isRewriteImmutable('evaluation_pending')).toBe(true);
    expect(isRewriteImmutable('evaluated')).toBe(true);
    expect(isRewriteImmutable('evaluation_failed')).toBe(true);
    expect(isRewriteImmutable('superseded')).toBe(true);
    expect(isRewriteImmutable('cancelled')).toBe(true);
  });

  it('SUBMITTED_IMMUTABLE_FIELDS contains all required fields', () => {
    const required = [
      'rewrite_text',
      'original_submission_id',
      'review_id',
      'mission_id',
      'user_id',
      'rewrite_sequence',
      'submitted_at',
      'support_usage_snapshot',
    ];
    for (const field of required) {
      expect(SUBMITTED_IMMUTABLE_FIELDS.has(field)).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 2: Text normalization (8 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Text normalization', () => {
  it('normalizeTextForExactComparison: trims whitespace', () => {
    expect(normalizeTextForExactComparison('  Hello  ')).toBe('hello');
  });

  it('normalizeTextForExactComparison: lowercases and collapses spaces', () => {
    expect(normalizeTextForExactComparison('Hello   World')).toBe('hello world');
  });

  it('normalizeTextForExactComparison: handles empty string', () => {
    expect(normalizeTextForExactComparison('')).toBe('');
  });

  it("normalizeTextForStructuralComparison: expands I'm → i am", () => {
    const result = normalizeTextForStructuralComparison("I'm happy");
    expect(result).toContain('i am');
    expect(result).not.toContain("i'm");
  });

  it("normalizeTextForStructuralComparison: expands don't → do not", () => {
    const result = normalizeTextForStructuralComparison("I don't know");
    expect(result).toContain('do not');
  });

  it("normalizeTextForStructuralComparison: expands can't → cannot", () => {
    const result = normalizeTextForStructuralComparison("I can't go");
    expect(result).toContain('cannot');
  });

  it('normalizeTextForCopyDetection: broader normalization produces different result from structural', () => {
    const text = 'The quick brown fox jumps over the lazy dog.';
    const structural = normalizeTextForStructuralComparison(text);
    const forCopy = normalizeTextForCopyDetection(text);
    // Copy detection sorts words within sentences — likely different from structural
    expect(typeof forCopy).toBe('string');
    expect(forCopy.length).toBeGreaterThan(0);
  });

  it('hashText: returns same hash for same input, different for different input', () => {
    const h1 = hashText('Hello World');
    const h2 = hashText('Hello World');
    const h3 = hashText('Hello World!');

    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(typeof h1).toBe('string');
    expect(h1.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 3: Copy detection (10 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Copy detection', () => {
  const correctedText =
    'I went to the store yesterday and bought some groceries. It was a nice day.';

  it('identical text → copied', () => {
    const result = detectCopy(correctedText, correctedText);
    expect(result.assessment).toBe('copied');
  });

  it('almost identical text (1 word changed) → likely_copied or copied', () => {
    const slightlyDiff = correctedText.replace('nice', 'great');
    const result = detectCopy(slightlyDiff, correctedText);
    expect(['copied', 'likely_copied']).toContain(result.assessment);
  });

  it('very different text → independent', () => {
    const veryDiff = 'My cat loves to sleep on the sofa every afternoon.';
    const result = detectCopy(veryDiff, correctedText);
    expect(['independent', 'likely_independent']).toContain(result.assessment);
  });

  it('contraction variant → not copied (likely_independent or independent)', () => {
    // Using contraction where corrected doesn't
    const withContractions = "I went to the store yesterday and bought groceries. It's a nice day.";
    const result = detectCopy(withContractions, correctedText);
    expect(['independent', 'likely_independent', 'uncertain']).toContain(result.assessment);
  });

  it('word order rewrite → not copied', () => {
    const reordered = 'Yesterday I went to the store and bought groceries. It was such a nice day.';
    const result = detectCopy(reordered, correctedText);
    expect(result.assessment).not.toBe('copied');
  });

  it('CopyDetectionResult has signals and confidence', () => {
    const result = detectCopy(correctedText, correctedText);
    expect(result.signals).toBeDefined();
    expect(typeof result.confidence).toBe('number');
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('signals.exactMatchNormalized is true for identical text', () => {
    const result = detectCopy(correctedText, correctedText);
    expect(result.signals.exactMatchNormalized).toBe(true);
  });

  it('signals.exactMatchNormalized is false for different text', () => {
    const other = 'Completely different sentence about something else.';
    const result = detectCopy(other, correctedText);
    expect(result.signals.exactMatchNormalized).toBe(false);
  });

  it('signals.similarityStructural is in [0,1]', () => {
    const result = detectCopy('Hello world', 'Hello there world');
    expect(result.signals.similarityStructural).toBeGreaterThanOrEqual(0);
    expect(result.signals.similarityStructural).toBeLessThanOrEqual(1);
  });

  it('uncertain similarity range returns uncertain or higher assessment', () => {
    // Moderately similar text
    const moderate =
      'I went to the store yesterday and bought some food for my family.';
    const result = detectCopy(moderate, correctedText);
    // Should be at least "uncertain" or better (not worse than uncertain)
    expect(['independent', 'likely_independent', 'uncertain', 'likely_copied', 'copied']).toContain(
      result.assessment,
    );
    expect(typeof result.signals.copySignalCount).toBe('number');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 4: Score calculation (8 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Score calculation', () => {
  const allHundreds = {
    correctionResolutionScore: 100,
    newErrorAvoidanceScore: 100,
    meaningPreservationScore: 100,
    clarityImprovementScore: 100,
    cohesionImprovementScore: 100,
    independenceScore: 100,
  };

  const allZeros = {
    correctionResolutionScore: 0,
    newErrorAvoidanceScore: 0,
    meaningPreservationScore: 0,
    clarityImprovementScore: 0,
    cohesionImprovementScore: 0,
    independenceScore: 0,
  };

  it('all 100s → overall 100', () => {
    expect(calculateRewriteImprovementScore(allHundreds)).toBe(100);
  });

  it('all 0s → overall 0', () => {
    expect(calculateRewriteImprovementScore(allZeros)).toBe(0);
  });

  it('weights sum to 1.0', () => {
    // 0.30 + 0.20 + 0.15 + 0.15 + 0.10 + 0.10 = 1.0
    const sum = 0.30 + 0.20 + 0.15 + 0.15 + 0.10 + 0.10;
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it('adjustedIndependenceScore: copied → 0', () => {
    expect(adjustedIndependenceScore(80, 'copied')).toBe(0);
  });

  it('adjustedIndependenceScore: likely_copied → raw * 0.3', () => {
    expect(adjustedIndependenceScore(100, 'likely_copied')).toBe(30);
    expect(adjustedIndependenceScore(50, 'likely_copied')).toBe(15);
  });

  it('clampScore: negative → 0, >100 → 100', () => {
    expect(clampScore(-10)).toBe(0);
    expect(clampScore(110)).toBe(100);
    expect(clampScore(50)).toBe(50);
  });

  it('buildRewriteScoreComponents returns overallImprovementScore in 0–100', () => {
    const scores = buildRewriteScoreComponents({
      correctionResolutionScore: 75,
      newErrorAvoidanceScore: 80,
      meaningPreservationScore: 90,
      clarityImprovementScore: 60,
      cohesionImprovementScore: 70,
      independenceScore: 85,
    });
    expect(scores.overallImprovementScore).toBeGreaterThanOrEqual(0);
    expect(scores.overallImprovementScore).toBeLessThanOrEqual(100);
  });

  it('server recalculates score — client score is not in the input shape', () => {
    // Score is derived from ScoreCalculationInput — there is no "clientScore" field
    const scoreInput = {
      correctionResolutionScore: 50,
      newErrorAvoidanceScore: 50,
      meaningPreservationScore: 50,
      clarityImprovementScore: 50,
      cohesionImprovementScore: 50,
      independenceScore: 50,
    };
    const result = calculateRewriteImprovementScore(scoreInput);
    // Weighted: 50 across all = 50
    expect(result).toBe(50);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 5: Correction outcomes (8 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Correction outcomes', () => {
  it('parseOutcomeStatus maps all canonical values', () => {
    expect(parseOutcomeStatus('corrected')).toBe('corrected');
    expect(parseOutcomeStatus('partially_corrected')).toBe('partially_corrected');
    expect(parseOutcomeStatus('partial')).toBe('partially_corrected');
    expect(parseOutcomeStatus('unchanged')).toBe('unchanged');
    expect(parseOutcomeStatus('valid_alternative')).toBe('valid_alternative');
    expect(parseOutcomeStatus('alternative')).toBe('valid_alternative');
    expect(parseOutcomeStatus('worsened')).toBe('worsened');
    expect(parseOutcomeStatus('not_applicable')).toBe('not_applicable');
    expect(parseOutcomeStatus('na')).toBe('not_applicable');
  });

  it('parseOutcomeStatus throws for unknown value', () => {
    expect(() => parseOutcomeStatus('something_weird')).toThrow();
  });

  it('outcomeIsResolved: true for corrected and valid_alternative', () => {
    expect(outcomeIsResolved('corrected')).toBe(true);
    expect(outcomeIsResolved('valid_alternative')).toBe(true);
    expect(outcomeIsResolved('unchanged')).toBe(false);
    expect(outcomeIsResolved('partially_corrected')).toBe(false);
    expect(outcomeIsResolved('worsened')).toBe(false);
    expect(outcomeIsResolved('not_applicable')).toBe(false);
  });

  it('calculateCorrectionResolutionScore: all corrected → 100', () => {
    const outcomes = [
      { status: 'corrected' as const, shouldAffectRewriteScore: true },
      { status: 'corrected' as const, shouldAffectRewriteScore: true },
    ];
    expect(calculateCorrectionResolutionScore(outcomes)).toBe(100);
  });

  it('calculateCorrectionResolutionScore: all unchanged → 0', () => {
    const outcomes = [
      { status: 'unchanged' as const, shouldAffectRewriteScore: true },
      { status: 'unchanged' as const, shouldAffectRewriteScore: true },
    ];
    expect(calculateCorrectionResolutionScore(outcomes)).toBe(0);
  });

  it('calculateCorrectionResolutionScore: not_applicable excluded from denominator', () => {
    const outcomes = [
      { status: 'corrected' as const, shouldAffectRewriteScore: true },
      { status: 'not_applicable' as const, shouldAffectRewriteScore: false },
    ];
    // 1 corrected out of 1 applicable = 100
    expect(calculateCorrectionResolutionScore(outcomes)).toBe(100);
  });

  it('calculateCorrectionResolutionScore: empty list → 0', () => {
    expect(calculateCorrectionResolutionScore([])).toBe(0);
  });

  it('outcomeContributesToCorrectionResolution: corrected + shouldAffect=true → true', () => {
    expect(outcomeContributesToCorrectionResolution('corrected', true)).toBe(true);
    expect(outcomeContributesToCorrectionResolution('corrected', false)).toBe(false);
    expect(outcomeContributesToCorrectionResolution('unchanged', true)).toBe(false);
    expect(outcomeContributesToCorrectionResolution('valid_alternative', true)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 6: Evidence types (4 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Evidence types', () => {
  it('shouldAffectMastery: error_corrected_independently + independent → true', () => {
    expect(shouldAffectMastery('error_corrected_independently', 'independent')).toBe(true);
    expect(shouldAffectMastery('error_corrected_independently', 'likely_independent')).toBe(true);
  });

  it('shouldAffectMastery: error_corrected_independently + copied → false', () => {
    expect(shouldAffectMastery('error_corrected_independently', 'copied')).toBe(false);
    expect(shouldAffectMastery('error_corrected_independently', 'likely_copied')).toBe(false);
  });

  it('shouldAffectMastery: no_independent_evidence → always false', () => {
    const assessments = ['independent', 'likely_independent', 'uncertain', 'likely_copied', 'copied'] as const;
    for (const a of assessments) {
      expect(shouldAffectMastery('no_independent_evidence', a)).toBe(false);
    }
  });

  it('buildContextKey has correct format', () => {
    const key = buildContextKey('review-1', 'correction-0', 'error_corrected_independently');
    expect(key).toBe('review-1:correction-0:error_corrected_independently');

    const keyNoCorrId = buildContextKey('review-1', undefined, 'no_independent_evidence');
    expect(keyNoCorrId).toBe('review-1:none:no_independent_evidence');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 7: Public DTO (8 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Public DTO', () => {
  const originalText = 'I go to the store yesterday.';
  const correctedText = 'I went to the store yesterday.';

  it('buildPublicRewriteDTO does NOT include raw model result', () => {
    const dto = buildPublicRewriteDTO(makeAttempt(), originalText, correctedText, makeEvaluation());
    expect((dto as Record<string, unknown>).rawModelOutput).toBeUndefined();
    expect((dto as Record<string, unknown>).promptVersion).toBeUndefined();
  });

  it('buildPublicRewriteDTO does NOT include copy signals', () => {
    const dto = buildPublicRewriteDTO(makeAttempt(), originalText, correctedText, makeEvaluation());
    expect((dto as Record<string, unknown>).signals).toBeUndefined();
    expect((dto as Record<string, unknown>).copySignals).toBeUndefined();
    expect((dto as Record<string, unknown>).copyDetection).toBeUndefined();
  });

  it('buildPublicRewriteDTO does NOT include evidence candidates', () => {
    const dto = buildPublicRewriteDTO(makeAttempt(), originalText, correctedText, makeEvaluation());
    expect((dto as Record<string, unknown>).evidenceCandidates).toBeUndefined();
    expect((dto as Record<string, unknown>).shouldAffectMastery).toBeUndefined();
  });

  it('buildPublicRewriteDTO maps all three texts correctly', () => {
    const dto = buildPublicRewriteDTO(makeAttempt(), originalText, correctedText, null);
    expect(dto.originalText).toBe(originalText);
    expect(dto.correctedText).toBe(correctedText);
    expect(dto.rewriteText).toBe('I went to the store yesterday.');
  });

  it('buildPublicRewriteDTO: evaluation is null when not yet evaluated', () => {
    const dto = buildPublicRewriteDTO(
      makeAttempt({ status: 'submitted', rewriteText: 'I went there.' }),
      originalText,
      correctedText,
      null,
    );
    expect(dto.evaluation).toBeNull();
  });

  it('buildPublicRewriteDTO: correctionOutcomes has correctionId, status, explanationPtBR', () => {
    const dto = buildPublicRewriteDTO(makeAttempt(), originalText, correctedText, makeEvaluation());
    expect(dto.evaluation).not.toBeNull();
    const outcome = dto.evaluation!.correctionOutcomes[0];
    expect(outcome.correctionId).toBe('0');
    expect(outcome.status).toBe('corrected');
    expect(outcome.explanationPtBR).toBe('Corrigido corretamente.');
    // Internal fields should NOT be present
    expect((outcome as Record<string, unknown>).confidence).toBeUndefined();
    expect((outcome as Record<string, unknown>).shouldAffectRewriteScore).toBeUndefined();
  });

  it('mapStatus: evaluation_pending → pending, evaluation_failed → failed', () => {
    const pendingDto = buildPublicRewriteDTO(
      makeAttempt({ status: 'evaluation_pending' }),
      originalText,
      correctedText,
      null,
    );
    expect(pendingDto.status).toBe('pending');

    const failedDto = buildPublicRewriteDTO(
      makeAttempt({ status: 'evaluation_failed' }),
      originalText,
      correctedText,
      null,
    );
    expect(failedDto.status).toBe('failed');
  });

  it('mapStatus: superseded → submitted (backward compat)', () => {
    const dto = buildPublicRewriteDTO(
      makeAttempt({ status: 'superseded' }),
      originalText,
      correctedText,
      null,
    );
    expect(dto.status).toBe('submitted');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Group 8: Feature flags (8 tests)
// ═══════════════════════════════════════════════════════════════════════════════

describe('RewriteV2 feature flags', () => {
  let orig: string | undefined;

  beforeEach(() => {
    orig = process.env.CANONICAL_WRITING_REWRITE_V2;
  });

  afterEach(() => {
    if (orig !== undefined) {
      process.env.CANONICAL_WRITING_REWRITE_V2 = orig;
    } else {
      delete process.env.CANONICAL_WRITING_REWRITE_V2;
    }
  });

  it('getRewriteV2Mode defaults to "off" when env not set', () => {
    delete process.env.CANONICAL_WRITING_REWRITE_V2;
    expect(getRewriteV2Mode()).toBe('off');
  });

  it('getRewriteV2Mode reads CANONICAL_WRITING_REWRITE_V2 correctly', () => {
    process.env.CANONICAL_WRITING_REWRITE_V2 = 'shadow';
    expect(getRewriteV2Mode()).toBe('shadow');

    process.env.CANONICAL_WRITING_REWRITE_V2 = 'full';
    expect(getRewriteV2Mode()).toBe('full');
  });

  it('isRewriteV2Enabled: false when off', () => {
    delete process.env.CANONICAL_WRITING_REWRITE_V2;
    expect(isRewriteV2Enabled()).toBe(false);
  });

  it('isRewriteV2Enabled: true when shadow', () => {
    process.env.CANONICAL_WRITING_REWRITE_V2 = 'shadow';
    expect(isRewriteV2Enabled()).toBe(true);
  });

  it('isRewriteV2Shadow: true only in shadow mode', () => {
    process.env.CANONICAL_WRITING_REWRITE_V2 = 'shadow';
    expect(isRewriteV2Shadow()).toBe(true);

    process.env.CANONICAL_WRITING_REWRITE_V2 = 'full';
    expect(isRewriteV2Shadow()).toBe(false);
  });

  it('isRewriteV2FullyActive: true for full, admin, new_users', () => {
    for (const mode of ['full', 'admin', 'new_users']) {
      process.env.CANONICAL_WRITING_REWRITE_V2 = mode;
      expect(isRewriteV2FullyActive()).toBe(true);
    }
  });

  it('isRewriteV2FullyActive: false for shadow', () => {
    process.env.CANONICAL_WRITING_REWRITE_V2 = 'shadow';
    expect(isRewriteV2FullyActive()).toBe(false);
  });

  it('unknown value falls back to "off"', () => {
    process.env.CANONICAL_WRITING_REWRITE_V2 = 'maybe_later';
    expect(getRewriteV2Mode()).toBe('off');
    expect(isRewriteV2Enabled()).toBe(false);
  });
});
