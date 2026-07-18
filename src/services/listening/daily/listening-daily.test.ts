import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveListeningActivityDate } from './resolve-listening-activity-date';
import { calculateListeningPerformance } from '../performance/calculate-listening-performance';
import { resolveListeningCalendarStatus } from '../calendar/resolve-listening-calendar-status';
import { getOrCreateListeningAssignment } from './get-or-create-listening-assignment';
import { getListeningByDate } from './get-listening-by-date';
import { selectListeningEpisodeForUser } from './select-listening-episode-for-user';

// Chainable Supabase-like mock: every filter method (eq/not/is/order/etc.)
// returns the same chain object regardless of call count, so tests don't
// need to hardcode how many .eq()/.not() calls the real query makes.
function makeChain(result: { data: unknown; error?: unknown }) {
  const resolved = Promise.resolve({ error: null, ...result });
  const chain: Record<string, unknown> = {
    select: () => chain, eq: () => chain, in: () => chain, not: () => chain, is: () => chain, order: () => chain,
    maybeSingle: () => resolved,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => resolved.then(resolve, reject),
  };
  return chain;
}

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
        ...makeChain({ data: null }),
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
      from: () => makeChain({ data: existingRow }),
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

  it('creating a different episode the same day is a distinct row, not a race', async () => {
    // limit=3 scenario: story 2 of the day — no existing row for THIS episode.
    const secondEpisodeRow = makeRow({ id: 'assignment-id-2', episode_id: 'episode-2' });
    const supabase = {
      from: () => ({
        ...makeChain({ data: null }),
        insert: () => ({
          select: () => ({
            single: async () => ({ data: secondEpisodeRow, error: null }),
          }),
        }),
      }),
    } as any;

    const result = await getOrCreateListeningAssignment(supabase, {
      userId: 'user-1',
      episodeId: 'episode-2',
      activityDate: '2026-07-15',
    });

    expect(result.created).toBe(true);
    expect(result.assignment.episodeId).toBe('episode-2');
  });
});

// ── selectListeningEpisodeForUser — excludeEpisodeIds ────────────────────────

describe('selectListeningEpisodeForUser', () => {
  function makeSupabase(episodes: { id: string }[], assignments: { episode_id: string; status: string }[]) {
    return {
      from: (table: string) => {
        if (table === 'listening_episodes') {
          return { select: () => ({ eq: () => ({ eq: () => ({ order: async () => ({ data: episodes, error: null }) }) }) }) };
        }
        return { select: () => ({ eq: () => ({ in: async () => ({ data: assignments, error: null }) }) }) };
      },
    } as any;
  }

  it('never-assigned episode is picked first when nothing is excluded', async () => {
    const supabase = makeSupabase([{ id: 'ep-1' }, { id: 'ep-2' }], []);
    const result = await selectListeningEpisodeForUser(supabase, 'user-1', 'A1');
    expect(result).toBe('ep-1');
  });

  it("today's already-assigned episodes are excluded so a distinct story is returned", async () => {
    const supabase = makeSupabase([{ id: 'ep-1' }, { id: 'ep-2' }, { id: 'ep-3' }], []);
    const result = await selectListeningEpisodeForUser(supabase, 'user-1', 'A1', ['ep-1', 'ep-2']);
    expect(result).toBe('ep-3');
  });

  it('returns null when every episode at this level is already excluded (inventory exhausted for today)', async () => {
    const supabase = makeSupabase([{ id: 'ep-1' }, { id: 'ep-2' }], []);
    const result = await selectListeningEpisodeForUser(supabase, 'user-1', 'A1', ['ep-1', 'ep-2']);
    expect(result).toBeNull();
  });
});

// ── getListeningByDate — multi-row days ───────────────────────────────────────

describe('getListeningByDate', () => {
  it('returns no_assignment when nothing exists for the date', async () => {
    const supabase = { from: () => makeChain({ data: [] }) } as any;
    const result = await getListeningByDate(supabase, 'user-1', '2026-07-18');
    expect(result).toEqual({ status: 'no_assignment' });
  });

  it('prefers the active (non-completed) row when a multi-story day has both', async () => {
    const rows = [
      { id: 'a-completed', episode_id: 'ep-1', activity_date: '2026-07-18', status: 'completed', created_at: '2026-07-18T10:00:00Z' },
      { id: 'a-active', episode_id: 'ep-2', activity_date: '2026-07-18', status: 'in_progress', created_at: '2026-07-18T11:00:00Z' },
    ];
    const supabase = { from: () => makeChain({ data: rows }) } as any;
    const result = await getListeningByDate(supabase, 'user-1', '2026-07-18');
    expect(result).toEqual({ status: 'in_progress', assignmentId: 'a-active', episodeId: 'ep-2', activityDate: '2026-07-18' });
  });

  it('falls back to the most recent row when every story that day is completed', async () => {
    // Rows arrive pre-sorted by created_at desc, as the real query orders them.
    const rows = [
      { id: 'a-2', episode_id: 'ep-2', activity_date: '2026-07-18', status: 'completed', created_at: '2026-07-18T12:00:00Z' },
      { id: 'a-1', episode_id: 'ep-1', activity_date: '2026-07-18', status: 'completed', created_at: '2026-07-18T09:00:00Z' },
    ];
    const supabase = { from: () => makeChain({ data: rows }) } as any;
    const result = await getListeningByDate(supabase, 'user-1', '2026-07-18');
    expect(result).toEqual({ status: 'completed', assignmentId: 'a-2', episodeId: 'ep-2', activityDate: '2026-07-18' });
  });
});
