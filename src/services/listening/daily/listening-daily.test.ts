import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveListeningActivityDate } from './resolve-listening-activity-date';
import { calculateListeningPerformance } from '../performance/calculate-listening-performance';
import { resolveListeningCalendarStatus } from '../calendar/resolve-listening-calendar-status';
import { getOrCreateListeningAssignment } from './get-or-create-listening-assignment';

// ── resolveListeningActivityDate ──────────────────────────────────────────────

describe('resolveListeningActivityDate', () => {
  it('returns a valid YYYY-MM-DD string', () => {
    const date = resolveListeningActivityDate();
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('accepts a custom Date and returns correct format', () => {
    const date = resolveListeningActivityDate(new Date('2026-07-15T12:00:00Z'));
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ── calculateListeningPerformance ─────────────────────────────────────────────

describe('calculateListeningPerformance', () => {
  it('cycles (1,1) → score 100', () => {
    const result = calculateListeningPerformance(1, 1);
    expect(result.performanceScore).toBe(100);
  });

  it('cycles (2,2) → score 70', () => {
    const result = calculateListeningPerformance(2, 2);
    expect(result.performanceScore).toBe(70);
  });

  it('cycles (3,3) → score 40', () => {
    const result = calculateListeningPerformance(3, 3);
    expect(result.performanceScore).toBe(40);
  });

  it('cycles (1,2) → score 85', () => {
    const result = calculateListeningPerformance(1, 2);
    expect(result.performanceScore).toBe(85);
  });

  it('cycles (99,99) → score 40 (MIN_WEIGHT clamping)', () => {
    const result = calculateListeningPerformance(99, 99);
    expect(result.performanceScore).toBe(40);
  });
});

// ── resolveListeningCalendarStatus ───────────────────────────────────────────

describe('resolveListeningCalendarStatus', () => {
  it("'completed' → 'completed'", () => {
    expect(resolveListeningCalendarStatus('completed')).toBe('completed');
  });

  it('undefined → coming_soon', () => {
    expect(resolveListeningCalendarStatus(undefined)).toBe('coming_soon');
  });

  it("'in_progress' → 'in_progress'", () => {
    expect(resolveListeningCalendarStatus('in_progress')).toBe('in_progress');
  });

  it("'not_started' → 'not_started'", () => {
    expect(resolveListeningCalendarStatus('not_started')).toBe('not_started');
  });
});

// ── getOrCreateListeningAssignment ───────────────────────────────────────────

describe('getOrCreateListeningAssignment', () => {
  function makeRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'assignment-id-1',
      user_id: 'user-1',
      episode_id: 'episode-1',
      activity_date: '2026-07-15',
      status: 'assigned',
      assigned_at: '2026-07-15T00:00:00Z',
      started_at: null,
      completed_at: null,
      created_at: '2026-07-15T00:00:00Z',
      updated_at: '2026-07-15T00:00:00Z',
      ...overrides,
    };
  }

  it('creates a new assignment when none exists', async () => {
    const existingRow = makeRow();
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
        insert: () => ({
          select: () => ({
            single: async () => ({ data: existingRow, error: null }),
          }),
        }),
      }),
    } as any;

    const result = await getOrCreateListeningAssignment(supabase, {
      userId: 'user-1',
      episodeId: 'episode-1',
      activityDate: '2026-07-15',
    });

    expect(result.created).toBe(true);
    expect(result.assignment.id).toBe('assignment-id-1');
  });

  it('returns existing assignment on 2nd call', async () => {
    const existingRow = makeRow({ status: 'in_progress' });
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: existingRow, error: null }),
            }),
          }),
        }),
      }),
    } as any;

    const result = await getOrCreateListeningAssignment(supabase, {
      userId: 'user-1',
      episodeId: 'episode-1',
      activityDate: '2026-07-15',
    });

    expect(result.created).toBe(false);
    expect(result.assignment.status).toBe('in_progress');
  });

  it('handles 23505 race condition gracefully', async () => {
    const existingRow = makeRow();
    let maybeSingleCalls = 0;
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => {
                maybeSingleCalls++;
                // First call returns null (no existing), second returns the row (race winner)
                if (maybeSingleCalls === 1) return { data: null, error: null };
                return { data: existingRow, error: null };
              },
            }),
          }),
        }),
        insert: () => ({
          select: () => ({
            single: async () => ({
              data: null,
              error: { code: '23505', message: 'duplicate key value' },
            }),
          }),
        }),
      }),
    } as any;

    const result = await getOrCreateListeningAssignment(supabase, {
      userId: 'user-1',
      episodeId: 'episode-1',
      activityDate: '2026-07-15',
    });

    expect(result.created).toBe(false);
    expect(result.assignment.id).toBe('assignment-id-1');
  });
});
