-- Canonical rewrite attempt entity.
-- submission_type = 'rewrite_v2', author_type = 'learner'
-- Points to english_reviews.id (which has original_text + corrected_text)

CREATE TYPE rewrite_status AS ENUM (
  'draft',
  'submitted',
  'evaluation_pending',
  'evaluated',
  'evaluation_failed',
  'superseded',
  'cancelled'
);

CREATE TABLE writing_rewrite_attempts (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- No FK to writing_missions(id): that table (and its own dependency,
  -- mission_pedagogical_plans) is a separate, not-yet-migrated epic.
  -- mission_id is always NULL in the current call path (no caller passes
  -- missionId) — kept as a plain nullable UUID so the constraint can be
  -- added later, whenever writing_missions actually ships, without a
  -- backfill.
  mission_id              UUID,
  review_id               UUID NOT NULL REFERENCES english_reviews(id) ON DELETE CASCADE,
  rewrite_sequence        INTEGER NOT NULL DEFAULT 1,
  status                  rewrite_status NOT NULL DEFAULT 'draft',
  author_type             TEXT NOT NULL DEFAULT 'learner' CHECK (author_type = 'learner'),
  submission_type         TEXT NOT NULL DEFAULT 'rewrite_v2' CHECK (submission_type = 'rewrite_v2'),
  rewrite_text            TEXT,
  original_text_snapshot  TEXT NOT NULL,  -- frozen copy of english_reviews.original_text at creation time
  corrected_text_hash     TEXT NOT NULL,  -- hash of corrected_text at submission time
  review_version          INTEGER NOT NULL DEFAULT 1,
  support_usage_snapshot  JSONB,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at            TIMESTAMPTZ,
  UNIQUE (review_id, user_id, rewrite_sequence)
);

CREATE INDEX idx_rewrite_attempts_review_user ON writing_rewrite_attempts (review_id, user_id, rewrite_sequence);
CREATE INDEX idx_rewrite_attempts_user_status ON writing_rewrite_attempts (user_id, status);

ALTER TABLE writing_rewrite_attempts ENABLE ROW LEVEL SECURITY;

-- Users may read their own attempts and create drafts
CREATE POLICY "Users read own rewrite attempts"
  ON writing_rewrite_attempts FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own rewrite draft"
  ON writing_rewrite_attempts FOR INSERT
  WITH CHECK (auth.uid() = user_id AND status = 'draft' AND author_type = 'learner' AND submission_type = 'rewrite_v2');

-- Updates only for draft status (text editing); submission and evaluation go through service role
CREATE POLICY "Users update own draft rewrite text"
  ON writing_rewrite_attempts FOR UPDATE
  USING (auth.uid() = user_id AND status = 'draft')
  WITH CHECK (auth.uid() = user_id AND status = 'draft');
