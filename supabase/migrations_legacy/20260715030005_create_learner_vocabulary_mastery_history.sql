-- Append-only audit log for meaningful vocabulary mastery changes.

CREATE TABLE learner_vocabulary_mastery_history (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  vocabulary_item_id       UUID NOT NULL REFERENCES vocabulary_items(id) ON DELETE CASCADE,
  previous_state           TEXT,
  new_state                TEXT NOT NULL,
  previous_next_review_at  TIMESTAMPTZ,
  new_next_review_at       TIMESTAMPTZ,
  previous_stability       NUMERIC(8,3),
  new_stability            NUMERIC(8,3),
  reason_code              TEXT NOT NULL,
  evidence_ids             UUID[] NOT NULL DEFAULT '{}',
  scheduling_version       TEXT NOT NULL DEFAULT 'v1',
  changed_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_vocab_history_user_item ON learner_vocabulary_mastery_history (user_id, vocabulary_item_id, changed_at DESC);

ALTER TABLE learner_vocabulary_mastery_history ENABLE ROW LEVEL SECURITY;
-- No SELECT policy: service role only
