-- =============================================================================
-- MIGRATION: 20260714160002_create_learner_skill_level_history
-- Projeto: Lemon (english learning app)
--
-- Idempotente: pode ser aplicada múltiplas vezes sem efeito colateral.
--
-- O que esta migration faz:
--   1. Cria tabela de histórico imutável de alterações de nível por habilidade.
--   2. Habilita RLS.
--   3. Cria política SELECT para o próprio usuário.
--   4. Cria índices de auditoria.
--
-- Esta tabela é append-only: registros nunca são alterados nem removidos.
-- Ela responde às perguntas: quando o nível mudou, de qual para qual,
-- quem/qual processo causou a mudança e quais evidências resumidas
-- justificaram a decisão.
--
-- evidence_snapshot: campo JSONB controlado. Gravar apenas resumos pequenos.
-- Nunca gravar: prompts completos, textos do aluno, respostas completas de IA,
-- tokens de API ou dados de autenticação.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.learner_skill_level_history (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  skill                public.learning_skill NOT NULL,

  previous_level       TEXT         CHECK (previous_level IN ('A1','A2','B1','B2','C1','C2')),
  new_level            TEXT         CHECK (new_level IN ('A1','A2','B1','B2','C1','C2')),

  previous_status      public.skill_assessment_status NOT NULL,
  new_status           public.skill_assessment_status NOT NULL,

  previous_confidence  NUMERIC(4,3) NOT NULL
                       CHECK (previous_confidence >= 0 AND previous_confidence <= 1),
  new_confidence       NUMERIC(4,3) NOT NULL
                       CHECK (new_confidence >= 0 AND new_confidence <= 1),

  source               public.skill_level_source NOT NULL,

  reason_code          TEXT         NOT NULL
                       CHECK (char_length(reason_code) BETWEEN 1 AND 128),

  -- Resumo de evidências. Tamanho limitado: sem textos ou prompts completos.
  evidence_snapshot    JSONB,

  changed_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE public.learner_skill_level_history ENABLE ROW LEVEL SECURITY;

-- SELECT: usuário autenticado lê apenas seu próprio histórico.
DROP POLICY IF EXISTS "lslh_select" ON public.learner_skill_level_history;
CREATE POLICY "lslh_select" ON public.learner_skill_level_history
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- INSERT/UPDATE/DELETE: sem políticas para usuários autenticados.
-- Registros de histórico são criados exclusivamente pelo service role.

-- ─────────────────────────────────────────────────────────────────────────────
-- Índices de auditoria e performance
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_lslh_user_id
  ON public.learner_skill_level_history (user_id);

CREATE INDEX IF NOT EXISTS idx_lslh_user_skill_time
  ON public.learner_skill_level_history (user_id, skill, changed_at DESC);
