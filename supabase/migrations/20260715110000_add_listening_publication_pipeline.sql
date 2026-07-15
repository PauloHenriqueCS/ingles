-- Listening Publication Pipeline (Etapa 8)
-- Adiciona tabelas de áudio, timing, log de publicação e campos de publicação.
-- Bucket privado lemon-listening criado aqui; nenhuma URL pública.

-- ── Bucket privado ────────────────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'lemon-listening',
  'lemon-listening',
  false,
  52428800,   -- 50 MB por arquivo
  ARRAY['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav']
)
ON CONFLICT (id) DO NOTHING;

-- Service role acessa tudo; usuários autenticados não têm acesso direto.
CREATE POLICY "Service role full access"
  ON storage.objects FOR ALL TO service_role
  USING (bucket_id = 'lemon-listening')
  WITH CHECK (bucket_id = 'lemon-listening');

-- ── Adicionar 'publishing' ao enum de status do episódio ─────────────────────

ALTER TYPE listening_episode_status ADD VALUE IF NOT EXISTS 'publishing' AFTER 'ready';

-- ── Campos de publicação em listening_episodes ────────────────────────────────

ALTER TABLE listening_episodes
  ADD COLUMN IF NOT EXISTS publication_version  INTEGER NOT NULL DEFAULT 0 CHECK (publication_version >= 0),
  ADD COLUMN IF NOT EXISTS published_by         UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS publication_source   TEXT CHECK (publication_source IN ('admin', 'system', 'script')),
  ADD COLUMN IF NOT EXISTS access_tier          TEXT NOT NULL DEFAULT 'free'
    CHECK (access_tier IN ('free', 'premium', 'all'));

-- ── Campos de hash em listening_blocks ───────────────────────────────────────

ALTER TABLE listening_blocks
  ADD COLUMN IF NOT EXISTS ssml_content_hash TEXT;

-- ── Validation status em listening_questions ──────────────────────────────────

ALTER TABLE listening_questions
  ADD COLUMN IF NOT EXISTS validation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (validation_status IN ('pending', 'valid', 'invalid', 'needs_review'));

-- ── listening_audio_assets ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS listening_audio_assets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id        UUID NOT NULL REFERENCES listening_episodes(id) ON DELETE CASCADE,
  block_id          UUID NOT NULL REFERENCES listening_blocks(id) ON DELETE CASCADE,
  ssml_hash         TEXT NOT NULL,
  audio_hash        TEXT NOT NULL,
  staging_path      TEXT,
  published_path    TEXT,
  file_size_bytes   BIGINT CHECK (file_size_bytes IS NULL OR file_size_bytes > 0),
  duration_ms       INTEGER CHECK (duration_ms IS NULL OR duration_ms > 0),
  content_type      TEXT NOT NULL DEFAULT 'audio/mpeg',
  status            TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'ready', 'published', 'failed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (block_id)
);

CREATE INDEX IF NOT EXISTS idx_laa_episode ON listening_audio_assets (episode_id);

ALTER TABLE listening_audio_assets ENABLE ROW LEVEL SECURITY;
-- Nenhuma SELECT policy: acessado somente via service role.

-- ── listening_timing_artifacts ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS listening_timing_artifacts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audio_asset_id  UUID NOT NULL REFERENCES listening_audio_assets(id) ON DELETE CASCADE,
  block_id        UUID NOT NULL REFERENCES listening_blocks(id) ON DELETE CASCADE,
  ssml_hash       TEXT NOT NULL,
  audio_hash      TEXT NOT NULL,
  timing_hash     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (audio_asset_id)
);

CREATE INDEX IF NOT EXISTS idx_lta_block ON listening_timing_artifacts (block_id);

ALTER TABLE listening_timing_artifacts ENABLE ROW LEVEL SECURITY;
-- Nenhuma SELECT policy: acessado somente via service role.

-- ── listening_publication_log ─────────────────────────────────────────────────

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
-- Nenhuma SELECT policy: acessado somente via service role.
