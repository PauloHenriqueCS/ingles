-- Add persistence columns to english_reviews
ALTER TABLE english_reviews
  ADD COLUMN IF NOT EXISTS entry_date DATE,
  ADD COLUMN IF NOT EXISTS mission_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS version_2_text TEXT,
  ADD COLUMN IF NOT EXISTS version_2_comparison JSONB,
  ADD COLUMN IF NOT EXISTS version_2_improvement_score INTEGER;

CREATE INDEX IF NOT EXISTS idx_english_reviews_user_entry_date
  ON english_reviews (user_id, entry_date);
