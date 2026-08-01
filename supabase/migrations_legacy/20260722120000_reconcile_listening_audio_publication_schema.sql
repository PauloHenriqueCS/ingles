-- Reconciles Listening schema drift on the remote "ingles" project.
--
-- Several early local migrations (20260714160000, 20260715110000 x2,
-- 20260715120000, 20260715130000, 20260715140000, 20260715150000) were
-- never applied here, and one of them
-- (20260715110000_add_listening_publication_pipeline.sql) defines
-- listening_audio_assets and a Storage bucket that CONFLICT with what the
-- actual synthesis/timing code (src/services/listening/audio,
-- src/services/listening/timing) writes — different columns, different
-- status vocabulary, different bucket name ('lemon-listening' vs the real
-- 'listening-audio'). Applying both verbatim would leave
-- publishListeningEpisode permanently broken for every episode, in both the
-- on-demand and shared level-group pipelines (this is why all 8 existing
-- episodes are stuck in 'content_ready' with no questions/audio).
--
-- Instead of replaying those files, this migration is composed directly
-- from what the current application code actually reads and writes
-- (verified by grepping every .from('listening_audio_assets' | ...) call
-- site), reconciling the one genuine conflict:
--   - listening_audio_assets uses the synthesis module's real shape
--     (audio_path, status IN (...,'validated',...)), extended with one new
--     'published_path' column and one new 'published' status value so the
--     publication module (rewritten in this same change) can record the
--     canonical copy without inventing a second, incompatible table.
--   - listening_timing_artifacts (a table nothing outside the old
--     publication-module code ever wrote to) is NOT created; the
--     publication validator now reads the timing signal the real timing
--     pipeline actually writes (listening_audio_assets.timing_hash).
--   - The Storage bucket created here is 'listening-audio' (matching
--     AUDIO_STORAGE_BUCKET in listening-audio-config.ts), not
--     'lemon-listening'. listening-publication-config.ts's LISTENING_BUCKET
--     constant is corrected to match in this same change.
--
-- This migration does not modify or remove any existing data.

-- ─── learner_skill_profiles (from 20260714160000, verbatim/idempotent) ────────

DO $$ BEGIN
  CREATE TYPE public.learning_skill AS ENUM (
    'writing', 'pronunciation', 'conversation', 'listening'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.skill_assessment_status AS ENUM (
    'unknown', 'provisional', 'calibrating', 'confirmed', 'stale'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.skill_level_source AS ENUM (
    'diagnostic', 'ongoing_calibration', 'checkpoint',
    'manual_admin', 'legacy_migration', 'system_default'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.learner_skill_profiles (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  skill             public.learning_skill NOT NULL,
  cefr_level        TEXT        CHECK (cefr_level IN ('A1','A2','B1','B2','C1','C2')),
  assessment_status public.skill_assessment_status NOT NULL DEFAULT 'unknown',
  source            public.skill_level_source     NOT NULL DEFAULT 'system_default',
  confidence        NUMERIC(4,3) NOT NULL DEFAULT 0
                    CHECK (confidence >= 0 AND confidence <= 1),
  evidence_count    INTEGER      NOT NULL DEFAULT 0
                    CHECK (evidence_count >= 0),
  catalog_version   INTEGER      NOT NULL DEFAULT 1
                    CHECK (catalog_version > 0),
  assessed_at       TIMESTAMPTZ,
  calibrated_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_learner_skill_profiles_user_skill UNIQUE (user_id, skill)
);

ALTER TABLE public.learner_skill_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lsp_select" ON public.learner_skill_profiles;
CREATE POLICY "lsp_select" ON public.learner_skill_profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_lsp_user_id ON public.learner_skill_profiles (user_id);
CREATE INDEX IF NOT EXISTS idx_lsp_user_skill ON public.learner_skill_profiles (user_id, skill);

-- ─── listening_questions enrichment (Etapa 3) ──────────────────────────────────

ALTER TABLE listening_questions
  ADD COLUMN IF NOT EXISTS question_type TEXT
    CHECK (
      question_type IS NULL OR
      question_type IN ('main_idea','detail','cause','sequence','intention','simple_inference')
    ),
  ADD COLUMN IF NOT EXISTS difficulty TEXT
    CHECK (difficulty IS NULL OR difficulty IN ('easy','appropriate','hard')),
  ADD COLUMN IF NOT EXISTS evidence_sentence_keys JSONB
    CHECK (
      evidence_sentence_keys IS NULL OR (
        jsonb_typeof(evidence_sentence_keys) = 'array' AND
        jsonb_array_length(evidence_sentence_keys) >= 1
      )
    ),
  ADD COLUMN IF NOT EXISTS validation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (validation_status IN ('pending','valid','invalid','needs_review')),
  ADD COLUMN IF NOT EXISTS validation_notes JSONB,
  ADD COLUMN IF NOT EXISTS generator_prompt_version TEXT,
  ADD COLUMN IF NOT EXISTS validator_prompt_version TEXT;

CREATE INDEX IF NOT EXISTS idx_lq_episode_validation
  ON listening_questions (episode_id, validation_status, generator_prompt_version)
  WHERE validation_status IS NOT NULL;

ALTER TABLE listening_episodes
  ADD COLUMN IF NOT EXISTS questions_status TEXT
    CHECK (questions_status IS NULL OR questions_status IN ('pending','processing','ready','failed')),
  ADD COLUMN IF NOT EXISTS questions_generated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_le_questions_status
  ON listening_episodes (questions_status)
  WHERE questions_status IS NOT NULL;

-- ─── listening_blocks SSML fields (Etapa 5) ────────────────────────────────────

ALTER TABLE listening_blocks
  ADD COLUMN IF NOT EXISTS ssml_status TEXT
    CHECK (ssml_status IN ('pending', 'processing', 'ready', 'failed')),
  ADD COLUMN IF NOT EXISTS ssml_version INTEGER,
  ADD COLUMN IF NOT EXISTS ssml_generator_version TEXT,
  ADD COLUMN IF NOT EXISTS ssml_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ssml_content_hash TEXT;

ALTER TABLE listening_blocks
  DROP CONSTRAINT IF EXISTS chk_lb_ssml_ready;
ALTER TABLE listening_blocks
  ADD CONSTRAINT chk_lb_ssml_ready CHECK (
    ssml_status IS DISTINCT FROM 'ready'
    OR (
      ssml IS NOT NULL
      AND ssml_content_hash IS NOT NULL
      AND ssml_generated_at IS NOT NULL
      AND ssml_version IS NOT NULL
    )
  );

CREATE INDEX IF NOT EXISTS idx_lb_ssml_status ON listening_blocks (episode_id, ssml_status);

ALTER TABLE listening_episodes
  ADD COLUMN IF NOT EXISTS ssml_status TEXT
    CHECK (ssml_status IN ('pending', 'processing', 'ready', 'failed')),
  ADD COLUMN IF NOT EXISTS ssml_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ssml_generator_version TEXT,
  ADD COLUMN IF NOT EXISTS locale TEXT;

-- ─── audio status columns (Etapa 6) ────────────────────────────────────────────

ALTER TABLE listening_episodes
  ADD COLUMN IF NOT EXISTS audio_status TEXT
    CHECK (audio_status IN ('pending', 'processing', 'ready', 'failed'));

ALTER TABLE listening_blocks
  ADD COLUMN IF NOT EXISTS audio_status TEXT
    CHECK (audio_status IN ('pending', 'processing', 'uploaded', 'validated', 'failed')),
  ADD COLUMN IF NOT EXISTS audio_asset_id UUID;

-- ─── listening_audio_assets ─────────────────────────────────────────────────────
-- Real shape, matching src/services/listening/audio/persist-listening-audio.ts.
-- 'published' + published_path are the one addition on top of that module's
-- own shape, added here so the publication module (rewritten alongside this
-- migration) can record the canonical Storage copy on the SAME row instead
-- of a second, incompatible table.

CREATE TABLE IF NOT EXISTS listening_audio_assets (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id                 UUID        NOT NULL REFERENCES listening_episodes(id),
  block_id                   UUID        NOT NULL REFERENCES listening_blocks(id),
  block_order                SMALLINT    NOT NULL CHECK (block_order IN (1, 2)),
  audio_path                 TEXT,
  published_path             TEXT,
  audio_format                TEXT        NOT NULL,
  content_type                TEXT        NOT NULL,
  file_size_bytes            BIGINT,
  duration_ms                INTEGER,
  voice_name                 TEXT        NOT NULL,
  locale                     TEXT        NOT NULL,
  ssml_hash                  TEXT        NOT NULL,
  audio_hash                 TEXT,
  word_timing_status         TEXT        CHECK (word_timing_status IN ('complete', 'partial', 'missing', 'invalid')),
  duration_status            TEXT        CHECK (duration_status IN ('valid', 'needs_review', 'invalid')),
  synthesis_config_version   TEXT        NOT NULL,
  status                     TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'processing', 'uploaded', 'validated', 'published', 'failed')),
  raw_synthesis_events_json  JSONB,
  error_code                 TEXT,
  error_message              TEXT,
  timing_hash                TEXT,
  timing_manifest_json       JSONB,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (block_id, ssml_hash, synthesis_config_version)
);

ALTER TABLE listening_audio_assets
  DROP CONSTRAINT IF EXISTS chk_laa_validated;
ALTER TABLE listening_audio_assets
  ADD CONSTRAINT chk_laa_validated CHECK (
    status NOT IN ('validated', 'published')
    OR (
      audio_path       IS NOT NULL AND
      file_size_bytes  IS NOT NULL AND
      duration_ms      IS NOT NULL AND
      audio_hash       IS NOT NULL
    )
  );

CREATE INDEX IF NOT EXISTS idx_laa_block ON listening_audio_assets (block_id, status);
CREATE INDEX IF NOT EXISTS idx_laa_episode ON listening_audio_assets (episode_id, status);
CREATE INDEX IF NOT EXISTS idx_laa_ssml_hash ON listening_audio_assets (ssml_hash);

ALTER TABLE listening_audio_assets ENABLE ROW LEVEL SECURITY;
-- No policies: service role only (same access model as listening_jobs).

-- ─── listening_subtitle_cues enrichment (Etapa 4 + Etapa 7, merged) ────────────

ALTER TABLE listening_subtitle_cues
  ALTER COLUMN start_ms DROP NOT NULL,
  ALTER COLUMN end_ms   DROP NOT NULL;

ALTER TABLE listening_subtitle_cues
  DROP CONSTRAINT IF EXISTS chk_lsc_end_after_start;
ALTER TABLE listening_subtitle_cues
  DROP CONSTRAINT IF EXISTS chk_lsc_timing;
ALTER TABLE listening_subtitle_cues
  ADD CONSTRAINT chk_lsc_timing CHECK (
    (start_ms IS NULL AND end_ms IS NULL)
    OR
    (start_ms IS NOT NULL AND end_ms IS NOT NULL AND start_ms >= 0 AND end_ms > start_ms)
  );

ALTER TABLE listening_subtitle_cues
  ADD COLUMN IF NOT EXISTS cue_key TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.listening_subtitle_cues'::regclass
      AND conname = 'uq_lsc_block_lang_cue_key'
  ) THEN
    ALTER TABLE listening_subtitle_cues
      ADD CONSTRAINT uq_lsc_block_lang_cue_key UNIQUE (block_id, language, cue_key);
  END IF;
END $$;

ALTER TABLE listening_subtitle_cues
  ADD COLUMN IF NOT EXISTS source_sentence_keys JSONB;

ALTER TABLE listening_subtitle_cues
  DROP CONSTRAINT IF EXISTS chk_lsc_source_keys_array;
ALTER TABLE listening_subtitle_cues
  ADD CONSTRAINT chk_lsc_source_keys_array CHECK (
    source_sentence_keys IS NULL
    OR (jsonb_typeof(source_sentence_keys) = 'array'
        AND jsonb_array_length(source_sentence_keys) >= 1)
  );

ALTER TABLE listening_subtitle_cues
  ADD COLUMN IF NOT EXISTS content_version INTEGER DEFAULT 1
    CHECK (content_version IS NULL OR content_version >= 1);

ALTER TABLE listening_subtitle_cues
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

ALTER TABLE listening_subtitle_cues
  ADD COLUMN IF NOT EXISTS timing_source       TEXT CHECK (timing_source IN ('word_boundaries','sentence_bookmarks','hybrid','fallback')),
  ADD COLUMN IF NOT EXISTS timing_confidence   NUMERIC(4,3) CHECK (timing_confidence >= 0 AND timing_confidence <= 1),
  ADD COLUMN IF NOT EXISTS audio_asset_id      UUID REFERENCES listening_audio_assets(id),
  ADD COLUMN IF NOT EXISTS ssml_hash           TEXT,
  ADD COLUMN IF NOT EXISTS audio_hash          TEXT,
  ADD COLUMN IF NOT EXISTS timed_at            TIMESTAMPTZ;

-- Final widened status set (supersedes the Etapa-4-only version): includes
-- timing_processing/needs_review from Etapa 7.
ALTER TABLE listening_subtitle_cues
  DROP CONSTRAINT IF EXISTS listening_subtitle_cues_status_check,
  DROP CONSTRAINT IF EXISTS lsc_status_check;
ALTER TABLE listening_subtitle_cues
  ADD CONSTRAINT lsc_status_check CHECK (
    status IN ('text_ready','timing_pending','timing_processing','timed','needs_review','failed')
  );

ALTER TABLE listening_subtitle_cues
  ALTER COLUMN status SET DEFAULT 'timing_pending';

ALTER TABLE listening_subtitle_cues
  DROP CONSTRAINT IF EXISTS chk_lsc_timed_fields;
ALTER TABLE listening_subtitle_cues
  ADD CONSTRAINT chk_lsc_timed_fields CHECK (
    status != 'timed' OR (
      start_ms IS NOT NULL AND end_ms IS NOT NULL
      AND audio_asset_id IS NOT NULL AND timing_source IS NOT NULL
    )
  );

CREATE INDEX IF NOT EXISTS idx_lsc_audio_asset ON listening_subtitle_cues (audio_asset_id);
CREATE INDEX IF NOT EXISTS idx_lsc_block_lang_status ON listening_subtitle_cues (block_id, language, status);

ALTER TABLE listening_episodes
  ADD COLUMN IF NOT EXISTS subtitles_status TEXT
    CHECK (subtitles_status IN ('pending', 'processing', 'ready', 'failed')),
  ADD COLUMN IF NOT EXISTS subtitles_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS subtitle_prompt_version TEXT,
  ADD COLUMN IF NOT EXISTS subtitle_validator_prompt_version TEXT;

CREATE INDEX IF NOT EXISTS idx_le_subtitles_status ON listening_episodes (subtitles_status);

-- ─── listening_bookmark_timings / listening_word_timings (Etapa 6) ────────────

CREATE TABLE IF NOT EXISTS listening_bookmark_timings (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  audio_asset_id   UUID        NOT NULL REFERENCES listening_audio_assets(id) ON DELETE CASCADE,
  bookmark_name    TEXT        NOT NULL,
  event_order      INTEGER     NOT NULL,
  offset_ms        INTEGER     NOT NULL CHECK (offset_ms >= 0),
  raw_offset_ticks BIGINT      NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (audio_asset_id, bookmark_name)
);

CREATE INDEX IF NOT EXISTS idx_lbt_asset_order ON listening_bookmark_timings (audio_asset_id, event_order);

CREATE TABLE IF NOT EXISTS listening_word_timings (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  audio_asset_id     UUID        NOT NULL REFERENCES listening_audio_assets(id) ON DELETE CASCADE,
  word_order         INTEGER     NOT NULL CHECK (word_order > 0),
  text               TEXT        NOT NULL,
  start_ms           INTEGER     NOT NULL CHECK (start_ms >= 0),
  duration_ms        INTEGER     CHECK (duration_ms >= 0),
  end_ms             INTEGER     CHECK (end_ms >= 0),
  text_offset        INTEGER,
  word_length        INTEGER,
  boundary_type      TEXT,
  raw_offset_ticks   BIGINT,
  raw_duration_ticks BIGINT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (audio_asset_id, word_order)
);

CREATE INDEX IF NOT EXISTS idx_lwt_asset_order ON listening_word_timings (audio_asset_id, word_order);

-- ─── Storage bucket: listening-audio (private) ─────────────────────────────────
-- Real bucket name (matches AUDIO_STORAGE_BUCKET in listening-audio-config.ts
-- and, after this same change, LISTENING_BUCKET in
-- listening-publication-config.ts). NOT 'lemon-listening' — that name was
-- only ever referenced by the now-corrected publication module, never
-- actually used by synthesis, so no bucket or files exist under it.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'listening-audio',
  'listening-audio',
  false,
  104857600,  -- 100 MB per file limit
  ARRAY['audio/mpeg', 'audio/mp3']
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "service_role_all_listening_audio" ON storage.objects;
CREATE POLICY "service_role_all_listening_audio"
  ON storage.objects FOR ALL TO service_role
  USING (bucket_id = 'listening-audio')
  WITH CHECK (bucket_id = 'listening-audio');

DROP POLICY IF EXISTS "deny_authed_listening_audio" ON storage.objects;
CREATE POLICY "deny_authed_listening_audio"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id != 'listening-audio');

-- ─── timing status columns (Etapa 7) ───────────────────────────────────────────

ALTER TABLE listening_blocks
  ADD COLUMN IF NOT EXISTS timing_status         TEXT CHECK (timing_status IN ('pending','processing','ready','needs_review','failed')),
  ADD COLUMN IF NOT EXISTS timing_generated_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS timing_version        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS timing_config_version TEXT;

ALTER TABLE listening_episodes
  ADD COLUMN IF NOT EXISTS timing_status         TEXT CHECK (timing_status IN ('pending','processing','ready','needs_review','failed')),
  ADD COLUMN IF NOT EXISTS timing_generated_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS timing_version        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS timing_config_version TEXT;

CREATE TABLE IF NOT EXISTS listening_sentence_timings (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  audio_asset_id      UUID         NOT NULL REFERENCES listening_audio_assets(id) ON DELETE CASCADE,
  block_id            UUID         NOT NULL REFERENCES listening_blocks(id) ON DELETE CASCADE,
  sentence_key        TEXT         NOT NULL,
  sentence_order      INTEGER      NOT NULL CHECK (sentence_order >= 1),
  start_ms            INTEGER      NOT NULL CHECK (start_ms >= 0),
  spoken_end_ms       INTEGER      NOT NULL,
  interval_end_ms     INTEGER      NOT NULL,
  timing_confidence   NUMERIC(4,3) NOT NULL DEFAULT 1.0
                        CHECK (timing_confidence >= 0 AND timing_confidence <= 1),
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (audio_asset_id, sentence_key),
  CONSTRAINT chk_lst_end_order CHECK (
    spoken_end_ms >= start_ms AND interval_end_ms >= spoken_end_ms
  )
);

CREATE INDEX IF NOT EXISTS idx_lst_asset ON listening_sentence_timings (audio_asset_id);
CREATE INDEX IF NOT EXISTS idx_lst_block ON listening_sentence_timings (block_id, sentence_order);

ALTER TABLE listening_sentence_timings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all_lst" ON listening_sentence_timings;
CREATE POLICY "service_role_all_lst" ON listening_sentence_timings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "deny_authenticated_lst" ON listening_sentence_timings;
CREATE POLICY "deny_authenticated_lst" ON listening_sentence_timings
  FOR ALL TO authenticated USING (false);

-- ─── publication fields (Etapa 8, minus the conflicting audio table/bucket) ────

ALTER TYPE listening_episode_status ADD VALUE IF NOT EXISTS 'publishing' AFTER 'ready';

ALTER TABLE listening_episodes
  ADD COLUMN IF NOT EXISTS publication_version  INTEGER NOT NULL DEFAULT 0 CHECK (publication_version >= 0),
  ADD COLUMN IF NOT EXISTS published_by         UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS publication_source   TEXT CHECK (publication_source IN ('admin', 'system', 'script')),
  ADD COLUMN IF NOT EXISTS access_tier          TEXT NOT NULL DEFAULT 'free'
    CHECK (access_tier IN ('free', 'premium', 'all'));

CREATE TABLE IF NOT EXISTS listening_publication_log (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id           UUID NOT NULL REFERENCES listening_episodes(id) ON DELETE CASCADE,
  event                TEXT NOT NULL,
  publication_version  INTEGER,
  published_by         UUID REFERENCES auth.users(id),
  publication_source   TEXT,
  details              JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lpl_episode ON listening_publication_log (episode_id, created_at);

ALTER TABLE listening_publication_log ENABLE ROW LEVEL SECURITY;
-- No policies: service role only.
