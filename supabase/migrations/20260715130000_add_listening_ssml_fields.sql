-- Migration: Etapa 5 — SSML fields for listening blocks and episodes
-- Adds SSML generation state, versioning, and content hash tracking.
-- Does NOT generate audio. These fields support the SSML preparation step only.

-- ── listening_blocks additions ────────────────────────────────────────────────

ALTER TABLE listening_blocks
  ADD COLUMN IF NOT EXISTS ssml_status TEXT
    CHECK (ssml_status IN ('pending', 'processing', 'ready', 'failed')),
  ADD COLUMN IF NOT EXISTS ssml_version INTEGER,
  ADD COLUMN IF NOT EXISTS ssml_generator_version TEXT,
  ADD COLUMN IF NOT EXISTS ssml_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ssml_content_hash TEXT;

-- SSML content must be present when status is 'ready'
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

CREATE INDEX IF NOT EXISTS idx_lb_ssml_status
  ON listening_blocks (episode_id, ssml_status);

-- ── listening_episodes additions ──────────────────────────────────────────────

ALTER TABLE listening_episodes
  ADD COLUMN IF NOT EXISTS ssml_status TEXT
    CHECK (ssml_status IN ('pending', 'processing', 'ready', 'failed')),
  ADD COLUMN IF NOT EXISTS ssml_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ssml_generator_version TEXT,
  ADD COLUMN IF NOT EXISTS locale TEXT;

-- voice_name already exists from the base migration (20260715080000)
