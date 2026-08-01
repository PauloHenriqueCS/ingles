-- Per-item mastery state for each learner.
-- Unique per (user_id, vocabulary_item_id).

CREATE TABLE learner_vocabulary_mastery (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  vocabulary_item_id    UUID NOT NULL REFERENCES vocabulary_items(id) ON DELETE CASCADE,
  state                 TEXT NOT NULL DEFAULT 'new' CHECK (state IN (
                          'new', 'introduced', 'learning', 'reviewing',
                          'mastered', 'maintenance', 'suspended')),
  total_exposures       INTEGER NOT NULL DEFAULT 0 CHECK (total_exposures >= 0),
  total_opportunities   INTEGER NOT NULL DEFAULT 0 CHECK (total_opportunities >= 0),
  successful_recalls    INTEGER NOT NULL DEFAULT 0 CHECK (successful_recalls >= 0),
  successful_uses       INTEGER NOT NULL DEFAULT 0 CHECK (successful_uses >= 0),
  independent_uses      INTEGER NOT NULL DEFAULT 0 CHECK (independent_uses >= 0),
  guided_uses           INTEGER NOT NULL DEFAULT 0 CHECK (guided_uses >= 0),
  assisted_uses         INTEGER NOT NULL DEFAULT 0 CHECK (assisted_uses >= 0),
  error_count           INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  lapse_count           INTEGER NOT NULL DEFAULT 0 CHECK (lapse_count >= 0),
  distinct_context_count INTEGER NOT NULL DEFAULT 0 CHECK (distinct_context_count >= 0),
  stability             NUMERIC(8,3) NOT NULL DEFAULT 1.0 CHECK (stability > 0),
  difficulty            NUMERIC(4,3) NOT NULL DEFAULT 0.3 CHECK (difficulty BETWEEN 0 AND 1),
  confidence            NUMERIC(4,3) NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  first_seen_at         TIMESTAMPTZ,
  last_seen_at          TIMESTAMPTZ,
  last_practiced_at     TIMESTAMPTZ,
  last_success_at       TIMESTAMPTZ,
  next_review_at        TIMESTAMPTZ,
  mastered_at           TIMESTAMPTZ,
  suspended_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, vocabulary_item_id),
  CONSTRAINT chk_lvm_successful_uses_lte_opportunities
    CHECK (successful_uses <= total_opportunities + total_exposures),
  CONSTRAINT chk_lvm_independent_lte_successful
    CHECK (independent_uses <= successful_uses + successful_recalls)
);

CREATE INDEX idx_lvm_user_state ON learner_vocabulary_mastery (user_id, state);
CREATE INDEX idx_lvm_user_due ON learner_vocabulary_mastery (user_id, next_review_at)
  WHERE state NOT IN ('new', 'suspended');

ALTER TABLE learner_vocabulary_mastery ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own vocabulary mastery"
  ON learner_vocabulary_mastery FOR SELECT
  USING (auth.uid() = user_id);
-- All writes via service role
