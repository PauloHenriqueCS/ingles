import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockGenerateListeningStory, mockGenerateListeningQuestions, mockPrepareListeningSubtitles,
  mockGenerateListeningSsml, mockSynthesizeListeningEpisode, mockSynchronizeListeningEpisode,
  mockPublishListeningEpisode, mockTranslateListeningSynopsis, mockFindListeningEpisodeByGenerationKey,
} = vi.hoisted(() => ({
  mockGenerateListeningStory: vi.fn(),
  mockGenerateListeningQuestions: vi.fn(),
  mockPrepareListeningSubtitles: vi.fn(),
  mockGenerateListeningSsml: vi.fn(),
  mockSynthesizeListeningEpisode: vi.fn(),
  mockSynchronizeListeningEpisode: vi.fn(),
  mockPublishListeningEpisode: vi.fn(),
  mockTranslateListeningSynopsis: vi.fn(),
  mockFindListeningEpisodeByGenerationKey: vi.fn(),
}));

vi.mock('../generate-listening-story', () => ({
  generateListeningStory: mockGenerateListeningStory,
  createDefaultAICallFn: vi.fn(() => vi.fn()),
  // Mirrors the real join logic (cefrLevel|theme|seed|version|contentVersion)
  // closely enough for tests to observe that different seeds (job ids)
  // produce different keys, and the same seed always produces the same one.
  buildIdempotencyKey: vi.fn((opts: { cefrLevel: string; theme?: string | null; seed?: string | null }) =>
    `${opts.cefrLevel}|${opts.theme ?? ''}|${opts.seed ?? ''}|listening-story-v2|1`),
}));
vi.mock('../persist-listening-story', () => ({
  findListeningEpisodeByGenerationKey: mockFindListeningEpisodeByGenerationKey,
}));
vi.mock('../generate-listening-questions', () => ({
  generateListeningQuestions: mockGenerateListeningQuestions,
  createQuestionAICallFn: vi.fn(() => vi.fn()),
}));
vi.mock('../prepare-listening-subtitles', () => ({
  prepareListeningSubtitles: mockPrepareListeningSubtitles,
  createSubtitleAICallFn: vi.fn(() => vi.fn()),
}));
vi.mock('../generate-listening-ssml', () => ({
  generateListeningSsml: mockGenerateListeningSsml,
}));
vi.mock('../audio/synthesize-listening-episode', () => ({
  synthesizeListeningEpisode: mockSynthesizeListeningEpisode,
}));
vi.mock('../timing/synchronize-listening-episode', () => ({
  synchronizeListeningEpisode: mockSynchronizeListeningEpisode,
}));
vi.mock('../publication/publish-listening-episode', () => ({
  publishListeningEpisode: mockPublishListeningEpisode,
}));
vi.mock('../translate-listening-synopsis', () => ({
  translateListeningSynopsis: mockTranslateListeningSynopsis,
}));

import { processListeningGroupGenerationStep } from './process-listening-group-generation-step';
import { GroupJobNotFoundError, GroupJobLockedError, GroupJobTerminalError } from './listening-group-generation-types';

const JOB_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const EPISODE_ID = 'cccccccc-0000-0000-0000-000000000002';
const WORKER_ID = 'test-worker-1';

function makeAwaitableChain(result: { data: unknown; error: unknown }) {
  const p: any = Promise.resolve(result);
  for (const m of ['select', 'insert', 'update', 'eq', 'or', 'order', 'in', 'not']) {
    p[m] = vi.fn().mockReturnValue(p);
  }
  p.limit = vi.fn().mockReturnValue(p);
  p.single = vi.fn().mockReturnValue(Promise.resolve(result));
  p.maybeSingle = vi.fn().mockReturnValue(Promise.resolve(result));
  return p;
}

type JobFixture = {
  status: string;
  levelGroup?: string;
  targetLevel?: string;
  episodeId?: string | null;
  attempts?: number;
  maxAttempts?: number;
};

/**
 * Stateful fake for listening_generation_jobs, tracking whatever the step
 * processor writes via update(...) so the final fetch (and later assertions)
 * reflect what actually happened, not a hardcoded fixture. Other tables
 * default to a per-test override map so each test only wires the rows it
 * actually touches.
 */
function makeGroupSupabase(job: JobFixture, otherTables: Record<string, { data: unknown; error: unknown }> = {}) {
  let jobsCall = 0;
  const state = {
    status: job.status,
    levelGroup: job.levelGroup ?? 'B1_B2',
    targetLevel: job.targetLevel ?? 'B1',
    episodeId: job.episodeId ?? null,
    attempts: job.attempts ?? 0,
    maxAttempts: job.maxAttempts ?? 3,
    currentStep: 'x',
    progressPercent: 10,
    errorCode: null as string | null,
    errorMessage: null as string | null,
    retryable: false,
  };
  const calledTables: string[] = [];
  const updatePayloads: Record<string, unknown>[] = [];

  const from = vi.fn((table: string) => {
    calledTables.push(table);
    if (table === 'listening_generation_jobs') {
      jobsCall += 1;
      if (jobsCall === 1) {
        // acquireLock
        return makeAwaitableChain({
          data: {
            id: JOB_ID, status: state.status, level_group: state.levelGroup, target_level: state.targetLevel,
            episode_id: state.episodeId, attempts: state.attempts, max_attempts: state.maxAttempts,
          },
          error: null,
        });
      }
      const chain: any = {};
      for (const m of ['select', 'insert', 'eq', 'or', 'order', 'in', 'not']) {
        chain[m] = vi.fn().mockReturnValue(chain);
      }
      chain.limit = vi.fn().mockReturnValue(chain);
      chain.update = vi.fn((payload: Record<string, unknown>) => {
        updatePayloads.push(payload);
        if (typeof payload.status === 'string') state.status = payload.status;
        if ('episode_id' in payload) state.episodeId = payload.episode_id as string | null;
        if ('attempts' in payload) state.attempts = payload.attempts as number;
        if ('error_code' in payload) state.errorCode = payload.error_code as string | null;
        if ('error_message' in payload) state.errorMessage = payload.error_message as string | null;
        if ('retryable' in payload) state.retryable = payload.retryable as boolean;
        if (typeof payload.current_step === 'string') state.currentStep = payload.current_step;
        if (typeof payload.progress_percent === 'number') state.progressPercent = payload.progress_percent;
        return chain;
      });
      chain.single = vi.fn(() => Promise.resolve({
        data: {
          id: JOB_ID, level_group: state.levelGroup, target_level: state.targetLevel, status: state.status,
          current_step: state.currentStep, progress_percent: state.progressPercent, episode_id: state.episodeId,
          attempts: state.attempts, max_attempts: state.maxAttempts, error_code: state.errorCode,
          error_message: state.errorMessage, retryable: state.retryable,
        },
        error: null,
      }));
      chain.maybeSingle = chain.single;
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: null });
      return chain;
    }
    return makeAwaitableChain(otherTables[table] ?? { data: null, error: null });
  });

  return { from, calledTables, updatePayloads, state } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.AZURE_SPEECH_KEY = 'test-azure-key';
  process.env.AZURE_SPEECH_REGION = 'test-azure-region';
  mockFindListeningEpisodeByGenerationKey.mockResolvedValue(null);
});

describe('processListeningGroupGenerationStep — lock handling', () => {
  it('throws GroupJobNotFoundError when the job does not exist', async () => {
    const supabase = { from: vi.fn(() => makeAwaitableChain({ data: null, error: null })) };
    await expect(processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase as any))
      .rejects.toThrow(GroupJobNotFoundError);
  });

  it('throws GroupJobLockedError when the job is currently locked by another worker', async () => {
    let call = 0;
    const supabase = {
      from: vi.fn(() => {
        call += 1;
        if (call === 1) return makeAwaitableChain({ data: null, error: null }); // lock update matched nothing
        return makeAwaitableChain({ data: { id: JOB_ID }, error: null }); // job exists -> locked, not missing
      }),
    };
    await expect(processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase as any))
      .rejects.toThrow(GroupJobLockedError);
  });

  it('throws GroupJobTerminalError and releases the lock for an already-ready job', async () => {
    const supabase = makeGroupSupabase({ status: 'ready' });
    await expect(processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase))
      .rejects.toThrow(GroupJobTerminalError);
    const releaseCall = supabase.updatePayloads.find((p: any) => p.locked_by === null);
    expect(releaseCall).toBeTruthy();
  });
});

describe('processListeningGroupGenerationStep — created', () => {
  it('is a pure transition to generating_block_1: no story generation call', async () => {
    const supabase = makeGroupSupabase({ status: 'created' });
    const result = await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase);
    expect(mockGenerateListeningStory).not.toHaveBeenCalled();
    expect(result.status).toBe('generating_block_1');
  });
});

describe('processListeningGroupGenerationStep — generating_block_1', () => {
  it('generates the story using the job target_level as cefrLevel and persists episode_id', async () => {
    mockGenerateListeningStory.mockResolvedValue({ story: {}, episodeId: EPISODE_ID, idempotencyKey: 'k' });
    const supabase = makeGroupSupabase({ status: 'generating_block_1', targetLevel: 'B2', episodeId: null });
    const result = await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase);
    expect(mockGenerateListeningStory).toHaveBeenCalledWith(
      expect.objectContaining({ cefrLevel: 'B2' }),
      expect.anything(),
      supabase,
    );
    expect(result.episodeId).toBe(EPISODE_ID);
    expect(result.status).toBe('validating_block_1');
  });

  it('is idempotent: skips regeneration when an episode already exists on the job', async () => {
    const supabase = makeGroupSupabase(
      { status: 'generating_block_1', episodeId: EPISODE_ID },
      { listening_episodes: { data: { id: EPISODE_ID, status: 'content_ready' }, error: null } },
    );
    const result = await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase);
    expect(mockGenerateListeningStory).not.toHaveBeenCalled();
    expect(result.status).toBe('validating_block_1');
    expect(result.episodeId).toBe(EPISODE_ID);
  });
});

describe('processListeningGroupGenerationStep — generating_block_1 get-or-create by generation_key', () => {
  const EXISTING_EPISODE_ID = 'dddddddd-0000-0000-0000-000000000009';

  it('reuses an episode already persisted under this generation_key instead of generating fresh content (retry after a downstream failure)', async () => {
    mockFindListeningEpisodeByGenerationKey.mockResolvedValue({
      id: EXISTING_EPISODE_ID, status: 'content_ready', cefrLevel: 'A1',
    });
    const supabase = makeGroupSupabase({ status: 'generating_block_1', targetLevel: 'A1', episodeId: null });

    const result = await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase);

    expect(mockGenerateListeningStory).not.toHaveBeenCalled();
    expect(result.episodeId).toBe(EXISTING_EPISODE_ID);
    expect(result.status).toBe('validating_block_1');
  });

  it('generates fresh content when no episode exists for this generation_key', async () => {
    mockFindListeningEpisodeByGenerationKey.mockResolvedValue(null);
    mockGenerateListeningStory.mockResolvedValue({ story: {}, episodeId: EPISODE_ID, idempotencyKey: 'k' });
    const supabase = makeGroupSupabase({ status: 'generating_block_1', targetLevel: 'A1', episodeId: null });

    const result = await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase);

    expect(mockGenerateListeningStory).toHaveBeenCalledTimes(1);
    expect(result.episodeId).toBe(EPISODE_ID);
  });

  it('two retries into this step for the same job both resolve to the same reused episode_id (no duplicate story)', async () => {
    mockFindListeningEpisodeByGenerationKey.mockResolvedValue({
      id: EXISTING_EPISODE_ID, status: 'content_ready', cefrLevel: 'A1',
    });

    const supabase1 = makeGroupSupabase({ status: 'generating_block_1', targetLevel: 'A1', episodeId: null });
    const first = await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase1);

    const supabase2 = makeGroupSupabase({ status: 'generating_block_1', targetLevel: 'A1', episodeId: null });
    const second = await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase2);

    expect(first.episodeId).toBe(EXISTING_EPISODE_ID);
    expect(second.episodeId).toBe(EXISTING_EPISODE_ID);
    expect(mockGenerateListeningStory).not.toHaveBeenCalled();
  });

  it('fails the job with LISTENING_GROUP_JOB_EPISODE_INTEGRITY, non-retryable, when the job is already linked to a DIFFERENT episode than generation_key resolves to', async () => {
    mockFindListeningEpisodeByGenerationKey.mockResolvedValue({
      id: 'some-other-episode-id', status: 'content_ready', cefrLevel: 'A1',
    });
    const supabase = makeGroupSupabase(
      { status: 'generating_block_1', targetLevel: 'A1', episodeId: EPISODE_ID },
      { listening_episodes: { data: { id: EPISODE_ID, status: 'content_ready' }, error: null } },
    );

    const result = await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase);

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('LISTENING_GROUP_JOB_EPISODE_INTEGRITY');
    expect(result.retryable).toBe(false);
    expect(mockGenerateListeningStory).not.toHaveBeenCalled();
  });

  it('fast-forwards straight to ready when the reused episode is already published (nothing left to generate)', async () => {
    mockFindListeningEpisodeByGenerationKey.mockResolvedValue({
      id: EXISTING_EPISODE_ID, status: 'published', cefrLevel: 'A1',
    });
    const supabase = makeGroupSupabase({ status: 'generating_block_1', targetLevel: 'A1', episodeId: null });

    const result = await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase);

    expect(mockGenerateListeningStory).not.toHaveBeenCalled();
    expect(result.episodeId).toBe(EXISTING_EPISODE_ID);
    expect(result.status).toBe('ready');
  });

  it('fast-forwards to ready when the job.episode_id link itself already points to a published episode', async () => {
    mockFindListeningEpisodeByGenerationKey.mockResolvedValue({
      id: EPISODE_ID, status: 'published', cefrLevel: 'A1',
    });
    const supabase = makeGroupSupabase(
      { status: 'generating_block_1', targetLevel: 'A1', episodeId: EPISODE_ID },
      { listening_episodes: { data: { id: EPISODE_ID, status: 'published' }, error: null } },
    );

    const result = await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase);
    expect(result.status).toBe('ready');
    expect(mockGenerateListeningStory).not.toHaveBeenCalled();
  });

  it('does not treat a matching job.episode_id / generation_key episode as an integrity conflict', async () => {
    mockFindListeningEpisodeByGenerationKey.mockResolvedValue({
      id: EPISODE_ID, status: 'content_ready', cefrLevel: 'A1',
    });
    const supabase = makeGroupSupabase(
      { status: 'generating_block_1', targetLevel: 'A1', episodeId: EPISODE_ID },
      { listening_episodes: { data: { id: EPISODE_ID, status: 'content_ready' }, error: null } },
    );

    const result = await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase);
    expect(result.status).toBe('validating_block_1');
    expect(mockGenerateListeningStory).not.toHaveBeenCalled();
  });
});

describe('processListeningGroupGenerationStep — generation_key is scoped to the job (not the whole CEFR level)', () => {
  const OTHER_JOB_ID = 'bbbbbbbb-0000-0000-0000-000000000002';

  it('retries of the same job resolve to the same generation_key', async () => {
    mockFindListeningEpisodeByGenerationKey.mockResolvedValue(null);
    mockGenerateListeningStory.mockResolvedValue({ story: {}, episodeId: EPISODE_ID, idempotencyKey: 'k' });

    const supabase1 = makeGroupSupabase({ status: 'generating_block_1', targetLevel: 'A1', episodeId: null });
    await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase1);
    const key1 = mockFindListeningEpisodeByGenerationKey.mock.calls[0][1];

    const supabase2 = makeGroupSupabase({ status: 'generating_block_1', targetLevel: 'A1', episodeId: null });
    await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase2);
    const key2 = mockFindListeningEpisodeByGenerationKey.mock.calls[1][1];

    expect(key1).toBe(key2);
  });

  it('two different jobs for the same CEFR level compute two different generation_keys', async () => {
    mockFindListeningEpisodeByGenerationKey.mockResolvedValue(null);
    mockGenerateListeningStory.mockResolvedValue({ story: {}, episodeId: EPISODE_ID, idempotencyKey: 'k' });

    const supabase1 = makeGroupSupabase({ status: 'generating_block_1', targetLevel: 'A1', episodeId: null });
    await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase1);
    const key1 = mockFindListeningEpisodeByGenerationKey.mock.calls[0][1];

    const supabase2 = makeGroupSupabase({ status: 'generating_block_1', targetLevel: 'A1', episodeId: null });
    await processListeningGroupGenerationStep(OTHER_JOB_ID, WORKER_ID, supabase2);
    const key2 = mockFindListeningEpisodeByGenerationKey.mock.calls[1][1];

    expect(key1).not.toBe(key2);
  });

  it('passes the job id as the seed into generateListeningStory itself, not just the pre-check', async () => {
    mockFindListeningEpisodeByGenerationKey.mockResolvedValue(null);
    mockGenerateListeningStory.mockResolvedValue({ story: {}, episodeId: EPISODE_ID, idempotencyKey: 'k' });
    const supabase = makeGroupSupabase({ status: 'generating_block_1', targetLevel: 'A1', episodeId: null });

    await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase);

    expect(mockGenerateListeningStory).toHaveBeenCalledWith(
      expect.objectContaining({ cefrLevel: 'A1', seed: JOB_ID }),
      expect.anything(),
      supabase,
    );
  });

  it('two legitimate A1 generations (two different jobs) can each persist their own episode without colliding', async () => {
    mockFindListeningEpisodeByGenerationKey.mockResolvedValue(null); // neither job's key has been used before
    mockGenerateListeningStory
      .mockResolvedValueOnce({ story: {}, episodeId: 'episode-from-job-1', idempotencyKey: 'k1' })
      .mockResolvedValueOnce({ story: {}, episodeId: 'episode-from-job-2', idempotencyKey: 'k2' });

    const supabase1 = makeGroupSupabase({ status: 'generating_block_1', targetLevel: 'A1', episodeId: null });
    const first = await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase1);

    const supabase2 = makeGroupSupabase({ status: 'generating_block_1', targetLevel: 'A1', episodeId: null });
    const second = await processListeningGroupGenerationStep(OTHER_JOB_ID, WORKER_ID, supabase2);

    expect(first.episodeId).toBe('episode-from-job-1');
    expect(second.episodeId).toBe('episode-from-job-2');
    expect(first.episodeId).not.toBe(second.episodeId);
  });
});

describe('processListeningGroupGenerationStep — a rejected episode is never reused', () => {
  it('does not reuse an episode whose status is failed (rejected) even if its generation_key is found — generates fresh content instead', async () => {
    mockFindListeningEpisodeByGenerationKey.mockResolvedValue({
      id: 'rejected-episode-id', status: 'failed', cefrLevel: 'A1',
    });
    mockGenerateListeningStory.mockResolvedValue({ story: {}, episodeId: EPISODE_ID, idempotencyKey: 'k' });
    const supabase = makeGroupSupabase({ status: 'generating_block_1', targetLevel: 'A1', episodeId: null });

    const result = await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase);

    expect(mockGenerateListeningStory).toHaveBeenCalledTimes(1);
    expect(result.episodeId).toBe(EPISODE_ID);
    expect(result.episodeId).not.toBe('rejected-episode-id');
  });
});

describe('processListeningGroupGenerationStep — preparing_description', () => {
  it('translates the synopsis via the shared helper under the group-specific endpoint', async () => {
    mockTranslateListeningSynopsis.mockResolvedValue({ translated: true, synopsisPt: 'x' });
    const supabase = makeGroupSupabase({ status: 'preparing_description', episodeId: EPISODE_ID });
    const result = await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase);
    expect(mockTranslateListeningSynopsis).toHaveBeenCalledWith(
      { episodeId: EPISODE_ID, endpoint: 'listening/on-demand/group/process-next' },
      supabase,
    );
    expect(result.status).toBe('preparing_subtitles');
  });
});

describe('processListeningGroupGenerationStep — preparing_subtitles (content validation gate)', () => {
  it('does not call Azure synthesis when subtitle/cue validation fails', async () => {
    mockPrepareListeningSubtitles.mockRejectedValue(new Error('LISTENING_TRANSLATION_MISSING_CUE'));
    const supabase = makeGroupSupabase({ status: 'preparing_subtitles', episodeId: EPISODE_ID });
    const result = await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase);

    expect(result.status).toBe('failed');
    expect(mockSynthesizeListeningEpisode).not.toHaveBeenCalled();
  });

  it('advances to generating_audio_block_1 only once subtitles are validated', async () => {
    mockPrepareListeningSubtitles.mockResolvedValue({ status: 'ready' });
    const supabase = makeGroupSupabase({ status: 'preparing_subtitles', episodeId: EPISODE_ID });
    const result = await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase);

    expect(mockSynthesizeListeningEpisode).not.toHaveBeenCalled(); // this step itself never synthesizes
    expect(result.status).toBe('generating_audio_block_1');
  });
});

describe('processListeningGroupGenerationStep — generating_audio_block_1', () => {
  it('synthesizes exactly block 1 audio, once, only after content validation has already passed', async () => {
    mockSynthesizeListeningEpisode.mockResolvedValue(undefined);
    const supabase = makeGroupSupabase({ status: 'generating_audio_block_1', episodeId: EPISODE_ID });
    const result = await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase);

    expect(mockSynthesizeListeningEpisode).toHaveBeenCalledTimes(1);
    expect(mockSynthesizeListeningEpisode).toHaveBeenCalledWith(
      { episodeId: EPISODE_ID, blockFilter: 1 },
      supabase,
      expect.anything(),
      expect.anything(),
    );
    expect(result.status).toBe('generating_audio_block_2');
  });
});

describe('processListeningGroupGenerationStep — finalizing', () => {
  it('publishes the shared episode and never writes a per-user assignment', async () => {
    mockSynchronizeListeningEpisode.mockResolvedValue(undefined);
    mockPublishListeningEpisode.mockResolvedValue({ episodeId: EPISODE_ID, publicationStatus: 'published' });
    const supabase = makeGroupSupabase({ status: 'finalizing', episodeId: EPISODE_ID });
    const result = await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase);

    expect(mockPublishListeningEpisode).toHaveBeenCalledWith({
      episodeId: EPISODE_ID,
      publishedBy: 'listening-group-generation',
      publicationSource: 'system',
    });
    expect(supabase.calledTables).not.toContain('user_listening_assignments');
    expect(result.status).toBe('ready');
  });
});

describe('processListeningGroupGenerationStep — failure and attempts accounting', () => {
  it('marks the job failed, increments attempts, and stays retryable below max_attempts', async () => {
    mockTranslateListeningSynopsis.mockRejectedValue(new Error('boom'));
    const supabase = makeGroupSupabase({ status: 'preparing_description', episodeId: EPISODE_ID, attempts: 0, maxAttempts: 3 });
    const result = await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase);
    expect(result.status).toBe('failed');
    expect(result.attempts).toBe(1);
    expect(result.retryable).toBe(true);
  });

  it('marks the job non-retryable once attempts reach max_attempts', async () => {
    mockTranslateListeningSynopsis.mockRejectedValue(new Error('boom'));
    const supabase = makeGroupSupabase({ status: 'preparing_description', episodeId: EPISODE_ID, attempts: 2, maxAttempts: 3 });
    const result = await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase);
    expect(result.status).toBe('failed');
    expect(result.attempts).toBe(3);
    expect(result.retryable).toBe(false);
  });

  it('does not duplicate story generation on a retried generating_block_1 step once episode_id is set', async () => {
    mockGenerateListeningStory.mockResolvedValue({ story: {}, episodeId: EPISODE_ID, idempotencyKey: 'k' });
    // First attempt: no episode yet -> generates.
    const supabase1 = makeGroupSupabase({ status: 'generating_block_1', episodeId: null });
    const first = await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase1);
    expect(mockGenerateListeningStory).toHaveBeenCalledTimes(1);
    expect(first.episodeId).toBe(EPISODE_ID);

    // Simulated retry back into the same step after the episode already exists.
    mockGenerateListeningStory.mockClear();
    const supabase2 = makeGroupSupabase(
      { status: 'generating_block_1', episodeId: EPISODE_ID },
      { listening_episodes: { data: { id: EPISODE_ID, status: 'content_ready' }, error: null } },
    );
    const second = await processListeningGroupGenerationStep(JOB_ID, WORKER_ID, supabase2);
    expect(mockGenerateListeningStory).not.toHaveBeenCalled();
    expect(second.episodeId).toBe(EPISODE_ID);
  });
});
