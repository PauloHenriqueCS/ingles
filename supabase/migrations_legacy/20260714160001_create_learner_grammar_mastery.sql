-- =============================================================================
-- MIGRATION: 20260714160001_create_learner_grammar_mastery
-- Projeto: Lemon (english learning app)
--
-- Idempotente: pode ser aplicada múltiplas vezes sem efeito colateral.
--
-- O que esta migration faz:
--   1. Cria ENUM para mastery_state.
--   2. Cria tabela learner_grammar_mastery com constraints canônicos.
--   3. Habilita RLS.
--   4. Cria política SELECT para o próprio usuário.
--   5. Cria índices de performance.
--
-- Restrição sobre contadores:
--   - successful_uses <= total_opportunities (uso bem-sucedido não pode
--     exceder o número de oportunidades).
--   - independent_uses + guided_uses + assisted_uses <= total_opportunities
--     porque nem toda oportunidade resulta em uso categorizado. A diferença
--     representa oportunidades não aproveitadas ou não classificadas.
--
-- grammar_topic_id referencia o ID canônico do catálogo (ex: grammar.present_simple).
-- Não usa FK com CASCADE porque o catálogo é estático e gerenciado pelo código.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 1: ENUM mastery_state
-- ─────────────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE public.grammar_mastery_state AS ENUM (
    'locked', 'introduced', 'practicing',
    'consolidating', 'mastered', 'maintenance'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 2: Tabela learner_grammar_mastery
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.learner_grammar_mastery (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  grammar_topic_id       TEXT         NOT NULL
                         CHECK (char_length(grammar_topic_id) BETWEEN 1 AND 128),
  catalog_version        INTEGER      NOT NULL DEFAULT 1
                         CHECK (catalog_version > 0),

  mastery_state          public.grammar_mastery_state NOT NULL DEFAULT 'locked',

  total_opportunities    INTEGER      NOT NULL DEFAULT 0
                         CHECK (total_opportunities >= 0),
  successful_uses        INTEGER      NOT NULL DEFAULT 0
                         CHECK (successful_uses >= 0),
  error_count            INTEGER      NOT NULL DEFAULT 0
                         CHECK (error_count >= 0),

  independent_uses       INTEGER      NOT NULL DEFAULT 0
                         CHECK (independent_uses >= 0),
  guided_uses            INTEGER      NOT NULL DEFAULT 0
                         CHECK (guided_uses >= 0),
  assisted_uses          INTEGER      NOT NULL DEFAULT 0
                         CHECK (assisted_uses >= 0),

  distinct_context_count INTEGER      NOT NULL DEFAULT 0
                         CHECK (distinct_context_count >= 0),

  confidence             NUMERIC(4,3) NOT NULL DEFAULT 0
                         CHECK (confidence >= 0 AND confidence <= 1),

  first_introduced_at    TIMESTAMPTZ,
  last_practiced_at      TIMESTAMPTZ,
  last_successful_use_at TIMESTAMPTZ,
  mastered_at            TIMESTAMPTZ,
  maintenance_due_at     TIMESTAMPTZ,

  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- Um registro por tópico por usuário.
  CONSTRAINT uq_learner_grammar_mastery_user_topic UNIQUE (user_id, grammar_topic_id),

  -- successful_uses não pode exceder total de oportunidades.
  CONSTRAINT chk_lgm_successful_lte_total
    CHECK (successful_uses <= total_opportunities),

  -- A soma dos tipos de uso não excede o total de oportunidades.
  -- A diferença representa oportunidades não aproveitadas (pedagogicamente válido).
  CONSTRAINT chk_lgm_use_types_lte_total
    CHECK (independent_uses + guided_uses + assisted_uses <= total_opportunities)
);

ALTER TABLE public.learner_grammar_mastery ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 3: Políticas RLS
-- ─────────────────────────────────────────────────────────────────────────────

-- SELECT: usuário autenticado lê apenas seu próprio domínio gramatical.
DROP POLICY IF EXISTS "lgm_select" ON public.learner_grammar_mastery;
CREATE POLICY "lgm_select" ON public.learner_grammar_mastery
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- INSERT/UPDATE/DELETE: sem políticas para usuários autenticados.
-- Atualizações pedagógicas ocorrem via service role (API serverless).

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 4: Índices
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_lgm_user_id
  ON public.learner_grammar_mastery (user_id);

CREATE INDEX IF NOT EXISTS idx_lgm_user_topic
  ON public.learner_grammar_mastery (user_id, grammar_topic_id);

CREATE INDEX IF NOT EXISTS idx_lgm_state
  ON public.learner_grammar_mastery (user_id, mastery_state);
