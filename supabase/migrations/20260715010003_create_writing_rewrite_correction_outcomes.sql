CREATE TYPE rewrite_correction_outcome_status AS ENUM (
  'corrected',
  'partially_corrected',
  'unchanged',
  'valid_alternative',
  'worsened',
  'not_applicable'
);

CREATE TABLE writing_rewrite_correction_outcomes (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rewrite_evaluation_id   UUID NOT NULL REFERENCES writing_rewrite_evaluations(id) ON DELETE CASCADE,
  correction_id           TEXT NOT NULL,    -- index from main_mistakes array (as string)
  status                  rewrite_correction_outcome_status NOT NULL,
  original_excerpt        TEXT NOT NULL DEFAULT '',
  expected_correction     TEXT NOT NULL DEFAULT '',
  rewrite_excerpt         TEXT,
  explanation_pt_br       TEXT NOT NULL DEFAULT '',
  confidence              NUMERIC(4,3) NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  should_affect_score     BOOLEAN NOT NULL DEFAULT true,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_correction_outcomes_eval ON writing_rewrite_correction_outcomes (rewrite_evaluation_id);

ALTER TABLE writing_rewrite_correction_outcomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own outcomes via evaluation"
  ON writing_rewrite_correction_outcomes FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM writing_rewrite_evaluations wre
      WHERE wre.id = rewrite_evaluation_id
        AND wre.user_id = auth.uid()
    )
  );
