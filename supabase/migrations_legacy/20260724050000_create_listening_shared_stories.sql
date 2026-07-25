-- Persistence + reuse for the EXISTING on-the-fly Listening story flow
-- (src/services/listening/story-session/generate-listening-story.ts, served
-- via POST /api/listening/generate). Does NOT introduce a staged pipeline,
-- job table, cron, or worker — the old flow's own logic (OpenAI -> Azure TTS)
-- is unchanged; this only adds a place to cache its result per
-- (level_group, practice_date) so a second user/request in the same window
-- reuses it instead of generating again.
--
-- This migration does not modify or remove any existing data or tables.

-- ─── listening_shared_stories ───────────────────────────────────────────────
-- One row per (level_group, practice_date). The UNIQUE constraint on that
-- pair IS the lock: a concurrent second attempt to start a generation for
-- the same group/day can only ever update the SAME row (via the RPC below),
-- never create a second one. No job/queue table, no separate lock table.

CREATE TABLE listening_shared_stories (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  level_group       TEXT        NOT NULL CHECK (level_group IN ('A1_A2', 'B1_B2', 'C1_C2')),
  target_level      TEXT        NOT NULL CHECK (target_level IN ('A1','A2','B1','B2','C1','C2')),
  practice_date     DATE        NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'generating'
    CHECK (status IN ('generating', 'ready', 'failed')),
  -- Full reconstructable content minus audio: {title, summary, parts:
  -- [{id, text, question: {prompt, options, correctOptionIndex,
  -- explanationPt}}, {...}]} — the exact shape generateListeningStory()
  -- already returns, with audioBase64/audioMimeType/answerToken stripped
  -- (audio lives in Storage; answerToken is re-signed fresh on every serve).
  content           JSONB,
  part1_audio_path  TEXT,
  part2_audio_path  TEXT,
  audio_mime_type   TEXT,
  error_message     TEXT,
  lock_expires_at   TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_lss_target_level_in_group CHECK (
    (level_group = 'A1_A2' AND target_level IN ('A1', 'A2')) OR
    (level_group = 'B1_B2' AND target_level IN ('B1', 'B2')) OR
    (level_group = 'C1_C2' AND target_level IN ('C1', 'C2'))
  ),
  CONSTRAINT uq_lss_group_date UNIQUE (level_group, practice_date)
);

ALTER TABLE listening_shared_stories ENABLE ROW LEVEL SECURITY;
-- No policies: service role only (same access model as listening_generation_jobs).
-- No user_id column — this row is global shared content, never per-user.

CREATE OR REPLACE FUNCTION listening_shared_stories_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_listening_shared_stories_updated_at
  BEFORE UPDATE ON listening_shared_stories
  FOR EACH ROW EXECUTE FUNCTION listening_shared_stories_set_updated_at();

COMMENT ON TABLE listening_shared_stories IS
  'Cache/lock for the existing on-the-fly Listening story flow (story-session/generate-listening-story.ts), keyed by (level_group, practice_date). Not a job queue: one row per group per day, reused as-is once status=ready. No user_id — global shared content.';

-- ─── user_listening_shared_progress ────────────────────────────────────────
-- Per-user attachment/progress against a shared story. Content and audio are
-- global (listening_shared_stories); this is the individual side, mirroring
-- the user_id FK convention already used by user_listening_assignments
-- (ON DELETE CASCADE).

CREATE TABLE user_listening_shared_progress (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  shared_story_id   UUID        NOT NULL REFERENCES listening_shared_stories(id) ON DELETE CASCADE,
  answers           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  current_part      INTEGER     NOT NULL DEFAULT 1 CHECK (current_part IN (1, 2)),
  completed         BOOLEAN     NOT NULL DEFAULT false,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_ulsp_user_story UNIQUE (user_id, shared_story_id)
);

ALTER TABLE user_listening_shared_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own shared listening progress"
  ON user_listening_shared_progress FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own shared listening progress"
  ON user_listening_shared_progress FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own shared listening progress"
  ON user_listening_shared_progress FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION user_listening_shared_progress_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_user_listening_shared_progress_updated_at
  BEFORE UPDATE ON user_listening_shared_progress
  FOR EACH ROW EXECUTE FUNCTION user_listening_shared_progress_set_updated_at();

COMMENT ON TABLE user_listening_shared_progress IS
  'Per-user progress/answers against a listening_shared_stories row. Content/audio are global; this table is the individual side (one row per user per shared story, ON DELETE CASCADE on both FKs).';

-- ─── Lock acquisition RPC ───────────────────────────────────────────────────
-- Atomically does ONE of:
--   1. No row exists for (level_group, practice_date) -> inserts one with
--      status='generating', caller wins the lock.
--   2. A row exists with status='failed', or status='generating' with an
--      EXPIRED lock -> takes it over (same semantics as #1), caller wins.
--   3. A row exists with status='ready', or status='generating' with a
--      LIVE lock -> no write happens, caller does NOT win; current row
--      state is returned so the caller can reuse it or report "in progress".
-- Implemented as a single INSERT ... ON CONFLICT ... DO UPDATE ... WHERE so
-- the decision is made atomically by Postgres, not by a read-then-write race
-- in application code — this is the only way to express "take over an
-- expired lock" through a single statement rather than a separate lock
-- table with its own concurrency semantics.

CREATE OR REPLACE FUNCTION acquire_or_get_listening_shared_story(
  p_level_group TEXT,
  p_target_level TEXT,
  p_practice_date DATE,
  p_lock_duration_seconds INTEGER
)
RETURNS TABLE (
  id UUID,
  status TEXT,
  won BOOLEAN,
  content JSONB,
  part1_audio_path TEXT,
  part2_audio_path TEXT,
  audio_mime_type TEXT,
  error_message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO listening_shared_stories (level_group, target_level, practice_date, status, lock_expires_at)
  VALUES (p_level_group, p_target_level, p_practice_date, 'generating', now() + make_interval(secs => p_lock_duration_seconds))
  ON CONFLICT (level_group, practice_date) DO UPDATE
    SET status = 'generating',
        target_level = EXCLUDED.target_level,
        lock_expires_at = now() + make_interval(secs => p_lock_duration_seconds),
        error_message = NULL
    WHERE listening_shared_stories.status = 'failed'
       OR listening_shared_stories.lock_expires_at < now()
  RETURNING listening_shared_stories.id INTO v_id;

  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, 'generating'::TEXT, true, NULL::JSONB, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::TEXT;
    RETURN;
  END IF;

  RETURN QUERY
    SELECT s.id, s.status, false, s.content, s.part1_audio_path, s.part2_audio_path, s.audio_mime_type, s.error_message
    FROM listening_shared_stories s
    WHERE s.level_group = p_level_group AND s.practice_date = p_practice_date;
END;
$$;

COMMENT ON FUNCTION acquire_or_get_listening_shared_story IS
  'Atomic lock acquisition for listening_shared_stories: wins (won=true) on a fresh insert or takeover of a failed/expired row; otherwise returns the existing ready/generating row unchanged (won=false).';

GRANT EXECUTE ON FUNCTION acquire_or_get_listening_shared_story(TEXT, TEXT, DATE, INTEGER) TO service_role;
