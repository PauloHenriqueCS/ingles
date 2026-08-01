CREATE TABLE writing_rewrite_status_history (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rewrite_submission_id UUID NOT NULL REFERENCES writing_rewrite_attempts(id) ON DELETE CASCADE,
  evaluation_id         UUID REFERENCES writing_rewrite_evaluations(id) ON DELETE SET NULL,
  previous_status       rewrite_status,
  new_status            rewrite_status NOT NULL,
  reason_code           TEXT,
  source                TEXT NOT NULL DEFAULT 'user_action',
  request_id            TEXT,
  metadata_json         JSONB,
  changed_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rewrite_status_history_submission ON writing_rewrite_status_history (rewrite_submission_id, changed_at DESC);

ALTER TABLE writing_rewrite_status_history ENABLE ROW LEVEL SECURITY;
-- No direct SELECT policy needed (service role only, no client access to history)
