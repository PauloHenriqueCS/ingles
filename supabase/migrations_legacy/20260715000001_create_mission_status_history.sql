-- Append-only audit log of every mission status transition.

CREATE TYPE mission_transition_source AS ENUM (
  'user_action',
  'system_scheduler',
  'admin_action',
  'migration'
);

CREATE TABLE mission_status_history (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id       UUID NOT NULL REFERENCES writing_missions(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  from_status      mission_status NOT NULL,
  to_status        mission_status NOT NULL,
  source           mission_transition_source NOT NULL DEFAULT 'user_action',
  reason           TEXT,
  metadata         JSONB,
  transitioned_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_mission_status_history_mission
  ON mission_status_history (mission_id, transitioned_at DESC);

CREATE INDEX idx_mission_status_history_user
  ON mission_status_history (user_id, transitioned_at DESC);

ALTER TABLE mission_status_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own history"
  ON mission_status_history FOR SELECT
  USING (auth.uid() = user_id);
