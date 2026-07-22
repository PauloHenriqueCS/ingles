import { describe, it, expect } from 'vitest';
import { getOrCreateListeningGroupJob } from './get-or-create-listening-group-job';
import { NON_BLOCKING_STATUSES } from './listening-group-generation-types';
import type { GroupGenerationStatus } from './listening-group-generation-types';

type JobRow = {
  id: string;
  level_group: string;
  target_level: string;
  idempotency_key: string;
  status: GroupGenerationStatus;
  current_step: string | null;
  progress_percent: number;
  episode_id: string | null;
  attempts: number;
  max_attempts: number;
  error_code: string | null;
  error_message: string | null;
  retryable: boolean;
  locked_by: string | null;
  locked_at: string | null;
  lock_expires_at: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type EpisodeRow = { id: string; level_group: string; cefr_level: string; status: string; created_at: string };

/**
 * Minimal in-memory fake of the two tables get-or-create touches, wired to
 * the exact query chains the implementation issues. Lets tests simulate real
 * concurrent requests (call the function twice against the *same* store) and
 * assert on actual persisted rows rather than mocked call arguments.
 */
function createFakeDb(opts: { jobs?: JobRow[]; episodes?: EpisodeRow[] } = {}) {
  const jobs: JobRow[] = opts.jobs ?? [];
  const episodes: EpisodeRow[] = opts.episodes ?? [];
  let seq = 0;

  function jobsQuery() {
    const filters: Array<(r: JobRow) => boolean> = [];
    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => { filters.push(r => (r as any)[col] === val); return api; },
      not: (col: string, _op: string, valueList: string) => {
        // valueList looks like: ("ready","failed","cancelled")
        const excluded = new Set(valueList.replace(/[()"]/g, '').split(','));
        filters.push(r => !excluded.has((r as any)[col]));
        return api;
      },
      order: (col: string, o: { ascending: boolean }) => {
        api._order = { col, ascending: o.ascending };
        return api;
      },
      limit: (_n: number) => api,
      maybeSingle: async () => {
        let rows = jobs.filter(r => filters.every(f => f(r)));
        if (api._order) {
          const { col, ascending } = api._order;
          rows = [...rows].sort((a, b) => {
            const av = (a as any)[col]; const bv = (b as any)[col];
            return ascending ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
          });
        }
        return { data: rows[0] ?? null, error: null };
      },
      insert: (payload: Partial<JobRow>) => {
        // Enforce the partial unique index on level_group for non-terminal statuses.
        const collides = jobs.some(r => r.level_group === payload.level_group && !NON_BLOCKING_STATUSES.has(r.status));
        if (collides) {
          return {
            select: () => ({
              maybeSingle: async () => ({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }),
            }),
          };
        }
        seq += 1;
        const now = new Date(2026, 6, 22, 0, 0, seq).toISOString();
        const row: JobRow = {
          id: `job-${seq}`,
          level_group: String(payload.level_group),
          target_level: String(payload.target_level),
          idempotency_key: String(payload.idempotency_key),
          status: (payload.status ?? 'created') as GroupGenerationStatus,
          current_step: payload.current_step ?? null,
          progress_percent: payload.progress_percent ?? 0,
          episode_id: null,
          attempts: 0,
          max_attempts: 3,
          error_code: null,
          error_message: null,
          retryable: false,
          locked_by: null,
          locked_at: null,
          lock_expires_at: null,
          started_at: now,
          completed_at: null,
          created_at: now,
          updated_at: now,
        };
        jobs.push(row);
        return {
          select: () => ({
            maybeSingle: async () => ({ data: row, error: null }),
          }),
        };
      },
    };
    return api;
  }

  function episodesQuery() {
    const filters: Array<(r: EpisodeRow) => boolean> = [];
    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => { filters.push(r => (r as any)[col] === val); return api; },
      order: () => api,
      limit: () => api,
      maybeSingle: async () => {
        const rows = episodes.filter(r => filters.every(f => f(r)));
        return { data: rows[0] ?? null, error: null };
      },
    };
    return api;
  }

  const from = (table: string) => {
    if (table === 'listening_generation_jobs') return jobsQuery();
    if (table === 'listening_episodes') return episodesQuery();
    throw new Error(`Unexpected table: ${table}`);
  };

  return { from, jobs, episodes } as any;
}

describe('getOrCreateListeningGroupJob', () => {
  it('creates a new job when none exists, targeting the group first member', async () => {
    const db = createFakeDb();
    const result = await getOrCreateListeningGroupJob(db, 'A1_A2');
    expect(result.kind).toBe('created');
    if (result.kind === 'created') {
      expect(result.job.levelGroup).toBe('A1_A2');
      expect(result.job.targetLevel).toBe('A1');
      expect(result.job.status).toBe('created');
    }
    expect(db.jobs).toHaveLength(1);
  });

  it('two concurrent requests for the same group create only one job', async () => {
    const db = createFakeDb();
    const [a, b] = await Promise.all([
      getOrCreateListeningGroupJob(db, 'B1_B2'),
      getOrCreateListeningGroupJob(db, 'B1_B2'),
    ]);
    expect(db.jobs).toHaveLength(1);
    const ids = [a, b].map(r => (r.kind === 'created' || r.kind === 'active') ? r.job.id : null);
    expect(ids[0]).toBe(ids[1]);
    expect(['created', 'active']).toContain(a.kind);
    expect(['created', 'active']).toContain(b.kind);
  });

  it('a request while a job is active returns the same active job (no duplicate)', async () => {
    const db = createFakeDb();
    const first = await getOrCreateListeningGroupJob(db, 'A1_A2');
    expect(first.kind).toBe('created');
    const second = await getOrCreateListeningGroupJob(db, 'A1_A2');
    expect(second.kind).toBe('active');
    if (first.kind === 'created' && second.kind === 'active') {
      expect(second.job.id).toBe(first.job.id);
    }
    expect(db.jobs).toHaveLength(1);
  });

  it('different level groups generate independently (each gets its own job)', async () => {
    const db = createFakeDb();
    const a = await getOrCreateListeningGroupJob(db, 'A1_A2');
    const b = await getOrCreateListeningGroupJob(db, 'B1_B2');
    const c = await getOrCreateListeningGroupJob(db, 'C1_C2');
    expect(a.kind).toBe('created');
    expect(b.kind).toBe('created');
    expect(c.kind).toBe('created');
    expect(db.jobs).toHaveLength(3);
    expect(new Set(db.jobs.map((j: JobRow) => j.level_group))).toEqual(new Set(['A1_A2', 'B1_B2', 'C1_C2']));
  });

  it('reuses a published shared story instead of creating a job when one already covers the alternated level', async () => {
    const db = createFakeDb({
      episodes: [{ id: 'episode-a1', level_group: 'A1_A2', cefr_level: 'A1', status: 'published', created_at: '2026-07-01' }],
    });
    const result = await getOrCreateListeningGroupJob(db, 'A1_A2');
    expect(result).toEqual({ kind: 'reused', episodeId: 'episode-a1' });
    expect(db.jobs).toHaveLength(0);
  });

  it('does not reuse content for the alternate level once the first level is covered', async () => {
    const db = createFakeDb({
      jobs: [{
        id: 'job-prior', level_group: 'A1_A2', target_level: 'A1', idempotency_key: 'k1', status: 'ready',
        current_step: 'Pronto', progress_percent: 100, episode_id: 'episode-a1', attempts: 1, max_attempts: 3,
        error_code: null, error_message: null, retryable: false, locked_by: null, locked_at: null,
        lock_expires_at: null, started_at: '2026-07-01T00:00:00.000Z', completed_at: '2026-07-01T00:05:00.000Z',
        created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:05:00.000Z',
      }],
      episodes: [{ id: 'episode-a1', level_group: 'A1_A2', cefr_level: 'A1', status: 'published', created_at: '2026-07-01' }],
    });
    const result = await getOrCreateListeningGroupJob(db, 'A1_A2');
    expect(result.kind).toBe('created');
    if (result.kind === 'created') expect(result.job.targetLevel).toBe('A2');
  });

  it('a completed (ready) job does not block generating the next alternated level', async () => {
    const db = createFakeDb({
      jobs: [{
        id: 'job-prior', level_group: 'A1_A2', target_level: 'A1', idempotency_key: 'k1', status: 'ready',
        current_step: 'Pronto', progress_percent: 100, episode_id: 'episode-a1', attempts: 1, max_attempts: 3,
        error_code: null, error_message: null, retryable: false, locked_by: null, locked_at: null,
        lock_expires_at: null, started_at: '2026-07-01T00:00:00.000Z', completed_at: '2026-07-01T00:05:00.000Z',
        created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:05:00.000Z',
      }],
      // No published episode recorded (simulates archival/edge case) — must fall through to generation.
      episodes: [],
    });
    const result = await getOrCreateListeningGroupJob(db, 'A1_A2');
    expect(result.kind).toBe('created');
    expect(db.jobs).toHaveLength(2);
  });

  it('a failed job does not block creating a fresh job for the same group', async () => {
    const db = createFakeDb({
      jobs: [{
        id: 'job-failed', level_group: 'C1_C2', target_level: 'C1', idempotency_key: 'k1', status: 'failed',
        current_step: 'Falhou', progress_percent: 0, episode_id: null, attempts: 3, max_attempts: 3,
        error_code: 'STEP_ERROR', error_message: 'boom', retryable: false, locked_by: null, locked_at: null,
        lock_expires_at: null, started_at: '2026-07-01T00:00:00.000Z', completed_at: null,
        created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z',
      }],
    });
    const result = await getOrCreateListeningGroupJob(db, 'C1_C2');
    expect(result.kind).toBe('created');
    expect(db.jobs).toHaveLength(2);
  });
});
