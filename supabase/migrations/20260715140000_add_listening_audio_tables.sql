-- Migration: Etapa 6 — Audio synthesis tables and status fields
-- Adds audio asset tracking, bookmark/word timings, and Storage bucket.

-- ── listening_episodes: audio status ─────────────────────────────────────────

ALTER TABLE listening_episodes
  ADD COLUMN IF NOT EXISTS audio_status TEXT
    CHECK (audio_status IN ('pending', 'processing', 'ready', 'failed'));

-- ── listening_blocks: audio status + asset reference ─────────────────────────

ALTER TABLE listening_blocks
  ADD COLUMN IF NOT EXISTS audio_status TEXT
    CHECK (audio_status IN ('pending', 'processing', 'uploaded', 'validated', 'failed')),
  ADD COLUMN IF NOT EXISTS audio_asset_id UUID;

-- ── listening_audio_assets ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS listening_audio_assets (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id                 UUID        NOT NULL REFERENCES listening_episodes(id),
  block_id                   UUID        NOT NULL REFERENCES listening_blocks(id),
  block_order                SMALLINT    NOT NULL CHECK (block_order IN (1, 2)),
  audio_path                 TEXT,
  audio_format               TEXT        NOT NULL,
  content_type               TEXT        NOT NULL,
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
                               CHECK (status IN ('pending', 'processing', 'uploaded', 'validated', 'failed')),
  raw_synthesis_events_json  JSONB,
  error_code                 TEXT,
  error_message              TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (block_id, ssml_hash, synthesis_config_version)
);

-- status = validated requires all key fields populated
ALTER TABLE listening_audio_assets
  DROP CONSTRAINT IF EXISTS chk_laa_validated;

ALTER TABLE listening_audio_assets
  ADD CONSTRAINT chk_laa_validated CHECK (
    status IS DISTINCT FROM 'validated'
    OR (
      audio_path       IS NOT NULL AND
      file_size_bytes  IS NOT NULL AND
      duration_ms      IS NOT NULL AND
      audio_hash       IS NOT NULL
    )
  );

CREATE INDEX IF NOT EXISTS idx_laa_block
  ON listening_audio_assets (block_id, status);

CREATE INDEX IF NOT EXISTS idx_laa_episode
  ON listening_audio_assets (episode_id, status);

CREATE INDEX IF NOT EXISTS idx_laa_ssml_hash
  ON listening_audio_assets (ssml_hash);

-- ── listening_bookmark_timings ────────────────────────────────────────────────

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

CREATE INDEX IF NOT EXISTS idx_lbt_asset_order
  ON listening_bookmark_timings (audio_asset_id, event_order);

-- ── listening_word_timings ────────────────────────────────────────────────────

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

CREATE INDEX IF NOT EXISTS idx_lwt_asset_order
  ON listening_word_timings (audio_asset_id, word_order);

-- ── Supabase Storage bucket: listening-audio (private) ────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'listening-audio',
  'listening-audio',
  false,
  104857600,  -- 100 MB per file limit
  ARRAY['audio/mpeg', 'audio/mp3']
)
ON CONFLICT (id) DO NOTHING;

-- Only service role may read/write listening audio
-- (authenticated users have no direct access in staging)
CREATE POLICY IF NOT EXISTS "service_role_all_listening_audio"
  ON storage.objects FOR ALL TO service_role
  USING (bucket_id = 'listening-audio')
  WITH CHECK (bucket_id = 'listening-audio');

-- Explicitly deny authenticated users
CREATE POLICY IF NOT EXISTS "deny_authed_listening_audio"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id != 'listening-audio');
