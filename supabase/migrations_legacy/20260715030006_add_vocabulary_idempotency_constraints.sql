-- Add processed_at to legacy vocabulary sources for tracking.
-- The new learner_vocabulary_evidence already uses UNIQUE(idempotency_key).

-- Track when english_reviews vocabulary was processed into canonical evidence
ALTER TABLE english_reviews
  ADD COLUMN IF NOT EXISTS vocabulary_processed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_english_reviews_vocab_unprocessed
  ON english_reviews (user_id, created_at DESC)
  WHERE vocabulary_processed_at IS NULL;
