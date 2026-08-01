-- Idempotency table: prevents duplicate effects from double-clicks or retries.
-- One row per request_id; if the row already exists, return its recorded result.

CREATE TYPE mission_action_type AS ENUM (
  'accept',
  'start',
  'complete',
  'skip'
);

CREATE TABLE mission_action_idempotency (
  request_id    TEXT PRIMARY KEY,  -- caller-provided idempotency key (UUID recommended)
  mission_id    UUID NOT NULL REFERENCES writing_missions(id) ON DELETE CASCADE,
  action_type   mission_action_type NOT NULL,
  result_status mission_status NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_mission_action_idempotency_mission
  ON mission_action_idempotency (mission_id);

-- No RLS needed: this table is only accessed via service role.
