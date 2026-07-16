import { describe, it, expect } from 'vitest';
import { deduplicateReviews, computeWeekdayStreak, getPracticeDate } from './metricsCore';
import type { EnglishReviewSaved } from '../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReview(
  overrides: Partial<EnglishReviewSaved> & { entryDate?: string | null; createdAt: string },
): EnglishReviewSaved {
  return {
    id: overrides.createdAt,
    originalText: 'test',
    correctedText: null,
    score: 70,
    level: 'A1',
    grammar: 70,
    vocabulary: 70,
    naturalness: 70,
    fluency: 70,
    summary: null,
    mainMistakes: [],
    newVocabulary: [],
    objectiveFeedback: null,
    nextPractice: null,
    category: null,
    difficulty: null,
    objective: null,
    missionSnapshot: null,
    version2Text: null,
    version2Comparison: null,
    version2ImprovementScore: null,
    version2FinalText: null,
    ...overrides,
  };
}

// ── getPracticeDate ───────────────────────────────────────────────────────────

describe('getPracticeDate', () => {
  it('prefers entryDate over createdAt', () => {
    const r = makeReview({ createdAt: '2026-01-10T12:00:00Z', entryDate: '2026-01-05' });
    expect(getPracticeDate(r)).toBe('2026-01-05');
  });

  it('falls back to createdAt date when entryDate is null', () => {
    const r = makeReview({ createdAt: '2026-01-10T12:00:00Z', entryDate: null });
    expect(getPracticeDate(r)).toBe('2026-01-10');
  });
});

// ── deduplicateReviews ────────────────────────────────────────────────────────

describe('deduplicateReviews', () => {
  it('keeps only the most recent review per entryDate', () => {
    const reviews = [
      makeReview({ createdAt: '2026-01-05T10:00:00Z', entryDate: '2026-01-05', score: 60 }),
      makeReview({ createdAt: '2026-01-06T10:00:00Z', entryDate: '2026-01-05', score: 75 }),
      makeReview({ createdAt: '2026-01-07T10:00:00Z', entryDate: '2026-01-05', score: 80 }),
    ];
    const result = deduplicateReviews(reviews);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(80);
  });

  it('keeps separate reviews for different entryDates', () => {
    const reviews = [
      makeReview({ createdAt: '2026-01-05T10:00:00Z', entryDate: '2026-01-05' }),
      makeReview({ createdAt: '2026-01-06T10:00:00Z', entryDate: '2026-01-06' }),
    ];
    expect(deduplicateReviews(reviews)).toHaveLength(2);
  });

  it('keeps reviews with null entryDate without merging them', () => {
    const reviews = [
      makeReview({ createdAt: '2026-01-05T10:00:00Z', entryDate: null }),
      makeReview({ createdAt: '2026-01-06T10:00:00Z', entryDate: null }),
    ];
    expect(deduplicateReviews(reviews)).toHaveLength(2);
  });

  it('mixes dated and undated correctly', () => {
    const reviews = [
      makeReview({ createdAt: '2026-01-04T10:00:00Z', entryDate: '2026-01-04', score: 50 }),
      makeReview({ createdAt: '2026-01-05T10:00:00Z', entryDate: '2026-01-04', score: 70 }),
      makeReview({ createdAt: '2026-01-06T10:00:00Z', entryDate: null, score: 90 }),
    ];
    const result = deduplicateReviews(reviews);
    // 1 from deduplicated dated (Jan 4 latest) + 1 undated = 2
    expect(result).toHaveLength(2);
    const dated = result.find((r) => r.entryDate === '2026-01-04');
    expect(dated?.score).toBe(70);
  });

  it('returns empty array for empty input', () => {
    expect(deduplicateReviews([])).toHaveLength(0);
  });
});

// ── computeWeekdayStreak ──────────────────────────────────────────────────────

describe('computeWeekdayStreak', () => {
  // Reference: 2026-01-12 is Monday.

  it('returns 0 for empty activeDates', () => {
    expect(computeWeekdayStreak([], '2026-01-12')).toBe(0);
  });

  it('consecutive Mon-Thu, today = Thu → streak 4', () => {
    const dates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'];
    expect(computeWeekdayStreak(dates, '2026-01-08')).toBe(4);
  });

  it('today not yet done (weekday) does not break the streak', () => {
    // Mon-Thu done, today = Fri (not done yet)
    const dates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'];
    expect(computeWeekdayStreak(dates, '2026-01-09')).toBe(4);
  });

  it('gap on a past weekday breaks the streak', () => {
    // Mon, Tue, MISSING Wed, Thu – today = Thu → streak = 1 (only Thu)
    const dates = ['2026-01-05', '2026-01-06', '2026-01-08'];
    expect(computeWeekdayStreak(dates, '2026-01-08')).toBe(1);
  });

  it('weekend does NOT break the streak', () => {
    // Mon-Fri (Jan 5-9), today = Mon Jan 12 (not written yet) → streak = 5
    const dates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'];
    expect(computeWeekdayStreak(dates, '2026-01-12')).toBe(5);
  });

  it('today = Saturday skips to last Friday — streak intact', () => {
    // Mon-Fri written, today = Sat Jan 10 → streak = 5
    const dates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'];
    expect(computeWeekdayStreak(dates, '2026-01-10')).toBe(5);
  });

  it('today = Sunday skips to last Friday — streak intact', () => {
    const dates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'];
    expect(computeWeekdayStreak(dates, '2026-01-11')).toBe(5);
  });

  it('writing on a weekend does NOT add to the streak', () => {
    // Mon-Fri + Sat + Sun written — streak should still be 5
    const dates = [
      '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09',
      '2026-01-10', '2026-01-11',
    ];
    // Today = Mon Jan 12 (not written)
    expect(computeWeekdayStreak(dates, '2026-01-12')).toBe(5);
  });

  it('multiple reviews on the same date count as one active day', () => {
    // Jan 5 appears 3 times — streak should be 1, not 3
    const dates = ['2026-01-05', '2026-01-05', '2026-01-05'];
    expect(computeWeekdayStreak(dates, '2026-01-05')).toBe(1);
  });

  it('listening-only day counts as an active day for streak', () => {
    // Scenario: user did listening on Mon (no writing), then writing Tue-Wed.
    // All three contribute to streak = 3.
    const dates = ['2026-01-05', '2026-01-06', '2026-01-07'];
    expect(computeWeekdayStreak(dates, '2026-01-07')).toBe(3);
  });

  it('streak = 0 when latest activity is older than last weekday', () => {
    // Only Thu Jan 8 written, today = Mon Jan 12 → Fri Jan 9 gap breaks streak
    const dates = ['2026-01-08'];
    expect(computeWeekdayStreak(dates, '2026-01-12')).toBe(0);
  });

  it('single activity on today gives streak = 1', () => {
    expect(computeWeekdayStreak(['2026-01-12'], '2026-01-12')).toBe(1);
  });

  it('respects custom activeWeekdays (e.g. Mon-Sat)', () => {
    // With Sat included: Mon-Sat written, today = Sat
    const dates = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-10'];
    expect(computeWeekdayStreak(dates, '2026-01-10', [1, 2, 3, 4, 5, 6])).toBe(6);
  });
});
