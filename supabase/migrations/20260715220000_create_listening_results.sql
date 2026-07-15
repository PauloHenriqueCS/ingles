-- Etapa 12: Pedagogical performance results for completed listening assignments.

CREATE TABLE user_listening_results (
  id                         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                    UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  assignment_id              UUID         NOT NULL REFERENCES user_listening_assignments(id),
  episode_id                 UUID         NOT NULL REFERENCES listening_episodes(id),
  performance_score          NUMERIC(5,2) NOT NULL,
  q1_attempt_cycle           INTEGER      NOT NULL,
  q2_attempt_cycle           INTEGER      NOT NULL,
  q1_weight                  NUMERIC(4,3) NOT NULL,
  q2_weight                  NUMERIC(4,3) NOT NULL,
  calculation_version        TEXT         NOT NULL DEFAULT 'listening-performance-v1',
  level_evidence_submitted   BOOLEAN      NOT NULL DEFAULT FALSE,
  calculated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, assignment_id)
);

CREATE INDEX idx_ulr_user_id      ON user_listening_results (user_id);
CREATE INDEX idx_ulr_assignment   ON user_listening_results (assignment_id);

ALTER TABLE user_listening_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own listening results"
  ON user_listening_results FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
