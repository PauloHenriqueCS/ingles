CREATE TYPE rewrite_evaluation_status AS ENUM (
  'pending',
  'completed',
  'failed'
);

CREATE TYPE rewrite_independence_assessment AS ENUM (
  'independent',
  'likely_independent',
  'uncertain',
  'likely_copied',
  'copied'
);

CREATE TABLE writing_rewrite_evaluations (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- No FK to writing_missions(id) — see the same note in
  -- writing_rewrite_attempts (20260722190000_create_writing_rewrite_attempts.sql).
  mission_id                    UUID,
  original_submission_id        UUID NOT NULL REFERENCES english_reviews(id) ON DELETE CASCADE,
  rewrite_submission_id         UUID NOT NULL REFERENCES writing_rewrite_attempts(id) ON DELETE CASCADE,
  review_id                     UUID NOT NULL REFERENCES english_reviews(id) ON DELETE CASCADE,
  evaluation_version            INTEGER NOT NULL DEFAULT 1,
  status                        rewrite_evaluation_status NOT NULL DEFAULT 'pending',
  correction_resolution_score   INTEGER NOT NULL CHECK (correction_resolution_score BETWEEN 0 AND 100),
  new_error_avoidance_score     INTEGER NOT NULL CHECK (new_error_avoidance_score BETWEEN 0 AND 100),
  meaning_preservation_score    INTEGER NOT NULL CHECK (meaning_preservation_score BETWEEN 0 AND 100),
  clarity_improvement_score     INTEGER NOT NULL CHECK (clarity_improvement_score BETWEEN 0 AND 100),
  cohesion_improvement_score    INTEGER NOT NULL CHECK (cohesion_improvement_score BETWEEN 0 AND 100),
  independence_score            INTEGER NOT NULL CHECK (independence_score BETWEEN 0 AND 100),
  overall_improvement_score     INTEGER NOT NULL CHECK (overall_improvement_score BETWEEN 0 AND 100),
  independence_assessment       rewrite_independence_assessment NOT NULL DEFAULT 'uncertain',
  summary_pt_br                 TEXT,
  new_issues_json               JSONB NOT NULL DEFAULT '[]',
  scoring_version               TEXT NOT NULL DEFAULT 'v1',
  schema_version                TEXT NOT NULL DEFAULT 'v1',
  prompt_version                TEXT,
  model_provider                TEXT,
  model_name                    TEXT,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at                  TIMESTAMPTZ,
  UNIQUE (rewrite_submission_id, evaluation_version)
);

CREATE INDEX idx_rewrite_evaluations_submission ON writing_rewrite_evaluations (rewrite_submission_id);
CREATE INDEX idx_rewrite_evaluations_user ON writing_rewrite_evaluations (user_id, created_at DESC);

ALTER TABLE writing_rewrite_evaluations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own evaluations"
  ON writing_rewrite_evaluations FOR SELECT
  USING (auth.uid() = user_id);
-- All writes via service role
