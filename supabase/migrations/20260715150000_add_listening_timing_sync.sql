-- Etapa 7: subtitle timing synchronization tables and columns

-- ─── 1. Extend listening_subtitle_cues ──────────────────────────────────────

ALTER TABLE listening_subtitle_cues
  ADD COLUMN IF NOT EXISTS timing_source       TEXT CHECK (timing_source IN ('word_boundaries','sentence_bookmarks','hybrid','fallback')),
  ADD COLUMN IF NOT EXISTS timing_confidence   NUMERIC(4,3) CHECK (timing_confidence >= 0 AND timing_confidence <= 1),
  ADD COLUMN IF NOT EXISTS audio_asset_id      UUID REFERENCES listening_audio_assets(id),
  ADD COLUMN IF NOT EXISTS ssml_hash           TEXT,
  ADD COLUMN IF NOT EXISTS audio_hash          TEXT,
  ADD COLUMN IF NOT EXISTS timed_at            TIMESTAMPTZ;

-- Widen status CHECK to include needs_review and timing_processing
ALTER TABLE listening_subtitle_cues
  DROP CONSTRAINT IF EXISTS listening_subtitle_cues_status_check,
  DROP CONSTRAINT IF EXISTS lsc_status_check;

ALTER TABLE listening_subtitle_cues
  ADD CONSTRAINT lsc_status_check CHECK (
    status IN ('text_ready','timing_pending','timing_processing','timed','needs_review','failed')
  );

-- timed status requires both timing columns and the asset link
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

-- ─── 2. Extend listening_blocks with timing state ────────────────────────────

ALTER TABLE listening_blocks
  ADD COLUMN IF NOT EXISTS timing_status         TEXT CHECK (timing_status IN ('pending','processing','ready','needs_review','failed')),
  ADD COLUMN IF NOT EXISTS timing_generated_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS timing_version        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS timing_config_version TEXT;

-- ─── 3. Extend listening_episodes with timing state ─────────────────────────

ALTER TABLE listening_episodes
  ADD COLUMN IF NOT EXISTS timing_status         TEXT CHECK (timing_status IN ('pending','processing','ready','needs_review','failed')),
  ADD COLUMN IF NOT EXISTS timing_generated_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS timing_version        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS timing_config_version TEXT;

-- ─── 4. Extend listening_audio_assets with timing result ────────────────────

ALTER TABLE listening_audio_assets
  ADD COLUMN IF NOT EXISTS timing_hash           TEXT,
  ADD COLUMN IF NOT EXISTS timing_manifest_json  JSONB;

-- ─── 5. New table: listening_sentence_timings ────────────────────────────────

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

CREATE POLICY "service_role_all_lst" ON listening_sentence_timings
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "deny_authenticated_lst" ON listening_sentence_timings
  FOR ALL TO authenticated USING (false);
