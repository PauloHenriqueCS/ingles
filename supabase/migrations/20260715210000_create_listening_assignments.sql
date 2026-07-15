-- Etapa 12: Daily listening assignments per user.

CREATE TABLE user_listening_assignments (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  episode_id    UUID        NOT NULL REFERENCES listening_episodes(id),
  activity_date DATE        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'assigned'
                            CHECK (status IN ('assigned', 'in_progress', 'completed')),
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, activity_date)
);

CREATE INDEX idx_ula_user_date    ON user_listening_assignments (user_id, activity_date DESC);
CREATE INDEX idx_ula_episode_id   ON user_listening_assignments (episode_id);
CREATE INDEX idx_ula_user_status  ON user_listening_assignments (user_id, status);

ALTER TABLE user_listening_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own listening assignments"
  ON user_listening_assignments FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
