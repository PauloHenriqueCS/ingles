-- =============================================================================
-- MIGRATION: 20260714120000_schema_integrity_baseline
-- Projeto: Lemon (english learning app)
--
-- APLICAR UMA ÚNICA VEZ no Supabase SQL Editor:
--   Dashboard → SQL Editor → Nova query → cole este arquivo → Execute
--
-- Esta migration NÃO modifica nem remove dados existentes.
-- Todas as operações são aditivas ou removem políticas incorretas.
-- Idempotente: pode ser executada novamente sem efeito colateral.
--
-- O que esta migration faz:
--   1. Remove política RLS incorreta em writing_entries ("authenticated_all")
--      que permitia qualquer usuário autenticado ler entradas de outros usuários.
--   2. Remove "anon_all" de grammar_explanations e generated_themes, caso
--      tenha sobrevivido por ordem de aplicação das migrations antigas.
--   3. Garante que generated_themes tenha políticas user-specific corretas.
--   4. Adiciona CHECK constraints NOT VALID em tabelas críticas (não bloqueiam
--      dados existentes; reforçam apenas novas inserções/atualizações).
--   5. Adiciona índice composto em conversation_sessions para acelerar
--      getDayTotalSeconds (user_id + session_date).
--   6. Recria update_updated_at() e set_updated_at() com SET search_path = ''
--      (hardening: previne search_path injection em funções de trigger).
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 1: writing_entries — corrigir RLS
-- ─────────────────────────────────────────────────────────────────────────────
-- "authenticated_all" foi adicionada em migration_rls_authenticated.sql com
-- USING (true) — qualquer usuário autenticado podia ler e alterar entradas de
-- qualquer outro usuário. As políticas we_* (auth.uid() = user_id) são
-- suficientes e corretas. Remover a política insegura não afeta o frontend,
-- pois fetchAllEntries() e upsertEntry() sempre filtram por user_id.

DROP POLICY IF EXISTS "authenticated_all" ON public.writing_entries;

-- Remove "anon_all" legada, caso o banco tenha sido inicializado diretamente
-- do schema.sql original sem executar migration_multiuser.sql.
DROP POLICY IF EXISTS "anon_all" ON public.writing_entries;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 2: grammar_explanations — remover acesso anônimo
-- ─────────────────────────────────────────────────────────────────────────────
-- migration_grammar_explanations.sql cria a tabela com "anon_all".
-- Se executada APÓS migration_multiuser.sql (que criou ge_select/ge_insert/
-- ge_update e removeu anon_all), a política anon_all seria recriada.
-- As políticas ge_* já cobrem o acesso correto para usuários autenticados.

DROP POLICY IF EXISTS "anon_all" ON public.grammar_explanations;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 3: generated_themes — garantir RLS user-specific
-- ─────────────────────────────────────────────────────────────────────────────
-- Recria as quatro políticas de forma idempotente independentemente da ordem
-- em que migration_generated_themes.sql e migration_multiuser.sql foram
-- aplicadas. O resultado final é sempre: autenticado, dono da linha.

DROP POLICY IF EXISTS "anon_all"  ON public.generated_themes;
DROP POLICY IF EXISTS "gt_select" ON public.generated_themes;
DROP POLICY IF EXISTS "gt_insert" ON public.generated_themes;
DROP POLICY IF EXISTS "gt_update" ON public.generated_themes;
DROP POLICY IF EXISTS "gt_delete" ON public.generated_themes;

CREATE POLICY "gt_select" ON public.generated_themes
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "gt_insert" ON public.generated_themes
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "gt_update" ON public.generated_themes
  FOR UPDATE TO authenticated
  USING     (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "gt_delete" ON public.generated_themes
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 4: CHECK constraints NOT VALID
-- ─────────────────────────────────────────────────────────────────────────────
-- NOT VALID: a constraint é criada mas não valida dados existentes.
-- Novas inserções e atualizações serão rejeitadas se violarem a regra.
-- Para validar dados históricos (opcional, quando confirmado que estão
-- corretos), execute separadamente:
--   ALTER TABLE <tabela> VALIDATE CONSTRAINT <nome>;

-- 4a. review_groups: nível de revisão não pode ser negativo
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname    = 'review_groups_level_non_negative'
      AND conrelid   = 'public.review_groups'::regclass
  ) THEN
    ALTER TABLE public.review_groups
      ADD CONSTRAINT review_groups_level_non_negative
        CHECK (review_level >= 0) NOT VALID;
  END IF;
END;
$$;

-- 4b. pronunciation_assessments: scores de 0.00 a 100.00 (Azure sempre retorna
-- neste intervalo; NULL é permitido enquanto o assessment está em processamento)
DO $$
DECLARE
  v_table regclass := 'public.pronunciation_assessments'::regclass;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pa_pronunciation_score_range' AND conrelid = v_table) THEN
    ALTER TABLE public.pronunciation_assessments
      ADD CONSTRAINT pa_pronunciation_score_range
        CHECK (pronunciation_score IS NULL OR pronunciation_score BETWEEN 0 AND 100) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pa_accuracy_score_range' AND conrelid = v_table) THEN
    ALTER TABLE public.pronunciation_assessments
      ADD CONSTRAINT pa_accuracy_score_range
        CHECK (accuracy_score IS NULL OR accuracy_score BETWEEN 0 AND 100) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pa_fluency_score_range' AND conrelid = v_table) THEN
    ALTER TABLE public.pronunciation_assessments
      ADD CONSTRAINT pa_fluency_score_range
        CHECK (fluency_score IS NULL OR fluency_score BETWEEN 0 AND 100) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pa_completeness_score_range' AND conrelid = v_table) THEN
    ALTER TABLE public.pronunciation_assessments
      ADD CONSTRAINT pa_completeness_score_range
        CHECK (completeness_score IS NULL OR completeness_score BETWEEN 0 AND 100) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pa_prosody_score_range' AND conrelid = v_table) THEN
    ALTER TABLE public.pronunciation_assessments
      ADD CONSTRAINT pa_prosody_score_range
        CHECK (prosody_score IS NULL OR prosody_score BETWEEN 0 AND 100) NOT VALID;
  END IF;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 5: Índice de performance — conversation_sessions
-- ─────────────────────────────────────────────────────────────────────────────
-- getDayTotalSeconds() filtra por user_id e session_date simultaneamente.
-- O índice composto (user_id, session_date) evita full table scan por usuário.

CREATE INDEX IF NOT EXISTS idx_conversation_sessions_user_date
  ON public.conversation_sessions (user_id, session_date);

-- ─────────────────────────────────────────────────────────────────────────────
-- BLOCO 6: Hardening de funções de trigger
-- ─────────────────────────────────────────────────────────────────────────────
-- As funções update_updated_at() (schema.sql) e set_updated_at()
-- (migration_pronunciation_assessment.sql) foram criadas sem SET search_path.
-- Um search_path não fixado expõe a função a objetos de schemas inesperados
-- se o caller manipular seu próprio search_path.
-- Recriar com SET search_path = '' isola completamente as funções.
-- Corpo idêntico ao original — nenhum comportamento muda.

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- Nota: as funções SECURITY DEFINER das migrations de pronúncia e preferências
-- (set_ai_prefs_user_id, set_conversation_session_user_id,
-- reserve/complete/fail_pronunciation_assessment, compensate_pronunciation_assessment)
-- já possuem SET search_path = public nas suas migrations de origem.
-- Não são modificadas aqui.

-- =============================================================================
-- FIM DA MIGRATION 20260714120000_schema_integrity_baseline
--
-- Para verificar o banco após esta migration, execute:
--   supabase/verify_schema.sql  (somente leitura, sem efeitos colaterais)
-- =============================================================================
