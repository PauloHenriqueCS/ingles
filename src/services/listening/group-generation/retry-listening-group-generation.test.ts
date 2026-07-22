import { describe, it, expect } from 'vitest';
import { retryListeningGroupGeneration } from './retry-listening-group-generation';
import { GroupJobNotFoundError } from './listening-group-generation-types';
import { STEP_LABELS } from './listening-group-generation-types';

type JobRow = {
  id: string;
  level_group: string;
  target_level: string;
  status: string;
  current_step: string | null;
  progress_percent: number;
  episode_id: string | null;
  attempts: number;
  max_attempts: number;
  error_code: string | null;
  error_message: string | null;
  retryable: boolean;
};

function makeFakeDb(job: JobRow | null) {
  let row = job ? { ...job } : null;

  const from = (table: string) => {
    if (table !== 'listening_generation_jobs') throw new Error(`Unexpected table: ${table}`);
    const filters: Array<(r: JobRow) => boolean> = [];
    const api: any = {
      select: () => api,
      eq: (col: string, val: unknown) => { filters.push(r => (r as any)[col] === val); return api; },
      maybeSingle: async () => {
        if (!row) return { data: null, error: null };
        const matches = filters.every(f => f(row as JobRow));
        return { data: matches ? row : null, error: null };
      },
      single: async () => {
        if (!row) return { data: null, error: { message: 'not found' } };
        return { data: row, error: null };
      },
      update: (payload: Partial<JobRow>) => {
        // Supports any number of chained .eq(...) calls before .select().maybeSingle(),
        // matching the real query shape: .update(p).eq('id', x).eq('status', 'failed').select(...).maybeSingle()
        const updateFilters: Array<(r: JobRow) => boolean> = [...filters];
        const updateChain: any = {
          eq: (col: string, val: unknown) => {
            updateFilters.push(r => (r as any)[col] === val);
            return updateChain;
          },
          select: () => ({
            maybeSingle: async () => {
              const matched = row !== null && updateFilters.every(f => f(row as JobRow));
              if (matched) row = { ...(row as JobRow), ...payload };
              return { data: matched ? row : null, error: null };
            },
          }),
        };
        return updateChain;
      },
    };
    return api;
  };

  return { from, getRow: () => row } as any;
}

const JOB_ID = 'job-1';
const EPISODE_ID = 'episode-1';

function baseJob(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: JOB_ID, level_group: 'A1_A2', target_level: 'A1', status: 'failed',
    current_step: STEP_LABELS.generating_audio_block_2, progress_percent: 82,
    episode_id: EPISODE_ID, attempts: 1, max_attempts: 3,
    error_code: 'STEP_ERROR', error_message: 'boom', retryable: true,
    ...overrides,
  };
}

describe('retryListeningGroupGeneration', () => {
  it('throws GroupJobNotFoundError when the job does not exist', async () => {
    const db = makeFakeDb(null);
    await expect(retryListeningGroupGeneration(JOB_ID, db)).rejects.toThrow(GroupJobNotFoundError);
  });

  it('resets a failed, retryable job back to the step it failed at, clearing the error', async () => {
    const db = makeFakeDb(baseJob());
    const result = await retryListeningGroupGeneration(JOB_ID, db);
    expect(result.status).toBe('generating_audio_block_2');
    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
    expect(result.episodeId).toBe(EPISODE_ID); // never wiped — no duplicate generation on retry
  });

  it('does not duplicate the episode: episode_id from before the failure survives the retry', async () => {
    const db = makeFakeDb(baseJob({ current_step: STEP_LABELS.validating_duration }));
    const result = await retryListeningGroupGeneration(JOB_ID, db);
    expect(result.status).toBe('validating_duration');
    expect(result.episodeId).toBe(EPISODE_ID);
  });

  it('is a no-op when the job is not in failed status', async () => {
    const db = makeFakeDb(baseJob({ status: 'generating_block_1', retryable: false }));
    const result = await retryListeningGroupGeneration(JOB_ID, db);
    expect(result.status).toBe('generating_block_1');
  });

  it('is a no-op when the job is failed but not retryable (attempts exhausted)', async () => {
    const db = makeFakeDb(baseJob({ retryable: false, attempts: 3, max_attempts: 3 }));
    const result = await retryListeningGroupGeneration(JOB_ID, db);
    expect(result.status).toBe('failed');
    expect(result.retryable).toBe(false);
  });
});
