CREATE TABLE writing_rewrite_evidence_candidates (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rewrite_submission_id    UUID NOT NULL REFERENCES writing_rewrite_attempts(id) ON DELETE CASCADE,
  review_id                UUID NOT NULL REFERENCES english_reviews(id) ON DELETE CASCADE,
  correction_id            TEXT,
  grammar_topic_id         UUID,
  evidence_type            TEXT NOT NULL,
  independence_assessment  rewrite_independence_assessment NOT NULL DEFAULT 'uncertain',
  confidence               NUMERIC(4,3) NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  should_affect_mastery    BOOLEAN NOT NULL DEFAULT false,
  context_key              TEXT NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (review_id, correction_id, evidence_type, rewrite_submission_id)
);

CREATE INDEX idx_rewrite_evidence_user ON writing_rewrite_evidence_candidates (user_id, created_at DESC);
CREATE INDEX idx_rewrite_evidence_submission ON writing_rewrite_evidence_candidates (rewrite_submission_id);

ALTER TABLE writing_rewrite_evidence_candidates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own evidence candidates"
  ON writing_rewrite_evidence_candidates FOR SELECT
  USING (auth.uid() = user_id);
-- No INSERT policy: service role only
