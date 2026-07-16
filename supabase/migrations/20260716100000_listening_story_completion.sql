-- Allow story-mode listening completions that have no DB episode.
-- episode_id stays NOT NULL when an episode exists; NULL marks an on-the-fly story session.
ALTER TABLE user_listening_assignments ALTER COLUMN episode_id DROP NOT NULL;
