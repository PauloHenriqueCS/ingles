alter table public.user_learning_settings
  add column if not exists audio_preferences jsonb default null;
