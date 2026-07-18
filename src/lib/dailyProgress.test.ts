import { describe, it, expect } from 'vitest';
import { computeDailyProgress, type ActiveDailyFeatures } from './dailyProgress';
import type { DayEntry } from '../types';

const DATE = '2026-07-18';

function makeEntry(overrides: Partial<DayEntry> = {}): DayEntry {
  return {
    date: DATE,
    title: '',
    originalText: 'Some English text',
    correctedText: '',
    observations: '',
    mainErrors: '',
    difficulty: null,
    status: 'revisado',
    wordCount: 3,
    updatedAt: '',
    aiReview: null,
    reviewedAt: null,
    ...overrides,
  };
}

const ALL_ACTIVE: ActiveDailyFeatures = { writingEnabled: true, pronunciationEnabled: true, listeningEnabled: true };

describe('computeDailyProgress — conversation is always optional', () => {
  it('is green when writing, pronunciation, and listening are complete, even if conversation was never done', () => {
    const progress = computeDailyProgress(
      DATE, makeEntry(), /* convTotalSec */ 0, /* convGoalSec */ 15 * 60,
      new Set([DATE]), 'completed', ALL_ACTIVE,
    );
    expect(progress.conversation).toBe('not_started');
    expect(progress.allActiveCompleted).toBe(true);
  });

  it('is still green when the conversation goal exists but was not met', () => {
    const progress = computeDailyProgress(
      DATE, makeEntry(), /* convTotalSec */ 180, /* convGoalSec */ 15 * 60,
      new Set([DATE]), 'completed', ALL_ACTIVE,
    );
    expect(progress.conversation).toBe('in_progress');
    expect(progress.allActiveCompleted).toBe(true);
  });

  it('separately reports the conversation goal as completed without affecting the day color logic', () => {
    const progress = computeDailyProgress(
      DATE, makeEntry(), /* convTotalSec */ 20 * 60, /* convGoalSec */ 15 * 60,
      new Set([DATE]), 'completed', ALL_ACTIVE,
    );
    expect(progress.conversation).toBe('completed');
    expect(progress.allActiveCompleted).toBe(true);
  });
});

describe('computeDailyProgress — only plan-active features are obligatory', () => {
  it('requires writing when active but not pronunciation/listening when the plan disables them', () => {
    const features: ActiveDailyFeatures = { writingEnabled: true, pronunciationEnabled: false, listeningEnabled: false };
    const progress = computeDailyProgress(
      DATE, makeEntry({ status: 'revisado' }), 0, 900, new Set(), 'not_started', features,
    );
    expect(progress.allActiveCompleted).toBe(true);
  });

  it('does not require listening completion when listening is disabled by plan', () => {
    const features: ActiveDailyFeatures = { writingEnabled: true, pronunciationEnabled: true, listeningEnabled: false };
    const progress = computeDailyProgress(
      DATE, makeEntry({ status: 'revisado' }), 0, 900, new Set([DATE]), 'not_started', features,
    );
    expect(progress.allActiveCompleted).toBe(true);
  });

  it('still requires listening when it is active in the plan and not completed', () => {
    const features: ActiveDailyFeatures = { writingEnabled: true, pronunciationEnabled: true, listeningEnabled: true };
    const progress = computeDailyProgress(
      DATE, makeEntry({ status: 'revisado' }), 0, 900, new Set([DATE]), 'not_started', features,
    );
    expect(progress.allActiveCompleted).toBe(false);
  });

  it('never turns green automatically when the plan has zero obligatory activities active', () => {
    const features: ActiveDailyFeatures = { writingEnabled: false, pronunciationEnabled: false, listeningEnabled: false };
    const progress = computeDailyProgress(
      DATE, makeEntry({ status: 'revisado' }), 20 * 60, 900, new Set([DATE]), 'completed', features,
    );
    expect(progress.allActiveCompleted).toBe(false);
  });

  it('defaults to treating all three as active when activeFeatures is omitted (backward compatible)', () => {
    const progress = computeDailyProgress(
      DATE, makeEntry({ status: 'revisado' }), 0, 900, new Set([DATE]), 'completed',
    );
    expect(progress.allActiveCompleted).toBe(true);
  });

  it('is not green when a plan-active obligatory activity is incomplete, regardless of conversation', () => {
    const progress = computeDailyProgress(
      DATE, makeEntry({ status: 'nao-iniciado', originalText: '' }), 20 * 60, 900,
      new Set([DATE]), 'completed', ALL_ACTIVE,
    );
    expect(progress.writing).toBe('not_started');
    expect(progress.allActiveCompleted).toBe(false);
  });
});
