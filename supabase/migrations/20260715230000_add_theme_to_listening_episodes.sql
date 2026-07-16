-- Etapa 13: Add theme column to listening_episodes for accurate deduplication.

ALTER TABLE listening_episodes
  ADD COLUMN IF NOT EXISTS theme TEXT;

CREATE INDEX IF NOT EXISTS idx_le_cefr_theme
  ON listening_episodes (cefr_level, theme)
  WHERE theme IS NOT NULL;
