-- Additive migration: expand ai_conversation_preferences with full tutor settings.
-- Safe to run multiple times (all changes use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).

-- ── 1. Add new columns to existing table ─────────────────────────────────────

ALTER TABLE ai_conversation_preferences
  ADD COLUMN IF NOT EXISTS accent TEXT NOT NULL DEFAULT 'american'
    CHECK (accent IN ('american', 'british', 'neutral')),

  ADD COLUMN IF NOT EXISTS speech_pace TEXT NOT NULL DEFAULT 'slow'
    CHECK (speech_pace IN ('slow', 'normal', 'natural')),

  ADD COLUMN IF NOT EXISTS personality_preset TEXT NOT NULL DEFAULT 'patient'
    CHECK (personality_preset IN ('patient', 'friend', 'teacher', 'unfiltered_friend', 'custom')),

  ADD COLUMN IF NOT EXISTS formality TEXT NOT NULL DEFAULT 'medium'
    CHECK (formality IN ('very_low', 'low', 'medium', 'high')),

  ADD COLUMN IF NOT EXISTS humor_level TEXT NOT NULL DEFAULT 'low'
    CHECK (humor_level IN ('low', 'medium', 'high')),

  ADD COLUMN IF NOT EXISTS roast_intensity TEXT NOT NULL DEFAULT 'off'
    CHECK (roast_intensity IN ('off', 'light', 'high')),

  ADD COLUMN IF NOT EXISTS profanity_enabled BOOLEAN NOT NULL DEFAULT false,

  ADD COLUMN IF NOT EXISTS topic_initiative TEXT NOT NULL DEFAULT 'medium'
    CHECK (topic_initiative IN ('low', 'medium', 'high')),

  ADD COLUMN IF NOT EXISTS correction_timing TEXT NOT NULL DEFAULT 'after_each'
    CHECK (correction_timing IN ('after_each', 'end_of_block', 'session_summary')),

  ADD COLUMN IF NOT EXISTS correction_scope TEXT NOT NULL DEFAULT 'important_only'
    CHECK (correction_scope IN ('important_only', 'all_relevant', 'communication_impact')),

  ADD COLUMN IF NOT EXISTS correction_language TEXT NOT NULL DEFAULT 'portuguese'
    CHECK (correction_language IN ('portuguese', 'english')),

  ADD COLUMN IF NOT EXISTS correction_detail TEXT NOT NULL DEFAULT 'brief'
    CHECK (correction_detail IN ('brief', 'detailed'));

-- ── 2. Change default voice from 'marin' → 'coral' for new rows ──────────────
-- (Existing rows keep their chosen voice. Only affects future inserts.)
ALTER TABLE ai_conversation_preferences
  ALTER COLUMN voice SET DEFAULT 'coral';

-- ── 3. RLS policy already exists from previous migration — no-op ──────────────

-- ── 4. Ensure updated_at trigger covers new columns ───────────────────────────
-- The trigger set_ai_prefs_user_id already sets updated_at on every update,
-- so no additional trigger changes are needed.
