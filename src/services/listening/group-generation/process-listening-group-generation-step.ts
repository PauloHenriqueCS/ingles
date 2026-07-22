import type { SupabaseClient } from '@supabase/supabase-js';
import type { CEFRLevel } from '../../../domain/curriculum/cefr';
import type { ListeningLevelGroup } from '../listening-level-group';
import type { GroupGenerationStatusResult, GroupGenerationStatus } from './listening-group-generation-types';
import {
  STEP_LABELS, STEP_PROGRESS, NEXT_STATUS, TERMINAL_STATUSES,
  STEP_LOCK_MS, GroupJobNotFoundError, GroupJobLockedError,
  GroupJobTerminalError, GroupJobDurationError, GroupJobEpisodeIntegrityError, toPublicGroupJobResult,
} from './listening-group-generation-types';
import { generateListeningStory, createDefaultAICallFn, buildIdempotencyKey } from '../generate-listening-story';
import { findListeningEpisodeByGenerationKey } from '../persist-listening-story';
import { generateListeningQuestions, createQuestionAICallFn } from '../generate-listening-questions';
import { prepareListeningSubtitles, createSubtitleAICallFn } from '../prepare-listening-subtitles';
import { generateListeningSsml } from '../generate-listening-ssml';
import { synthesizeListeningEpisode } from '../audio/synthesize-listening-episode';
import { synchronizeListeningEpisode } from '../timing/synchronize-listening-episode';
import { publishListeningEpisode } from '../publication/publish-listening-episode';
import { translateListeningSynopsis } from '../translate-listening-synopsis';
import {
  BLOCK_MIN_MS, BLOCK_MAX_MS, TOTAL_MIN_MS, TOTAL_MAX_MS,
} from '../on-demand/process-listening-generation-step';

// This is the shared-content counterpart of
// on-demand/process-listening-generation-step.ts: it walks a single
// listening_generation_jobs row (keyed by level_group, not by user) through
// the same content pipeline — generateListeningStory, generateListeningQuestions,
// prepareListeningSubtitles/generateListeningSsml, synthesizeListeningEpisode,
// synchronizeListeningEpisode, publishListeningEpisode — using job.target_level
// as the CEFR level. There is no per-user step (no identifying_level, no
// user_listening_assignments write in finalizing): assigning the resulting
// published episode to individual users happens downstream, in the existing
// daily assignment flow (selectListeningEpisodeForUser /
// getOrCreateListeningAssignment), which already reuses any published episode
// matching a user's cefr_level regardless of how it was generated.

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing environment variable: ${name}`);
  return val;
}

function log(event: string, jobId: string, extra?: Record<string, unknown>) {
  console.error(JSON.stringify({ service: 'listening-group-generation', event, jobId, t: Date.now(), ...extra }));
}

type LockedJobRow = {
  id: string;
  status: GroupGenerationStatus;
  level_group: string;
  target_level: string;
  episode_id: string | null;
  attempts: number;
  max_attempts: number;
};

const JOB_STATUS_COLUMNS = 'id, level_group, target_level, status, current_step, progress_percent, episode_id, attempts, max_attempts, error_code, error_message, retryable';

// ── Lock acquisition ──────────────────────────────────────────────────────────

async function acquireLock(
  serviceClient: SupabaseClient,
  jobId: string,
  workerId: string,
): Promise<LockedJobRow> {
  const now = new Date();
  const lockExpires = new Date(now.getTime() + STEP_LOCK_MS);

  // Atomic lock: only succeeds if the job is unlocked or its lock expired.
  const { data, error } = await serviceClient
    .from('listening_generation_jobs')
    .update({
      locked_by: workerId,
      locked_at: now.toISOString(),
      lock_expires_at: lockExpires.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq('id', jobId)
    .or(`locked_at.is.null,lock_expires_at.lt.${now.toISOString()}`)
    .select('id, status, level_group, target_level, episode_id, attempts, max_attempts')
    .maybeSingle();

  if (error) throw new Error(`Lock acquisition DB error: ${error.message}`);
  if (!data) {
    // Could be not found OR locked — check which.
    const { data: check } = await serviceClient
      .from('listening_generation_jobs')
      .select('id')
      .eq('id', jobId)
      .maybeSingle();
    if (!check) throw new GroupJobNotFoundError(jobId);
    throw new GroupJobLockedError();
  }

  return data as LockedJobRow;
}

async function releaseLock(serviceClient: SupabaseClient, jobId: string): Promise<void> {
  await serviceClient
    .from('listening_generation_jobs')
    .update({ locked_by: null, locked_at: null, lock_expires_at: null, updated_at: new Date().toISOString() })
    .eq('id', jobId);
}

// ── Lock release (advance to next status) ────────────────────────────────────

async function advanceJob(
  serviceClient: SupabaseClient,
  jobId: string,
  nextStatus: GroupGenerationStatus,
  updates?: Record<string, unknown>,
): Promise<void> {
  const isReady = nextStatus === 'ready';
  await serviceClient
    .from('listening_generation_jobs')
    .update({
      status: nextStatus,
      current_step: STEP_LABELS[nextStatus],
      progress_percent: STEP_PROGRESS[nextStatus],
      locked_by: null,
      locked_at: null,
      lock_expires_at: null,
      error_code: null,
      error_message: null,
      retryable: false,
      ...(isReady ? { completed_at: new Date().toISOString() } : {}),
      updated_at: new Date().toISOString(),
      ...updates,
    })
    .eq('id', jobId);
}

async function failJob(
  serviceClient: SupabaseClient,
  jobId: string,
  errorCode: string,
  errorMessage: string,
  retryable: boolean,
  currentStatus: GroupGenerationStatus,
  attemptsBefore: number,
): Promise<void> {
  await serviceClient
    .from('listening_generation_jobs')
    .update({
      status: 'failed',
      current_step: STEP_LABELS[currentStatus],
      error_code: errorCode,
      error_message: errorMessage.slice(0, 1000),
      retryable,
      attempts: attemptsBefore + 1,
      locked_by: null,
      locked_at: null,
      lock_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId);
}

// ── Step handlers ─────────────────────────────────────────────────────────────

async function stepCreated(serviceClient: SupabaseClient, jobId: string): Promise<void> {
  // Pure transition — the target level is already fixed at job creation
  // (determineNextListeningGroupTargetLevel), unlike the on-demand pipeline's
  // 'identifying_level' step which resolves it per user.
  await advanceJob(serviceClient, jobId, 'generating_block_1');
}

async function stepGeneratingBlock1(
  serviceClient: SupabaseClient,
  jobId: string,
  job: { target_level: string; episode_id: string | null },
): Promise<void> {
  const cefrLevel = job.target_level as CEFRLevel;
  const idempotencyKey = buildIdempotencyKey({ cefrLevel });

  // get-or-create by generation_key: a previous attempt for this exact
  // (level, theme, seed, prompt/content version) may have already persisted
  // an episode before failing at a later step (e.g. subtitle translation).
  // generation_key is UNIQUE in the DB, so generating fresh content and
  // inserting again would fail the constraint — reuse it instead.
  const existingByKey = await findListeningEpisodeByGenerationKey(serviceClient, idempotencyKey);

  // Idempotency: if the job is already linked to an episode (e.g. a step
  // after this one failed and we retried into this step's neighbor), skip
  // generation — but first confirm it's still the same episode generation_key
  // resolves to, so a corrupted/mismatched link fails loudly instead of
  // silently operating on the wrong content.
  if (job.episode_id) {
    if (existingByKey && existingByKey.id !== job.episode_id) {
      throw new GroupJobEpisodeIntegrityError(jobId, job.episode_id, existingByKey.id);
    }
    const { data: ep } = await serviceClient
      .from('listening_episodes')
      .select('id, status')
      .eq('id', job.episode_id)
      .maybeSingle();
    if (ep) {
      const episodeStatus = (ep as { status: string }).status;
      await advanceJob(serviceClient, jobId, episodeStatus === 'published' ? 'ready' : 'validating_block_1');
      return;
    }
  }

  if (existingByKey) {
    log('reusing_existing_episode', jobId, { episodeId: existingByKey.id, episodeStatus: existingByKey.status });
    if (existingByKey.status === 'published') {
      // Nothing left for this job to do — content generation, subtitles and
      // audio for this generation_key are already done and live. Fast-forward
      // to ready instead of re-running (and failing) content steps against an
      // episode prepareListeningSubtitles/publishListeningEpisode both treat
      // as immutable. Per-user assignment happens downstream in the existing
      // daily flow, same as any other published episode.
      await advanceJob(serviceClient, jobId, 'ready', { episode_id: existingByKey.id });
      return;
    }
    await advanceJob(serviceClient, jobId, 'validating_block_1', { episode_id: existingByKey.id });
    return;
  }

  const openaiKey = requireEnv('OPENAI_API_KEY');
  const callAI = createDefaultAICallFn(openaiKey);

  const result = await generateListeningStory({ cefrLevel }, callAI, serviceClient);

  await advanceJob(serviceClient, jobId, 'validating_block_1', {
    episode_id: result.episodeId,
  });
}

async function stepValidatingBlock1(
  serviceClient: SupabaseClient,
  jobId: string,
  job: { episode_id: string | null },
): Promise<void> {
  if (!job.episode_id) throw new Error('episode_id is missing at validating_block_1');

  const { data: block1 } = await serviceClient
    .from('listening_blocks')
    .select('id, text_en')
    .eq('episode_id', job.episode_id)
    .eq('block_order', 1)
    .maybeSingle();

  if (!block1?.text_en) {
    throw new Error('Block 1 text is missing or empty');
  }

  await advanceJob(serviceClient, jobId, 'generating_block_2');
}

async function stepGeneratingBlock2(
  serviceClient: SupabaseClient,
  jobId: string,
  job: { episode_id: string | null },
): Promise<void> {
  // Block 2 is already generated by generateListeningStory (both blocks at once).
  if (!job.episode_id) throw new Error('episode_id is missing at generating_block_2');

  const { data: block2 } = await serviceClient
    .from('listening_blocks')
    .select('id, text_en')
    .eq('episode_id', job.episode_id)
    .eq('block_order', 2)
    .maybeSingle();

  if (!block2?.text_en) {
    throw new Error('Block 2 text is missing or empty');
  }

  await advanceJob(serviceClient, jobId, 'validating_block_2');
}

async function stepValidatingBlock2(
  serviceClient: SupabaseClient,
  jobId: string,
  job: { episode_id: string | null },
): Promise<void> {
  if (!job.episode_id) throw new Error('episode_id is missing at validating_block_2');

  const { data: block2 } = await serviceClient
    .from('listening_blocks')
    .select('id, text_en, status')
    .eq('episode_id', job.episode_id)
    .eq('block_order', 2)
    .maybeSingle();

  if (!block2?.text_en) {
    throw new Error('Block 2 text is missing or empty');
  }

  await advanceJob(serviceClient, jobId, 'generating_questions');
}

async function stepGeneratingQuestions(
  serviceClient: SupabaseClient,
  jobId: string,
  job: { episode_id: string | null },
): Promise<void> {
  if (!job.episode_id) throw new Error('episode_id is missing at generating_questions');

  const openaiKey = requireEnv('OPENAI_API_KEY');
  const callAI = createQuestionAICallFn(openaiKey);

  await generateListeningQuestions({ episodeId: job.episode_id }, callAI, serviceClient);
  await advanceJob(serviceClient, jobId, 'preparing_description');
}

async function stepPreparingDescription(
  serviceClient: SupabaseClient,
  jobId: string,
  job: { episode_id: string | null },
): Promise<void> {
  if (!job.episode_id) throw new Error('episode_id is missing at preparing_description');

  await translateListeningSynopsis(
    { episodeId: job.episode_id, endpoint: 'listening/on-demand/group/process-next' },
    serviceClient,
  );

  await advanceJob(serviceClient, jobId, 'preparing_subtitles');
}

async function stepPreparingSubtitles(
  serviceClient: SupabaseClient,
  jobId: string,
  job: { episode_id: string | null },
): Promise<void> {
  if (!job.episode_id) throw new Error('episode_id is missing at preparing_subtitles');

  const openaiKey = requireEnv('OPENAI_API_KEY');
  const callAI = createSubtitleAICallFn(openaiKey);

  // Step 1: Generate subtitles (EN + PT-BR)
  await prepareListeningSubtitles({ episodeId: job.episode_id }, callAI, serviceClient);

  // Step 2: Generate SSML for Azure
  await generateListeningSsml({ episodeId: job.episode_id }, serviceClient);

  await advanceJob(serviceClient, jobId, 'generating_audio_block_1');
}

async function stepGeneratingAudioBlock1(
  serviceClient: SupabaseClient,
  jobId: string,
  job: { episode_id: string | null },
): Promise<void> {
  if (!job.episode_id) throw new Error('episode_id is missing at generating_audio_block_1');

  const azureKey = requireEnv('AZURE_SPEECH_KEY');
  const azureRegion = requireEnv('AZURE_SPEECH_REGION');

  await synthesizeListeningEpisode(
    { episodeId: job.episode_id, blockFilter: 1 },
    serviceClient,
    azureKey,
    azureRegion,
  );

  await advanceJob(serviceClient, jobId, 'generating_audio_block_2');
}

async function stepGeneratingAudioBlock2(
  serviceClient: SupabaseClient,
  jobId: string,
  job: { episode_id: string | null },
): Promise<void> {
  if (!job.episode_id) throw new Error('episode_id is missing at generating_audio_block_2');

  const azureKey = requireEnv('AZURE_SPEECH_KEY');
  const azureRegion = requireEnv('AZURE_SPEECH_REGION');

  await synthesizeListeningEpisode(
    { episodeId: job.episode_id, blockFilter: 2 },
    serviceClient,
    azureKey,
    azureRegion,
  );

  await advanceJob(serviceClient, jobId, 'validating_duration');
}

async function stepValidatingDuration(
  serviceClient: SupabaseClient,
  jobId: string,
  job: { episode_id: string | null },
): Promise<void> {
  if (!job.episode_id) throw new Error('episode_id is missing at validating_duration');

  const { data: assets } = await serviceClient
    .from('listening_audio_assets')
    .select('block_id, duration_ms, status')
    .eq('episode_id', job.episode_id)
    .in('status', ['validated', 'published']);

  if (!assets || assets.length < 2) {
    throw new GroupJobDurationError(
      `Expected 2 audio assets, found ${assets?.length ?? 0}`
    );
  }

  const blockIds = assets.map((a: { block_id: string }) => a.block_id);
  const { data: blocks } = await serviceClient
    .from('listening_blocks')
    .select('id, block_order')
    .in('id', blockIds);

  const blockOrderMap = new Map<string, number>();
  for (const b of blocks ?? []) blockOrderMap.set(b.id, b.block_order);

  let block1Ms = 0;
  let block2Ms = 0;
  for (const asset of assets) {
    const order = blockOrderMap.get((asset as any).block_id);
    const duration = (asset as any).duration_ms ?? 0;
    if (order === 1) block1Ms = duration;
    if (order === 2) block2Ms = duration;
  }

  if (block1Ms < BLOCK_MIN_MS) {
    throw new GroupJobDurationError(`Block 1 too short: ${block1Ms}ms (min ${BLOCK_MIN_MS}ms)`);
  }
  if (block1Ms > BLOCK_MAX_MS) {
    throw new GroupJobDurationError(`Block 1 too long: ${block1Ms}ms (max ${BLOCK_MAX_MS}ms)`);
  }
  if (block2Ms < BLOCK_MIN_MS) {
    throw new GroupJobDurationError(`Block 2 too short: ${block2Ms}ms (min ${BLOCK_MIN_MS}ms)`);
  }
  if (block2Ms > BLOCK_MAX_MS) {
    throw new GroupJobDurationError(`Block 2 too long: ${block2Ms}ms (max ${BLOCK_MAX_MS}ms)`);
  }
  const totalMs = block1Ms + block2Ms;
  if (totalMs < TOTAL_MIN_MS) {
    throw new GroupJobDurationError(`Total duration too short: ${totalMs}ms (min ${TOTAL_MIN_MS}ms)`);
  }
  if (totalMs > TOTAL_MAX_MS) {
    throw new GroupJobDurationError(`Total duration too long: ${totalMs}ms (max ${TOTAL_MAX_MS}ms)`);
  }

  await advanceJob(serviceClient, jobId, 'finalizing');
}

async function stepFinalizing(
  serviceClient: SupabaseClient,
  jobId: string,
  job: { episode_id: string | null },
): Promise<void> {
  if (!job.episode_id) throw new Error('episode_id is missing at finalizing');

  // 1. Synchronize word timings for both blocks
  await synchronizeListeningEpisode(
    { episodeId: job.episode_id },
    serviceClient,
  );

  // 2. Publish the shared episode. No per-user assignment is created here —
  // this job has no user_id; assignment happens downstream in the existing
  // daily flow once the episode is published (status = 'published').
  await publishListeningEpisode({
    episodeId: job.episode_id,
    publishedBy: 'listening-group-generation',
    publicationSource: 'system',
  });

  await advanceJob(serviceClient, jobId, 'ready');
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function processListeningGroupGenerationStep(
  jobId: string,
  workerId: string,
  serviceClient: SupabaseClient,
): Promise<GroupGenerationStatusResult> {
  // Acquire lock — this is the atomic check
  const job = await acquireLock(serviceClient, jobId, workerId);
  const currentStatus = job.status;

  log('step_started', jobId, { status: currentStatus, levelGroup: job.level_group, targetLevel: job.target_level });

  if (TERMINAL_STATUSES.has(currentStatus)) {
    await releaseLock(serviceClient, jobId);
    throw new GroupJobTerminalError(currentStatus);
  }

  const nextStatus = NEXT_STATUS[currentStatus];
  if (!nextStatus) {
    await releaseLock(serviceClient, jobId);
    throw new Error(`No next status defined for: ${currentStatus}`);
  }

  try {
    switch (currentStatus) {
      case 'created':
        await stepCreated(serviceClient, jobId);
        break;
      case 'generating_block_1':
        await stepGeneratingBlock1(serviceClient, jobId, job);
        break;
      case 'validating_block_1':
        await stepValidatingBlock1(serviceClient, jobId, job);
        break;
      case 'generating_block_2':
        await stepGeneratingBlock2(serviceClient, jobId, job);
        break;
      case 'validating_block_2':
        await stepValidatingBlock2(serviceClient, jobId, job);
        break;
      case 'generating_questions':
        await stepGeneratingQuestions(serviceClient, jobId, job);
        break;
      case 'preparing_description':
        await stepPreparingDescription(serviceClient, jobId, job);
        break;
      case 'preparing_subtitles':
        await stepPreparingSubtitles(serviceClient, jobId, job);
        break;
      case 'generating_audio_block_1':
        await stepGeneratingAudioBlock1(serviceClient, jobId, job);
        break;
      case 'generating_audio_block_2':
        await stepGeneratingAudioBlock2(serviceClient, jobId, job);
        break;
      case 'validating_duration':
        await stepValidatingDuration(serviceClient, jobId, job);
        break;
      case 'finalizing':
        await stepFinalizing(serviceClient, jobId, job);
        break;
      default:
        throw new Error(`Unhandled status: ${currentStatus}`);
    }

    log('step_completed', jobId, { status: currentStatus, next: nextStatus });
  } catch (err) {
    const errorCode = (err as { code?: string }).code ?? 'STEP_ERROR';
    const errorMessage = err instanceof Error ? err.message : String(err);
    const attemptsAfter = job.attempts + 1;
    const retryable = ((err as { retryable?: boolean }).retryable ?? true) && attemptsAfter < job.max_attempts;

    log('step_failed', jobId, { status: currentStatus, errorCode, retryable, attempts: attemptsAfter });

    await failJob(serviceClient, jobId, errorCode, errorMessage, retryable, currentStatus, job.attempts);

    const { data: failedJob } = await serviceClient
      .from('listening_generation_jobs')
      .select(JOB_STATUS_COLUMNS)
      .eq('id', jobId)
      .single();

    if (failedJob) return toPublicGroupJobResult(failedJob as any);

    return {
      jobId,
      levelGroup: job.level_group as ListeningLevelGroup,
      targetLevel: job.target_level as CEFRLevel,
      status: 'failed',
      currentStep: STEP_LABELS[currentStatus],
      progressPercent: STEP_PROGRESS[currentStatus],
      episodeId: job.episode_id,
      attempts: attemptsAfter,
      maxAttempts: job.max_attempts,
      errorCode,
      errorMessage: errorMessage.slice(0, 500),
      retryable,
    };
  }

  // Fetch final state to return
  const { data: updatedJob } = await serviceClient
    .from('listening_generation_jobs')
    .select(JOB_STATUS_COLUMNS)
    .eq('id', jobId)
    .single();

  if (updatedJob) return toPublicGroupJobResult(updatedJob as any);

  return {
    jobId,
    levelGroup: job.level_group as ListeningLevelGroup,
    targetLevel: job.target_level as CEFRLevel,
    status: nextStatus,
    currentStep: STEP_LABELS[nextStatus],
    progressPercent: STEP_PROGRESS[nextStatus],
    episodeId: job.episode_id,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    errorCode: null,
    errorMessage: null,
    retryable: false,
  };
}
