-- Etapa 9: Block session state machine for Listening execution.
-- Creates user_listening_block_sessions; adds submission_id to user_listening_attempts.

-- ── Block session status enum ─────────────────────────────────────────────────

CREATE TYPE listening_block_session_status AS ENUM (
  'active',
  'awaiting_answer',
  'replay_required',
  'completed',
  'abandoned',
  'expired'
);

-- ── user_listening_block_sessions ─────────────────────────────────────────────
-- Tracks the real-time state of a user's attempt to complete a block.
-- Each session covers one attempt cycle (up to 3 attempts).
-- A new session (cycle + 1) is created if all 3 attempts fail.

CREATE TABLE user_listening_block_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  episode_id      UUID NOT NULL REFERENCES listening_episodes(id) ON DELETE CASCADE,
  block_id        UUID NOT NULL REFERENCES listening_blocks(id) ON DELETE CASCADE,
  question_id     UUID NOT NULL REFERENCES listening_questions(id) ON DELETE CASCADE,
  attempt_cycle   INTEGER NOT NULL DEFAULT 1 CHECK (attempt_cycle >= 1),
  current_attempt INTEGER NOT NULL DEFAULT 1 CHECK (current_attempt IN (1, 2, 3)),
  status          listening_block_session_status NOT NULL DEFAULT 'active',
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_ulbs_completed_requires_ts
    CHECK (status != 'completed' OR completed_at IS NOT NULL),
  CONSTRAINT chk_ulbs_expires_after_started
    CHECK (expires_at > started_at)
);

-- At most one live session per user+block at a time.
CREATE UNIQUE INDEX idx_ulbs_user_block_active
  ON user_listening_block_sessions (user_id, block_id)
  WHERE status IN ('active', 'awaiting_answer', 'replay_required');

CREATE INDEX idx_ulbs_user_episode ON user_listening_block_sessions (user_id, episode_id);
CREATE INDEX idx_ulbs_expires_active
  ON user_listening_block_sessions (expires_at)
  WHERE status IN ('active', 'awaiting_answer', 'replay_required');

ALTER TABLE user_listening_block_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own block sessions"
  ON user_listening_block_sessions FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- INSERT and UPDATE only via service role.

-- ── submission_id on user_listening_attempts ──────────────────────────────────
-- Prevents duplicate answer submissions (client-generated idempotency key).

ALTER TABLE user_listening_attempts
  ADD COLUMN IF NOT EXISTS submission_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ula_user_submission_id
  ON user_listening_attempts (user_id, submission_id)
  WHERE submission_id IS NOT NULL;
