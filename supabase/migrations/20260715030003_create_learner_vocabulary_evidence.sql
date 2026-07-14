-- Canonical, immutable vocabulary evidence. Idempotent via UNIQUE(idempotency_key).

CREATE TABLE learner_vocabulary_evidence (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  vocabulary_item_id    UUID NOT NULL REFERENCES vocabulary_items(id) ON DELETE CASCADE,
  source_type           TEXT NOT NULL CHECK (source_type IN (
                          'original_review', 'rewrite_evaluation', 'diagnostic',
                          'calibration', 'checkpoint', 'review_attempt', 'manual_admin')),
  source_id             TEXT NOT NULL,
  mission_id            UUID REFERENCES writing_missions(id) ON DELETE SET NULL,
  submission_id         UUID,
  review_id             UUID REFERENCES english_reviews(id) ON DELETE SET NULL,
  rewrite_submission_id UUID REFERENCES writing_rewrite_attempts(id) ON DELETE SET NULL,
  evidence_type         TEXT NOT NULL CHECK (evidence_type IN (
                          'exposure', 'recognized', 'recalled', 'successful_use',
                          'partial_use', 'incorrect_use', 'missed_required_item',
                          'valid_synonym', 'spelling_error', 'meaning_error',
                          'form_error', 'copied_use', 'retention_success', 'retention_failure')),
  production_mode       TEXT NOT NULL DEFAULT 'unknown' CHECK (production_mode IN (
                          'independent', 'guided', 'assisted', 'system_generated', 'unknown')),
  outcome               TEXT NOT NULL CHECK (outcome IN ('success', 'partial', 'failure', 'neutral')),
  planned_role          TEXT CHECK (planned_role IN ('review', 'support', 'optional_stretch', 'required')),
  context_key           TEXT NOT NULL,
  context_family        TEXT NOT NULL DEFAULT 'unknown',
  confidence            NUMERIC(4,3) NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  weight                NUMERIC(5,3) NOT NULL DEFAULT 0 CHECK (weight BETWEEN -2.0 AND 2.0),
  occurred_at           TIMESTAMPTZ NOT NULL,
  idempotency_key       TEXT NOT NULL,
  rules_version         TEXT NOT NULL DEFAULT 'v1',
  metadata_json         JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key)
);

CREATE INDEX idx_vocab_evidence_user_item ON learner_vocabulary_evidence (user_id, vocabulary_item_id, occurred_at DESC);
CREATE INDEX idx_vocab_evidence_source ON learner_vocabulary_evidence (source_type, source_id);

ALTER TABLE learner_vocabulary_evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own vocabulary evidence"
  ON learner_vocabulary_evidence FOR SELECT
  USING (auth.uid() = user_id);
