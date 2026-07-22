import type { SupabaseClient } from '@supabase/supabase-js';
import type { GenerationStatusResult, GenerationSessionStatus } from './listening-on-demand-types';
import {
  STEP_LABELS, STEP_PROGRESS, NEXT_STATUS, TERMINAL_STATUSES,
  STEP_LOCK_MS, OnDemandSessionNotFoundError, OnDemandSessionLockedError,
  OnDemandSessionTerminalError, OnDemandDurationError, toPublicSessionResult,
} from './listening-on-demand-types';
import { resolveUserListeningLevel } from '../daily/resolve-user-listening-level';
import { generateListeningStory, createDefaultAICallFn } from '../generate-listening-story';
import { generateListeningQuestions, createQuestionAICallFn } from '../generate-listening-questions';
import { prepareListeningSubtitles, createSubtitleAICallFn } from '../prepare-listening-subtitles';
import { generateListeningSsml } from '../generate-listening-ssml';
import { synthesizeListeningEpisode } from '../audio/synthesize-listening-episode';
import { synchronizeListeningEpisode } from '../timing/synchronize-listening-episode';
import { publishListeningEpisode } from '../publication/publish-listening-episode';
import { translateListeningSynopsis } from '../translate-listening-synopsis';

// Duration thresholds — exported so the shared level-group pipeline
// (group-generation/process-listening-group-generation-step.ts) validates
// against the exact same rule instead of duplicating these literals.
export const BLOCK_MIN_MS = 270_000; // 4m30s
export const BLOCK_MAX_MS = 330_000; // 5m30s
export const TOTAL_MIN_MS = 540_000; // 9m
export const TOTAL_MAX_MS = 660_000; // 11m

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing environment variable: ${name}`);
  return val;
}

function log(event: string, sessionId: string, extra?: Record<string, unknown>) {
  console.error(JSON.stringify({ service: 'listening-on-demand', event, sessionId, t: Date.now(), ...extra }));
}

// ── Lock acquisition ──────────────────────────────────────────────────────────

async function acquireLock(
  serviceClient: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<{ id: string; status: GenerationSessionStatus; user_level: string | null; episode_id: string | null; local_date: string }> {
  const now = new Date();
  const lockExpires = new Date(now.getTime() + STEP_LOCK_MS);

  // Atomic lock: only succeeds if session is unlocked or lock expired
  const { data, error } = await serviceClient
    .from('user_listening_generation_sessions')
    .update({
      locked_at: now.toISOString(),
      lock_expires_at: lockExpires.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq('id', sessionId)
    .eq('user_id', userId)
    .or(`locked_at.is.null,lock_expires_at.lt.${now.toISOString()}`)
    .select('id, status, user_level, episode_id, local_date')
    .maybeSingle();

  if (error) throw new Error(`Lock acquisition DB error: ${error.message}`);
  if (!data) {
    // Could be not found OR locked — check which
    const { data: check } = await serviceClient
      .from('user_listening_generation_sessions')
      .select('id')
      .eq('id', sessionId)
      .eq('user_id', userId)
      .maybeSingle();
    if (!check) throw new OnDemandSessionNotFoundError(sessionId);
    throw new OnDemandSessionLockedError();
  }

  return data as { id: string; status: GenerationSessionStatus; user_level: string | null; episode_id: string | null; local_date: string };
}

// ── Lock release (advance to next status) ────────────────────────────────────

async function advanceSession(
  serviceClient: SupabaseClient,
  sessionId: string,
  nextStatus: GenerationSessionStatus,
  updates?: Record<string, unknown>,
): Promise<void> {
  const isReady = nextStatus === 'ready';
  await serviceClient
    .from('user_listening_generation_sessions')
    .update({
      status: nextStatus,
      current_step: STEP_LABELS[nextStatus],
      progress_percent: STEP_PROGRESS[nextStatus],
      locked_at: null,
      lock_expires_at: null,
      error_code: null,
      error_message: null,
      retryable: false,
      ...(isReady ? { completed_at: new Date().toISOString() } : {}),
      updated_at: new Date().toISOString(),
      ...updates,
    })
    .eq('id', sessionId);
}

async function failSession(
  serviceClient: SupabaseClient,
  sessionId: string,
  errorCode: string,
  errorMessage: string,
  retryable: boolean,
  currentStatus: GenerationSessionStatus,
): Promise<void> {
  await serviceClient
    .from('user_listening_generation_sessions')
    .update({
      status: 'failed',
      current_step: STEP_LABELS[currentStatus],
      error_code: errorCode,
      error_message: errorMessage.slice(0, 1000),
      retryable,
      locked_at: null,
      lock_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', sessionId);
}

// ── Step handlers ─────────────────────────────────────────────────────────────

async function stepIdentifyingLevel(
  serviceClient: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<void> {
  const level = await resolveUserListeningLevel(serviceClient, userId);
  await advanceSession(serviceClient, sessionId, 'generating_block_1', { user_level: level });
}

async function stepGeneratingBlock1(
  serviceClient: SupabaseClient,
  sessionId: string,
  session: { user_level: string | null; episode_id: string | null },
): Promise<void> {
  // Idempotency: if episode already exists, skip generation
  if (session.episode_id) {
    const { data: ep } = await serviceClient
      .from('listening_episodes')
      .select('id, status')
      .eq('id', session.episode_id)
      .maybeSingle();
    if (ep) {
      await advanceSession(serviceClient, sessionId, 'validating_block_1');
      return;
    }
  }

  const cefrLevel = (session.user_level ?? 'A2') as Parameters<typeof generateListeningStory>[0]['cefrLevel'];
  const openaiKey = requireEnv('OPENAI_API_KEY');
  const callAI = createDefaultAICallFn(openaiKey);

  const result = await generateListeningStory({ cefrLevel }, callAI, serviceClient);

  await advanceSession(serviceClient, sessionId, 'validating_block_1', {
    episode_id: result.episodeId,
  });
}

async function stepValidatingBlock1(
  serviceClient: SupabaseClient,
  sessionId: string,
  session: { episode_id: string | null },
): Promise<void> {
  if (!session.episode_id) throw new Error('episode_id is missing at validating_block_1');

  const { data: block1 } = await serviceClient
    .from('listening_blocks')
    .select('id, text_en')
    .eq('episode_id', session.episode_id)
    .eq('block_order', 1)
    .maybeSingle();

  if (!block1?.text_en) {
    throw new Error('Block 1 text is missing or empty');
  }

  await advanceSession(serviceClient, sessionId, 'generating_block_2');
}

async function stepGeneratingBlock2(
  serviceClient: SupabaseClient,
  sessionId: string,
  session: { episode_id: string | null },
): Promise<void> {
  // Block 2 is already generated by generateListeningStory (both blocks at once)
  if (!session.episode_id) throw new Error('episode_id is missing at generating_block_2');

  const { data: block2 } = await serviceClient
    .from('listening_blocks')
    .select('id, text_en')
    .eq('episode_id', session.episode_id)
    .eq('block_order', 2)
    .maybeSingle();

  if (!block2?.text_en) {
    throw new Error('Block 2 text is missing or empty');
  }

  await advanceSession(serviceClient, sessionId, 'validating_block_2');
}

async function stepValidatingBlock2(
  serviceClient: SupabaseClient,
  sessionId: string,
  session: { episode_id: string | null },
): Promise<void> {
  if (!session.episode_id) throw new Error('episode_id is missing at validating_block_2');

  const { data: block2 } = await serviceClient
    .from('listening_blocks')
    .select('id, text_en, status')
    .eq('episode_id', session.episode_id)
    .eq('block_order', 2)
    .maybeSingle();

  if (!block2?.text_en) {
    throw new Error('Block 2 text is missing or empty');
  }

  await advanceSession(serviceClient, sessionId, 'generating_questions');
}

async function stepGeneratingQuestions(
  serviceClient: SupabaseClient,
  sessionId: string,
  session: { episode_id: string | null },
): Promise<void> {
  if (!session.episode_id) throw new Error('episode_id is missing at generating_questions');

  const openaiKey = requireEnv('OPENAI_API_KEY');
  const callAI = createQuestionAICallFn(openaiKey);

  await generateListeningQuestions({ episodeId: session.episode_id }, callAI, serviceClient);
  await advanceSession(serviceClient, sessionId, 'preparing_description');
}

async function stepPreparingDescription(
  serviceClient: SupabaseClient,
  sessionId: string,
  session: { episode_id: string | null },
): Promise<void> {
  if (!session.episode_id) throw new Error('episode_id is missing at preparing_description');

  await translateListeningSynopsis(
    { episodeId: session.episode_id, endpoint: 'listening/on-demand/process-next' },
    serviceClient,
  );

  await advanceSession(serviceClient, sessionId, 'preparing_subtitles');
}

async function stepPreparingSubtitles(
  serviceClient: SupabaseClient,
  sessionId: string,
  session: { episode_id: string | null },
): Promise<void> {
  if (!session.episode_id) throw new Error('episode_id is missing at preparing_subtitles');

  const openaiKey = requireEnv('OPENAI_API_KEY');
  const callAI = createSubtitleAICallFn(openaiKey);

  // Step 1: Generate subtitles (EN + PT-BR)
  await prepareListeningSubtitles({ episodeId: session.episode_id }, callAI, serviceClient);

  // Step 2: Generate SSML for Azure
  await generateListeningSsml({ episodeId: session.episode_id }, serviceClient);

  await advanceSession(serviceClient, sessionId, 'generating_audio_block_1');
}

async function stepGeneratingAudioBlock1(
  serviceClient: SupabaseClient,
  sessionId: string,
  session: { episode_id: string | null },
): Promise<void> {
  if (!session.episode_id) throw new Error('episode_id is missing at generating_audio_block_1');

  const azureKey = requireEnv('AZURE_SPEECH_KEY');
  const azureRegion = requireEnv('AZURE_SPEECH_REGION');

  await synthesizeListeningEpisode(
    { episodeId: session.episode_id, blockFilter: 1 },
    serviceClient,
    azureKey,
    azureRegion,
  );

  await advanceSession(serviceClient, sessionId, 'generating_audio_block_2');
}

async function stepGeneratingAudioBlock2(
  serviceClient: SupabaseClient,
  sessionId: string,
  session: { episode_id: string | null },
): Promise<void> {
  if (!session.episode_id) throw new Error('episode_id is missing at generating_audio_block_2');

  const azureKey = requireEnv('AZURE_SPEECH_KEY');
  const azureRegion = requireEnv('AZURE_SPEECH_REGION');

  await synthesizeListeningEpisode(
    { episodeId: session.episode_id, blockFilter: 2 },
    serviceClient,
    azureKey,
    azureRegion,
  );

  await advanceSession(serviceClient, sessionId, 'validating_duration');
}

async function stepValidatingDuration(
  serviceClient: SupabaseClient,
  sessionId: string,
  session: { episode_id: string | null },
): Promise<void> {
  if (!session.episode_id) throw new Error('episode_id is missing at validating_duration');

  const { data: assets } = await serviceClient
    .from('listening_audio_assets')
    .select('block_id, duration_ms, status')
    .eq('episode_id', session.episode_id)
    .in('status', ['validated', 'published']);

  if (!assets || assets.length < 2) {
    throw new OnDemandDurationError(
      `Expected 2 audio assets, found ${assets?.length ?? 0}`
    );
  }

  // Get block order for each asset
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
    throw new OnDemandDurationError(`Block 1 too short: ${block1Ms}ms (min ${BLOCK_MIN_MS}ms)`);
  }
  if (block1Ms > BLOCK_MAX_MS) {
    throw new OnDemandDurationError(`Block 1 too long: ${block1Ms}ms (max ${BLOCK_MAX_MS}ms)`);
  }
  if (block2Ms < BLOCK_MIN_MS) {
    throw new OnDemandDurationError(`Block 2 too short: ${block2Ms}ms (min ${BLOCK_MIN_MS}ms)`);
  }
  if (block2Ms > BLOCK_MAX_MS) {
    throw new OnDemandDurationError(`Block 2 too long: ${block2Ms}ms (max ${BLOCK_MAX_MS}ms)`);
  }
  const totalMs = block1Ms + block2Ms;
  if (totalMs < TOTAL_MIN_MS) {
    throw new OnDemandDurationError(`Total duration too short: ${totalMs}ms (min ${TOTAL_MIN_MS}ms)`);
  }
  if (totalMs > TOTAL_MAX_MS) {
    throw new OnDemandDurationError(`Total duration too long: ${totalMs}ms (max ${TOTAL_MAX_MS}ms)`);
  }

  await advanceSession(serviceClient, sessionId, 'finalizing');
}

async function stepFinalizing(
  serviceClient: SupabaseClient,
  sessionId: string,
  session: { episode_id: string | null; local_date: string; user_id?: string },
  userId: string,
): Promise<void> {
  if (!session.episode_id) throw new Error('episode_id is missing at finalizing');

  // 1. Synchronize word timings for both blocks
  await synchronizeListeningEpisode(
    { episodeId: session.episode_id },
    serviceClient,
  );

  // 2. Publish the episode
  await publishListeningEpisode({
    episodeId: session.episode_id,
    publishedBy: 'on-demand',
    publicationSource: 'system',
  });

  // 3. Create or verify assignment for today
  await serviceClient
    .from('user_listening_assignments')
    .upsert(
      {
        user_id: userId,
        episode_id: session.episode_id,
        activity_date: session.local_date,
        status: 'assigned',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,activity_date,episode_id', ignoreDuplicates: true },
    );

  await advanceSession(serviceClient, sessionId, 'ready');
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function processListeningGenerationStep(
  sessionId: string,
  userId: string,
  serviceClient: SupabaseClient,
): Promise<GenerationStatusResult> {
  // Acquire lock — this is the atomic check
  const session = await acquireLock(serviceClient, sessionId, userId);
  const currentStatus = session.status;

  log('step_started', sessionId, { status: currentStatus });

  if (TERMINAL_STATUSES.has(currentStatus)) {
    // Release lock and return current state
    await serviceClient
      .from('user_listening_generation_sessions')
      .update({ locked_at: null, lock_expires_at: null, updated_at: new Date().toISOString() })
      .eq('id', sessionId);
    throw new OnDemandSessionTerminalError(currentStatus);
  }

  const nextStatus = NEXT_STATUS[currentStatus];
  if (!nextStatus) {
    await serviceClient
      .from('user_listening_generation_sessions')
      .update({ locked_at: null, lock_expires_at: null, updated_at: new Date().toISOString() })
      .eq('id', sessionId);
    throw new Error(`No next status defined for: ${currentStatus}`);
  }

  try {
    switch (currentStatus) {
      case 'identifying_level':
        await stepIdentifyingLevel(serviceClient, sessionId, userId);
        break;
      case 'generating_block_1':
        await stepGeneratingBlock1(serviceClient, sessionId, session);
        break;
      case 'validating_block_1':
        await stepValidatingBlock1(serviceClient, sessionId, session);
        break;
      case 'generating_block_2':
        await stepGeneratingBlock2(serviceClient, sessionId, session);
        break;
      case 'validating_block_2':
        await stepValidatingBlock2(serviceClient, sessionId, session);
        break;
      case 'generating_questions':
        await stepGeneratingQuestions(serviceClient, sessionId, session);
        break;
      case 'preparing_description':
        await stepPreparingDescription(serviceClient, sessionId, session);
        break;
      case 'preparing_subtitles':
        await stepPreparingSubtitles(serviceClient, sessionId, session);
        break;
      case 'generating_audio_block_1':
        await stepGeneratingAudioBlock1(serviceClient, sessionId, session);
        break;
      case 'generating_audio_block_2':
        await stepGeneratingAudioBlock2(serviceClient, sessionId, session);
        break;
      case 'validating_duration':
        await stepValidatingDuration(serviceClient, sessionId, session);
        break;
      case 'finalizing':
        await stepFinalizing(serviceClient, sessionId, { ...session, user_id: userId }, userId);
        break;
      default:
        throw new Error(`Unhandled status: ${currentStatus}`);
    }

    log('step_completed', sessionId, { status: currentStatus, next: nextStatus });
  } catch (err) {
    const errorCode = (err as { code?: string }).code ?? 'STEP_ERROR';
    const errorMessage = err instanceof Error ? err.message : String(err);
    const retryable = (err as { retryable?: boolean }).retryable ?? true;

    log('step_failed', sessionId, { status: currentStatus, errorCode, retryable });

    await failSession(serviceClient, sessionId, errorCode, errorMessage, retryable, currentStatus);

    const { data: failedSession } = await serviceClient
      .from('user_listening_generation_sessions')
      .select('id, status, current_step, progress_percent, episode_id, error_code, error_message, retryable')
      .eq('id', sessionId)
      .single();

    if (failedSession) return toPublicSessionResult(failedSession as any);

    return {
      generationSessionId: sessionId,
      status: 'failed',
      currentStep: STEP_LABELS[currentStatus],
      progressPercent: STEP_PROGRESS[currentStatus],
      episodeId: session.episode_id,
      errorCode,
      errorMessage: errorMessage.slice(0, 500),
      retryable,
    };
  }

  // Fetch final state to return
  const { data: updatedSession } = await serviceClient
    .from('user_listening_generation_sessions')
    .select('id, status, current_step, progress_percent, episode_id, error_code, error_message, retryable')
    .eq('id', sessionId)
    .single();

  if (updatedSession) return toPublicSessionResult(updatedSession as any);

  return {
    generationSessionId: sessionId,
    status: nextStatus,
    currentStep: STEP_LABELS[nextStatus],
    progressPercent: STEP_PROGRESS[nextStatus],
    episodeId: session.episode_id,
    errorCode: null,
    errorMessage: null,
    retryable: false,
  };
}
