-- =============================================================================
-- MIGRATION: 20260714160000_create_learner_skill_profiles
-- Projeto: Lemon (english learning app)
--
-- Idempotente: pode ser aplicada múltiplas vezes sem efeito colateral.
--
-- O que esta migration faz:
--   1. Cria tipo ENUM para skill, assessment_status e source.
--   2. Cria tabela learner_skill_profiles com constraints canônicos.
--   3. Habilita RLS.
--   4. Cria política SELECT para o próprio usuário.
--   5. Cria índices de performance.
--
-- Princípio: cada habilidade tem seu próprio perfil. Um aluno pode ser A2
-- em writing e A1 em pronunciation. O nível nunca é global.
--
-- RLS deliberada: INSERT/UPDATE/DELETE não são permitidos por usuários
-- autenticados via browser. Atualizações pedagógicas são feitas por service
-- role ou RPCs controladas pelo servidor.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 1: ENUMs
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE public.learning_skill AS ENUM (
    'writing', 'pronunciation', 'conversation', 'listening'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.skill_assessment_status AS ENUM (
    'unknown', 'provisional', 'calibrating', 'confirmed', 'stale'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.skill_level_source AS ENUM (
    'diagnostic', 'ongoing_calibration', 'checkpoint',
    'manual_admin', 'legacy_migration', 'system_default'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 2: Tabela learner_skill_profiles
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.learner_skill_profiles (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  skill             public.learning_skill NOT NULL,

  -- null = não classificado (unknown). Ausência de classificação ≠ A1.
  cefr_level        TEXT        CHECK (cefr_level IN ('A1','A2','B1','B2','C1','C2')),

  assessment_status public.skill_assessment_status NOT NULL DEFAULT 'unknown',
  source            public.skill_level_source     NOT NULL DEFAULT 'system_default',

  -- 0–1. Nunca percentual. Verificado por constraint.
  confidence        NUMERIC(4,3) NOT NULL DEFAULT 0
                    CHECK (confidence >= 0 AND confidence <= 1),

  evidence_count    INTEGER      NOT NULL DEFAULT 0
                    CHECK (evidence_count >= 0),

  catalog_version   INTEGER      NOT NULL DEFAULT 1
                    CHECK (catalog_version > 0),

  assessed_at       TIMESTAMPTZ,
  calibrated_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Um perfil por habilidade por usuário.
  CONSTRAINT uq_learner_skill_profiles_user_skill UNIQUE (user_id, skill)
);

ALTER TABLE public.learner_skill_profiles ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 3: Políticas RLS
-- ─────────────────────────────────────────────────────────────────────────────

-- SELECT: usuário autenticado lê apenas seus próprios perfis.
DROP POLICY IF EXISTS "lsp_select" ON public.learner_skill_profiles;
CREATE POLICY "lsp_select" ON public.learner_skill_profiles
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- INSERT/UPDATE/DELETE: sem políticas para usuários autenticados.
-- RLS habilitado sem políticas = browser não pode escrever diretamente.
-- Escritas pedagógicas ocorrem via service role (API serverless).

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 4: Índices
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_lsp_user_id
  ON public.learner_skill_profiles (user_id);

CREATE INDEX IF NOT EXISTS idx_lsp_user_skill
  ON public.learner_skill_profiles (user_id, skill);
