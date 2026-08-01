-- Etapa 11: Fila de processamento, estoque e cron jobs de Listening
-- Listening job queue, operational alerts, claim/heartbeat RPCs

-- ─── listening_jobs table ──────────────────────────────────────────────────────

CREATE TABLE listening_jobs (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type           TEXT        NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'pending',
  priority           INT         NOT NULL DEFAULT 10,
  episode_id         UUID        REFERENCES listening_episodes(id) ON DELETE SET NULL,
  block_id           UUID        REFERENCES listening_blocks(id) ON DELETE SET NULL,
  cefr_level         TEXT,
  payload            JSONB       NOT NULL DEFAULT '{}',
  result             JSONB,
  idempotency_key    TEXT        NOT NULL,
  attempts           INT         NOT NULL DEFAULT 0,
  max_attempts       INT         NOT NULL DEFAULT 3,
  locked_by          TEXT,
  locked_at          TIMESTAMPTZ,
  lock_expires_at    TIMESTAMPTZ,
  next_attempt_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at         TIMESTAMPTZ,
  finished_at        TIMESTAMPTZ,
  error_code         TEXT,
  error_message      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT chk_listening_job_type CHECK (job_type IN (
    'ENSURE_LISTENING_INVENTORY',
    'GENERATE_LISTENING_STORY',
    'GENERATE_LISTENING_QUESTIONS',
    'PREPARE_LISTENING_SUBTITLES',
    'GENERATE_LISTENING_SSML',
    'SYNTHESIZE_LISTENING_BLOCK_AUDIO',
    'SYNCHRONIZE_LISTENING_BLOCK',
    'VALIDATE_LISTENING_EPISODE',
    'PUBLISH_LISTENING_EPISODE',
    'REPAIR_LISTENING_EPISODE',
    'AUDIT_LISTENING_INVENTORY',
    'AUDIT_LISTENING_STORAGE',
    'CLEANUP_LISTENING_STAGING'
  )),

  CONSTRAINT chk_listening_job_status CHECK (status IN (
    'pending', 'processing', 'retry', 'completed',
    'failed', 'cancelled', 'dead_letter'
  )),

  CONSTRAINT chk_listening_job_priority CHECK (priority >= 0)
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────

-- Unique active job per idempotency key (allows cancelled/dead_letter duplicates)
CREATE UNIQUE INDEX uq_listening_jobs_idempotency
  ON listening_jobs (idempotency_key)
  WHERE status NOT IN ('cancelled', 'dead_letter');

-- Dispatch: find next eligible job
CREATE INDEX idx_listening_jobs_dispatch
  ON listening_jobs (status, next_attempt_at, priority DESC, created_at)
  WHERE status IN ('pending', 'retry');

-- Per job type + status lookups
CREATE INDEX idx_listening_jobs_type_status ON listening_jobs (job_type, status);

-- Per episode lookups
CREATE INDEX idx_listening_jobs_episode ON listening_jobs (episode_id, status);

-- Per block lookups
CREATE INDEX idx_listening_jobs_block ON listening_jobs (block_id, status);

-- Stuck job recovery (find expired processing locks)
CREATE INDEX idx_listening_jobs_lock_expiry
  ON listening_jobs (lock_expires_at)
  WHERE status = 'processing';

-- Cleanup (find old completed/cancelled jobs)
CREATE INDEX idx_listening_jobs_updated ON listening_jobs (updated_at);

-- ─── RLS ─────────────────────────────────────────────────────────────────────
-- No access for regular users — service role only

ALTER TABLE listening_jobs ENABLE ROW LEVEL SECURITY;

-- ─── updated_at trigger ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION listening_jobs_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_listening_jobs_updated_at
  BEFORE UPDATE ON listening_jobs
  FOR EACH ROW EXECUTE FUNCTION listening_jobs_set_updated_at();

-- ─── listening_operational_alerts table ───────────────────────────────────────

CREATE TABLE listening_operational_alerts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type  TEXT        NOT NULL,
  severity    TEXT        NOT NULL DEFAULT 'warning',
  episode_id  UUID        REFERENCES listening_episodes(id) ON DELETE SET NULL,
  job_id      UUID        REFERENCES listening_jobs(id) ON DELETE SET NULL,
  message     TEXT        NOT NULL,
  details     JSONB,
  status      TEXT        NOT NULL DEFAULT 'open',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,

  CONSTRAINT chk_alert_severity CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  CONSTRAINT chk_alert_status   CHECK (status IN ('open', 'acknowledged', 'resolved'))
);

CREATE INDEX idx_listening_alerts_status ON listening_operational_alerts (status, created_at);
CREATE INDEX idx_listening_alerts_episode ON listening_operational_alerts (episode_id);
CREATE INDEX idx_listening_alerts_job ON listening_operational_alerts (job_id);

ALTER TABLE listening_operational_alerts ENABLE ROW LEVEL SECURITY;

-- ─── RPC: claim_next_listening_job ───────────────────────────────────────────
-- Atomically claim the next eligible job for a worker.
-- Uses FOR UPDATE SKIP LOCKED to prevent two workers from claiming the same job.

CREATE OR REPLACE FUNCTION claim_next_listening_job(
  p_worker_id  TEXT,
  p_job_types  TEXT[],
  p_lock_ms    INT DEFAULT 600000
)
RETURNS SETOF listening_jobs
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_job listening_jobs;
BEGIN
  SELECT * INTO v_job
  FROM listening_jobs
  WHERE status IN ('pending', 'retry')
    AND job_type = ANY(p_job_types)
    AND next_attempt_at <= now()
    AND (lock_expires_at IS NULL OR lock_expires_at < now())
  ORDER BY priority DESC, next_attempt_at ASC, created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_job.id IS NULL THEN
    RETURN;
  END IF;

  UPDATE listening_jobs SET
    status          = 'processing',
    locked_by       = p_worker_id,
    locked_at       = now(),
    lock_expires_at = now() + make_interval(secs => p_lock_ms::FLOAT / 1000.0),
    attempts        = attempts + 1,
    started_at      = COALESCE(started_at, now()),
    updated_at      = now()
  WHERE id = v_job.id
  RETURNING * INTO v_job;

  RETURN NEXT v_job;
END;
$$;

GRANT EXECUTE ON FUNCTION claim_next_listening_job(TEXT, TEXT[], INT) TO service_role;

-- ─── RPC: heartbeat_listening_job ────────────────────────────────────────────
-- Extend the lock on a job that the worker is still processing.
-- Returns TRUE if the lock was extended, FALSE if the worker no longer holds it.

CREATE OR REPLACE FUNCTION heartbeat_listening_job(
  p_job_id       UUID,
  p_worker_id    TEXT,
  p_extension_ms INT DEFAULT 600000
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE listening_jobs SET
    lock_expires_at = now() + make_interval(secs => p_extension_ms::FLOAT / 1000.0),
    updated_at      = now()
  WHERE id          = p_job_id
    AND locked_by   = p_worker_id
    AND status      = 'processing';

  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION heartbeat_listening_job(UUID, TEXT, INT) TO service_role;

-- ─── Comments ─────────────────────────────────────────────────────────────────

COMMENT ON TABLE listening_jobs IS
  'Persistent job queue for the Listening pipeline (Etapa 11). All operations use service_role only.';

COMMENT ON TABLE listening_operational_alerts IS
  'Administrative alerts for Listening pipeline issues (inventory, quality, storage).';

COMMENT ON FUNCTION claim_next_listening_job IS
  'Atomically claim the next eligible Listening job. Uses SKIP LOCKED to prevent concurrent workers from claiming the same job.';

COMMENT ON FUNCTION heartbeat_listening_job IS
  'Extend the lock on a job being processed. Worker should call every ~60s for long-running jobs.';
