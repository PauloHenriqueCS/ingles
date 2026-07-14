-- Add missing aggregate columns to learner_grammar_mastery.
-- Uses IF NOT EXISTS to be safe on re-run.

ALTER TABLE learner_grammar_mastery
  ADD COLUMN IF NOT EXISTS partial_uses        INTEGER NOT NULL DEFAULT 0
    CHECK (partial_uses >= 0),
  ADD COLUMN IF NOT EXISTS retention_successes INTEGER NOT NULL DEFAULT 0
    CHECK (retention_successes >= 0),
  ADD COLUMN IF NOT EXISTS retention_failures  INTEGER NOT NULL DEFAULT 0
    CHECK (retention_failures >= 0),
  ADD COLUMN IF NOT EXISTS weighted_success_score NUMERIC(8,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS weighted_error_score   NUMERIC(8,3) NOT NULL DEFAULT 0
    CHECK (weighted_error_score >= 0),
  ADD COLUMN IF NOT EXISTS last_evidence_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rules_version       TEXT NOT NULL DEFAULT 'v1';

-- Constraint: weighted scores reasonable
ALTER TABLE learner_grammar_mastery
  ADD CONSTRAINT IF NOT EXISTS chk_lgm_partial_lte_total
    CHECK (partial_uses <= total_opportunities);
