import { describe, it, expect, vi } from 'vitest';
import { resolveActivityCelebration, type ResolveDeps } from '../resolveCelebration';
import type { ObligatoryCompletion, ObligatoryFeatures } from '../celebration-types';

function makeDeps(over: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    fetchFeatures: async (): Promise<ObligatoryFeatures> => ({
      writing: true,
      pronunciation: true,
      listening: true,
    }),
    fetchCompletion: async (): Promise<ObligatoryCompletion> => ({
      writing: false,
      pronunciation: false,
      listening: false,
    }),
    fetchStreakEvent: async () => ({
      current: 8,
      previousBest: 0,
      isMilestone: false,
      isRecord: false,
      kind: null,
    }),
    ...over,
  };
}

describe('resolveActivityCelebration', () => {
  it('a genuine completion that is not the last → individual activity celebration', async () => {
    const c = await resolveActivityCelebration('writing', makeDeps());
    expect(c.type).toBe('activity-complete');
    if (c.type === 'activity-complete') {
      expect(c.activityType).toBe('writing');
      expect(c.completedCount).toBe(1);
      expect(c.totalCount).toBe(3);
    }
  });

  it('the last obligatory activity → ONLY day-complete (with streak), not an activity one', async () => {
    const c = await resolveActivityCelebration(
      'listening',
      makeDeps({
        fetchCompletion: async () => ({ writing: true, pronunciation: true, listening: false }),
      }),
    );
    expect(c.type).toBe('day-complete');
    if (c.type === 'day-complete') {
      expect(c.streakDays).toBe(8);
      expect(c.completedCount).toBe(3);
      expect(c.totalCount).toBe(3);
    }
  });

  it('user with a single configured activity → completing it goes straight to day-complete', async () => {
    const c = await resolveActivityCelebration(
      'listening',
      makeDeps({
        fetchFeatures: async () => ({ writing: false, pronunciation: false, listening: true }),
      }),
    );
    expect(c.type).toBe('day-complete');
    if (c.type === 'day-complete') expect(c.totalCount).toBe(1);
  });

  it('conversation (optional) never triggers day-complete and never fetches the day', async () => {
    const fetchFeatures = vi.fn(async () => ({ writing: true, pronunciation: true, listening: true }));
    const fetchCompletion = vi.fn(async () => ({ writing: true, pronunciation: true, listening: true }));
    const c = await resolveActivityCelebration('conversation', makeDeps({ fetchFeatures, fetchCompletion }));
    expect(c.type).toBe('activity-complete');
    expect(fetchFeatures).not.toHaveBeenCalled();
    expect(fetchCompletion).not.toHaveBeenCalled();
  });

  it('review (optional) resolves to a plain activity celebration', async () => {
    const c = await resolveActivityCelebration('review', makeDeps());
    expect(c.type).toBe('activity-complete');
    if (c.type === 'activity-complete') expect(c.activityType).toBe('review');
  });

  it('fail-safe: an entitlements fetch failure never yields a false day-complete', async () => {
    // features fetch throws → defaults to "all three required"; only one done →
    // must be activity-complete, never a wrongly-celebrated whole day.
    const c = await resolveActivityCelebration(
      'writing',
      makeDeps({
        fetchFeatures: async () => {
          throw new Error('network');
        },
      }),
    );
    expect(c.type).toBe('activity-complete');
  });

  it('fail-safe: a completion fetch failure still resolves (activity-complete)', async () => {
    const c = await resolveActivityCelebration(
      'pronunciation',
      makeDeps({
        fetchCompletion: async () => {
          throw new Error('db down');
        },
      }),
    );
    expect(c.type).toBe('activity-complete');
  });

  it('day-complete with an unavailable streak still resolves (streak omitted, not crash)', async () => {
    const c = await resolveActivityCelebration(
      'listening',
      makeDeps({
        fetchCompletion: async () => ({ writing: true, pronunciation: true, listening: false }),
        fetchStreakEvent: async () => {
          throw new Error('no streak');
        },
      }),
    );
    expect(c.type).toBe('day-complete');
    if (c.type === 'day-complete') expect(c.streakDays).toBeNull();
  });

  it('a milestone on the completing day → a streak celebration (not plain day-complete)', async () => {
    const c = await resolveActivityCelebration(
      'listening',
      makeDeps({
        fetchCompletion: async () => ({ writing: true, pronunciation: true, listening: false }),
        fetchStreakEvent: async () => ({
          current: 7,
          previousBest: 0,
          isMilestone: true,
          isRecord: false,
          kind: 'milestone',
        }),
      }),
    );
    expect(c.type).toBe('streak');
    if (c.type === 'streak') {
      expect(c.kind).toBe('milestone');
      expect(c.streakDays).toBe(7);
      expect(c.totalCount).toBe(3);
    }
  });

  it('a personal record / both carries the previous best', async () => {
    const c = await resolveActivityCelebration(
      'listening',
      makeDeps({
        fetchCompletion: async () => ({ writing: true, pronunciation: true, listening: false }),
        fetchStreakEvent: async () => ({
          current: 30,
          previousBest: 22,
          isMilestone: true,
          isRecord: true,
          kind: 'both',
        }),
      }),
    );
    expect(c.type).toBe('streak');
    if (c.type === 'streak') {
      expect(c.kind).toBe('both');
      expect(c.previousBest).toBe(22);
    }
  });

  it('always returns exactly one celebration object', async () => {
    const c = await resolveActivityCelebration('writing', makeDeps());
    expect(typeof c.type).toBe('string');
    expect(['activity-complete', 'day-complete', 'streak']).toContain(c.type);
  });
});
