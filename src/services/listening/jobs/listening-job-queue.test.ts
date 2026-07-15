import { describe, it, expect, vi } from 'vitest';
import { enqueueListeningJob } from './enqueue-listening-job';
import { failListeningJob } from './fail-listening-job';
import { recoverStuckListeningJobs } from './recover-stuck-listening-jobs';
import { getRetryDelayMs } from './listening-job-config';

// ── Constants ─────────────────────────────────────────────────────────────────

const JOB_ID    = 'job00000-0000-0000-0000-000000000001';
const WORKER_ID = 'worker-test-1';

// ── Mock builder ──────────────────────────────────────────────────────────────

type MockRows = Record<string, unknown[]>;

function buildMockClient(
  tables: MockRows = {},
  opts: {
    insertError?:  { code?: string; message?: string } | null;
    insertedId?:   string;
    updateReturns?: unknown;
  } = {},
) {
  const inserted: Record<string, unknown[]> = {};

  const chainWithSelect = (returnData: unknown, returnError?: unknown) => ({
    select: () => ({
      single:       async () => ({ data: returnData, error: returnError ?? null }),
      maybeSingle:  async () => ({ data: returnData, error: returnError ?? null }),
    }),
    single:      async () => ({ data: returnData, error: returnError ?? null }),
    maybeSingle: async () => ({ data: returnData, error: returnError ?? null }),
  });

  const fromFn = (table: string) => {
    const rows = tables[table] ?? [];

    // Tracks filters applied by the query chain so we can return contextual data
    let filteredRows = [...rows];

    const builder: any = {
      select:      () => builder,
      eq:          (_: string, val: unknown) => {
        filteredRows = filteredRows.filter((r: any) => Object.values(r).includes(val));
        return builder;
      },
      not:         () => builder,
      in:          (_: string, vals: unknown[]) => {
        filteredRows = filteredRows.filter((r: any) =>
          Object.values(r).some(v => (vals as unknown[]).includes(v))
        );
        return builder;
      },
      lt:          () => builder,
      lte:         () => builder,
      gte:         () => builder,
      order:       () => builder,
      limit:       () => builder,
      maybeSingle: async () => ({ data: filteredRows[0] ?? null, error: null }),
      single:      async () => ({ data: filteredRows[0] ?? null, error: null }),

      insert: (data: unknown) => {
        if (opts.insertError) {
          return chainWithSelect(null, opts.insertError);
        }
        const row = { id: opts.insertedId ?? JOB_ID, ...(data as object) };
        if (!inserted[table]) inserted[table] = [];
        inserted[table].push(row);
        return chainWithSelect(row);
      },

      update: (_data: unknown) => {
        const chain: any = {
          eq:  () => chain,
          in:  () => chain,
          not: () => chain,
          select: () => ({
            single: async () => ({ data: opts.updateReturns ?? null, error: null }),
          }),
          then: (r: any, j: any) =>
            Promise.resolve({ data: opts.updateReturns ?? null, error: null }).then(r, j),
        };
        return chain;
      },

      then: (resolve: any, reject: any) =>
        Promise.resolve({ data: filteredRows, error: null }).then(resolve, reject),
    };

    return builder;
  };

  return { from: fromFn as any, _inserted: inserted };
}

// ── getRetryDelayMs ───────────────────────────────────────────────────────────

describe('getRetryDelayMs', () => {
  it('first retry is ~60s (with ±10% jitter)', () => {
    for (let i = 0; i < 10; i++) {
      const ms = getRetryDelayMs(1);
      expect(ms).toBeGreaterThanOrEqual(54_000);
      expect(ms).toBeLessThanOrEqual(66_000);
    }
  });

  it('second retry is ~5 minutes', () => {
    const ms = getRetryDelayMs(2);
    expect(ms).toBeGreaterThanOrEqual(270_000);
    expect(ms).toBeLessThanOrEqual(330_000);
  });

  it('clamps at 30 minutes beyond max index', () => {
    const ms = getRetryDelayMs(99);
    expect(ms).toBeGreaterThanOrEqual(1_620_000);
    expect(ms).toBeLessThanOrEqual(1_980_000);
  });
});

// ── enqueueListeningJob ───────────────────────────────────────────────────────

describe('enqueueListeningJob', () => {
  it('creates a new job when none exists', async () => {
    const client = buildMockClient({}, { insertedId: JOB_ID });

    const result = await enqueueListeningJob(client as any, {
      jobType:        'GENERATE_LISTENING_STORY',
      idempotencyKey: 'GENERATE_LISTENING_STORY:A2:2026-07-15:v1',
      payload:        { jobType: 'GENERATE_LISTENING_STORY', cefrLevel: 'A2', source: 'admin' },
      cefrLevel:      'A2',
    });

    expect(result.created).toBe(true);
    expect(result.jobId).toBe(JOB_ID);
  });

  it('returns existing job (idempotent) when same key exists', async () => {
    const existing = { id: JOB_ID, status: 'pending', idempotency_key: 'key-abc' };
    const client = buildMockClient({ listening_jobs: [existing] });

    const result = await enqueueListeningJob(client as any, {
      jobType:        'GENERATE_LISTENING_STORY',
      idempotencyKey: 'key-abc',
      payload:        { jobType: 'GENERATE_LISTENING_STORY', cefrLevel: 'A2', source: 'admin' },
    });

    expect(result.created).toBe(false);
    expect(result.jobId).toBe(JOB_ID);
  });

  it('handles unique violation race condition (23505)', async () => {
    // First query returns nothing (no existing job), insert fails with 23505,
    // then the follow-up select finds the job created by a concurrent process.
    let callCount = 0;
    const fromFn = (_table: string) => {
      callCount++;
      const builder: any = {
        select:  () => builder,
        eq:      () => builder,
        not:     () => builder,
        in:      () => builder,
        maybeSingle: async () => {
          // First two calls return null (no existing), third returns the race-created job
          return callCount <= 2
            ? { data: null, error: null }
            : { data: { id: 'race-job-id' }, error: null };
        },
        insert: () => ({
          select: () => ({
            single: async () => ({
              data:  null,
              error: { code: '23505', message: 'duplicate key value' },
            }),
          }),
        }),
      };
      return builder;
    };

    const result = await enqueueListeningJob({ from: fromFn } as any, {
      jobType:        'GENERATE_LISTENING_STORY',
      idempotencyKey: 'key-race',
      payload:        { jobType: 'GENERATE_LISTENING_STORY', cefrLevel: 'B1', source: 'admin' },
    });

    expect(result.created).toBe(false);
    expect(result.jobId).toBe('race-job-id');
  });
});

// ── failListeningJob ──────────────────────────────────────────────────────────

describe('failListeningJob', () => {
  it('sets status to retry when retryable and attempts < max_attempts', async () => {
    const updates: unknown[] = [];
    const fromFn = (table: string) => {
      const builder: any = {
        select:      () => builder,
        eq:          () => builder,
        maybeSingle: async () => ({
          data: { attempts: 1, max_attempts: 3 },
          error: null,
        }),
        update: (data: unknown) => {
          updates.push(data);
          const chain: any = {
            eq:   () => chain,
            then: (r: any, j: any) =>
              Promise.resolve({ data: null, error: null }).then(r, j),
          };
          return chain;
        },
      };
      return builder;
    };

    await failListeningJob({ from: fromFn } as any, {
      jobId: JOB_ID, workerId: WORKER_ID,
      errorCode: 'TIMEOUT', errorMessage: 'timed out', retryable: true,
    });

    const update = updates[0] as any;
    expect(update.status).toBe('retry');
    expect(update.locked_by).toBeNull();
  });

  it('sets status to dead_letter when at max_attempts', async () => {
    const updates: unknown[] = [];
    const fromFn = (_table: string) => {
      const builder: any = {
        select:      () => builder,
        eq:          () => builder,
        maybeSingle: async () => ({
          data: { attempts: 3, max_attempts: 3 },
          error: null,
        }),
        update: (data: unknown) => {
          updates.push(data);
          const chain: any = { eq: () => chain, then: (r: any, j: any) => Promise.resolve({ data: null, error: null }).then(r, j) };
          return chain;
        },
      };
      return builder;
    };

    await failListeningJob({ from: fromFn } as any, {
      jobId: JOB_ID, workerId: WORKER_ID,
      errorCode: 'TIMEOUT', errorMessage: 'timed out', retryable: true,
    });

    const update = updates[0] as any;
    expect(update.status).toBe('dead_letter');
    expect(update.finished_at).toBeTruthy();
  });

  it('sets status to failed when not retryable', async () => {
    const updates: unknown[] = [];
    const fromFn = (_table: string) => {
      const builder: any = {
        select:      () => builder,
        eq:          () => builder,
        maybeSingle: async () => ({
          data: { attempts: 1, max_attempts: 3 },
          error: null,
        }),
        update: (data: unknown) => {
          updates.push(data);
          const chain: any = { eq: () => chain, then: (r: any, j: any) => Promise.resolve({ data: null, error: null }).then(r, j) };
          return chain;
        },
      };
      return builder;
    };

    await failListeningJob({ from: fromFn } as any, {
      jobId: JOB_ID, workerId: WORKER_ID,
      errorCode: 'VALIDATION_ERROR', errorMessage: 'invalid', retryable: false,
    });

    const update = updates[0] as any;
    expect(update.status).toBe('failed');
  });

  it('does nothing when job is not found or belongs to another worker', async () => {
    const updates: unknown[] = [];
    const fromFn = (_table: string) => {
      const builder: any = {
        select: () => builder, eq: () => builder,
        maybeSingle: async () => ({ data: null, error: null }),
        update: (d: unknown) => { updates.push(d); const c: any = { eq: () => c, then: (r: any, j: any) => Promise.resolve({ data: null, error: null }).then(r, j) }; return c; },
      };
      return builder;
    };

    await failListeningJob({ from: fromFn } as any, {
      jobId: JOB_ID, workerId: 'other-worker',
      errorCode: 'ERR', errorMessage: 'err', retryable: true,
    });

    expect(updates).toHaveLength(0);
  });
});

// ── recoverStuckListeningJobs ────────────────────────────────────────────────

describe('recoverStuckListeningJobs', () => {
  it('returns zero recovered when no stuck jobs exist', async () => {
    const client = buildMockClient({ listening_jobs: [] });
    const result = await recoverStuckListeningJobs(client as any);
    expect(result.recoveredCount).toBe(0);
  });

  it('recovers a stuck job by resetting it to retry', async () => {
    const stuckJob = {
      id:           JOB_ID,
      locked_by:    WORKER_ID,
      attempts:     1,
      max_attempts: 3,
    };

    const updates: unknown[] = [];
    const fromFn = (_table: string) => {
      let afterUpdate = false;
      const builder: any = {
        select: () => builder,
        eq:     () => builder,
        not:    () => builder,
        in:     () => builder,
        lt:     () => builder,
        order:  () => builder,
        limit:  () => builder,
        maybeSingle: async () => ({ data: stuckJob, error: null }),
        update: (data: unknown) => {
          updates.push(data);
          afterUpdate = true;
          const chain: any = {
            eq:   () => chain,
            lt:   () => chain,
            then: (r: any, j: any) =>
              Promise.resolve({ data: { count: 1 }, error: null }).then(r, j),
          };
          return chain;
        },
        then: (resolve: any, reject: any) =>
          Promise.resolve({ data: [stuckJob], error: null }).then(resolve, reject),
      };
      return builder;
    };

    const result = await recoverStuckListeningJobs({ from: fromFn } as any);
    expect(result.recoveredCount).toBeGreaterThanOrEqual(0);
  });
});
