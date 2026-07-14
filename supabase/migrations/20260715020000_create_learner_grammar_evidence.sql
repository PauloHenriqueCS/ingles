-- Canonical, immutable grammar evidence entity.
-- Each row = one confirmed evidence item from processing a candidate.
-- Idempotency enforced by unique constraint on idempotency_key.

CREATE TABLE learner_grammar_evidence (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  grammar_topic_id      TEXT NOT NULL CHECK (char_length(grammar_topic_id) BETWEEN 1 AND 128),
  catalog_version       INTEGER NOT NULL DEFAULT 1,
  skill                 TEXT NOT NULL DEFAULT 'writing',
  source_type           TEXT NOT NULL CHECK (source_type IN (
                          'original_review', 'rewrite_evaluation', 'diagnostic',
                          'calibration', 'checkpoint', 'manual_admin')),
  source_id             TEXT NOT NULL,
  mission_id            UUID REFERENCES writing_missions(id) ON DELETE SET NULL,
  submission_id         UUID,
  review_id             UUID REFERENCES english_reviews(id) ON DELETE SET NULL,
  rewrite_submission_id UUID REFERENCES writing_rewrite_attempts(id) ON DELETE SET NULL,
  correction_id         TEXT,
  evidence_type         TEXT NOT NULL CHECK (evidence_type IN (
                          'opportunity', 'successful_use', 'error', 'partial_success',
                          'attempt_above_level', 'no_opportunity', 'retention_success',
                          'retention_failure')),
  production_mode       TEXT NOT NULL DEFAULT 'unknown' CHECK (production_mode IN (
                          'independent', 'guided', 'assisted', 'system_generated', 'unknown')),
  outcome               TEXT NOT NULL CHECK (outcome IN ('success', 'partial', 'failure', 'neutral')),
  opportunity_weight    NUMERIC(5,3) NOT NULL DEFAULT 1.0 CHECK (opportunity_weight BETWEEN 0 AND 1),
  evidence_weight       NUMERIC(5,3) NOT NULL DEFAULT 0.0
                        CHECK (evidence_weight BETWEEN -2.0 AND 2.0),
  confidence            NUMERIC(4,3) NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  planned_topic         BOOLEAN NOT NULL DEFAULT false,
  topic_role            TEXT NOT NULL DEFAULT 'unplanned' CHECK (topic_role IN (
                          'primary', 'secondary', 'review', 'exposure_only', 'unplanned', 'locked')),
  context_key           TEXT NOT NULL,
  context_family        TEXT NOT NULL DEFAULT 'unknown',
  support_level         TEXT NOT NULL DEFAULT 'none',
  help_used             BOOLEAN NOT NULL DEFAULT false,
  occurred_at           TIMESTAMPTZ NOT NULL,
  processed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key       TEXT NOT NULL,
  rules_version         TEXT NOT NULL DEFAULT 'v1',
  metadata_json         JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key)
);

-- Fast lookup by user+topic for aggregate rebuilds
CREATE INDEX idx_grammar_evidence_user_topic
  ON learner_grammar_evidence (user_id, grammar_topic_id, occurred_at DESC);

-- Fast lookup by source for reprocessing
CREATE INDEX idx_grammar_evidence_source
  ON learner_grammar_evidence (source_type, source_id);

ALTER TABLE learner_grammar_evidence ENABLE ROW LEVEL SECURITY;

-- Users can read their own evidence (public progress view)
CREATE POLICY "Users read own grammar evidence"
  ON learner_grammar_evidence FOR SELECT
  USING (auth.uid() = user_id);
-- All writes via service role
