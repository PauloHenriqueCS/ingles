-- Canonical writing mission entity with explicit state machine.
-- Status: generated → accepted → started → completed | skipped | cancelled
--         generated → superseded | expired | cancelled

CREATE TYPE mission_status AS ENUM (
  'generated',
  'accepted',
  'started',
  'completed',
  'skipped',
  'superseded',
  'expired',
  'cancelled'
);

CREATE TYPE writing_mission_mode AS ENUM (
  'normal',
  'review',
  'diagnostic'
);

CREATE TABLE writing_missions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  skill                TEXT NOT NULL DEFAULT 'writing',
  status               mission_status NOT NULL DEFAULT 'generated',
  mode                 writing_mission_mode NOT NULL DEFAULT 'normal',

  -- Content fields — frozen after accepted_at is set (enforced by trigger)
  title                TEXT NOT NULL,
  prompt_pt_br         TEXT NOT NULL,
  level                TEXT NOT NULL,
  difficulty           TEXT NOT NULL,
  suggested_words      TEXT[],
  support_sentences    TEXT[],

  -- References
  pedagogical_plan_id  UUID REFERENCES mission_pedagogical_plans(id) ON DELETE SET NULL,
  legacy_theme_id      UUID,  -- backward compat link to generated_themes

  -- Timestamps
  generated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at          TIMESTAMPTZ,
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  skipped_at           TIMESTAMPTZ,
  expired_at           TIMESTAMPTZ,
  cancelled_at         TIMESTAMPTZ,

  -- Server-only audit data (not exposed to clients)
  internal_snapshot    JSONB
);

-- At most one active (accepted or started) mission per user per skill.
CREATE UNIQUE INDEX uq_writing_missions_one_active_per_user_skill
  ON writing_missions (user_id, skill)
  WHERE status IN ('accepted', 'started');

-- Fast lookups by user+skill+status
CREATE INDEX idx_writing_missions_user_skill_status
  ON writing_missions (user_id, skill, status);

-- RLS: users may only read their own missions; all writes go through service role.
ALTER TABLE writing_missions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own missions"
  ON writing_missions FOR SELECT
  USING (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policies: service role bypasses RLS for writes.
