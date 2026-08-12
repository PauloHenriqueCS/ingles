import { describe, it, expect, vi, beforeEach } from 'vitest';

// getPronunciationDatesForMonth reads the browser supabase client singleton,
// which throws at module load without VITE_SUPABASE_URL/ANON_KEY. Mock it (same
// technique as the other lib tests) so we can drive per-table query results.
// Kept in its own file so the existing dailyProgress.test.ts (pure
// computeDailyProgress tests, no supabase) stays mock-free.
const { mockSupabaseFrom } = vi.hoisted(() => ({ mockSupabaseFrom: vi.fn() }));

vi.mock('./supabase', () => ({ supabase: { from: mockSupabaseFrom } }));

import { getPronunciationDatesForMonth } from './dailyProgress';

// Minimal thenable query-builder stub: select/eq/gte/lt are chainable and the
// object resolves to { data } when awaited. Records the status filter so we can
// assert only status='completed' rows are requested.
const builders: Record<string, { statusFilter?: string }> = {};
function makeTable(table: string, rows: unknown[]) {
  const state: { statusFilter?: string } = {};
  builders[table] = state;
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (col: string, val: string) => {
      if (col === 'status') state.statusFilter = val;
      return builder;
    },
    gte: () => builder,
    lt: () => builder,
    then: (resolve: (v: { data: unknown[] }) => unknown) => resolve({ data: rows }),
  };
  return builder;
}

function routeTables(map: Record<string, unknown[]>) {
  for (const k of Object.keys(builders)) delete builders[k];
  mockSupabaseFrom.mockImplementation((table: string) => makeTable(table, map[table] ?? []));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getPronunciationDatesForMonth — unions both pronunciation surfaces', () => {
  it('lights up a day whose ONLY completed analysis is a "Treinar pronúncia" training session', async () => {
    routeTables({
      pronunciation_assessments: [],
      // 2026-08-15T12:00:00Z → 09:00 America/Sao_Paulo → 2026-08-15
      pronunciation_training_sessions: [{ completed_at: '2026-08-15T12:00:00Z' }],
    });

    const dates = await getPronunciationDatesForMonth(2026, 8);

    expect(dates.has('2026-08-15')).toBe(true);
  });

  it('collapses multiple analyses on the same day (both surfaces) into a single active day', async () => {
    routeTables({
      pronunciation_assessments: [{ completed_at: '2026-08-15T12:00:00Z' }],
      pronunciation_training_sessions: [
        { completed_at: '2026-08-15T18:00:00Z' },
        { completed_at: '2026-08-15T20:30:00Z' },
      ],
    });

    const dates = await getPronunciationDatesForMonth(2026, 8);

    expect([...dates]).toEqual(['2026-08-15']);
  });

  it('only counts status=completed for both surfaces (failed/text-only excluded)', async () => {
    routeTables({ pronunciation_assessments: [], pronunciation_training_sessions: [] });

    await getPronunciationDatesForMonth(2026, 8);

    expect(builders['pronunciation_training_sessions'].statusFilter).toBe('completed');
    expect(builders['pronunciation_assessments'].statusFilter).toBe('completed');
  });

  it('maps completed_at to the São Paulo day across the UTC midnight boundary', async () => {
    routeTables({
      pronunciation_assessments: [],
      // 2026-08-16T02:00:00Z → 2026-08-15 23:00 America/Sao_Paulo → 2026-08-15
      pronunciation_training_sessions: [{ completed_at: '2026-08-16T02:00:00Z' }],
    });

    const dates = await getPronunciationDatesForMonth(2026, 8);

    expect(dates.has('2026-08-15')).toBe(true);
    expect(dates.has('2026-08-16')).toBe(false);
  });

  it('still works when only diary (Surface #1) assessments exist (regression)', async () => {
    routeTables({
      pronunciation_assessments: [{ completed_at: '2026-08-10T12:00:00Z' }],
      pronunciation_training_sessions: [],
    });

    const dates = await getPronunciationDatesForMonth(2026, 8);

    expect(dates.has('2026-08-10')).toBe(true);
  });
});
