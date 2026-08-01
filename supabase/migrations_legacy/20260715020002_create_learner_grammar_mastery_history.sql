-- Append-only audit log of meaningful mastery state transitions.
-- NOT created for every counter update — only for state changes.

CREATE TABLE learner_grammar_mastery_history (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  grammar_topic_id    TEXT NOT NULL CHECK (char_length(grammar_topic_id) BETWEEN 1 AND 128),
  previous_state      public.grammar_mastery_state,
  new_state           public.grammar_mastery_state NOT NULL,
  previous_confidence NUMERIC(4,3) NOT NULL DEFAULT 0,
  new_confidence      NUMERIC(4,3) NOT NULL DEFAULT 0,
  reason_code         TEXT NOT NULL,
  evidence_ids        UUID[] NOT NULL DEFAULT '{}',
  rules_version       TEXT NOT NULL DEFAULT 'v1',
  changed_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_grammar_mastery_history_user_topic
  ON learner_grammar_mastery_history (user_id, grammar_topic_id, changed_at DESC);

ALTER TABLE learner_grammar_mastery_history ENABLE ROW LEVEL SECURITY;
-- No SELECT policy: service role only (internal audit)
