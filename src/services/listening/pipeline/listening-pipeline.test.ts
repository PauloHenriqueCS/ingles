import { describe, it, expect, vi } from 'vitest';
import { enqueueListeningEpisodePipeline } from './enqueue-listening-episode-pipeline';
import { advanceListeningPipeline } from './advance-listening-pipeline';
import type { ListeningJob } from '../jobs/listening-job-types';

// ── Constants ─────────────────────────────────────────────────────────────────

const EP_ID  = 'ep000000-0000-0000-0000-000000000001';
const B1_ID  = 'b1000000-0000-0000-0000-000000000001';
const B2_ID  = 'b1000000-0000-0000-0000-000000000002';
const JOB_ID = 'job00000-0000-0000-0000-000000000001';

// ── Mock builder ──────────────────────────────────────────────────────────────

function buildMockClient(tables: Record<string, unknown[]> = {}, inserted: unknown[][] = []) {
  const fromFn = (_table: string) => {
    const rows = tables[_table] ?? [];
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
      not:    () => builder,
      order:  () => builder,
      limit:  () => builder,

      maybeSingle: async () => ({ data: filtered[0] ?? null, error: null }),
      single:      async () => ({ data: filtered[0] ?? null, error: null }),

      insert: (data: unknown) => {
        inserted.push([_table, data] as unknown[]);
        const row = { id: JOB_ID, ...(data as object) };
        return {
          select: () => ({
            single: async () => ({ data: row, error: null }),
          }),
        };
      },

      update: (_data: unknown) => {
        const chain: any = {
          eq:   () => chain,
          then: (r: any, j: any) => Promise.resolve({ data: null, error: null }).then(r, j),
        };
        return chain;
      },

      then: (resolve: any, reject: any) =>
        Promise.resolve({ data: filtered, error: null }).then(resolve, reject),
    };

    return builder;
  };

  return { from: fromFn as any };
}

// ── enqueueListeningEpisodePipeline ───────────────────────────────────────────

describe('enqueueListeningEpisodePipeline', () => {
  it('creates a GENERATE_LISTENING_STORY job with correct payload', async () => {
    const insertedRows: unknown[][] = [];
    const client = buildMockClient({}, insertedRows);

    const result = await enqueueListeningEpisodePipeline(client as any, {
      cefrLevel: 'B1',
      theme:     'travel',
      seed:      '2026-07-15',
      source:    'admin',
    });

    expect(result.created).toBe(true);
    expect(result.idempotencyKey).toContain('GENERATE_LISTENING_STORY');
    expect(result.idempotencyKey).toContain('B1');
    expect(result.idempotencyKey).toContain('travel');

    const [tableName, insertData] = insertedRows[0] as [string, any];
    expect(tableName).toBe('listening_jobs');
    expect(insertData.job_type).toBe('GENERATE_LISTENING_STORY');
    expect(insertData.cefr_level).toBe('B1');
    expect(insertData.payload.cefrLevel).toBe('B1');
    expect(insertData.payload.source).toBe('admin');
  });

  it('returns existing job when idempotency key already exists', async () => {
    const existingJob = { id: JOB_ID, status: 'pending', idempotency_key: 'x' };
    const client = buildMockClient({ listening_jobs: [existingJob] });

    const result = await enqueueListeningEpisodePipeline(client as any, {
      cefrLevel: 'A2',
      seed:      '2026-07-15',
      source:    'inventory_cron',
    });

    expect(result.created).toBe(false);
    expect(result.jobId).toBe(JOB_ID);
  });

  it('generates a date-based seed when none provided', async () => {
    const insertedRows: unknown[][] = [];
    const client = buildMockClient({}, insertedRows);

    const today = new Date().toISOString().slice(0, 10);

    const result = await enqueueListeningEpisodePipeline(client as any, {
      cefrLevel: 'C1',
      source:    'admin',
    });

    expect(result.idempotencyKey).toContain(today);
  });
});

// ── advanceListeningPipeline ──────────────────────────────────────────────────

function makeJob(overrides: Partial<ListeningJob> & { result?: Record<string, unknown> }): ListeningJob & { result?: Record<string, unknown> } {
  return {
    id:              JOB_ID,
    job_type:        'GENERATE_LISTENING_STORY',
    status:          'completed',
    priority:        10,
    episode_id:      EP_ID,
    block_id:        null,
    cefr_level:      'B1',
    payload:         { jobType: 'GENERATE_LISTENING_STORY', cefrLevel: 'B1', source: 'admin' },
    result:          null,
    idempotency_key: 'key',
    attempts:        1,
    max_attempts:    3,
    locked_by:       null,
    locked_at:       null,
    lock_expires_at: null,
    next_attempt_at: new Date().toISOString(),
    started_at:      null,
    finished_at:     null,
    error_code:      null,
    error_message:   null,
    created_at:      new Date().toISOString(),
    updated_at:      new Date().toISOString(),
    ...overrides,
  };
}

describe('advanceListeningPipeline', () => {
  it('creates GENERATE_LISTENING_QUESTIONS after story completes', async () => {
    const insertedRows: unknown[][] = [];
    const client = buildMockClient({}, insertedRows);

    const job = makeJob({
      job_type:   'GENERATE_LISTENING_STORY',
      episode_id: EP_ID,
      result:     { episodeId: EP_ID },
    });

    await advanceListeningPipeline(client as any, job as any);

    const questionJob = (insertedRows as any[]).find(([table, data]: any[]) =>
      table === 'listening_jobs' && data.job_type === 'GENERATE_LISTENING_QUESTIONS'
    );
    expect(questionJob).toBeTruthy();
    expect(questionJob[1].payload.episodeId).toBe(EP_ID);
  });

  it('creates PREPARE_LISTENING_SUBTITLES after questions complete', async () => {
    const insertedRows: unknown[][] = [];
    const client = buildMockClient({}, insertedRows);

    const job = makeJob({
      job_type:   'GENERATE_LISTENING_QUESTIONS',
      episode_id: EP_ID,
    });

    await advanceListeningPipeline(client as any, job as any);

    const subtitlesJob = (insertedRows as any[]).find(([table, data]: any[]) =>
      table === 'listening_jobs' && data.job_type === 'PREPARE_LISTENING_SUBTITLES'
    );
    expect(subtitlesJob).toBeTruthy();
  });

  it('creates GENERATE_LISTENING_SSML after subtitles complete', async () => {
    const insertedRows: unknown[][] = [];
    const client = buildMockClient({}, insertedRows);

    const job = makeJob({
      job_type:   'PREPARE_LISTENING_SUBTITLES',
      episode_id: EP_ID,
    });

    await advanceListeningPipeline(client as any, job as any);

    const ssmlJob = (insertedRows as any[]).find(([table, data]: any[]) =>
      table === 'listening_jobs' && data.job_type === 'GENERATE_LISTENING_SSML'
    );
    expect(ssmlJob).toBeTruthy();
  });

  it('creates two SYNTHESIZE_LISTENING_BLOCK_AUDIO jobs after SSML complete', async () => {
    const insertedRows: unknown[][] = [];
    const blocks = [
      { id: B1_ID, block_order: 1 },
      { id: B2_ID, block_order: 2 },
    ];
    const client = buildMockClient({ listening_blocks: blocks }, insertedRows);

    const job = makeJob({
      job_type:   'GENERATE_LISTENING_SSML',
      episode_id: EP_ID,
    });

    await advanceListeningPipeline(client as any, job as any);

    const audioJobs = (insertedRows as any[]).filter(([table, data]: any[]) =>
      table === 'listening_jobs' && data.job_type === 'SYNTHESIZE_LISTENING_BLOCK_AUDIO'
    );
    expect(audioJobs).toHaveLength(2);
    const blockIds = audioJobs.map(([, d]: any) => d.payload.blockId);
    expect(blockIds).toContain(B1_ID);
    expect(blockIds).toContain(B2_ID);
  });

  it('creates SYNCHRONIZE_LISTENING_BLOCK jobs when both blocks have validated audio', async () => {
    const insertedRows: unknown[][] = [];

    const audioAssets = [
      { block_id: B1_ID, status: 'validated' },
      { block_id: B2_ID, status: 'validated' },
    ];
    const blocks = [
      { id: B1_ID, block_order: 1 },
      { id: B2_ID, block_order: 2 },
    ];

    const client = buildMockClient(
      { listening_audio_assets: audioAssets, listening_blocks: blocks },
      insertedRows,
    );

    const job = makeJob({
      job_type:   'SYNTHESIZE_LISTENING_BLOCK_AUDIO',
      episode_id: EP_ID,
      block_id:   B1_ID,
    });

    await advanceListeningPipeline(client as any, job as any);

    const syncJobs = (insertedRows as any[]).filter(([table, data]: any[]) =>
      table === 'listening_jobs' && data.job_type === 'SYNCHRONIZE_LISTENING_BLOCK'
    );
    expect(syncJobs).toHaveLength(2);
  });

  it('does not create SYNCHRONIZE jobs when only one block has validated audio', async () => {
    const insertedRows: unknown[][] = [];

    // Only one block validated
    const audioAssets = [
      { block_id: B1_ID, status: 'validated' },
      { block_id: B2_ID, status: 'processing' },
    ];

    const client = buildMockClient(
      { listening_audio_assets: audioAssets },
      insertedRows,
    );

    const job = makeJob({
      job_type:   'SYNTHESIZE_LISTENING_BLOCK_AUDIO',
      episode_id: EP_ID,
      block_id:   B1_ID,
    });

    await advanceListeningPipeline(client as any, job as any);

    const syncJobs = (insertedRows as any[]).filter(([, data]: any[]) =>
      (data as any).job_type === 'SYNCHRONIZE_LISTENING_BLOCK'
    );
    expect(syncJobs).toHaveLength(0);
  });

  it('creates PUBLISH job after VALIDATE job completes', async () => {
    const insertedRows: unknown[][] = [];
    const client = buildMockClient({}, insertedRows);

    const job = makeJob({
      job_type:   'VALIDATE_LISTENING_EPISODE',
      episode_id: EP_ID,
    });

    await advanceListeningPipeline(client as any, job as any);

    const publishJob = (insertedRows as any[]).find(([, data]: any[]) =>
      (data as any).job_type === 'PUBLISH_LISTENING_EPISODE'
    );
    expect(publishJob).toBeTruthy();
  });
});
