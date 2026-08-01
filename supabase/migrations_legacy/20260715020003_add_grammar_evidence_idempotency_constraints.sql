-- Add processed_at column to writing_rewrite_evidence_candidates for tracking processing status
ALTER TABLE writing_rewrite_evidence_candidates
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

-- Index for fast "unprocessed" queries
CREATE INDEX IF NOT EXISTS idx_rewrite_evidence_unprocessed
  ON writing_rewrite_evidence_candidates (rewrite_submission_id)
  WHERE processed_at IS NULL;
