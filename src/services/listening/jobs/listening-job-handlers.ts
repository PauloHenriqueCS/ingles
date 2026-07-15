import type { SupabaseClient } from '@supabase/supabase-js';
import {
  generateListeningStory,
  createDefaultAICallFn,
} from '../generate-listening-story';
import {
  generateListeningQuestions,
  createQuestionAICallFn,
} from '../generate-listening-questions';
import {
  prepareListeningSubtitles,
  createSubtitleAICallFn,
} from '../prepare-listening-subtitles';
import { generateListeningSsml } from '../generate-listening-ssml';
import { synthesizeListeningEpisode } from '../audio/synthesize-listening-episode';
import { synchronizeListeningEpisode } from '../timing/synchronize-listening-episode';
import { validateListeningEpisodeForPublication } from '../publication/validate-listening-publication';
import { publishListeningEpisode } from '../publication/publish-listening-episode';
import { auditListeningStorageConsistency } from '../publication/audit-listening-storage';
import { cleanupPublishedListeningStaging } from '../publication/cleanup-listening-staging';
import { getJobsServiceClient } from './_supabase';
import {
  LISTENING_JOB_TYPES,
  ListeningJobError,
} from './listening-job-types';
import type {
  ListeningJobType,
  ListeningJobHandlerFn,
  GenerateStoryJobPayload,
  GenerateQuestionsJobPayload,
  PrepareSubtitlesJobPayload,
  GenerateSsmlJobPayload,
  SynthesizeBlockAudioJobPayload,
  SynchronizeBlockJobPayload,
  ValidateEpisodeJobPayload,
  PublishEpisodeJobPayload,
  AuditStorageJobPayload,
  CleanupStagingJobPayload,
} from './listening-job-types';
import { ensureListeningInventory } from '../inventory/ensure-listening-inventory';

// ── Helper: get service client ────────────────────────────────────────────────

function client(): SupabaseClient {
  return getJobsServiceClient();
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new ListeningJobError(`MISSING_ENV_${name}`, `Environment variable ${name} is not set`, false);
  return val;
}

// ── Handler: GENERATE_LISTENING_STORY ─────────────────────────────────────────

const handleGenerateStory: ListeningJobHandlerFn = async ({ job }) => {
  const payload = job.payload as GenerateStoryJobPayload;
  const openaiKey = requireEnv('OPENAI_API_KEY');
  const callAI = createDefaultAICallFn(openaiKey);
  const supabase = client();

  const result = await generateListeningStory(
    { cefrLevel: payload.cefrLevel, theme: payload.theme, seed: payload.seed },
    callAI,
    supabase,
  );

  if (result.episodeId) {
    // Store episodeId in the job record so advance pipeline can use it
    await supabase
      .from('listening_jobs')
      .update({ episode_id: result.episodeId, updated_at: new Date().toISOString() })
      .eq('id', job.id);
  }

  return {
    episodeId:      result.episodeId,
    idempotencyKey: result.idempotencyKey,
    title:          result.story.title,
  };
};

// ── Handler: GENERATE_LISTENING_QUESTIONS ────────────────────────────────────

const handleGenerateQuestions: ListeningJobHandlerFn = async ({ job }) => {
  const payload = job.payload as GenerateQuestionsJobPayload;
  const openaiKey = requireEnv('OPENAI_API_KEY');
  const callAI = createQuestionAICallFn(openaiKey);
  const supabase = client();

  const result = await generateListeningQuestions(
    { episodeId: payload.episodeId },
    callAI,
    supabase,
  );

  return {
    episodeId:            payload.episodeId,
    questionsCount:       result.questions?.length ?? 0,
    generatorPromptVersion: result.generatorPromptVersion,
    validatorPromptVersion: result.validatorPromptVersion,
  };
};

// ── Handler: PREPARE_LISTENING_SUBTITLES ─────────────────────────────────────

const handlePrepareSubtitles: ListeningJobHandlerFn = async ({ job }) => {
  const payload = job.payload as PrepareSubtitlesJobPayload;
  const openaiKey = requireEnv('OPENAI_API_KEY');
  const callAI = createSubtitleAICallFn(openaiKey);
  const supabase = client();

  const result = await prepareListeningSubtitles(
    { episodeId: payload.episodeId },
    callAI,
    supabase,
  );

  return {
    episodeId:    payload.episodeId,
    enCueCount:   result.englishCueCount,
    ptBrCueCount: result.portugueseCueCount,
  };
};

// ── Handler: GENERATE_LISTENING_SSML ─────────────────────────────────────────

const handleGenerateSsml: ListeningJobHandlerFn = async ({ job }) => {
  const payload = job.payload as GenerateSsmlJobPayload;
  const supabase = client();

  const result = await generateListeningSsml(
    { episodeId: payload.episodeId },
    supabase,
  );

  return {
    episodeId:    payload.episodeId,
    blocksUpdated: result.blocks?.length ?? 0,
  };
};

// ── Handler: SYNTHESIZE_LISTENING_BLOCK_AUDIO ────────────────────────────────

const handleSynthesizeBlockAudio: ListeningJobHandlerFn = async ({ job, heartbeat }) => {
  const payload = job.payload as SynthesizeBlockAudioJobPayload;
  const supabase = client();
  const azureKey    = requireEnv('AZURE_SPEECH_KEY');
  const azureRegion = requireEnv('AZURE_SPEECH_REGION');

  // Heartbeat before the long Azure call
  await heartbeat();

  const result = await synthesizeListeningEpisode(
    { episodeId: payload.episodeId, blockFilter: payload.blockOrder },
    supabase,
    azureKey,
    azureRegion,
  );

  return {
    episodeId:   payload.episodeId,
    blockOrder:  payload.blockOrder,
    audioStatus: result.audioStatus,
    blocks:      result.blocks.map(b => ({
      blockOrder: b.blockOrder,
      durationMs: b.durationMs,
      audioHash:  b.audioHash,
    })),
  };
};

// ── Handler: SYNCHRONIZE_LISTENING_BLOCK ─────────────────────────────────────

const handleSynchronizeBlock: ListeningJobHandlerFn = async ({ job }) => {
  const payload = job.payload as SynchronizeBlockJobPayload;
  const supabase = client();

  const result = await synchronizeListeningEpisode(
    { episodeId: payload.episodeId, blockFilter: payload.blockOrder },
    supabase,
  );

  return {
    episodeId:    payload.episodeId,
    blockOrder:   payload.blockOrder,
    timingStatus: result.timingStatus,
    alignerVersion: result.alignerVersion,
  };
};

// ── Handler: VALIDATE_LISTENING_EPISODE ──────────────────────────────────────

const handleValidateEpisode: ListeningJobHandlerFn = async ({ job }) => {
  const payload = job.payload as ValidateEpisodeJobPayload;
  const supabase = client();

  const validation = await validateListeningEpisodeForPublication(payload.episodeId, supabase);

  if (!validation.valid) {
    const errorSummary = validation.errors.map(e => e.message).join('; ');
    throw new ListeningJobError(
      'EPISODE_VALIDATION_FAILED',
      `Episode validation failed: ${errorSummary}`,
      false, // non-retryable — content issue, not transient
    );
  }

  return {
    episodeId:  payload.episodeId,
    valid:      true,
    checksRun:  Object.keys(validation.checks).length,
    warnings:   validation.warnings.length,
  };
};

// ── Handler: PUBLISH_LISTENING_EPISODE ───────────────────────────────────────

const handlePublishEpisode: ListeningJobHandlerFn = async ({ job }) => {
  const payload = job.payload as PublishEpisodeJobPayload;

  const result = await publishListeningEpisode({
    episodeId:         payload.episodeId,
    publishedBy:       'system-job',
    publicationSource: 'system',
  });

  return {
    episodeId:          result.episodeId,
    publicationVersion: result.publicationVersion,
    publishedAt:        result.publishedAt,
  };
};

// ── Handler: AUDIT_LISTENING_STORAGE ─────────────────────────────────────────

const handleAuditStorage: ListeningJobHandlerFn = async ({ job }) => {
  const payload = job.payload as AuditStorageJobPayload;
  void payload; // episodeId not used in current implementation (global audit)

  const result = await auditListeningStorageConsistency();

  return {
    totalIssues:         result.summary.totalIssues,
    recordsWithoutFiles: result.summary.recordsWithoutFiles,
    filesWithoutRecords: result.summary.filesWithoutRecords,
    hashMismatches:      result.summary.hashMismatches,
    auditedAt:           result.auditedAt,
  };
};

// ── Handler: CLEANUP_LISTENING_STAGING ───────────────────────────────────────

const handleCleanupStaging: ListeningJobHandlerFn = async ({ job }) => {
  const payload = job.payload as CleanupStagingJobPayload;
  const supabase = client();

  if (payload.episodeId) {
    const result = await cleanupPublishedListeningStaging(payload.episodeId);
    return {
      episodeId:    payload.episodeId,
      removedPaths: result.removedPaths.length,
      errors:       result.errors.length,
    };
  }

  // Global cleanup: find all published episodes and clean their staging files
  const { data: episodes } = await supabase
    .from('listening_episodes')
    .select('id')
    .eq('status', 'published')
    .limit(20); // cap per run

  let totalRemoved = 0;
  const errorEpisodes: string[] = [];

  for (const ep of episodes ?? []) {
    try {
      const res = await cleanupPublishedListeningStaging(ep.id);
      totalRemoved += res.removedPaths.length;
    } catch {
      errorEpisodes.push(ep.id);
    }
  }

  return { episodesProcessed: episodes?.length ?? 0, totalRemoved, errorEpisodes };
};

// ── Handler: ENSURE_LISTENING_INVENTORY ──────────────────────────────────────

const handleEnsureInventory: ListeningJobHandlerFn = async () => {
  const supabase = client();
  const result = await ensureListeningInventory(supabase, { source: 'inventory_cron' });
  return { pipelinesCreated: result.created, levels: result.levels };
};

// ── Handler: AUDIT_LISTENING_INVENTORY ───────────────────────────────────────

const handleAuditInventory: ListeningJobHandlerFn = async () => {
  const { auditListeningInventory } = await import('../inventory/audit-listening-inventory');
  const supabase = client();
  const result = await auditListeningInventory(supabase);
  return { alertsCreated: result.alertsCreated, issues: result.issues };
};

// ── Handler: REPAIR_LISTENING_EPISODE ────────────────────────────────────────

const handleRepairEpisode: ListeningJobHandlerFn = async ({ job }) => {
  const { repairListeningPipeline } = await import('../pipeline/repair-listening-pipeline');
  const supabase = client();
  const payload = job.payload as { episodeId: string };
  const result = await repairListeningPipeline(supabase, payload.episodeId);
  return { episodeId: payload.episodeId, repaired: result.repaired, action: result.action };
};

// ── Handler map ───────────────────────────────────────────────────────────────

export const listeningJobHandlers: Record<ListeningJobType, ListeningJobHandlerFn> = {
  [LISTENING_JOB_TYPES.GENERATE_LISTENING_STORY]:         handleGenerateStory,
  [LISTENING_JOB_TYPES.GENERATE_LISTENING_QUESTIONS]:     handleGenerateQuestions,
  [LISTENING_JOB_TYPES.PREPARE_LISTENING_SUBTITLES]:      handlePrepareSubtitles,
  [LISTENING_JOB_TYPES.GENERATE_LISTENING_SSML]:          handleGenerateSsml,
  [LISTENING_JOB_TYPES.SYNTHESIZE_LISTENING_BLOCK_AUDIO]: handleSynthesizeBlockAudio,
  [LISTENING_JOB_TYPES.SYNCHRONIZE_LISTENING_BLOCK]:      handleSynchronizeBlock,
  [LISTENING_JOB_TYPES.VALIDATE_LISTENING_EPISODE]:       handleValidateEpisode,
  [LISTENING_JOB_TYPES.PUBLISH_LISTENING_EPISODE]:        handlePublishEpisode,
  [LISTENING_JOB_TYPES.ENSURE_LISTENING_INVENTORY]:       handleEnsureInventory,
  [LISTENING_JOB_TYPES.AUDIT_LISTENING_INVENTORY]:        handleAuditInventory,
  [LISTENING_JOB_TYPES.AUDIT_LISTENING_STORAGE]:          handleAuditStorage,
  [LISTENING_JOB_TYPES.CLEANUP_LISTENING_STAGING]:        handleCleanupStaging,
  [LISTENING_JOB_TYPES.REPAIR_LISTENING_EPISODE]:         handleRepairEpisode,
};
