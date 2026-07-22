-- Shared Listening level-group generation.
--
-- Adds a centralized `level_group` mapping to listening_episodes (mirrors the
-- application-level mapping in src/services/listening/listening-level-group.ts:
-- A1+A2 -> A1_A2, B1+B2 -> B1_B2, C1+C2 -> C1_C2) and a new
-- listening_generation_jobs table that is the database-backed concurrency
-- lock for the shared on-demand generation pipeline: at most one active
-- OpenAI/Azure pipeline may run per level_group at a time.
--
-- This migration does not modify or remove any existing data.

-- ─── listening_episodes.level_group ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION listening_level_group_for_cefr(p_cefr_level TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_cefr_level IN ('A1', 'A2') THEN 'A1_A2'
    WHEN p_cefr_level IN ('B1', 'B2') THEN 'B1_B2'
    WHEN p_cefr_level IN ('C1', 'C2') THEN 'C1_C2'
    ELSE NULL
  END;
$$;

COMMENT ON FUNCTION listening_level_group_for_cefr IS
  'Centralized CEFR level -> shared listening level_group mapping. Keep in sync with LEVEL_GROUP_MEMBERS in src/services/listening/listening-level-group.ts.';

ALTER TABLE listening_episodes
  ADD COLUMN IF NOT EXISTS level_group TEXT
    GENERATED ALWAYS AS (listening_level_group_for_cefr(cefr_level)) STORED;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.listening_episodes'::regclass
      AND conname = 'chk_le_level_group'
  ) THEN
    ALTER TABLE listening_episodes
      ADD CONSTRAINT chk_le_level_group CHECK (level_group IN ('A1_A2', 'B1_B2', 'C1_C2'));
  END IF;
END $$;

-- Serves shared-content reuse lookups: "is there already a published story
-- for this level_group + individual target level?"
CREATE INDEX IF NOT EXISTS idx_le_level_group_status_level
  ON listening_episodes (level_group, cefr_level, status);

-- ─── listening_generation_jobs ─────────────────────────────────────────────────
-- State machine tracking one shared generation attempt per level_group.
-- Mirrors the shape of user_listening_generation_sessions (Etapa on-demand)
-- but is keyed by level_group instead of (user_id, local_date) and carries no
-- user_id: this table is global shared content plumbing, not per-user state.

CREATE TABLE listening_generation_jobs (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  level_group       TEXT        NOT NULL CHECK (level_group IN ('A1_A2', 'B1_B2', 'C1_C2')),
  target_level      TEXT        NOT NULL CHECK (target_level IN ('A1','A2','B1','B2','C1','C2')),
  idempotency_key   TEXT        NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'created'
    CHECK (status IN (
      'created',
      'generating_block_1', 'validating_block_1',
      'generating_block_2', 'validating_block_2',
      'generating_questions', 'preparing_description', 'preparing_subtitles',
      'generating_audio_block_1', 'generating_audio_block_2',
      'validating_duration', 'finalizing', 'ready', 'failed', 'cancelled'
    )),
  current_step      TEXT,
  progress_percent  INTEGER     NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
  episode_id        UUID        REFERENCES listening_episodes(id),
  attempts          INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts      INTEGER     NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  error_code        TEXT,
  error_message     TEXT,
  retryable         BOOLEAN     NOT NULL DEFAULT false,
  locked_by         TEXT,
  locked_at         TIMESTAMPTZ,
  lock_expires_at   TIMESTAMPTZ,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_lgj_target_level_in_group CHECK (
    (level_group = 'A1_A2' AND target_level IN ('A1', 'A2')) OR
    (level_group = 'B1_B2' AND target_level IN ('B1', 'B2')) OR
    (level_group = 'C1_C2' AND target_level IN ('C1', 'C2'))
  )
);

-- The lock: exactly one active (non-terminal) job per level_group. 'ready' is
-- intentionally excluded alongside 'failed'/'cancelled' so a *completed* job
-- does not permanently block the next alternated generation for the group —
-- reuse of the completed story is decided in the application layer, not here.
CREATE UNIQUE INDEX uq_listening_generation_jobs_active_group
  ON listening_generation_jobs (level_group)
  WHERE status NOT IN ('ready', 'failed', 'cancelled');

-- Alternation lookup: "what was the last target_level generated for this group?"
CREATE INDEX idx_listening_generation_jobs_group_created
  ON listening_generation_jobs (level_group, created_at DESC);

-- Stale-job recovery: find expired locks still marked active.
CREATE INDEX idx_listening_generation_jobs_lock_expiry
  ON listening_generation_jobs (lock_expires_at)
  WHERE status NOT IN ('ready', 'failed', 'cancelled');

ALTER TABLE listening_generation_jobs ENABLE ROW LEVEL SECURITY;
-- No policies: service role only (same access model as listening_jobs).

CREATE OR REPLACE FUNCTION listening_generation_jobs_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_listening_generation_jobs_updated_at
  BEFORE UPDATE ON listening_generation_jobs
  FOR EACH ROW EXECUTE FUNCTION listening_generation_jobs_set_updated_at();

COMMENT ON TABLE listening_generation_jobs IS
  'Shared, level_group-keyed on-demand generation jobs. Global content plumbing only (no user_id). The partial unique index on level_group is the database-backed lock preventing two concurrent OpenAI/Azure pipelines for the same shared group.';
