import { describe, it, expect } from 'vitest';
import { recoverStuckListeningGroupJobs } from './recover-stuck-listening-group-jobs';

type JobRow = {
  id: string;
  status: string;
  attempts: number;
  max_attempts: number;
  lock_expires_at: string | null;
  retryable?: boolean;
  error_code?: string | null;
};

function makeFakeDb(jobs: JobRow[]) {
  const rows = jobs.map(j => ({ ...j }));

  function query() {
    const filters: Array<(r: JobRow) => boolean> = [];
    const api: any = {
      select: () => api,
      not: (col: string, op: string, value: string) => {
        if (op === 'in') {
          const excluded = new Set(value.replace(/[()"]/g, '').split(','));
          filters.push(r => !excluded.has((r as any)[col]));
        } else if (op === 'is') {
          filters.push(r => (r as any)[col] !== null);
        }
        return api;
      },
      lt: (col: string, value: string) => {
        filters.push(r => (r as any)[col] !== null && (r as any)[col] < value);
        return api;
      },
      then: (resolve: (v: unknown) => void) => {
        const matched = rows.filter(r => filters.every(f => f(r)));
        return resolve({ data: matched, error: null });
      },
      update: (payload: Partial<JobRow>) => {
        const updateFilters: Array<(r: JobRow) => boolean> = [...filters];
        const chain: any = {
          eq: (col: string, val: unknown) => { updateFilters.push(r => (r as any)[col] === val); return chain; },
          lt: (col: string, value: string) => {
            updateFilters.push(r => (r as any)[col] !== null && (r as any)[col] < value);
            return chain;
          },
          select: () => ({
            maybeSingle: async () => {
              const target = rows.find(r => updateFilters.every(f => f(r)));
              if (target) Object.assign(target, payload);
              return { data: target ?? null, error: target ? null : null };
            },
          }),
        };
        return chain;
      },
    };
    return api;
  }

  const from = (table: string) => {
    if (table !== 'listening_generation_jobs') throw new Error(`Unexpected table: ${table}`);
    return query();
  };

  return { from, rows } as any;
}

const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';

describe('recoverStuckListeningGroupJobs', () => {
  it('recovers nothing when there are no stuck jobs', async () => {
    const db = makeFakeDb([]);
    const result = await recoverStuckListeningGroupJobs(db);
    expect(result).toEqual({ recoveredCount: 0, jobIds: [] });
  });

  it('recovers a job whose lock expired while still generating, marking it failed and retryable', async () => {
    const db = makeFakeDb([
      { id: 'job-1', status: 'generating_audio_block_1', attempts: 0, max_attempts: 3, lock_expires_at: PAST },
    ]);
    const result = await recoverStuckListeningGroupJobs(db);
    expect(result.recoveredCount).toBe(1);
    expect(result.jobIds).toEqual(['job-1']);
    expect(db.rows[0].status).toBe('failed');
    expect(db.rows[0].attempts).toBe(1);
    expect(db.rows[0].retryable).toBe(true);
    expect(db.rows[0].error_code).toBe('LOCK_EXPIRED');
  });

  it('marks a job non-retryable once recovery exhausts max_attempts', async () => {
    const db = makeFakeDb([
      { id: 'job-2', status: 'validating_duration', attempts: 2, max_attempts: 3, lock_expires_at: PAST },
    ]);
    const result = await recoverStuckListeningGroupJobs(db);
    expect(result.recoveredCount).toBe(1);
    expect(db.rows[0].attempts).toBe(3);
    expect(db.rows[0].retryable).toBe(false);
  });

  it('ignores jobs whose lock has not expired yet', async () => {
    const db = makeFakeDb([
      { id: 'job-3', status: 'generating_block_1', attempts: 0, max_attempts: 3, lock_expires_at: FUTURE },
    ]);
    const result = await recoverStuckListeningGroupJobs(db);
    expect(result).toEqual({ recoveredCount: 0, jobIds: [] });
  });

  it('ignores jobs with no active lock (lock_expires_at is null)', async () => {
    const db = makeFakeDb([
      { id: 'job-4', status: 'created', attempts: 0, max_attempts: 3, lock_expires_at: null },
    ]);
    const result = await recoverStuckListeningGroupJobs(db);
    expect(result).toEqual({ recoveredCount: 0, jobIds: [] });
  });

  it('ignores jobs already in a terminal status, even with an old lock timestamp', async () => {
    const db = makeFakeDb([
      { id: 'job-5', status: 'ready', attempts: 1, max_attempts: 3, lock_expires_at: PAST },
      { id: 'job-6', status: 'failed', attempts: 3, max_attempts: 3, lock_expires_at: PAST },
      { id: 'job-7', status: 'cancelled', attempts: 0, max_attempts: 3, lock_expires_at: PAST },
    ]);
    const result = await recoverStuckListeningGroupJobs(db);
    expect(result).toEqual({ recoveredCount: 0, jobIds: [] });
  });
});
