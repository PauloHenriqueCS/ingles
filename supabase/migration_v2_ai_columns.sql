-- Run this in the Supabase SQL Editor

alter table public.writing_entries
  add column if not exists ai_score       integer,
  add column if not exists cefr_level     text,
  add column if not exists grammar_score  integer,
  add column if not exists vocabulary_score integer,
  add column if not exists naturalness_score integer,
  add column if not exists fluency_score  integer,
  -- corrected_text already exists (text column)
  add column if not exists ai_summary     text,
  add column if not exists grammar_feedback jsonb,
  -- Note: main_errors already exists as text (manual field).
  -- AI version stored separately to avoid type conflict:
  add column if not exists ai_main_errors jsonb,
  add column if not exists new_vocabulary jsonb,
  add column if not exists natural_expressions jsonb,
  add column if not exists grammar_goal_achieved boolean,
  add column if not exists rewrite_challenge text,
  add column if not exists reviewed_at    timestamptz;
