-- =============================================================================
-- MIGRATION: 20260715040000_create_promotion_engine
-- Projeto: Lemon (english learning app)
--
-- Idempotente: pode ser aplicada múltiplas vezes sem efeito colateral.
--
-- O que esta migration faz:
--   1. Cria tabela promotion_evaluations com RLS SELECT.
--   2. Cria tabela promotion_checkpoints com RLS SELECT.
--   3. Cria RPC promote_learner_skill_atomic (SECURITY DEFINER).
--   4. Cria índices de performance.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 1: Tabela promotion_evaluations
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.promotion_evaluations (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  skill                   public.learning_skill NOT NULL,
  current_level           TEXT        NOT NULL CHECK (current_level IN ('A1','A2','B1','B2','C1')),
  target_level            TEXT        CHECK (target_level IN ('A2','B1','B2','C1')),
  decision                TEXT        NOT NULL CHECK (decision IN (
                            'promote','keep_level','insufficient_data',
                            'configuration_error','maximum_supported_level')),
  eligible                BOOLEAN     NOT NULL DEFAULT false,
  confidence              NUMERIC(4,3) NOT NULL DEFAULT 0
                          CHECK (confidence >= 0 AND confidence <= 1),
  progress_percent        NUMERIC(5,2) NOT NULL DEFAULT 0
                          CHECK (progress_percent >= 0 AND progress_percent <= 100),
  requirements_json       JSONB       NOT NULL DEFAULT '[]',
  blocking_reasons_json   JSONB       NOT NULL DEFAULT '[]',
  evidence_snapshot_json  JSONB,
  engine_version          TEXT        NOT NULL,
  curriculum_version      INTEGER     NOT NULL DEFAULT 1,
  idempotency_key         TEXT        NOT NULL UNIQUE,
  trigger_source          TEXT        NOT NULL DEFAULT 'system',
  promotion_applied       BOOLEAN     NOT NULL DEFAULT false,
  evaluated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.promotion_evaluations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pe_select" ON public.promotion_evaluations;
CREATE POLICY "pe_select" ON public.promotion_evaluations
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 2: Tabela promotion_checkpoints
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.promotion_checkpoints (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  skill        public.learning_skill NOT NULL,
  level        TEXT        NOT NULL CHECK (level IN ('A1','A2','B1','B2','C1')),
  mission_id   UUID,
  passed       BOOLEAN     NOT NULL,
  confidence   NUMERIC(4,3) NOT NULL DEFAULT 0
               CHECK (confidence >= 0 AND confidence <= 1),
  score_json   JSONB,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.promotion_checkpoints ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pc_select" ON public.promotion_checkpoints;
CREATE POLICY "pc_select" ON public.promotion_checkpoints
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 3: RPC promote_learner_skill_atomic (SECURITY DEFINER)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.promote_learner_skill_atomic(
  p_user_id              UUID,
  p_skill                TEXT,
  p_expected_current_level TEXT,
  p_new_level            TEXT,
  p_confidence           NUMERIC,
  p_evidence_snapshot    JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_level    TEXT;
  v_profile_id       UUID;
  v_old_confidence   NUMERIC;
  v_reason_code      TEXT;
BEGIN
  -- Lock the learner_skill_profiles row to prevent concurrent promotions
  -- Capture old confidence here, before UPDATE overwrites it.
  SELECT id, cefr_level, confidence
  INTO v_profile_id, v_current_level, v_old_confidence
  FROM public.learner_skill_profiles
  WHERE user_id = p_user_id AND skill = p_skill::public.learning_skill
  FOR UPDATE;

  -- Check if level changed concurrently
  IF v_current_level IS DISTINCT FROM p_expected_current_level THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason', 'level_changed_concurrently',
      'actual_level', v_current_level
    );
  END IF;

  -- Build reason code
  v_reason_code := 'PROMOTION_' || upper(p_expected_current_level) || '_TO_' || upper(p_new_level);

  -- Update the skill profile
  UPDATE public.learner_skill_profiles
  SET
    cefr_level        = p_new_level,
    assessment_status = 'confirmed',
    source            = 'ongoing_calibration',
    confidence        = p_confidence,
    assessed_at       = NOW(),
    calibrated_at     = NOW(),
    updated_at        = NOW()
  WHERE id = v_profile_id;

  -- Insert history record
  INSERT INTO public.learner_skill_level_history (
    user_id,
    skill,
    previous_level,
    new_level,
    previous_status,
    new_status,
    previous_confidence,
    new_confidence,
    source,
    reason_code,
    evidence_snapshot,
    changed_at
  )
  VALUES (
    p_user_id,
    p_skill::public.learning_skill,
    p_expected_current_level,
    p_new_level,
    'confirmed',
    'confirmed',
    v_old_confidence,
    p_confidence,
    'ongoing_calibration',
    v_reason_code,
    p_evidence_snapshot,
    NOW()
  );

  RETURN jsonb_build_object(
    'success', true,
    'new_level', p_new_level
  );
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 4: Índices
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_pe_user_skill_evaluated
  ON public.promotion_evaluations (user_id, skill, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_pc_user_skill_level
  ON public.promotion_checkpoints (user_id, skill, level);
