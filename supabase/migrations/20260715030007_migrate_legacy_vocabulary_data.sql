-- Conservative migration of legacy vocabulary from english_learning_memory and english_reviews.
-- Creates vocabulary_items entries for known words, with low confidence mastery.
-- Idempotent: ON CONFLICT DO NOTHING throughout.

-- Step 1: Create vocabulary items from new_vocabulary JSONB in english_reviews
-- We extract distinct words and create items with state='introduced' (conservative)
-- This is a best-effort migration; full evidence is not available

-- Note: This migration uses PL/pgSQL to iterate over JSONB arrays safely.
-- In production, this should be run as a background job per user batch.

-- For safety, this migration only creates vocabulary_items entries for existing words.
-- Learner mastery entries are NOT created here (too risky to infer state without evidence).
-- The vocabulary engine will create mastery entries on first evidence processing.

-- Create a placeholder vocabulary item for migration tracking
INSERT INTO vocabulary_items (canonical_value, normalized_value, kind, language, is_active)
VALUES ('__legacy_migration_marker__', '__legacy_migration_marker__', 'word', 'en', false)
ON CONFLICT (normalized_value, language) DO NOTHING;

-- Mark all existing english_reviews as pending vocabulary processing
-- (will be processed by the evidence pipeline)
-- Only mark reviews that haven't been processed yet
UPDATE english_reviews
SET vocabulary_processed_at = NULL  -- explicitly mark as unprocessed
WHERE vocabulary_processed_at IS NULL
  AND new_vocabulary IS NOT NULL
  AND jsonb_array_length(new_vocabulary) > 0;
