import type { SupabaseClient } from '@supabase/supabase-js';
import type { CEFRLevel } from '../../../domain/curriculum/cefr';
import type { ListeningPipelineSource } from '../jobs/listening-job-types';
import { LISTENING_JOB_TYPES } from '../jobs/listening-job-types';
import { JOB_PRIORITY } from '../jobs/listening-job-config';
import { enqueueListeningJob } from '../jobs/enqueue-listening-job';

export type EnqueueListeningEpisodePipelineInput = {
  cefrLevel:           CEFRLevel;
  theme?:              string | null;
  seed?:               string | null;
  priority?:           number;
  source:              ListeningPipelineSource;
  requiredVocabulary?: string[];
};

export type EnqueueListeningEpisodePipelineResult = {
  jobId:          string;
  created:        boolean;
  idempotencyKey: string;
};

// Bump this version to allow re-generation for the same (level, seed, theme) combination
const PIPELINE_VERSION = 'v1';

export async function enqueueListeningEpisodePipeline(
  supabase: SupabaseClient,
  input: EnqueueListeningEpisodePipelineInput,
): Promise<EnqueueListeningEpisodePipelineResult> {
  const { cefrLevel, theme, seed, priority, source, requiredVocabulary } = input;

  // Use current date as seed when not provided — creates one pipeline per day per level/theme
  const dateSeed = seed ?? new Date().toISOString().slice(0, 10);
  const safeTheme = theme
    ? `:${theme.slice(0, 40).replace(/[^a-zA-Z0-9]/g, '_')}`
    : '';

  const idempotencyKey = [
    LISTENING_JOB_TYPES.GENERATE_LISTENING_STORY,
    cefrLevel,
    dateSeed,
    safeTheme,
    PIPELINE_VERSION,
  ].filter(Boolean).join(':');

  const result = await enqueueListeningJob(supabase, {
    jobType:        LISTENING_JOB_TYPES.GENERATE_LISTENING_STORY,
    idempotencyKey,
    payload: {
      jobType:             LISTENING_JOB_TYPES.GENERATE_LISTENING_STORY,
      cefrLevel,
      theme:               theme ?? null,
      seed:                dateSeed,
      source,
      requiredVocabulary:  requiredVocabulary ?? [],
    },
    cefrLevel,
    priority: priority ?? JOB_PRIORITY.NORMAL,
  });

  console.error(JSON.stringify({
    event:          'listening_pipeline_started',
    cefrLevel,
    theme:          theme ?? null,
    seed:           dateSeed,
    source,
    idempotencyKey,
    jobId:          result.jobId,
    created:        result.created,
    t: Date.now(),
  }));

  return { ...result, idempotencyKey };
}
