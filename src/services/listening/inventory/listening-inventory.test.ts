import { describe, it, expect } from 'vitest';
import { getListeningInventoryStatus } from './get-listening-inventory-status';
import { selectListeningGenerationTheme } from './select-listening-generation-theme';

// ── Mock builder ──────────────────────────────────────────────────────────────

function buildMockClient(tables: Record<string, unknown[]> = {}) {
  const fromFn = (table: string) => {
    const rows = tables[table] ?? [];
    let filtered = [...rows];

    const builder: any = {
      select: () => builder,
      eq:     (_: string, val: unknown) => {
        filtered = filtered.filter((r: any) => Object.values(r).includes(val));
        return builder;
      },
      in:     (_: string, vals: unknown[]) => {
        filtered = filtered.filter((r: any) =>
          Object.values(r).some(v => (vals as unknown[]).includes(v))
        );
        return builder;
      },
      not:    (_: string, op: string, val: unknown) => {
        if (op === 'is') {
          filtered = filtered.filter((r: any) => (r as any)[_] !== null);
        }
        return builder;
      },
      gte:    () => builder,
      order:  () => builder,
      limit:  () => builder,

      maybeSingle: async () => ({ data: filtered[0] ?? null, error: null }),
      single:      async () => ({ data: filtered[0] ?? null, error: null }),

      then: (resolve: any, reject: any) =>
        Promise.resolve({ data: filtered, error: null }).then(resolve, reject),
    };

    return builder;
  };

  return { from: fromFn as any };
}

// ── getListeningInventoryStatus ───────────────────────────────────────────────

describe('getListeningInventoryStatus', () => {
  it('marks a level as healthy when published count meets desired target', async () => {
    const episodes = Array.from({ length: 7 }, (_, i) => ({
      id:         `ep-${i}`,
      cefr_level: 'B1',
      status:     'published',
    }));

    const client = buildMockClient({ listening_episodes: episodes });
    const statuses = await getListeningInventoryStatus(client as any);

    const b1 = statuses.find(s => s.cefrLevel === 'B1');
    expect(b1).toBeTruthy();
    expect(b1!.status).toBe('healthy');
    expect(b1!.publishedAvailable).toBe(7);
    expect(b1!.missingCount).toBe(0);
  });

  it('marks a level as critical when published count is below minimum', async () => {
    const episodes = [
      { id: 'ep-1', cefr_level: 'A1', status: 'published' },
      { id: 'ep-2', cefr_level: 'A1', status: 'published' },
    ];

    const client = buildMockClient({ listening_episodes: episodes });
    const statuses = await getListeningInventoryStatus(client as any);

    const a1 = statuses.find(s => s.cefrLevel === 'A1');
    expect(a1).toBeTruthy();
    expect(a1!.status).toBe('critical');
    expect(a1!.publishedAvailable).toBe(2);
    expect(a1!.missingCount).toBeGreaterThan(0);
  });

  it('marks a level as empty when there are no published episodes and no active pipeline', async () => {
    const client = buildMockClient({ listening_episodes: [] });
    const statuses = await getListeningInventoryStatus(client as any);

    // All standard CEFR levels should appear
    const levels = statuses.map(s => s.cefrLevel);
    expect(levels).toContain('A1');
    expect(levels).toContain('B2');

    const empty = statuses.filter(s => s.status === 'empty');
    expect(empty.length).toBeGreaterThan(0);
  });

  it('counts in-pipeline episodes as available for status calculation', async () => {
    // 3 published + 4 in pipeline = 7 total → should be healthy
    const episodes = Array.from({ length: 3 }, (_, i) => ({
      id:         `ep-pub-${i}`,
      cefr_level: 'C1',
      status:     'published',
    }));

    const pipelineJobs = Array.from({ length: 4 }, (_, i) => ({
      id:         `job-${i}`,
      episode_id: `ep-pip-${i}`,
      cefr_level: 'C1',
      job_type:   'GENERATE_LISTENING_QUESTIONS',
      status:     'pending',
    }));

    const client = buildMockClient({
      listening_episodes: episodes,
      listening_jobs:     pipelineJobs,
    });

    const statuses = await getListeningInventoryStatus(client as any);
    const c1 = statuses.find(s => s.cefrLevel === 'C1');
    expect(c1).toBeTruthy();
    expect(c1!.publishedAvailable).toBe(3);
    expect(c1!.inPipeline).toBe(4);
    // missingCount = desired(7) - published(3) - inPipeline(4) = 0
    expect(c1!.missingCount).toBe(0);
  });

  it('sorts by urgency: empty < critical < low < healthy', async () => {
    const episodes = [
      // A1: 7 published → healthy
      ...Array.from({ length: 7 }, (_, i) => ({ id: `a1-${i}`, cefr_level: 'A1', status: 'published' })),
      // B1: 2 published → critical
      { id: 'b1-0', cefr_level: 'B1', status: 'published' },
      { id: 'b1-1', cefr_level: 'B1', status: 'published' },
    ];

    const client = buildMockClient({ listening_episodes: episodes });
    const statuses = await getListeningInventoryStatus(client as any);

    const indices = new Map(statuses.map((s, i) => [s.cefrLevel, i]));

    // critical (B1) must appear before healthy (A1)
    if (indices.has('B1') && indices.has('A1')) {
      expect(indices.get('B1')!).toBeLessThan(indices.get('A1')!);
    }
  });
});

// ── selectListeningGenerationTheme ────────────────────────────────────────────

describe('selectListeningGenerationTheme', () => {
  it('returns a non-null theme string', async () => {
    const client = buildMockClient({ listening_episodes: [] });
    const theme = await selectListeningGenerationTheme(client as any, 'B2');
    expect(typeof theme).toBe('string');
    expect(theme!.length).toBeGreaterThan(0);
  });

  it('avoids overused themes from recent episodes', async () => {
    // Pre-populate episodes that all use "hotel" theme
    const hotelEpisodes = Array.from({ length: 10 }, (_, i) => ({
      id:        `ep-${i}`,
      cefr_level: 'A2',
      status:    'published',
      title:     `Hotel Adventure ${i}`,
      synopsis:  'A story about a hotel stay.',
    }));

    const client = buildMockClient({ listening_episodes: hotelEpisodes });

    // Run multiple selections — hotel should be deprioritized
    const themes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await selectListeningGenerationTheme(client as any, 'A2');
      if (t) themes.push(t);
    }

    // Should not always return hotel
    const allHotel = themes.every(t => t.toLowerCase().includes('hotel'));
    expect(allHotel).toBe(false);
  });

  it('returns consistent type for all CEFR levels', async () => {
    const client = buildMockClient();
    const levels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;

    for (const level of levels) {
      const theme = await selectListeningGenerationTheme(client as any, level);
      expect(typeof theme === 'string' || theme === null).toBe(true);
    }
  });
});
